/**
 * `dispatch.mjs --log-phase` — the CLI path that lets the conductor record a
 * phase that made no model call.
 *
 * It exists because of a real run: a refactor whose extraction was already
 * complete wrote review.json and security_review.md, dispatched neither, and
 * left a three-event telemetry.jsonl that looked truncated. The pipeline skill
 * said "skipped phases still emit a TelemetryEvent" while the telemetry
 * contract said "you never hand-write a telemetry event" — and there was no
 * CLI surface for log_telemetry either way, so nothing could satisfy the first
 * instruction. The Claude harness has always logged these (provenance
 * "estimated", via the chars/3.8 estimator); this port dropped the estimator,
 * correctly, but left nothing in its place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildLogEventArgs, summarize } from "../../../codex/dispatch.mjs";

test("a skipped phase produces an all-zero event the bridge will accept", () => {
  const args = buildLogEventArgs({
    phase: "architecture_design", taskType: "skipped",
    policyName: "gpt-plus-flash", telemetryPath: "/out/telemetry.jsonl",
  });
  // snake_case: the bridge's inputSchema declares telemetry_path, and a
  // camelCase key reaches the handler as undefined and fails inside
  // appendEvent rather than at validation.
  assert.equal(args.telemetry_path, "/out/telemetry.jsonl");
  assert.equal(args.event.cost_usd, 0);
  assert.equal(args.event.input_tokens, 0);
  assert.equal(args.event.output_tokens, 0);
  assert.equal(args.event.provenance, "none", "zeros here are facts, not estimates");
  assert.equal(args.event.phase, "architecture_design");
  assert.equal(args.event.task_type, "skipped");
});

test("the event carries no ts or latency — the server stamps those", () => {
  // Same reason log_telemetry normalizes: a model has no clock, and an
  // invented ts corrupts run duration, which buildManifest derives by sorting.
  const { event } = buildLogEventArgs({ phase: "tests", telemetryPath: "/t.jsonl" });
  assert.equal("ts" in event, false);
  assert.equal("latency_ms" in event, false);
});

test("an in-session phase says where its cost actually went", () => {
  const { event } = buildLogEventArgs({ phase: "senior_code_review", taskType: "in_session", telemetryPath: "/t.jsonl" });
  assert.match(event.routing.rule_reason, /driver loop/, "a zero-cost row must not read as free work");
});

test("a caller-supplied reason wins over the default", () => {
  const { event } = buildLogEventArgs({
    phase: "senior_code_review", taskType: "in_session",
    reason: "no changed modules to review", telemetryPath: "/t.jsonl",
  });
  assert.equal(event.routing.rule_reason, "no changed modules to review");
});

test("a missing telemetry path is refused — an unwritten event is not a record", () => {
  assert.throws(() => buildLogEventArgs({ phase: "tests" }), /--telemetry/);
});

test("phase is required", () => {
  assert.throws(() => buildLogEventArgs({ telemetryPath: "/t.jsonl" }), /--log-phase/);
});

test("an unknown task type is refused rather than silently recorded", () => {
  assert.throws(
    () => buildLogEventArgs({ phase: "tests", taskType: "guessed", telemetryPath: "/t.jsonl" }),
    /must be 'skipped' or 'in_session'/,
  );
});

test("summarize reads the request, since log_telemetry replies with bare 'ok'", () => {
  const line = summarize("log_telemetry", "ok", { "log-phase": "tests", "task-type": "skipped" });
  assert.match(line, /phase=tests/);
  assert.match(line, /cost_usd=0/);
});
