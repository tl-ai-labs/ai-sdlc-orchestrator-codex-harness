/**
 * Driver usage semantics, pinned on real codex 0.160.1 captures
 * (tools/test/fixtures/codex-0.160.1): one `codex exec` and two
 * `codex exec resume` calls against a localhost Responses mock that served
 * 1000/200/50, 3000/900/70 and 5000/2000/90 input/cached/output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  driverTurns,
  parseDriverRecords,
  priceUsage,
  summarizeDriverTurns,
  normalizeUsage,
} from "../../plugin/mcp/model-dispatch/dist/driverUsage.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-0.160.1");
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.jsonl`), "utf-8");
const PRICING = { input: 2.0, input_cached: 0.2, output: 12.0 };
const THREAD = "01a1340d-41da-7e31-84cd-b0907e9bc31f";

/** Wraps bare codex lines as one v1 invocation, the way run.mjs records them. */
function invocation(n, text, { mode = n === 1 ? "fresh" : "resume", resumeThread = n === 1 ? null : THREAD, end = { exit_status: 0, ended_by: "exit" } } = {}) {
  const lines = [{ v: 1, kind: "invocation_start", run_id: "r", invocation: n, at: `2026-10-13T00:0${n}:00.000Z`, mode, resume_thread_id: resumeThread }];
  let thread = resumeThread;
  for (const raw of text.split("\n").filter((l) => l.trim())) {
    const event = JSON.parse(raw);
    if (event.type === "thread.started") thread = event.thread_id;
    lines.push({ v: 1, kind: "codex", invocation: n, thread_id: thread, received_at: `2026-10-13T00:0${n}:01.000Z`, event });
  }
  if (end) lines.push({ v: 1, kind: "invocation_end", invocation: n, at: `2026-10-13T00:0${n}:59.000Z`, thread_id: thread, signal: null, ...end });
  return lines;
}

const toText = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const RESUMED_RUN = toText([...invocation(1, fixture("exec1")), ...invocation(2, fixture("exec2")), ...invocation(3, fixture("exec3"))]);

test("turn.completed after exec resume is the thread's running total (codex 0.160.1)", () => {
  const usage = ["exec1", "exec2", "exec3"].map((f) => {
    const line = fixture(f).split("\n").find((l) => l.includes('"turn.completed"'));
    return JSON.parse(line).usage;
  });
  assert.deepEqual(usage.map((u) => u.input_tokens), [1000, 1000 + 3000, 1000 + 3000 + 5000]);
  assert.deepEqual(usage.map((u) => u.cached_input_tokens), [200, 200 + 900, 200 + 900 + 2000]);
  assert.deepEqual(usage.map((u) => u.output_tokens), [50, 50 + 70, 50 + 70 + 90]);
});

test("exec plus two resumes prices to the last running total, not the sum of totals", () => {
  const turns = driverTurns(parseDriverRecords(RESUMED_RUN));
  assert.deepEqual(turns.map((t) => t.delta.input_tokens), [1000, 3000, 5000]);
  assert.deepEqual(turns.map((t) => t.delta.cached_input_tokens), [200, 900, 2000]);
  assert.deepEqual(turns.map((t) => t.delta.output_tokens), [50, 70, 90]);
  const last = turns[turns.length - 1].cumulative;
  const summary = summarizeDriverTurns(turns, PRICING);
  assert.equal(summary.cost_usd, priceUsage(last, PRICING).cost_usd);
  assert.equal(summary.cost_usd, 0.01494, "9000 in (3100 cached, 5900 fresh), 210 out at 2.00/0.20/12.00");
  assert.equal(summary.turns_incomplete, 0);
  assert.deepEqual(summary.thread_ids, [THREAD]);
});

test("a legacy concatenated stream (no v1 markers) prices the same", () => {
  const legacy = fixture("exec1") + fixture("exec2") + fixture("exec3");
  const summary = summarizeDriverTurns(driverTurns(parseDriverRecords(legacy)), PRICING);
  assert.equal(summary.cost_usd, 0.01494);
});

test("a later driver process resuming a thread recorded earlier in the folder subtracts the earlier total", () => {
  const earlier = toText(invocation(1, fixture("exec1")));
  const later = toText(invocation(2, fixture("exec2")));
  const turns = driverTurns(parseDriverRecords(earlier + later));
  assert.deepEqual(turns.map((t) => t.delta.input_tokens), [1000, 3000]);
  assert.deepEqual(turns.flatMap((t) => t.flags), []);
});

test("a resume of a thread this folder has no record of is flagged baseline_unknown and priced at its full total", () => {
  const turns = driverTurns(parseDriverRecords(toText(invocation(1, fixture("exec2"), { mode: "resume", resumeThread: THREAD }))));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].delta.input_tokens, 4000, "an upper bound: the earlier turns are inside it");
  assert.deepEqual(turns[0].flags, ["baseline_unknown"]);
});

