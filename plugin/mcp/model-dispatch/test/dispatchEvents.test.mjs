/**
 * One telemetry event per attempt, each stamped with its own attempt's
 * provenance. Runs against dist/dispatchEvents.js, the builder server.ts
 * calls.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { attemptEvent, attemptEvents, attemptProvenance } from "../dist/dispatchEvents.js";

const PACKET = {
  id: "tp_events_1",
  phase: "codegen",
  task_type: "implement",
  module: "core",
  instruction: "x",
  inputs: [],
  outputSchema: {},
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 512 },
  pass_id: "events-pass",
  retry_count: 0,
};

const ID = {
  packet: PACKET,
  decision: { modelId: "flash-completion", reason: "codegen is mechanical", ruleIndex: 2 },
  policy: { name: "gpt-plus-flash", version: 1 },
  modelName: "gemini-3.7-flash",
};

const measured = (n) => ({
  attempt_number: n,
  ceiling_used: 512 * n,
  stop_reason: "MAX_TOKENS",
  hit_output_cap: true,
  tokens: { input: 4000, input_cached: 0, output: 512 },
  cost_usd: 0.00492,
  latency_ms: 900,
  success: false,
  price_basis: "list",
  price_tier: "standard",
  price_verified: "2026-10-13",
});

const result = (attempts, extra = {}) => ({
  result: null,
  tokens: { input: 0, input_cached: 0, output: 0 },
  cost_usd: attempts.reduce((s, a) => s + a.cost_usd, 0),
  latency_ms: 0,
  cache_hit: false,
  success: false,
  attempts,
  terminal_reason: "vendor_error",
  ...extra,
});

test("a measured attempt stays vendor when a later attempt of the same packet is estimated", () => {
  const estimated = { ...measured(2), cost_provenance: "estimated", error: "ECONNRESET", error_code: "ECONNRESET" };
  const events = attemptEvents(ID, result([measured(1), estimated], { cost_provenance: "estimated" }), "2026-10-13T00:00:00.000Z");
  assert.deepEqual(events.map((e) => e.provenance), ["vendor", "estimated"]);
  assert.equal(events[1].error_code, "ECONNRESET");
  assert.equal(events[0].error_code, undefined);
});

test("an unlabelled attempt takes the adapter's own source", () => {
  const [ev] = attemptEvents({ ...ID, adapterProvenance: "modeled" }, result([measured(1)]), "t");
  assert.equal(ev.provenance, "modeled");
});

test("a result-level label still covers every attempt when no attempt carries one", () => {
  const events = attemptEvents(ID, result([measured(1), measured(2)], { cost_provenance: "estimated" }), "t");
  assert.deepEqual(events.map((e) => e.provenance), ["estimated", "estimated"]);
});

test("a result with no attempts becomes one event carrying the result's figures and label", () => {
  const r = {
    result: {},
    tokens: { input: 10, input_cached: 0, output: 5 },
    cost_usd: 0.1,
    latency_ms: 50,
    cache_hit: false,
    success: true,
    cost_provenance: "estimated",
  };
  const events = attemptEvents(ID, r, "t");
  assert.equal(events.length, 1);
  assert.equal(events[0].provenance, "estimated");
  assert.equal(events[0].ceiling_used, 512);
  assert.equal(events[0].input_tokens, 10);
  assert.equal(events[0].attempt_number, 1);
});

test("an event keeps the field order and contents the server always wrote", () => {
  const ev = attemptEvent(ID, measured(2), { ts: "2026-10-13T00:00:00.000Z" });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(ev))), [
    "ts", "pass", "phase", "task_type", "task_id", "module", "model", "provenance", "routed_by",
    "model_id", "routing", "retry_count", "input_tokens", "input_tokens_cached", "output_tokens",
    "cost_usd", "latency_ms", "success", "attempt_number", "ceiling_used", "retry_reason",
    "price_basis", "price_tier", "price_verified",
  ]);
  assert.deepEqual(ev.routing, {
    policy_name: "gpt-plus-flash",
    policy_version: 1,
    rule_index: 2,
    rule_reason: "codegen is mechanical",
    select: undefined,
  });
  assert.equal(ev.retry_reason, "output_cap");
  assert.equal(ev.task_id, "tp_events_1");
  assert.equal(ev.model_id, "flash-completion");
});

test("the failure detail on an attempt reaches its event", () => {
  const att = {
    ...measured(1),
    success: false,
    error: "abandoned",
    usage_complete: false,
    error_status: 429,
    error_code: "ECONNRESET",
    codex_thread_id: "0199-thread",
    cost_provenance: "estimated",
  };
  const ev = attemptEvent(ID, att, { ts: "t" });
  assert.equal(ev.usage_complete, false);
  assert.equal(ev.error_status, 429);
  assert.equal(ev.error_code, "ECONNRESET");
  assert.equal(ev.codex_thread_id, "0199-thread");
  assert.equal(ev.provenance, "estimated");
});

test("an estimated row from a seat adapter says so, so a report can keep it out of metered spend", () => {
  const failed = { ...measured(1), cost_provenance: "estimated", usage_complete: false, error: "codex-cli timeout after 840s" };
  const seat = attemptEvent({ ...ID, adapterProvenance: "modeled" }, failed, { ts: "t" });
  assert.equal(seat.provenance, "estimated");
  assert.equal(seat.adapter_provenance, "modeled");
  const metered = attemptEvent(ID, failed, { ts: "t" });
  assert.equal(metered.adapter_provenance, undefined);
  const vendorAdapter = attemptEvent({ ...ID, adapterProvenance: "vendor" }, failed, { ts: "t" });
  assert.equal("adapter_provenance" in JSON.parse(JSON.stringify(vendorAdapter)), false, "vendor is the default and is not written");
});

test("attemptProvenance falls back to vendor when nothing labels the attempt", () => {
  assert.equal(attemptProvenance(measured(1), {}), "vendor");
  assert.equal(attemptProvenance({ ...measured(1), cost_provenance: "modeled" }, { adapterProvenance: "vendor" }), "modeled");
});
