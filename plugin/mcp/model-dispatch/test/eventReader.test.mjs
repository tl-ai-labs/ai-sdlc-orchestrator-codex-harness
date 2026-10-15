/**
 * Unit tests for plugin/codex/telemetry/event-reader.mjs, run from here so
 * it can reuse the bridge's own computeCostUsd via a relative import
 * (plugin/codex/ has no node_modules of its own).
 *
 * Fixture JSONL below is taken verbatim from real `codex exec --json`
 * output captured during this port's own live verification runs
 * (docs/verification/p1-codex-runtime.md), not invented — the shell wrap
 * is `/bin/bash -lc '…'` because that's what this machine (Linux/WSL2)
 * actually produces, not the `/bin/zsh -lc '…'` the port track document
 * inherited from a macOS probe machine.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  unwrapShellCommand,
  parseEventStream,
  extractTurnUsage,
  modeledDriverCostEvents,
  modeledDriverCostRows,
  readDriverRecord,
  codexEvents,
} from "../../../codex/telemetry/event-reader.mjs";

const REAL_JSONL = [
  '{"type":"thread.started","thread_id":"01a0560d-55c0-7141-b85d-9509e3dd5226"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'rg -n \\"load_policy\\" .\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'rg -n \\"load_policy\\" .\'","aggregated_output":"./plugin/config/policies/gpt-plus-flash.yaml:13:name: gpt-plus-flash\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"name: gpt-plus-flash"}}',
  '{"type":"turn.completed","usage":{"input_tokens":94878,"cached_input_tokens":84480,"cache_write_input_tokens":0,"output_tokens":731,"reasoning_output_tokens":398}}',
].join("\n");

test("unwrapShellCommand strips the bash wrapper this platform actually uses", () => {
  const wrapped = "/bin/bash -lc 'printf hello > probe.txt'";
  assert.equal(unwrapShellCommand(wrapped), "printf hello > probe.txt");
});

test("unwrapShellCommand also strips the zsh wrapper (the macOS-probe-machine finding)", () => {
  const wrapped = "/bin/zsh -lc 'cat file.txt'";
  assert.equal(unwrapShellCommand(wrapped), "cat file.txt");
});

test("unwrapShellCommand leaves an already-bare command unchanged", () => {
  assert.equal(unwrapShellCommand("cat file.txt"), "cat file.txt");
});

test("unwrapShellCommand is a no-op on non-string input", () => {
  assert.equal(unwrapShellCommand(undefined), undefined);
});

test("parseEventStream stamps its own timestamp on every event — codex supplies none", () => {
  const events = parseEventStream(REAL_JSONL, () => "2026-08-31T00:00:00.000Z");
  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.ts, "2026-08-31T00:00:00.000Z");
  }
});

test("parseEventStream unwraps command_execution items without losing the original", () => {
  const events = parseEventStream(REAL_JSONL);
  const commandEvents = events.filter((e) => e.item?.type === "command_execution");
  assert.equal(commandEvents.length, 2, "both item.started and item.completed for the command");
  for (const ev of commandEvents) {
    assert.match(ev.item.command, /^\/bin\/bash -lc/, "original wrapped command is preserved");
    assert.equal(ev.item.unwrapped_command, 'rg -n "load_policy" .');
  }
});

test("parseEventStream skips a malformed line instead of throwing", () => {
  const withGarbage = REAL_JSONL + "\nnot valid json at all\n";
  const events = parseEventStream(withGarbage);
  // Same count as the clean stream — the garbage line contributed nothing.
  assert.equal(events.length, parseEventStream(REAL_JSONL).length);
});

test("parseEventStream handles blank lines between JSONL records", () => {
  const withBlanks = REAL_JSONL.split("\n").join("\n\n");
  const events = parseEventStream(withBlanks);
  assert.equal(events.length, parseEventStream(REAL_JSONL).length);
});

test("extractTurnUsage reads the one turn.completed usage block, keyed by turn index", () => {
  const events = parseEventStream(REAL_JSONL);
  const usages = extractTurnUsage(events);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].turn_index, 1);
  assert.equal(usages[0].usage.input_tokens, 94878);
  assert.equal(usages[0].usage.cached_input_tokens, 84480);
  assert.equal(usages[0].usage.output_tokens, 731);
});

test("extractTurnUsage counts turns correctly across a multi-turn stream", () => {
  const twoTurns = [
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0}}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5}}',
  ].join("\n");
  const usages = extractTurnUsage(parseEventStream(twoTurns));
  assert.equal(usages.length, 2);
  assert.equal(usages[0].turn_index, 1);
  assert.equal(usages[1].turn_index, 2);
  assert.equal(usages[1].usage.input_tokens, 200);
});

// ── modeled driver cost — the D4/D9 pin, from docs/verification/p1-codex-runtime.md ──
const GPT_PRICING = { input: 2.0, input_cached: 0.2, output: 12.0 };
const OPTS = { pass: "test-pass", model: "gpt-5.6-terra", pricing: GPT_PRICING, policyName: "gpt-seat-plus-flash", policyVersion: 3 };

test("modeledDriverCostEvents prices a turn at the pinned gpt-5.6-terra rates", () => {
  const events = parseEventStream(REAL_JSONL, () => "2026-08-31T00:00:00.000Z");
  const modeled = modeledDriverCostEvents(events, OPTS);
  assert.equal(modeled.length, 1);
  const ev = modeled[0];
  assert.equal(ev.provenance, "modeled");
  assert.equal(ev.model, "gpt-5.6-terra");
  assert.equal(ev.phase, "driver_loop");
  assert.equal(ev.status, "complete");
  assert.equal(ev.usage_source, "exec-stream");
  assert.equal(ev.ts, "2026-08-31T00:00:00.000Z");
  assert.equal(ev.input_tokens, 94878 - 84480, "input is the FRESH count, cached excluded");
  assert.equal(ev.input_tokens_cached, 84480);
  assert.equal(ev.output_tokens, 731);
  assert.equal(ev.output_tokens_reasoning, 398);
  assert.equal(ev.latency_ms, null, "no stopwatch ran on a modeled event, same convention as the direct tier");
  const expectedCost =
    ((94878 - 84480) / 1_000_000) * 2.0 + (84480 / 1_000_000) * 0.2 + (731 / 1_000_000) * 12.0;
  assert.ok(Math.abs(ev.cost_usd - expectedCost) < 1e-9, `cost_usd=${ev.cost_usd} expected~${expectedCost}`);
});

test("modeled rows name the policy and version they are given, not a hard-coded one", () => {
  const [row] = modeledDriverCostEvents(parseEventStream(REAL_JSONL), OPTS);
  assert.equal(row.routing.policy_name, "gpt-seat-plus-flash");
  assert.equal(row.routing.policy_version, 3);
});

test("modeled rows refuse to guess the policy name", () => {
  assert.throws(
    () => modeledDriverCostEvents(parseEventStream(REAL_JSONL), { ...OPTS, policyName: undefined }),
    /policyName is required/,
  );
});

test("a turn that never completed is one incomplete row, cost unknown rather than $0", () => {
  const events = parseEventStream('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.started"}');
  const modeled = modeledDriverCostEvents(events, OPTS);
  assert.equal(modeled.length, 1);
  assert.equal(modeled[0].status, "incomplete");
  assert.equal(modeled[0].incomplete_reason, "no invocation_end");
  assert.equal(modeled[0].cost_usd, null);
  assert.equal(modeled[0].input_tokens, null);
  assert.equal(modeled[0].success, false);
  assert.equal(modeled[0].provenance, "modeled");
});

test("turn.started then turn.failed gives an incomplete row naming the failure", () => {
  const text = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"stream disconnected"}}',
  ].join("\n");
  const [row] = modeledDriverCostEvents(parseEventStream(text), OPTS);
  assert.equal(row.status, "incomplete");
  assert.equal(row.incomplete_reason, "turn.failed: stream disconnected");
  assert.equal(row.cost_usd, null);
});

test("task ids are unique across invocations and each row carries its invocation and thread", () => {
  const records = [
    { v: 1, kind: "invocation_start", run_id: "r", invocation: 1, at: "2026-10-13T00:00:00.000Z", mode: "fresh" },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:01.000Z", event: { type: "thread.started", thread_id: "t1" } },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:02.000Z", event: { type: "turn.started" } },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:03.000Z", event: { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } },
    { v: 1, kind: "invocation_end", invocation: 1, at: "2026-10-13T00:00:04.000Z", thread_id: "t1", exit_status: 0, ended_by: "exit" },
    { v: 1, kind: "invocation_start", run_id: "r", invocation: 2, at: "2026-10-13T00:01:00.000Z", mode: "resume", resume_thread_id: "t1" },
    { v: 1, kind: "codex", invocation: 2, thread_id: "t1", received_at: "2026-10-13T00:01:01.000Z", event: { type: "thread.started", thread_id: "t1" } },
    { v: 1, kind: "codex", invocation: 2, thread_id: "t1", received_at: "2026-10-13T00:01:02.000Z", event: { type: "turn.started" } },
    { v: 1, kind: "codex", invocation: 2, thread_id: "t1", received_at: "2026-10-13T00:01:03.000Z", event: { type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 30 } } },
    { v: 1, kind: "invocation_end", invocation: 2, at: "2026-10-13T00:01:04.000Z", thread_id: "t1", exit_status: 0, ended_by: "exit" },
  ];
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  const rows = modeledDriverCostRows(readDriverRecord(text), { runId: "r", model: "gpt-5.6-terra", pricing: GPT_PRICING, policyName: "p" });
  assert.deepEqual(rows.map((r) => r.task_id), ["driver-i1-t1", "driver-i2-t1"]);
  assert.deepEqual(rows.map((r) => r.invocation), [1, 2]);
  assert.deepEqual(rows.map((r) => r.thread_id), ["t1", "t1"]);
  assert.deepEqual(rows.map((r) => r.input_tokens), [100, 200], "the second row is the difference of the running totals");
  assert.equal(rows[1].ts, "2026-10-13T00:01:03.000Z", "a row's time is when its turn.completed arrived");
});

test("readDriverRecord unwraps v1 codex lines with ts = received_at and still reads a legacy file", () => {
  const v1 = JSON.stringify({ v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T01:02:03.000Z", event: { type: "turn.started" } });
  const [ev] = codexEvents(readDriverRecord(v1));
  assert.equal(ev.type, "turn.started");
  assert.equal(ev.ts, "2026-10-13T01:02:03.000Z");
  assert.equal(ev.invocation, 1);

  const legacy = readDriverRecord(REAL_JSONL);
  const events = codexEvents(legacy);
  assert.equal(events.length, REAL_JSONL.split("\n").length);
  assert.ok(events.every((e) => e.invocation === 1), "a legacy stream with one thread.started is one invocation");
});