test("a known baseline for a foreign thread prices only what this run added", () => {
  const records = parseDriverRecords(toText(invocation(1, fixture("exec2"), { mode: "resume", resumeThread: THREAD })));
  const turns = driverTurns(records, { baselines: { [THREAD]: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 } } });
  assert.equal(turns[0].delta.input_tokens, 3000);
  assert.deepEqual(turns[0].flags, []);
});

test("a failed invocation between two completed ones: its tokens are priced once, inside the next delta", () => {
  const failed = [
    `{"type":"thread.started","thread_id":"${THREAD}"}`,
    '{"type":"turn.started"}',
    '{"type":"turn.failed","error":{"message":"stream disconnected"}}',
  ].join("\n");
  const text = toText([
    ...invocation(1, fixture("exec1")),
    ...invocation(2, failed, { end: { exit_status: 1, ended_by: "exit" } }),
    ...invocation(3, fixture("exec3")),
  ]);
  const turns = driverTurns(parseDriverRecords(text));
  assert.deepEqual(turns.map((t) => t.status), ["complete", "incomplete", "complete"]);
  assert.equal(turns[1].incomplete_reason, "turn.failed: stream disconnected");
  assert.equal(turns[2].delta.input_tokens, 8000, "the failed turn's 3000 arrive inside the next running total");
  assert.equal(summarizeDriverTurns(turns, PRICING).cost_usd, 0.01494);
});

test("an all-zero turn.completed leaves the running total alone, so the next invocation is not double-counted", () => {
  const zero = [
    `{"type":"thread.started","thread_id":"${THREAD}"}`,
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}',
  ].join("\n");
  const turns = driverTurns(parseDriverRecords(toText([...invocation(1, fixture("exec1")), ...invocation(2, zero), ...invocation(3, fixture("exec2"))])));
  assert.deepEqual(turns[1].flags, ["zero_usage"]);
  assert.equal(turns[2].delta.input_tokens, 3000);
});

test("a running total that drops is priced as a fresh segment and flagged", () => {
  const lower = [
    `{"type":"thread.started","thread_id":"${THREAD}"}`,
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":5}}',
  ].join("\n");
  const turns = driverTurns(parseDriverRecords(toText([...invocation(1, fixture("exec2"), { mode: "fresh", resumeThread: null }), ...invocation(2, lower)])));
  assert.deepEqual(turns[1].flags, ["cumulative_reset"]);
  assert.equal(turns[1].delta.input_tokens, 500);
});

test("two threads in one record are priced independently", () => {
  const text = toText([...invocation(1, fixture("exec1")), ...invocation(2, fixture("drop"), { mode: "fresh", resumeThread: null })]);
  const summary = summarizeDriverTurns(driverTurns(parseDriverRecords(text)), PRICING);
  assert.equal(summary.thread_ids.length, 2);
  assert.equal(summary.cost_usd, priceUsage(normalizeUsage({ input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 }), PRICING).cost_usd + priceUsage(normalizeUsage({ input_tokens: 3000, cached_input_tokens: 900, output_tokens: 70 }), PRICING).cost_usd);
});

test("a reconnect inside a turn does not stop it pricing (drop.jsonl)", () => {
  const turns = driverTurns(parseDriverRecords(toText(invocation(1, fixture("drop")))));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "complete");
  assert.equal(turns[0].delta.input_tokens, 3000);
});

test("an open turn is closed by how its invocation ended", () => {
  const open = `{"type":"thread.started","thread_id":"${THREAD}"}\n{"type":"turn.started"}`;
  const signalled = driverTurns(parseDriverRecords(toText(invocation(1, open, { end: { exit_status: null, signal: "SIGTERM", ended_by: "driver_signal" } }))));
  assert.equal(signalled[0].incomplete_reason, "driver signal SIGTERM mid-turn");
  const exited = driverTurns(parseDriverRecords(toText(invocation(1, open, { end: { exit_status: 1, ended_by: "exit" } }))));
  assert.equal(exited[0].incomplete_reason, "codex exited 1 before turn.completed");
  const killed = driverTurns(parseDriverRecords(toText(invocation(1, open, { end: null }))));
  assert.equal(killed[0].incomplete_reason, "no invocation_end");
});

test("a torn last line is skipped: the record is read while it is appended to", () => {
  const torn = RESUMED_RUN + '{"v":1,"kind":"codex","invocation":3,"event":{"type":"tu';
  assert.equal(summarizeDriverTurns(driverTurns(parseDriverRecords(torn)), PRICING).cost_usd, 0.01494);
});

test("priceUsage bills fresh input as input minus cached, and never adds reasoning to output", () => {
  const priced = priceUsage(normalizeUsage({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 30 }), PRICING);
  assert.deepEqual(priced.tokens, { input: 600, input_cached: 400, output: 50 });
  assert.equal(priced.reasoning, 30);
  assert.equal(priced.cost_usd, (600 * 2 + 400 * 0.2 + 50 * 12) / 1e6);
});
