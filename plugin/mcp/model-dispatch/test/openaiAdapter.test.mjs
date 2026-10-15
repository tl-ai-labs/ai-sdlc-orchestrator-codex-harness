/**
 * Runs against dist/adapters/OpenAIAdapter.js — the adapter takes its
 * `openai` client by injection so these tests never make a network call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

/** Failure tests skip the backoff between the adapter's transient retries. */
const NO_WAIT = { retryDelayMs: () => 0 };

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
  assert.equal(out.tokens.input, 600, "input is the FRESH count: 1000 total minus 400 cached");
  assert.equal(out.tokens.input_cached, 400);
  assert.equal(out.tokens.output, 50);
  assert.equal(out.tokens.output_reasoning, 20);
  assert.equal(out.cache_hit, true, "any cached_tokens > 0 flips cache_hit");
  assert.equal(out.attempts.length, 1, "no output cap hit — one attempt");
  assert.equal(
    out.cost_usd,
    // fresh = 1000 total - 400 cached. OpenAI reports input_tokens
    // inclusive of input_tokens_details.cached_tokens.
    (600 / 1_000_000) * 2.0 + (400 / 1_000_000) * 0.2 + (50 / 1_000_000) * 12.0,
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
  const adapter = new OpenAIAdapter(BASE_CONFIG, { client, ...NO_WAIT });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /rate limit exceeded/);
  assert.equal(out.result, null);
  assert.equal(client.calls.length, 3, "a 429 is retried twice, as the SDK would");
  assert.equal(out.attempts.length, 3, "each request is its own attempt");
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

// ── cost provenance ──────────────────────────────────────────────────
//
// This adapter normally reports real vendor-metered usage and so declares no
// costProvenance, inheriting `vendor` in server.ts. But it falls back to
// estimateTokens whenever the vendor sends no usage — and an estimate
// published as vendor-metered spend is exactly what the provenance taxonomy
// exists to prevent. The result must say so itself.

test("a metered response is not labelled — it inherits vendor, as it should", async () => {
  const client = fakeClient(() => ({
    status: "completed",
    output_text: JSON.stringify({ ok: true }),
    incomplete_details: null,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }));
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(
    out.cost_provenance, undefined,
    "a real metered call must not claim to be an estimate",
  );
});

test("a response with no usage block is labelled estimated, not vendor", async () => {
  // The exact hole: tokens here come from estimateTokens, and without the
  // label they would be reported as money the vendor actually charged.
  const client = fakeClient(() => ({
    status: "completed",
    output_text: JSON.stringify({ ok: true }),
    incomplete_details: null,
    usage: undefined,
  }));
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute(PACKET);
  assert.equal(out.success, true);
  assert.ok(out.cost_usd > 0, "it still prices the call");
  assert.equal(out.cost_provenance, "estimated", "…but must not present that price as metered");
});

test("a usage block missing only output_tokens is still an estimate", async () => {
  const client = fakeClient(() => ({
    status: "completed",
    output_text: JSON.stringify({ ok: true }),
    incomplete_details: null,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 } },
  }));
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute(PACKET);
  assert.equal(out.cost_provenance, "estimated");
});

test("a vendor error prices the attempt but labels it estimated", async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error("500 upstream"), { status: 500 });
  });
  const out = await new OpenAIAdapter(BASE_CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.equal(
    out.cost_provenance, "estimated",
    "a failure priced from the prompt was never a vendor measurement",
  );
});

test("each attempt carries its own label: an estimated first attempt does not relabel a measured second", async () => {
  let call = 0;
  const client = fakeClient((req) => {
    call += 1;
    if (call === 1) {
      return {
        status: "incomplete",
        output_text: "",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 } },
      };
    }
    return {
      status: "completed",
      output_text: JSON.stringify({ ok: true }),
      incomplete_details: null,
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
    };
  });
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, budget: { maxInputTokens: 8000, maxOutputTokens: 500 } });
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[1].cost_provenance, undefined);
  assert.equal(out.cost_provenance, "estimated", "the result still summarises that one attempt estimated");
});

