/**
 * The OpenAI client makes no retries of its own; the adapter makes them, so
 * every request a transient failure repeats is recorded and billed by its own
 * outcome. Offline: injected clients and an injected fetch only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";

import { OpenAIAdapter, retryable, sdkRetryDelayMs } from "../dist/adapters/OpenAIAdapter.js";
import { attemptEvents } from "../dist/dispatchEvents.js";

const CONFIG = {
  id: "gpt",
  adapter: "openai",
  model_name: "gpt-5.6-terra",
  pricing: { input: 2.0, input_cached: 0.2, output: 12.0 },
  max_output_tokens_absolute: 4000,
};

const PACKET = {
  id: "p1",
  phase: "requirements_analysis",
  task_type: "r",
  module: "m",
  instruction: "x".repeat(400),
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 8000, maxOutputTokens: 1000 },
  pass_id: "t",
};

const NO_WAIT = { retryDelayMs: () => 0 };

const OK = {
  status: "completed",
  output_text: "{}",
  incomplete_details: null,
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } },
};

/** The SDK's error for a fetch that threw: node-fetch's FetchError carries the system code. */
const fetchError = (code) => Object.assign(new Error(`request failed, reason: ${code}`), { name: "FetchError", type: "system", code, errno: code });
const connectionError = (code) => new OpenAI.APIConnectionError({ cause: fetchError(code) });

/** Replies with `script[i]` on call i: an Error is thrown, anything else returned. */
function scripted(script) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => {
        const step = script[Math.min(calls.length, script.length - 1)];
        calls.push(req);
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
}

test("the adapter's own client is built with no SDK retries", () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const adapter = new OpenAIAdapter(CONFIG);
    assert.equal(adapter.client.maxRetries, 0, "an SDK retry is a billed request the adapter never sees");
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test("a reset retried into a success records both requests", async () => {
  const client = scripted([connectionError("ECONNRESET"), OK]);
  const out = await new OpenAIAdapter(CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(client.calls.length, 2);
  assert.equal(out.attempts.length, 2);
  const [reset, ok] = out.attempts;
  assert.ok(reset.cost_usd > 0, "the reset request may have been served");
  assert.equal(reset.cost_provenance, "estimated");
  assert.equal(reset.usage_complete, false);
  assert.equal(ok.retry_reason, "transient");
  assert.equal(ok.cost_provenance, undefined, "the retry's usage is metered");
  assert.equal(ok.tokens.input, 100);
  assert.equal(out.cost_usd, reset.cost_usd + ok.cost_usd);
  assert.equal(out.cost_provenance, "estimated", "the summary says one attempt was estimated");
});

test("a reset whose retries never left the machine still books the reset", async () => {
  const client = scripted([connectionError("ECONNRESET"), connectionError("ENOTFOUND")]);
  const out = await new OpenAIAdapter(CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.attempts.length, 3);
  assert.ok(out.attempts[0].cost_usd > 0);
  assert.equal(out.attempts[1].cost_usd, 0);
  assert.equal(out.attempts[2].cost_usd, 0);
  assert.equal(out.cost_usd, out.attempts[0].cost_usd, "classifying by the final error alone booked $0");
  assert.equal(out.cost_provenance, "estimated");
  assert.equal(out.attempts[2].error_code, "ENOTFOUND");
});

test("a 400 is not retried", async () => {
  const client = scripted([Object.assign(new Error("400 bad request"), { status: 400 })]);
  const out = await new OpenAIAdapter(CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  assert.equal(client.calls.length, 1);
  assert.equal(out.terminal_reason, "vendor_error");
});

test("the vendor's x-should-retry header decides over the status", () => {
  const withHeader = (status, value) => Object.assign(new Error("e"), { status, headers: { "x-should-retry": value } });
  assert.equal(retryable(withHeader(500, "false"), { error_status: 500 }), false);
  assert.equal(retryable(withHeader(400, "true"), { error_status: 400 }), true);
  for (const status of [408, 409, 429, 500, 503]) assert.equal(retryable(new Error("e"), { error_status: status }), true, String(status));
  assert.equal(retryable(new Error("e"), { error_status: 404 }), false);
  assert.equal(retryable(new OpenAI.APIUserAbortError(), {}), false);
  assert.equal(retryable(new OpenAI.APIConnectionTimeoutError(), {}), true);
  assert.equal(retryable(connectionError("ECONNRESET"), { error_code: "ECONNRESET" }), true);
  assert.equal(retryable(new TypeError("rsp.output is not iterable"), {}), false, "an error after a 200 is not resent");
});

test("the backoff follows the vendor's retry-after under a minute, else the SDK's schedule", () => {
  const h = (headers) => ({ headers });
  assert.equal(sdkRetryDelayMs(0, h({ "retry-after-ms": "250" })), 250);
  assert.equal(sdkRetryDelayMs(0, h({ "retry-after": "2" })), 2000);
  const longWait = sdkRetryDelayMs(0, h({ "retry-after": "120" }));
  assert.ok(longWait >= 375 && longWait <= 500, `a two-minute ask falls back to the schedule, got ${longWait}`);
  const first = sdkRetryDelayMs(0, new Error("e"));
  assert.ok(first >= 375 && first <= 500, String(first));
  const capped = sdkRetryDelayMs(6, new Error("e"));
  assert.ok(capped >= 6000 && capped <= 8000, String(capped));
});

test("the deadline ends a backoff, and no request follows it", async () => {
  const client = scripted([connectionError("ECONNRESET"), OK]);
  const started = Date.now();
  const out = await new OpenAIAdapter({ ...CONFIG, worker_timeout_sec: 0.2 }, { client, retryDelayMs: () => 10_000 }).execute(PACKET);
  assert.ok(Date.now() - started < 2000, "the 10 s backoff was cut at the 0.2 s deadline");
  assert.equal(client.calls.length, 1);
  assert.equal(out.success, false);
  assert.equal(out.attempts.length, 1);
});

test("the real SDK client, with no retries of its own, surfaces each failed request to the adapter", async () => {
  let fetches = 0;
  const body = { id: "r", object: "response", status: "completed", incomplete_details: null, usage: OK.usage, output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] };
  const fetch = async () => {
    fetches += 1;
    if (fetches === 1) throw fetchError("ECONNRESET");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new OpenAI({ apiKey: "sk-test", baseURL: "http://127.0.0.1:9/v1", maxRetries: 0, fetch });
  const out = await new OpenAIAdapter(CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  assert.equal(fetches, 2);
  assert.equal(out.success, true);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].error_code, "ECONNRESET");
  assert.equal(out.attempts[0].usage_complete, false);
});

test("a transient retry's telemetry event says why it was made", async () => {
  const client = scripted([Object.assign(new Error("503"), { status: 503 }), OK]);
  const out = await new OpenAIAdapter(CONFIG, { client, ...NO_WAIT }).execute(PACKET);
  const events = attemptEvents(
    {
      packet: PACKET,
      decision: { modelId: "gpt", ruleIndex: 0, reason: "r", selection: undefined },
      policy: { name: "p", version: 1 },
      modelName: "gpt-5.6-terra",
      adapterProvenance: undefined,
    },
    out,
    "2026-10-13T00:00:00.000Z",
  );
  assert.deepEqual(events.map((e) => e.retry_reason), [undefined, "transient"]);
});
