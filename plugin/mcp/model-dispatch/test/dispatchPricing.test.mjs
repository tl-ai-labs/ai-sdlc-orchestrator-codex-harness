/**
 * Every adapter prices a dispatch from the dated list on the dispatch's own
 * day, and refuses, before any vendor call or spawn, a model nothing prices.
 * Offline: clients, transports and spawns are injected stubs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";

import { OpenAIAdapter } from "../dist/adapters/OpenAIAdapter.js";
import { CodexCliAdapter } from "../dist/adapters/CodexCliAdapter.js";
import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";
import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { BuiltinAnthropicAdapter } from "../dist/adapters/BuiltinAnthropicAdapter.js";
import { ClaudeCliAdapter } from "../dist/adapters/ClaudeCliAdapter.js";
import { WORKER_PYTHON_ENV } from "../dist/delegation/workerProcess.js";
import { computeCostUsd } from "../dist/pricing.js";

const at = (iso) => () => new Date(iso);
const TODAY = at("2026-10-13T12:00:00Z");
const GPT_STANDARD = { input: 2, input_cached: 0.2, output: 12 };
const GPT_LONG = { input: 4, input_cached: 0.4, output: 18 };

const PACKET = {
  id: "pkt-price",
  phase: "requirements_analysis",
  task_type: "requirements",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 1000 },
  pass_id: "test-pass",
};

function assertRefused(out, modelId, day) {
  assert.equal(out.success, false);
  assert.equal(out.cost_usd, 0);
  assert.deepEqual(out.tokens, { input: 0, input_cached: 0, output: 0 });
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, new RegExp(`^unpriced: model '${modelId}' \\(.+\\) has no price for a dispatch on ${day}, so nothing was sent: `));
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0].cost_usd, 0);
}

// ── OpenAI: one Responses request per attempt, tiered on its own prompt ──

const OPENAI_CONFIG = { id: "gpt-judgment", adapter: "openai", model_name: "gpt-5.6-terra", pricing: GPT_STANDARD, max_output_tokens_absolute: 4000 };

function openaiClient(responses) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => {
        calls.push(req);
        return responses[Math.min(calls.length - 1, responses.length - 1)];
      },
    },
  };
}

const openaiResponse = (input, cached, output, status = "completed") => ({
  status,
  output_text: JSON.stringify({ ok: true }),
  incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 } },
});

test("OpenAI: a request over 272,000 input tokens bills every token at 4.00/0.40/18.00", async () => {
  const client = openaiClient([openaiResponse(300_000, 100_000, 10_000)]);
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: TODAY }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(out.cost_usd, 1.02, "not the 0.54 the standard card gives");
  const [a] = out.attempts;
  assert.equal(a.price_tier, "long_context");
  assert.equal(a.price_basis, "list");
  assert.equal(a.price_verified, "2026-10-13");
  assert.equal(a.prompt_tokens, 300_000);
});

test("OpenAI: a request of exactly 272,000 input tokens bills standard", async () => {
  const client = openaiClient([openaiResponse(272_000, 72_000, 1_000)]);
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: TODAY }).execute(PACKET);
  assert.equal(out.attempts[0].price_tier, "standard");
  assert.equal(out.cost_usd, computeCostUsd({ input: 200_000, input_cached: 72_000, output: 1_000 }, GPT_STANDARD));
});

test("OpenAI: each doubling-loop attempt is tiered on its own request", async () => {
  const client = openaiClient([openaiResponse(300_000, 0, 1_000, "incomplete"), openaiResponse(100_000, 0, 1_500)]);
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: TODAY }).execute(PACKET);
  assert.deepEqual(out.attempts.map((a) => a.price_tier), ["long_context", "standard"]);
  assert.equal(out.attempts[0].cost_usd, computeCostUsd({ input: 300_000, input_cached: 0, output: 1_000 }, GPT_LONG));
  assert.equal(out.attempts[1].cost_usd, computeCostUsd({ input: 100_000, input_cached: 0, output: 1_500 }, GPT_STANDARD));
});

// 1.2M characters estimate to about 316,000 tokens: over the line, but only by estimate.
const LONG_PACKET = { ...PACKET, id: "pkt-price-long", instruction: "x".repeat(1_200_000) };
const NO_USAGE = { status: "completed", output_text: JSON.stringify({ ok: true }), incomplete_details: null };

test("OpenAI: with no usage block, an estimate over 272,000 bills the long card but is labelled unverified", async () => {
  const client = openaiClient([NO_USAGE]);
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: TODAY }).execute(LONG_PACKET);
  const [a] = out.attempts;
  assert.ok(a.tokens.input > 272_000);
  assert.equal(a.price_tier, "unverified");
  assert.equal(a.cost_usd, computeCostUsd(a.tokens, GPT_LONG));
  assert.equal(a.prompt_tokens, undefined, "no vendor count to report");
  assert.equal(out.cost_provenance, "estimated");
});

test("OpenAI: with no usage block, a small estimate bills standard and is still labelled unverified", async () => {
  const client = openaiClient([NO_USAGE]);
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: TODAY }).execute(PACKET);
  const [a] = out.attempts;
  assert.equal(a.price_tier, "unverified");
  assert.equal(a.cost_usd, computeCostUsd(a.tokens, GPT_STANDARD));
});

test("OpenAI: a vendor error's estimated attempt is labelled unverified, not long_context", async () => {
  const client = {
    responses: {
      create: async () => {
        throw Object.assign(new Error("500 server error"), { status: 500 });
      },
    },
  };
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: TODAY, retryDelayMs: () => 0 }).execute(LONG_PACKET);
  assert.equal(out.success, false);
  assert.equal(out.attempts[0].price_tier, "unverified");
});

test("OpenAI: an unlisted model is refused without calling the API", async () => {
  const client = openaiClient([openaiResponse(10, 0, 1)]);
  const config = { ...OPENAI_CONFIG, model_name: "gpt-unknown-9", pricing: { input: 0, input_cached: 0, output: 0 } };
  const out = await new OpenAIAdapter(config, { client, clock: TODAY }).execute(PACKET);
  assert.equal(client.calls.length, 0);
  assertRefused(out, "gpt-judgment", "2026-10-13");
});

test("OpenAI: a day before the list's first entry is refused without calling the API", async () => {
  const client = openaiClient([openaiResponse(10, 0, 1)]);
  const out = await new OpenAIAdapter(OPENAI_CONFIG, { client, clock: at("2026-08-08T23:00:00Z") }).execute(PACKET);
  assert.equal(client.calls.length, 0);
  assertRefused(out, "gpt-judgment", "2026-08-08");
  assert.match(out.error, /no price for gpt-5\.6-terra on 2026-08-08/);
});

test("OpenAI: pricing_override bills the block, labelled custom", async () => {
  const client = openaiClient([openaiResponse(400_000, 0, 1_000)]);
  const block = { input: 1, input_cached: 0.1, output: 5 };
  const config = { ...OPENAI_CONFIG, model_name: "gpt-gateway-x", pricing: block, pricing_override: true };
  const out = await new OpenAIAdapter(config, { client, clock: TODAY }).execute(PACKET);
  assert.equal(out.attempts[0].price_basis, "custom");
  assert.equal(out.attempts[0].price_verified, null);
  assert.equal(out.cost_usd, computeCostUsd({ input: 400_000, input_cached: 0, output: 1_000 }, block));
});

// ── codex-cli: one turn's usage sums every request in it ─────────────────

const CODEX_CONFIG = { id: "gpt", adapter: "codex-cli", model_name: "gpt-5.6-terra", reasoning: { effort: "high" }, pricing: GPT_STANDARD };

function codexSpawn(usage) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ ok: true }));
      child.stdout.write(JSON.stringify({ type: "turn.completed", usage }));
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test("codex-cli: a turn at or below 272,000 input tokens is proven standard", async () => {
  const spawnFn = codexSpawn({ input_tokens: 272_000, cached_input_tokens: 0, output_tokens: 100 });
  const out = await new CodexCliAdapter(CODEX_CONFIG, { spawnFn, clock: TODAY }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(out.attempts[0].price_tier, "standard");
  assert.equal(out.attempts[0].prompt_tokens, undefined, "a turn is not one request");
});

test("codex-cli: a 2.9M-token turn bills standard rates and is flagged unverified", async () => {
  const spawnFn = codexSpawn({ input_tokens: 2_900_000, cached_input_tokens: 2_800_000, output_tokens: 1_000 });
  const out = await new CodexCliAdapter(CODEX_CONFIG, { spawnFn, clock: TODAY }).execute(PACKET);
  assert.equal(out.attempts[0].price_tier, "unverified");
  assert.equal(out.cost_usd, computeCostUsd({ input: 100_000, input_cached: 2_800_000, output: 1_000 }, GPT_STANDARD));
});

test("codex-cli: a turn with no usage block is estimated, so its tier is unverified", async () => {
  const spawnFn = codexSpawn(undefined);
  const out = await new CodexCliAdapter(CODEX_CONFIG, { spawnFn, clock: TODAY }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(out.attempts[0].price_tier, "unverified", "a small estimate does not prove standard");
  assert.equal(out.cost_usd, computeCostUsd(out.attempts[0].tokens, GPT_STANDARD));
});

test("codex-cli: an unpriced model is refused before codex is spawned", async () => {
  const spawnFn = codexSpawn({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
  const out = await new CodexCliAdapter({ ...CODEX_CONFIG, model_name: "gpt-unknown-9" }, { spawnFn, clock: TODAY }).execute(PACKET);
  assert.equal(spawnFn.calls.length, 0);
  assertRefused(out, "gpt", "2026-10-13");
});

// ── Gemini completion: priced per dispatch, never at construction ────────

const FLASH_CONFIG = { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 } };
const GEMINI_USAGE = { promptTokenCount: 1_000_000, cachedContentTokenCount: 0, candidatesTokenCount: 1_000_000 };

function geminiTransport({ backend = "api-key", location = "" } = {}) {
  const calls = [];
  return {
    calls,
    backend,
    location,
    createCache: async () => undefined,
    generate: async (args) => {
      calls.push(args);
      return { text: '{"ok":true}', usage: GEMINI_USAGE, finishReason: "STOP" };
    },
  };
}

test("Gemini: one adapter bills the intro card on 2026-12-31 and the 2027 card on 2027-01-01", async () => {
  let now = new Date("2026-12-31T23:59:59Z");
  const adapter = new GeminiFlashAdapter(FLASH_CONFIG, { transport: geminiTransport(), clock: () => now });
  const dec31 = await adapter.execute(PACKET);
  now = new Date("2027-01-01T00:00:00Z");
  const jan1 = await adapter.execute(PACKET);
  assert.equal(dec31.cost_usd, 0.75 + 3.75);
  assert.equal(jan1.cost_usd, 1.5 + 7.5);
  assert.equal(jan1.attempts[0].price_basis, "list");
});

test("Gemini: a regional Vertex endpoint bills the list card x1.10", async () => {
  const transport = geminiTransport({ backend: "vertex-adc", location: "us-central1" });
  const adapter = new GeminiFlashAdapter(FLASH_CONFIG, { transport, clock: at("2027-01-02T00:00:00Z") });
  const out = await adapter.execute(PACKET);
  assert.equal(out.cost_usd, computeCostUsd({ input: 1_000_000, input_cached: 0, output: 1_000_000 }, { input: 1.5 * 1.1, input_cached: 0.15 * 1.1, output: 7.5 * 1.1 }));
  assert.deepEqual(adapter.pricingOn(new Date("2026-10-13")).billed, { input: 0.75 * 1.1, input_cached: 0.075 * 1.1, output: 3.75 * 1.1 });
});

test("Gemini: an unpriced day is refused before any Gemini call", async () => {
  const transport = geminiTransport();
  const out = await new GeminiFlashAdapter(FLASH_CONFIG, { transport, clock: at("2026-08-12T12:00:00Z") }).execute(PACKET);
  assert.equal(transport.calls.length, 0);
  assertRefused(out, "flash", "2026-08-12");
});

test("Gemini: the shipped 3.8 leaf is refused the day before 3.8 Flash's GA, a day 3.7 Flash is priced", async () => {
  const transport = geminiTransport();
  const v38 = await new GeminiFlashAdapter({ ...FLASH_CONFIG, model_name: "gemini-3.8-flash" }, { transport, clock: at("2026-09-01T12:00:00Z") }).execute(PACKET);
  assert.equal(transport.calls.length, 0);
  assertRefused(v38, "flash", "2026-09-01");
  const v37 = await new GeminiFlashAdapter(FLASH_CONFIG, { transport, clock: at("2026-09-01T12:00:00Z") }).execute(PACKET);
  assert.equal(v37.success, true);
});

// ── the other adapters refuse the same way ───────────────────────────────

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test("Antigravity worker: an unpriced day is refused before the worker is spawned", async () => {
  await withEnv({ GOOGLE_CLOUD_PROJECT: "unit-test-project", [WORKER_PYTHON_ENV]: process.execPath }, async () => {
    const config = { id: "flash-agsdk-worker", adapter: "antigravity-worker", model_name: "gemini-3.7-flash" };
    const adapter = new AntigravityWorkerAdapter(config, { clock: at("2026-08-12T12:00:00Z") });
    // No work_dir: a dispatch that got past the price check would fail on that instead.
    const out = await adapter.execute(PACKET);
    assertRefused(out, "flash-agsdk-worker", "2026-08-12");
    assert.equal(adapter.billedPricing, undefined);
  });
});

test("Antigravity worker: the billed card follows the dispatch day", async () => {
  await withEnv({ GOOGLE_CLOUD_PROJECT: "unit-test-project", [WORKER_PYTHON_ENV]: process.execPath }, async () => {
    const config = { id: "w", adapter: "antigravity-worker", model_name: "gemini-3.7-flash", region: "asia-south1" };
    const adapter = new AntigravityWorkerAdapter(config, { clock: TODAY });
    assert.deepEqual(adapter.pricingOn(new Date("2026-12-31T12:00:00Z")).billed, { input: 0.75 * 1.1, input_cached: 0.075 * 1.1, output: 3.75 * 1.1 });
    assert.deepEqual(adapter.pricingOn(new Date("2027-01-01T12:00:00Z")).billed, { input: 1.5 * 1.1, input_cached: 0.15 * 1.1, output: 7.5 * 1.1 });
  });
});

function anthropicClient() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } };
      },
    },
  };
}

test("Anthropic SDK: an unpriced model is refused before any request", async () => {
  const client = anthropicClient();
  const config = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-9", pricing: { input: 5, input_cached: 0.5, output: 25 } };
  const out = await new BuiltinAnthropicAdapter(config, { client, clock: TODAY }).execute(PACKET);
  assert.equal(client.calls.length, 0);
  assertRefused(out, "opus", "2026-10-13");
});

test("Anthropic SDK: a listed model reaches the injected client and bills the list card", async () => {
  const client = anthropicClient();
  const config = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5", pricing: { input: 5, input_cached: 0.5, output: 25 } };
  const out = await new BuiltinAnthropicAdapter(config, { client, clock: TODAY }).execute(PACKET);
  assert.equal(client.calls.length, 1);
  assert.equal(out.success, true);
  assert.equal(out.attempts[0].price_basis, "list");
  assert.equal(out.cost_usd, computeCostUsd({ input: 10, input_cached: 0, output: 1 }, { input: 5, input_cached: 0.5, output: 25 }));
});

test("claude-cli: an unpriced model is refused before claude is spawned", async () => {
  let spawned = 0;
  const spawnFn = () => { spawned++; throw new Error("spawned"); };
  const config = { id: "sonnet-cli", adapter: "claude-cli", model_name: "claude-sonnet-9" };
  const adapter = new ClaudeCliAdapter(config, { spawnFn, probeBinary: () => {}, clock: TODAY });
  const out = await adapter.execute(PACKET);
  assert.equal(spawned, 0);
  assertRefused(out, "sonnet-cli", "2026-10-13");
});
