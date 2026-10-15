/**
 * Unit tests for plugin/codex/telemetry/fairnessPin.mjs.
 *
 * The three rejection-event fixtures below are real `codex exec --json`
 * output, captured live against an invalid reasoning effort and an
 * unrecognized model slug (docs/verification/p1-codex-runtime.md check 7),
 * not reconstructed from memory. All three shapes were needed: an early
 * version of findPinRejection only checked two of them and would have
 * missed the top-level `error` event and the `turn.failed` event's nested
 * `.error.message` — this suite pins that fix.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readPin, readDriver, argvPin, assertPinnedInvocation, findPinRejection, findCodexWarnings } from "../../../codex/telemetry/fairnessPin.mjs";
import { parseEventStream } from "../../../codex/telemetry/event-reader.mjs";

const RATES = { input: 2.0, input_cached: 0.2, output: 12.0 };

const POLICY = {
  name: "gpt-plus-flash",
  driver: { model_name: "gpt-5.6-terra", reasoning: { effort: "high" }, pricing: RATES },
  models: [
    { id: "gpt", adapter: "openai", model_name: "gpt-5.6-terra", reasoning: { effort: "medium" }, pricing: RATES },
    { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash" },
  ],
};

const LEGACY = {
  name: "legacy",
  models: [{ id: "gpt", adapter: "openai", model_name: "gpt-5.6-terra", reasoning: { effort: "high" }, pricing: RATES }],
};

const silent = { warn: () => {} };

test("readPin reads model and effort from the driver block, not the gpt model entry", () => {
  assert.deepEqual(readPin(POLICY), { model: "gpt-5.6-terra", effort: "high" });
});

test("readDriver returns the pin, the rates and where they came from", () => {
  assert.deepEqual(readDriver(POLICY), { pin: { model: "gpt-5.6-terra", effort: "high" }, pricing: RATES, from: "driver" });
});

test("readDriver takes the rates from a model entry for the same model when the block has none", () => {
  const policy = { ...POLICY, driver: { model_name: "gpt-5.6-terra", reasoning: { effort: "high" } } };
  assert.deepEqual(readDriver(policy).pricing, RATES);
});

test("readDriver leaves the price to the dated list: a driver block with no pricing block is not an error", () => {
  const policy = { name: "p", driver: { model_name: "gpt-9", reasoning: { effort: "high" } }, models: [] };
  assert.deepEqual(readDriver(policy), { pin: { model: "gpt-9", effort: "high" }, pricing: null, from: "driver" });
});

test("a policy with no driver block falls back to its gpt entry, with a warning", () => {
  const warnings = [];
  const driver = readDriver(LEGACY, { warn: (m) => warnings.push(m) });
  assert.deepEqual(driver, { pin: { model: "gpt-5.6-terra", effort: "high" }, pricing: RATES, from: "models.gpt" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /has no driver: block/);
});

test("a policy with neither a driver block nor a gpt entry throws and shows the block to add", () => {
  assert.throws(
    () => readPin({ name: "flash-only", models: [{ id: "x", model_name: "y" }] }, silent),
    /has no driver: block.*\ndriver:\n  model_name: gpt-5\.6-terra/s,
  );
});

test("readPin throws when the gpt entry is missing reasoning.effort", () => {
  assert.throws(
    () => readPin({ name: "broken", models: [{ id: "gpt", model_name: "gpt-5.6-terra" }] }, silent),
    /missing model_name or reasoning\.effort/,
  );
});

test("readPin throws when the driver block is missing reasoning.effort", () => {
  assert.throws(
    () => readPin({ name: "broken", driver: { model_name: "gpt-5.6-terra" }, models: [] }),
    /driver block is missing model_name or reasoning\.effort/,
  );
});

test("argvPin reads -m and the effort override out of a codex argv, ignoring the prompt", () => {
  const argv = [
    "exec", "--json", "-m", "gpt-5.6-terra",
    "-c", 'model_reasoning_effort="high"',
    "-c", 'sandbox_mode="workspace-write"',
    "--", "-m gpt-6 -c model_reasoning_effort=\"low\"",
  ];
  assert.deepEqual(argvPin(argv), { model: "gpt-5.6-terra", effort: "high" });
  assert.deepEqual(argvPin(["exec", "--", "hi"]), { model: null, effort: null });
});

test("assertPinnedInvocation on an argv that drifted from the policy throws", () => {
  const argv = ["exec", "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="medium"', "--", "p"];
  assert.throws(() => assertPinnedInvocation(argvPin(argv), POLICY), /reasoning effort 'medium'/);
});

test("assertPinnedInvocation passes when model and effort match the pin", () => {
  assert.doesNotThrow(() => assertPinnedInvocation({ model: "gpt-5.6-terra", effort: "high" }, POLICY));
});

test("assertPinnedInvocation throws on a drifted model", () => {
  assert.throws(
    () => assertPinnedInvocation({ model: "gpt-6", effort: "high" }, POLICY),
    /about to invoke model 'gpt-6'.*pinned model is 'gpt-5\.6-terra'/s,
  );
});

test("assertPinnedInvocation throws on a drifted effort", () => {
  assert.throws(
    () => assertPinnedInvocation({ model: "gpt-5.6-terra", effort: "medium" }, POLICY),
    /about to invoke reasoning effort 'medium'.*pinned effort is 'high'/s,
  );
});

// ── real captured rejection shapes ──────────────────────────────────────

const REAL_INVALID_EFFORT_STREAM = [
  '{"type":"thread.started","thread_id":"01a0571f-19c0-7920-87ff-d99a568ccd36"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\n  \\"type\\": \\"error\\",\\n  \\"error\\": {\\n    \\"type\\": \\"invalid_request_error\\",\\n    \\"code\\": null,\\n    \\"message\\": \\"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: \'not-a-real-level\'. Supported values are: \'none\', \'minimal\', \'low\', \'medium\', \'high\', \'xhigh\', and \'max\'.\\",\\n    \\"param\\": null\\n  },\\n  \\"status\\": 400\\n}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value.\\"}}"}}',
].join("\n");

const REAL_INVALID_MODEL_STREAM = [
  '{"type":"thread.started","thread_id":"01a0571f-61a4-7402-ac13-62236a1accdc"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `not-a-real-model-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'not-a-real-model-xyz\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'not-a-real-model-xyz\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
].join("\n");

test("findPinRejection catches a real invalid-reasoning-effort rejection via the top-level 'error' event", () => {
  const events = parseEventStream(REAL_INVALID_EFFORT_STREAM);
  const rejection = findPinRejection(events);
  assert.ok(rejection, "must find the rejection");
  assert.match(rejection, /reasoning\.effort/);
});

test("findPinRejection catches a real invalid-model rejection; the fallback-metadata item beside it is a warning", () => {
  const events = parseEventStream(REAL_INVALID_MODEL_STREAM);
  const rejection = findPinRejection(events);
  assert.ok(rejection, "must find the rejection");
  assert.match(rejection, /not supported when using Codex/);
  assert.ok(findCodexWarnings(events).some((w) => /Defaulting to fallback metadata/.test(w)));
});

test("findPinRejection also sees the turn.failed shape specifically (nested under .error.message)", () => {
  // Isolate just the turn.failed event to prove this shape alone is caught,
  // not just the earlier item.completed in the same stream.
  const onlyTurnFailed = [
    '{"type":"turn.failed","error":{"message":"[ReasoningEffortParam] invalid_enum_value: bad"}}',
  ].join("\n");
  const rejection = findPinRejection(parseEventStream(onlyTurnFailed));
  assert.ok(rejection, "turn.failed's nested .error.message must be reachable");
  assert.match(rejection, /invalid_enum_value/);
});

test("findPinRejection returns null on a clean, successful stream", () => {
  const clean = [
    '{"type":"thread.started","thread_id":"x"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2}}',
  ].join("\n");
  assert.equal(findPinRejection(parseEventStream(clean)), null);
});

// ── codex 0.160.1 warnings are not rejections ───────────────────────────

const FALLBACK_THEN_COMPLETED = [
  '{"type":"thread.started","thread_id":"01a1340d-41da-7e31-84cd-b0907e9bc31f"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `mock-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"reply 1"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":200,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10}}',
].join("\n");

test("the 0.160.1 fallback-metadata item followed by turn.completed is a warning, not a rejection", () => {
  const events = parseEventStream(FALLBACK_THEN_COMPLETED);
  assert.equal(findPinRejection(events), null);
  const warnings = findCodexWarnings(events);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Defaulting to fallback metadata/);
});

test("a 'Reconnecting...' top-level error followed by turn.completed is not a rejection", () => {
  const drop = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)"}',
    '{"type":"turn.completed","usage":{"input_tokens":3000,"cached_input_tokens":900,"output_tokens":70}}',
  ].join("\n");
  const events = parseEventStream(drop);
  assert.equal(findPinRejection(events), null);
  assert.match(findCodexWarnings(events)[0], /^Reconnecting/);
});

test("a completed turn outranks an earlier rejection-shaped error in the same invocation", () => {
  const text = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"model foo not found, retrying"}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}',
  ].join("\n");
  assert.equal(findPinRejection(parseEventStream(text)), null);
});

test("an invalid-model turn.failed with no completed turn is still a rejection, invocation by invocation", () => {
  const twoInvocations = FALLBACK_THEN_COMPLETED + "\n" + REAL_INVALID_EFFORT_STREAM;
  const rejection = findPinRejection(parseEventStream(twoInvocations));
  assert.match(rejection, /reasoning\.effort/, "a clean first invocation does not excuse a rejected second one");
});

test("warnings are deduplicated across invocations", () => {
  const text = FALLBACK_THEN_COMPLETED + "\n" + FALLBACK_THEN_COMPLETED;
  assert.equal(findCodexWarnings(parseEventStream(text)).length, 1);
});
