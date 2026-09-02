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

import { readPin, assertPinnedInvocation, findPinRejection } from "../../../codex/telemetry/fairnessPin.mjs";
import { parseEventStream } from "../../../codex/telemetry/event-reader.mjs";

const POLICY = {
  name: "gpt-plus-flash",
  models: [
    { id: "gpt", adapter: "openai", model_name: "gpt-5.6-terra", reasoning: { effort: "high" } },
    { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash" },
  ],
};

test("readPin reads model and effort from the policy's gpt entry", () => {
  const pin = readPin(POLICY);
  assert.deepEqual(pin, { model: "gpt-5.6-terra", effort: "high" });
});

test("readPin throws when the policy has no gpt model entry", () => {
  assert.throws(
    () => readPin({ name: "flash-only", models: [{ id: "x", model_name: "y" }] }),
    /no model with id 'gpt'/,
  );
});

test("readPin throws when the gpt entry is missing reasoning.effort", () => {
  assert.throws(
    () => readPin({ name: "broken", models: [{ id: "gpt", model_name: "gpt-5.6-terra" }] }),
    /missing model_name or reasoning\.effort/,
  );
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

test("findPinRejection catches a real invalid-model rejection via the item.completed error item", () => {
  const events = parseEventStream(REAL_INVALID_MODEL_STREAM);
  const rejection = findPinRejection(events);
  assert.ok(rejection, "must find the rejection");
  assert.match(rejection, /Model metadata for/);
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
