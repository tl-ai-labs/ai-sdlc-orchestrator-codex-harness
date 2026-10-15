/**
 * A failed Gemini completion call is described by the vendor's own fields, and
 * one Google answered with an error status, or that never left this machine,
 * is billed $0. A connection lost with no answer keeps the prompt as an
 * estimate. Runs against dist/adapters/GeminiFlashAdapter.js with an injected
 * transport, so nothing reaches Google.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";
import { describeVendorFailure } from "../dist/adapters/vendorFailure.js";

const LEAF = {
  id: "flash-completion",
  adapter: "mcp:model-dispatch",
  model_name: "gemini-3.8-flash",
  pricing: { input: 0.75, input_cached: 0.075, output: 3.75 },
  max_output_tokens_absolute: 8192,
};
const PACKET = {
  id: "p1",
  phase: "codegen",
  task_type: "dto",
  module: "m",
  instruction: "Return {ok:true}.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 512 },
  pass_id: "t",
};
const clock = () => new Date("2026-10-13T12:00:00Z");

function transport(generate) {
  return { backend: "api-key", location: "", createCache: async () => undefined, generate };
}

const adapterWith = (generate, opts = {}) => new GeminiFlashAdapter(LEAF, { clock, transport: transport(generate), ...opts });

/** Shaped like @google/genai's ApiError: `status` plus the JSON error body as the message. */
const apiError = (status, body) => Object.assign(new Error(JSON.stringify(body)), { name: "ApiError", status });
const transit = (code) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket"), { code }) });

test("a 429 is recorded with its status and billed nothing, labelled as the vendor's rule", async () => {
  const r = await adapterWith(async () => {
    throw apiError(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
  }).execute(PACKET);
  const a = r.attempts.at(-1);
  assert.equal(r.success, false);
  assert.equal(r.terminal_reason, "vendor_error");
  assert.equal(a.error_status, 429);
  assert.deepEqual(a.tokens, { input: 0, input_cached: 0, output: 0 });
  assert.equal(a.cost_usd, 0);
  assert.equal(r.cost_usd, 0);
  assert.equal(a.cost_provenance, undefined, "the zero is Google's billing rule, not an estimate");
  assert.equal(a.usage_complete, undefined, "Google's answer is the whole bill");
  assert.equal(r.cost_provenance, undefined);
});

test("a delay the vendor asks for is read from its RetryInfo entry", async () => {
  const r = await adapterWith(async () => {
    throw apiError(503, {
      error: {
        code: 503,
        status: "UNAVAILABLE",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }],
      },
    });
  }).execute(PACKET);
  const a = r.attempts.at(-1);
  assert.equal(a.error_status, 503);
  assert.equal(a.retry_after_ms, 7000);
  assert.equal(a.cost_usd, 0);
});

test("a connection lost in transit is recorded with its code and priced as an estimate", async () => {
  const r = await adapterWith(async () => {
    throw transit("ECONNRESET");
  }).execute(PACKET);
  const a = r.attempts.at(-1);
  assert.equal(a.error_code, "ECONNRESET");
  assert.equal(a.error_status, undefined);
  assert.ok(a.cost_usd > 0, "no answer came back, so the request may have been served");
  assert.equal(a.cost_provenance, "estimated");
  assert.equal(a.usage_complete, false, "the prompt alone is a floor for a request that may have been served");
  assert.equal(r.cost_provenance, "estimated");
});

test("a request that never reached Google is billed nothing", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EAI_AGAIN"]) {
    const r = await adapterWith(async () => {
      throw transit(code);
    }).execute(PACKET);
    assert.equal(r.attempts.at(-1).cost_usd, 0, code);
    assert.equal(r.attempts.at(-1).error_code, code);
  }
});

test("a measured attempt keeps its cost and label when the next doubling is answered with a 429", async () => {
  let call = 0;
  const r = await adapterWith(async () => {
    call += 1;
    if (call === 1) {
      return {
        text: "{",
        usage: { promptTokenCount: 4000, candidatesTokenCount: 512 },
        finishReason: "MAX_TOKENS",
      };
    }
    throw apiError(429, { error: { code: 429 } });
  }).execute(PACKET);
  assert.equal(r.attempts.length, 2);
  const first = r.attempts[0];
  assert.equal(first.cost_usd, 0.00492);
  assert.equal(r.cost_usd, first.cost_usd, "the 429 adds nothing");
  assert.equal(r.attempts[1].cost_usd, 0);
  assert.equal(first.cost_provenance, undefined);
  assert.equal(r.cost_provenance, undefined, "nothing in this packet was estimated");
});

test("a measured attempt stays unlabelled when the next doubling is lost in transit", async () => {
  let call = 0;
  const r = await adapterWith(async () => {
    call += 1;
    if (call === 1) {
      return { text: "{", usage: { promptTokenCount: 4000, candidatesTokenCount: 512 }, finishReason: "MAX_TOKENS" };
    }
    throw transit("ECONNRESET");
  }).execute(PACKET);
  assert.equal(r.attempts[0].cost_provenance, undefined);
  assert.equal(r.attempts[1].cost_provenance, "estimated");
  assert.equal(r.cost_provenance, "estimated");
});

test("describeVendorFailure reads nothing from a plain error or a non-JSON message", () => {
  assert.deepEqual(describeVendorFailure(new Error("boom")), {});
  assert.deepEqual(describeVendorFailure(Object.assign(new Error("not json"), { status: 500 })), { error_status: 500 });
  assert.deepEqual(describeVendorFailure(undefined), {});
});

test("each attempt reaches onAttempt as it returns, in order, as the same records the result carries", async () => {
  let call = 0;
  const seen = [];
  const r = await adapterWith(async () => {
    call += 1;
    if (call === 1) return { text: "{", usage: { promptTokenCount: 10, candidatesTokenCount: 512 }, finishReason: "MAX_TOKENS" };
    return { text: "{}", usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, finishReason: "STOP" };
  }).execute(PACKET, undefined, { onAttempt: (a) => seen.push(a) });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], r.attempts[0]);
  assert.equal(seen[1], r.attempts[1]);
});

test("aborting the dispatch aborts the Gemini request in flight", async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  const r = await adapterWith(
    (args) =>
      new Promise((_, reject) => args.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  ).execute(PACKET, undefined, { signal: stop.signal });
  assert.equal(r.success, false);
  assert.match(r.error, /aborted/);
});
