/** The driver's run record: outcomes and exit codes, the stop check, and driver-manifest.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDriverManifest,
  classifyDriverAuth,
  completionEvidence,
  driverAlive,
  gateDecision,
  isDeliberate,
  lastRunEnd,
  latestRunEnd,
  liveDriver,
  outcomeExitCode,
  parseEtime,
  previousRunEnd,
  snapshotStopEvidence,
  stopCheck,
} from "../../plugin/codex/run-record.mjs";
import { writeManifest } from "../../plugin/scripts/write-manifest.mjs";

function folder() {
  const root = mkdtempSync(join(tmpdir(), "run-record-"));
  const runDir = join(root, ".sdlc", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  return { root, runDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const line = (o) => JSON.stringify(o) + "\n";

test("every outcome maps to the exit code the docs promise", () => {
  const table = {
    completed: 0,
    aborted: 4,
    halted: 4,
    refused: 4,
    stopped: 4,
    cost_cap: 4,
    pin_rejected: 1,
    max_turns: 3,
    codex_failed: 1,
  };
  for (const [outcome, code] of Object.entries(table)) assert.equal(outcomeExitCode(outcome), code, outcome);
  assert.equal(outcomeExitCode("interrupted", "SIGINT"), 130);
  assert.equal(outcomeExitCode("interrupted", "SIGTERM"), 143);
  assert.equal(outcomeExitCode("interrupted", "SIGHUP"), 129);
  assert.throws(() => outcomeExitCode("nonsense"), /unknown outcome/);
});

test("deliberate stops are the ones a person or a rule meant", () => {
  for (const o of ["aborted", "halted", "refused", "stopped", "cost_cap", "pin_rejected"]) assert.equal(isDeliberate(o), true, o);
  for (const o of ["completed", "max_turns", "codex_failed", "interrupted"]) assert.equal(isDeliberate(o), false, o);
});

test("the stop check reads only evidence from this invocation, in a fixed order", () => {
  const f = folder();
  try {
    const startedAtMs = Date.now() - 1000;
    writeFileSync(join(f.runDir, "gates.jsonl"), line({ gate: 1, decision: "aborted" }));
    const base = { runDir: f.runDir, projectRoot: f.root, runId: "r1", gateMode: "prompt", startedAtMs };
    assert.equal(stopCheck({ ...base, gatesLinesBefore: 1 }), null, "a line from an earlier invocation does not count");
    assert.equal(stopCheck({ ...base, gatesLinesBefore: 0 }).outcome, "aborted");

    writeFileSync(join(f.runDir, "gates.jsonl"), line({ gate: 1, decision: "aborted" }) + line({ gate: 2, decision: "pending" }));
    assert.equal(stopCheck({ ...base, gatesLinesBefore: 1 }).outcome, "gate_pending");
    assert.equal(stopCheck({ ...base, gatesLinesBefore: 1 }).gate, 2);
    assert.equal(stopCheck({ ...base, gateMode: "auto-approve", gatesLinesBefore: 1 }), null, "only prompt mode relays a gate");

    writeFileSync(join(f.runDir, "preflight.json"), JSON.stringify({ ok: false, halt_reason: "no key" }));
    assert.deepEqual(stopCheck({ ...base, gatesLinesBefore: 2 }), { outcome: "halted", reason: "no key" });
    const old = new Date(startedAtMs - 60_000);
    utimesSync(join(f.runDir, "preflight.json"), old, old);
    assert.equal(stopCheck({ ...base, gatesLinesBefore: 2 }), null, "a preflight from an earlier invocation does not count");
  } finally {
    f.cleanup();
  }
});

test("a guard deny counts for this run or for no run, not for another run", () => {
  const f = folder();
  try {
    mkdirSync(join(f.root, ".sdlc", "local"), { recursive: true });
    const deny = (run_id) => line({ ts: new Date().toISOString(), decision: "deny", path: "a.ts", reason: "off-limits", run_id });
    const path = join(f.root, ".sdlc", "local", "guard-decisions.jsonl");
    const base = { runDir: f.runDir, projectRoot: f.root, runId: "r1", gateMode: "auto-approve", startedAtMs: Date.now() - 1000 };
    writeFileSync(path, deny("other-run"));
    assert.equal(stopCheck(base), null);
    writeFileSync(path, deny(undefined));
    assert.equal(stopCheck(base).outcome, "refused");
  } finally {
    f.cleanup();
  }
});

const phase9 = (f, status = "accepted") => writeManifest({ runDir: f.runDir, runId: "r1", policy: "gpt-plus-flash", projectRoot: f.root, status, summary: true });

test("completion needs a SUMMARY.md write-manifest.mjs wrote during the run and an accepted Gate 4", () => {
  const f = folder();
  try {
    const started = Date.now() - 1000;
    phase9(f);
    assert.equal(completionEvidence(f.runDir, started).complete, false);
    writeFileSync(join(f.runDir, "gates.jsonl"), line({ gate: "gate-4", status: "accepted" }));
    assert.equal(completionEvidence(f.runDir, started).complete, true, "gate-4 written as {status} counts");
    const old = new Date(started - 60_000);
    utimesSync(join(f.runDir, "SUMMARY.md"), old, old);
    assert.equal(completionEvidence(f.runDir, started).complete, false, "a SUMMARY.md older than the run is stale");
    phase9(f);
    writeFileSync(join(f.runDir, "gates.jsonl"), line({ gate: 4, decision: "reject: tests fail" }));
    assert.equal(completionEvidence(f.runDir, started).complete, false, "a rejected Gate 4 sends the run back");
  } finally {
    f.cleanup();
  }
});

test("Phase 9's provisional SUMMARY.md, written before Gate 4, is not the final report", () => {
  const f = folder();
  try {
    const started = Date.now() - 1000;
    phase9(f, null);
    writeFileSync(join(f.runDir, "gates.jsonl"), line({ gate: 4, decision: "accepted" }));
    const ev = completionEvidence(f.runDir, started);
    assert.equal(ev.complete, false);
    assert.match(ev.summaryReason, /status is provisional: Phase 9's command has not been run again with --status=accepted/);
    phase9(f, "rejected");
    assert.equal(completionEvidence(f.runDir, started).complete, false);
    phase9(f, "auto-approved");
    assert.equal(completionEvidence(f.runDir, started).complete, true);
  } finally {
    f.cleanup();
  }
});

test("a SUMMARY.md the conductor wrote or edited by hand is not the final report", () => {
  const f = folder();
  try {
    const started = Date.now() - 1000;
    writeFileSync(join(f.runDir, "gates.jsonl"), line({ gate: 4, decision: "accepted" }));
    writeFileSync(join(f.runDir, "SUMMARY.md"), "# done\n");
    let ev = completionEvidence(f.runDir, started);
    assert.equal(ev.complete, false, "no code-written manifest vouches for it");
    assert.match(ev.summaryReason, /SUMMARY\.md was not written by plugin\/scripts\/write-manifest\.mjs: manifest\.json is missing/);

    phase9(f);
    assert.equal(completionEvidence(f.runDir, started).complete, true);
    appendFileSync(join(f.runDir, "SUMMARY.md"), "\nAll good, says the conductor.\n");
    ev = completionEvidence(f.runDir, started);
    assert.equal(ev.complete, false, "an edited summary no longer matches the manifest's hash");
    assert.match(ev.summaryReason, /hand-written or edited/);

    writeFileSync(join(f.runDir, "manifest.json"), JSON.stringify({ pass: "r1", total_cost_usd: 0 }));
    phase9(f);
    writeFileSync(join(f.runDir, "SUMMARY.md"), readFileSync(join(f.runDir, "SUMMARY.md"), "utf-8"));
    assert.equal(completionEvidence(f.runDir, started).complete, true, "rewriting the same bytes keeps it the code's");
  } finally {
    f.cleanup();
  }
});

test("gate lines may carry decision or status", () => {
  assert.equal(gateDecision({ decision: "approved" }), "approved");
  assert.equal(gateDecision({ status: "pending" }), "pending");
  assert.equal(gateDecision({}), "");
});

test("codex login status wording classifies the conductor's auth without keeping the text", () => {
  assert.equal(classifyDriverAuth("Logged in using ChatGPT\n"), "chatgpt");
  assert.equal(classifyDriverAuth("Logged in using an API key - sk-proj-***abcd\n"), "api_key");
  assert.equal(classifyDriverAuth("Not logged in"), "unknown");
  assert.equal(classifyDriverAuth(""), "unknown");
});

test("the run end of the latest driver process, and of the record as a whole", () => {
  const records = [
    { kind: "invocation_start", invocation: 1 },
    { kind: "run_end", outcome: "max_turns" },
    { kind: "invocation_start", invocation: 2 },
  ];
  assert.equal(lastRunEnd(records), null, "a process that started after the run_end has not ended");
  assert.equal(latestRunEnd(records).outcome, "max_turns");
});

test("driver-manifest.json is rebuilt from the record, incomplete turns and all", () => {
  const records = [
    { v: 1, kind: "invocation_start", run_id: "r1", invocation: 1, at: "2026-10-13T00:00:00.000Z", mode: "fresh", gates: "auto-approve" },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:01.000Z", event: { type: "thread.started", thread_id: "t1" } },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:02.000Z", event: { type: "turn.started" } },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:03.000Z", event: { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } } },
    { v: 1, kind: "invocation_end", invocation: 1, at: "2026-10-13T00:00:04.000Z", thread_id: "t1", exit_status: 0, ended_by: "exit" },
    { v: 1, kind: "invocation_start", run_id: "r1", invocation: 2, at: "2026-10-13T00:01:00.000Z", mode: "resume", resume_thread_id: "t1", gates: "auto-approve" },
    { v: 1, kind: "codex", invocation: 2, thread_id: "t1", received_at: "2026-10-13T00:01:01.000Z", event: { type: "turn.started" } },
    { v: 1, kind: "invocation_end", invocation: 2, at: "2026-10-13T00:01:02.000Z", thread_id: "t1", exit_status: null, signal: "SIGTERM", ended_by: "driver_signal" },
    { v: 1, kind: "run_end", invocation: 2, at: "2026-10-13T00:01:03.000Z", outcome: "interrupted", deliberate: false, reason: "the driver received SIGTERM", exit_code: 143 },
  ];
  const m = buildDriverManifest(records, {
    runId: "r1",
    policyName: "gpt-plus-flash",
    pin: { model: "gpt-5.6-terra", effort: "high" },
    sandbox: "workspace-write",
    approvalPolicy: "never",
    pricing: { input: 2, input_cached: 0.2, output: 12 },
    driverAuth: "api_key",
  });
  assert.equal(m.started_at, "2026-10-13T00:00:00.000Z");
  assert.equal(m.ended_at, "2026-10-13T00:01:03.000Z");
  assert.equal(m.codex_invocations, 2);
  assert.equal(m.driver_turns, 2);
  assert.equal(m.driver_turns_incomplete, 1);
  assert.equal(m.driver_cost_complete, false);
  assert.equal(m.driver_cost_usd_modeled, 0.00224);
  assert.equal(m.outcome, "interrupted");
  assert.equal(m.exit_code, 143);
  assert.equal(m.completed, false);
  assert.equal(m.driver_auth, "api_key");
  assert.deepEqual(m.thread_ids, ["t1"]);
  assert.deepEqual(m.pin, { model: "gpt-5.6-terra", effort: "high", sandbox: "workspace-write", approval_policy: "never" });
});

test("previousRunEnd names a driver that never wrote run_end as killed, and ignores legacy records", () => {
  assert.equal(previousRunEnd([]), null);
  assert.equal(previousRunEnd([{ kind: "invocation_start", legacy: true }, { kind: "codex", legacy: true }]), null);
  const ended = [{ kind: "invocation_start" }, { kind: "run_end", outcome: "max_turns" }];
  assert.equal(previousRunEnd(ended).outcome, "max_turns");
  const killed = [...ended, { kind: "invocation_start" }, { kind: "codex" }, { kind: "invocation_end" }];
  assert.equal(previousRunEnd(killed).outcome, "killed");
  assert.equal(previousRunEnd(killed).deliberate, false);
  assert.equal(previousRunEnd([{ kind: "run_end", outcome: "cost_cap" }]).outcome, "cost_cap");
});

test("a question.json written this invocation waits for the person under prompt, and stops an unattended run", () => {
  const { root, runDir, cleanup } = folder();
  try {
    const startedAtMs = Date.now();
    writeFileSync(join(runDir, "question.json"), line({ question: "Which job type: docs or bugfix?" }));
    const base = { runDir, projectRoot: root, runId: "r1", startedAtMs };
    assert.deepEqual(stopCheck({ ...base, gateMode: "prompt" }), {
      outcome: "question_pending",
      question: "Which job type: docs or bugfix?",
      reason: "the conductor is waiting for an answer to its question",
    });
    const unattended = stopCheck({ ...base, gateMode: "auto-approve" });
    assert.equal(unattended.outcome, "stopped");
    assert.match(unattended.reason, /nobody can answer under --gates=auto-approve: Which job type/);

    const old = new Date(startedAtMs - 60_000);
    utimesSync(join(runDir, "question.json"), old, old);
    assert.equal(stopCheck({ ...base, gateMode: "prompt" }), null, "a question from an earlier invocation is not pending");
  } finally {
    cleanup();
  }
});

test("with a snapshot, only stop evidence written after it counts, however close the next invocation starts", () => {
  const { root, runDir, cleanup } = folder();
  try {
    writeFileSync(join(runDir, "question.json"), line({ question: "first?" }));
    mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "local", "guard-decisions.jsonl"), line({ ts: new Date().toISOString(), decision: "deny", path: "a" }));
    const base = { runDir, projectRoot: root, runId: "r1", gateMode: "prompt", startedAtMs: Date.now() - 60_000 };
    const before = snapshotStopEvidence(runDir, root);
    assert.equal(stopCheck({ ...base, before }), null, "the earlier question and deny are not this invocation's");

    writeFileSync(join(runDir, "question.json"), line({ question: "second?" }));
    assert.equal(stopCheck({ ...base, before }).question, "second?");

    const later = snapshotStopEvidence(runDir, root);
    writeFileSync(join(root, ".sdlc", "local", "guard-decisions.jsonl"), line({ ts: "2020-01-01T00:00:00.000Z", decision: "deny", path: "b", reason: "off-limits" }), { flag: "a" });
    assert.deepEqual(stopCheck({ ...base, before: later }), { outcome: "refused", reason: "b: off-limits" });
  } finally {
    cleanup();
  }
});

test("ps etime text parses to seconds", () => {
  assert.equal(parseEtime("00:07"), 7);
  assert.equal(parseEtime("   12:34\n"), 12 * 60 + 34);
  assert.equal(parseEtime("01:02:03"), 3723);
  assert.equal(parseEtime("2-01:00:00"), 2 * 86400 + 3600);
  assert.equal(parseEtime(""), null);
  assert.equal(parseEtime("soon"), null);
});

test("a live driver is the latest process with no run_end whose pid still runs", () => {
  const start = (n, pid) => ({ v: 1, kind: "invocation_start", invocation: n, at: "2026-10-13T10:00:00.000Z", driver_pid: pid });
  const end = (n) => ({ v: 1, kind: "invocation_end", invocation: n });
  const runEnd = (n) => ({ v: 1, kind: "run_end", invocation: n, outcome: "max_turns" });
  const alive = (pid) => pid === 4242;
  assert.equal(liveDriver([], alive), null);
  assert.equal(liveDriver([start(1, 4242), end(1), runEnd(1)], alive), null, "it wrote run_end");
  assert.deepEqual(liveDriver([start(1, 4242)], alive), { pid: 4242, invocation: 1, at: "2026-10-13T10:00:00.000Z" });
  assert.equal(liveDriver([start(1, 4242), end(1)], alive)?.pid, 4242, "waiting at a gate between invocations");
  assert.equal(liveDriver([start(1, 7)], alive), null, "its pid is gone");
  assert.equal(liveDriver([{ ...start(1, 4242), driver_pid: undefined }], alive), null, "an older record names no driver");
  assert.equal(liveDriver([start(1, 4242), { ...start(2, 4242), legacy: true }, runEnd(1)], alive), null);
});

test("driverAlive: not this process, not a dead pid, and not a pid reused after the record", () => {
  assert.equal(driverAlive(process.pid, new Date().toISOString()), false);
  assert.equal(driverAlive(undefined, null), false);
  assert.equal(driverAlive(2 ** 22 + 12345, new Date().toISOString()), false);
  assert.equal(driverAlive(process.ppid, new Date().toISOString()), true, "a process started before the record");
  if (process.platform !== "win32") {
    assert.equal(driverAlive(process.ppid, "2000-01-01T00:00:00.000Z"), false, "started long after the record: a reused pid");
  }
});
