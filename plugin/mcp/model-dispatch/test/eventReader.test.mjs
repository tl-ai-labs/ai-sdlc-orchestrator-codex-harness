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

test("modeledDriverCostEvents prices a turn at the pinned gpt-5.6-terra rates", () => {
  const events = parseEventStream(REAL_JSONL);
  const modeled = modeledDriverCostEvents(events, {
    pass: "test-pass",
    model: "gpt-5.6-terra",
    pricing: GPT_PRICING,
    now: () => "2026-08-31T00:00:00.000Z",
  });
  assert.equal(modeled.length, 1);
  const ev = modeled[0];
  assert.equal(ev.provenance, "modeled");
  assert.equal(ev.model, "gpt-5.6-terra");
  assert.equal(ev.phase, "driver_loop");
  assert.equal(ev.input_tokens, 94878 - 84480, "input is the FRESH count, cached excluded");
  assert.equal(ev.input_tokens_cached, 84480);
  assert.equal(ev.output_tokens, 731);
  assert.equal(ev.output_tokens_reasoning, 398);
  assert.equal(ev.latency_ms, null, "no stopwatch ran on a modeled event, same convention as the direct tier");
  const expectedCost =
    // fresh = 94878 total - 84480 cached. Codex reports input_tokens
    // inclusive of the cached subset; pricing treats them as disjoint.
    ((94878 - 84480) / 1_000_000) * 2.0 + (84480 / 1_000_000) * 0.2 + (731 / 1_000_000) * 12.0;
  assert.ok(Math.abs(ev.cost_usd - expectedCost) < 1e-9, `cost_usd=${ev.cost_usd} expected~${expectedCost}`);
});

test("modeledDriverCostEvents produces zero events when the stream never completed a turn", () => {
  const events = parseEventStream('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.started"}');
  const modeled = modeledDriverCostEvents(events, { pass: "p", model: "gpt-5.6-terra", pricing: GPT_PRICING });
  assert.deepEqual(modeled, []);
});

test("modeledDriverCostEvents' task_id is unique per turn, so events don't collide in the manifest", () => {
  const twoTurns = [
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":20}}',
  ].join("\n");
  const modeled = modeledDriverCostEvents(parseEventStream(twoTurns), {
    pass: "p", model: "gpt-5.6-terra", pricing: GPT_PRICING,
  });
  assert.equal(modeled.length, 2);
  assert.notEqual(modeled[0].task_id, modeled[1].task_id);
});