// ── failure billing ──────────────────────────────────────────────────
//
// A request that never left this machine is billed $0. An error OpenAI
// answered keeps the prompt estimate, because OpenAI publishes no statement
// that a 4xx or 5xx is free.

const connectionError = (code, name = "APIConnectionError") =>
  Object.assign(new Error("Connection error."), { name, cause: Object.assign(new Error("fetch failed"), { code }) });

test("an answered error keeps the estimate and records its status", async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error("429 rate limit exceeded"), { status: 429 });
  });
  const out = await new OpenAIAdapter(BASE_CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  assert.equal(out.attempts[0].error_status, 429);
  assert.ok(out.cost_usd > 0);
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, undefined, "an answered error booked as a stand-in is not a floor");
});

test("a request that never reached OpenAI is billed nothing", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]) {
    const client = fakeClient(() => {
      throw connectionError(code);
    });
    const out = await new OpenAIAdapter(BASE_CONFIG, { client, ...NO_WAIT }).execute(PACKET);
    assert.equal(out.success, false);
    assert.equal(out.cost_usd, 0, code);
    assert.equal(out.attempts[0].error_code, code);
    assert.equal(out.attempts[0].cost_provenance, undefined, `${code}: a $0 nothing-was-sent is not an estimate`);
    assert.equal(out.cost_provenance, undefined);
  }
});

test("a connection reset or a timeout with no answer is priced as an estimate", async () => {
  for (const err of [connectionError("ECONNRESET"), Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" })]) {
    const client = fakeClient(() => {
      throw err;
    });
    const out = await new OpenAIAdapter(BASE_CONFIG, { client, ...NO_WAIT }).execute(PACKET);
    assert.ok(out.cost_usd > 0, err.name);
    assert.equal(out.attempts[0].cost_provenance, "estimated");
    assert.equal(out.attempts[0].usage_complete, false, `${err.name}: the prompt alone is a floor`);
  }
});

test("the failure estimate counts the instructions block as well as the user prompt", async () => {
  const adapter = new OpenAIAdapter(BASE_CONFIG, {
    client: fakeClient(() => {
      throw Object.assign(new Error("500"), { status: 500 });
    }),
    ...NO_WAIT,
  });
  const bare = (await adapter.execute(PACKET)).tokens.input;
  adapter.setSystemCache("x".repeat(3800));
  const withSystem = (await adapter.execute(PACKET)).tokens.input;
  assert.ok(withSystem >= bare + 1000, `${withSystem} should include the ~1000-token instructions block`);
});

test("each attempt reaches onAttempt as it returns, and the abort signal reaches the request", async () => {
  let call = 0;
  const opts = [];
  const client = {
    responses: {
      create: async (req, o) => {
        call += 1;
        opts.push(o);
        return call === 1
          ? { status: "incomplete", output_text: "", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 0 } } }
          : { status: "completed", output_text: "{}", incomplete_details: null, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } };
      },
    },
  };
  const seen = [];
  const stop = new AbortController();
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute(
    { ...PACKET, budget: { maxInputTokens: 8000, maxOutputTokens: 500 } },
    undefined,
    { onAttempt: (a) => seen.push(a), signal: stop.signal },
  );
  assert.deepEqual(seen, out.attempts);
  assert.equal(seen[0], out.attempts[0]);
  assert.ok(opts[0].signal instanceof AbortSignal, "every request carries the dispatch's signal");
});

test("aborting the dispatch aborts the request in flight", async () => {
  const stop = new AbortController();
  const client = {
    responses: {
      create: (_req, o) =>
        new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true })),
    },
  };
  setTimeout(() => stop.abort(), 20);
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute(PACKET, undefined, { signal: stop.signal });
  assert.equal(out.success, false);
  assert.match(out.error, /aborted/);
  assert.doesNotMatch(out.error, /deadline/, "the caller's abort is not the deadline");
});

// ── strict structured output ─────────────────────────────────────────

const STRICT_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const planSchema = (mode) =>
  JSON.parse(readFileSync(new URL(`../../../config/schemas/plan-packets.${mode}.json`, import.meta.url), "utf8"));
const USAGE = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } };
const answer = (value) => () => ({ status: "completed", output_text: JSON.stringify(value), incomplete_details: null, usage: USAGE });

