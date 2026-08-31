/**
 * Runs against dist/adapters/OpenAIAdapter.js — the adapter takes its
 * `openai` client by injection so these tests never make a network call.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIAdapter } from "../dist/adapters/OpenAIAdapter.js";

const BASE_CONFIG = {
  id: "gpt-judgment",
  adapter: "openai",
  model_name: "gpt-5.6-terra",
  pricing: { input: 2.0, input_cached: 0.2, output: 12.0 },
  reasoning: { effort: "high" },
  max_output_tokens_absolute: 4000,
};

const PACKET = {
  id: "pkt-1",
  phase: "requirements_analysis",
  task_type: "requirements",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  acceptance: ["Responds with valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 1000 },
  pass_id: "test-pass",
};

/** A fake `openai` client whose `.responses.create` is driven by `behavior`. */
function fakeClient(behavior) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => {
        calls.push(req);
        return behavior(req);
      },
    },
  };
}

test("returns a successful ExecutionResult with usage passthrough", async () => {
  const client = fakeClient(() => ({
    status: "completed",
    output_text: JSON.stringify({ ok: true }),
    incomplete_details: null,
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 400 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
    },
  }));
  const adapter = new OpenAIAdapter(BASE_CONFIG, { client });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.equal(out.terminal_reason, "success");
  assert.deepEqual(out.result, { ok: true });
  assert.equal(out.tokens.input, 1000);
  assert.equal(out.tokens.input_cached, 400);
  assert.equal(out.tokens.output, 50);
  assert.equal(out.tokens.output_reasoning, 20);
  assert.equal(out.cache_hit, true, "any cached_tokens > 0 flips cache_hit");
  assert.equal(out.attempts.length, 1, "no output cap hit — one attempt");
  assert.equal(
    out.cost_usd,
    (1000 / 1_000_000) * 2.0 + (400 / 1_000_000) * 0.2 + (50 / 1_000_000) * 12.0,
  );
});

test("passes the pinned reasoning effort and model name through on every attempt", async () => {
  const client = fakeClient(() => ({
    status: "completed",
    output_text: "{}",
    incomplete_details: null,
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } },
  }));
  const adapter = new OpenAIAdapter(BASE_CONFIG, { client });
  await adapter.execute(PACKET);

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, "gpt-5.6-terra");
  assert.deepEqual(client.calls[0].reasoning, { effort: "high" });
});

test("doubles the output ceiling on max_output_tokens and succeeds on the next attempt", async () => {
  let call = 0;
  const client = fakeClient((req) => {
    call += 1;
    if (call === 1) {
      return {
        status: "incomplete",
        output_text: "",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: req.max_output_tokens, output_tokens_details: { reasoning_tokens: 0 } },
      };
    }
    return {
      status: "completed",
      output_text: JSON.stringify({ ok: true }),
      incomplete_details: null,
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
    };
  });
  const adapter = new OpenAIAdapter(BASE_CONFIG, { client });
  const out = await adapter.execute({ ...PACKET, budget: { maxInputTokens: 8000, maxOutputTokens: 500 } });

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].max_output_tokens, 500);
  assert.equal(client.calls[1].max_output_tokens, 1000, "ceiling doubles on the retry");
  assert.equal(out.success, true);
  assert.equal(out.terminal_reason, "success");
  assert.equal(out.attempts.length, 2);
});

test("stops at the model's absolute ceiling rather than doubling past it", async () => {
  const client = fakeClient(() => ({
    status: "incomplete",
    output_text: "partial",
    incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4000, output_tokens_details: { reasoning_tokens: 0 } },
  }));
  const adapter = new OpenAIAdapter(
    { ...BASE_CONFIG, max_output_tokens_absolute: 500 },
    { client },
  );
  const out = await adapter.execute({ ...PACKET, budget: { maxInputTokens: 8000, maxOutputTokens: 500 } });

  assert.equal(client.calls.length, 1, "ceiling already equals the absolute — no retry fired");
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "output_cap_at_model_absolute");
  assert.deepEqual(out.result, { raw: "partial", _truncated: true });
});

test("gives up after the doubling budget without reaching the absolute ceiling", async () => {
  const client = fakeClient(() => ({
    status: "incomplete",
    output_text: "",
    incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } },
  }));
  const adapter = new OpenAIAdapter(
    { ...BASE_CONFIG, max_output_tokens_absolute: 1_000_000 },
    { client },
  );
  const out = await adapter.execute({ ...PACKET, budget: { maxInputTokens: 8000, maxOutputTokens: 100 } });

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "output_cap_doubling_budget_exhausted");
  assert.equal(out.attempts.length, 4, "3 doublings + the initial attempt");
});

test("classifies a thrown vendor error as a vendor_error ExecutionResult, not a throw", async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error("rate limit exceeded"), { status: 429 });
  });
  const adapter = new OpenAIAdapter(BASE_CONFIG, { client });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /rate limit exceeded/);
  assert.equal(out.result, null);
});

test("output_text that isn't valid JSON falls back to a raw wrapper, not an error", async () => {
  const client = fakeClient(() => ({
    status: "completed",
    output_text: "not JSON at all",
    incomplete_details: null,
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 } },
  }));
  const adapter = new OpenAIAdapter(BASE_CONFIG, { client });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true, "a non-JSON completion still succeeded — parsing is best-effort");
  assert.deepEqual(out.result, { raw: "not JSON at all" });
});

test("constructor throws when OPENAI_API_KEY is not set and no client is injected", () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => new OpenAIAdapter(BASE_CONFIG), /OPENAI_API_KEY not set/);
  } finally {
    if (original !== undefined) process.env.OPENAI_API_KEY = original;
  }
});