test("a schema strict mode accepts goes as strict structured output, named after the phase", async () => {
  const client = fakeClient(answer({ ok: true }));
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, outputSchema: STRICT_SCHEMA });
  assert.deepEqual(client.calls[0].text, {
    format: { type: "json_schema", name: "requirements_analysis", schema: STRICT_SCHEMA, strict: true },
  });
  assert.deepEqual(out.result, { ok: true });
});

test("a schema strict mode would refuse sends no text format, as before", async () => {
  for (const outputSchema of [PACKET.outputSchema, { type: "array", items: { type: "object" } }, { __free_text__: true }]) {
    const client = fakeClient(answer({ ok: true }));
    const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, outputSchema });
    assert.equal("text" in client.calls[0], false, JSON.stringify(outputSchema));
    assert.equal(out.success, true);
  }
});

test("the shipped plan schemas go as strict structured output, priced as any other reply", async () => {
  const plan = { packets: [] };
  const loose = fakeClient(answer(plan));
  const looseOut = await new OpenAIAdapter(BASE_CONFIG, { client: loose }).execute(PACKET);
  for (const mode of ["greenfield", "brownfield"]) {
    const schema = planSchema(mode);
    const client = fakeClient(answer(plan));
    const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, phase: "plan_task_packets", outputSchema: schema });
    assert.deepEqual(client.calls[0].text, { format: { type: "json_schema", name: "plan_task_packets", schema, strict: true } }, mode);
    assert.deepEqual(out.result, plan);
    assert.equal(out.cost_usd, looseOut.cost_usd, "the format changes no usage or pricing");
    assert.deepEqual(out.tokens, looseOut.tokens);
    assert.deepEqual(out.attempts[0].tokens, looseOut.attempts[0].tokens);
  }
});

test("strict structured output rides every attempt of the output-cap doubling", async () => {
  let call = 0;
  const client = fakeClient((req) => {
    call += 1;
    return call === 1
      ? { status: "incomplete", output_text: "", incomplete_details: { reason: "max_output_tokens" }, usage: { ...USAGE, output_tokens: req.max_output_tokens } }
      : answer({ ok: true })();
  });
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, outputSchema: STRICT_SCHEMA, budget: { maxInputTokens: 8000, maxOutputTokens: 500 } });
  assert.equal(client.calls.length, 2);
  for (const req of client.calls) assert.equal(req.text.format.strict, true);
  assert.equal(out.success, true);
});

test("a schema past strict mode's limits goes without a text format, as any schema strict mode refuses", async () => {
  let deep = { type: "object", properties: { leaf: { type: "string" } }, required: ["leaf"], additionalProperties: false };
  for (let i = 1; i < 11; i++) deep = { type: "object", properties: { inner: deep }, required: ["inner"], additionalProperties: false };
  const client = fakeClient(answer({ inner: {} }));
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, outputSchema: deep });
  assert.equal("text" in client.calls[0], false);
  assert.equal(out.success, true);
});

test("a strict-mode refusal is a failed dispatch that keeps the model's reason, priced as the reply it was", async () => {
  const refused = () => ({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that request." }] }],
    output_text: "",
    incomplete_details: null,
    usage: USAGE,
  });
  const client = fakeClient(refused);
  const out = await new OpenAIAdapter(BASE_CONFIG, { client }).execute({ ...PACKET, phase: "plan_task_packets", outputSchema: planSchema("brownfield") });
  assert.equal(client.calls.length, 1, "a refusal is not retried");
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.equal(out.error, "openai: the model refused the request under strict structured output: I can't help with that request.");
  assert.deepEqual(out.result, { refusal: "I can't help with that request." });
  assert.equal(out.attempts[0].success, false);
  assert.equal(out.tokens.output, USAGE.output_tokens, "the refusal's tokens are billed and counted");
  assert.ok(out.cost_usd > 0);

  const loose = fakeClient(refused);
  const looseOut = await new OpenAIAdapter(BASE_CONFIG, { client: loose }).execute(PACKET);
  assert.equal(looseOut.success, true, "without a text format the reply reads as it always has");
  assert.deepEqual(looseOut.result, { raw: "" });
});
