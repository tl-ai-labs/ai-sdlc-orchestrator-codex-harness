/**
 * The whole run.mjs loop, end to end, against a stand-in codex
 * (fixtures/fake-codex.mjs) that replays scripted steps. Offline and free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GATE_MODES, main } from "../../plugin/codex/run.mjs";
import { resolveRunPolicy } from "../../plugin/codex/run-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-codex.mjs");
const RUN_MJS = join(HERE, "..", "..", "plugin", "codex", "run.mjs");
const THREAD = "01a1340d-41da-7e31-84cd-b0907e9bc31f";

/** A shipped preset, resolved the way run.mjs resolves --policy in a project with no routing-policy.yaml. */
const presetPolicy = (name) => resolveRunPolicy({ projectRoot: join(HERE, "fixtures"), policyArg: name, warn: () => {} }).policy;

const fakeSpawn = (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];

function harness() {
  const root = mkdtempSync(join(tmpdir(), "driver-life-"));
  const work = mkdtempSync(join(tmpdir(), "driver-life-work-"));
  const codexHome = mkdtempSync(join(tmpdir(), "driver-life-home-"));
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const scenarioPath = join(work, "scenario.json");
  const logPath = join(work, "fake.log");
  const runDirOf = (id) => join(root, ".sdlc", "runs", id);
  const env = { ...process.env, CODEX_HOME: codexHome, FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: logPath };
  return {
    root,
    work,
    env,
    runDirOf,
    scenario(steps, { runDir, ...extra } = {}) {
      writeFileSync(scenarioPath, JSON.stringify({ runDir, projectRoot: root, steps, ...extra }));
      try { unlinkSync(`${scenarioPath}.state`); } catch { /* first scenario */ }
    },
    calls: () => readLines(logPath).filter((l) => l.argv),
    log: () => readLines(logPath),
    records: (id) => readLines(join(runDirOf(id), "driver-events.jsonl")),
    rows: (id) => readLines(join(runDirOf(id), "driver-cost-modeled.jsonl")),
    manifest: (id) => JSON.parse(readFileSync(join(runDirOf(id), "driver-manifest.json"), "utf-8")),
    async run(argv, deps = {}) {
      let out = "";
      let err = "";
      const code = await main(argv, {
        cwd: root,
        env,
        spawnFn: fakeSpawn,
        stdin: { isTTY: false },
        signals: new EventEmitter(),
        stdout: { write: (s) => ((out += s), true) },
        stderr: { write: (s) => ((err += s), true) },
        ...deps,
      });
      return { code, out, err };
    },
    cleanup() {
      for (const d of [root, work, codexHome]) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** A greenfield, unattended run with an explicit id: the shape most tests start from. */
function args(h, id, ...extra) {
  return ["--project-root", h.root, "--run-id", id, "--mode=greenfield", "--gates=auto-approve", ...extra];
}

function withScenario(h, id, steps) {
  h.scenario(steps, { runDir: h.runDirOf(id) });
}

const COMPLETE = { gates: [{ gate: 1, decision: "auto-approved" }, { gate: 4, decision: "auto-approved" }], summary: true };

/**
 * A terminal stand-in. Each answer is typed only once a question has been
 * printed: a string is written, null ends the input, a function runs.
 */
function terminal(answers = []) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const queue = [...answers];
  let out = "";
  const stdout = {
    write(s) {
      out += s;
      if (/(abort:|<comments>:|Your answer:) $/.test(s) && queue.length) {
        const next = queue.shift();
        setImmediate(() => (next === null ? stdin.end() : typeof next === "function" ? next(stdin) : stdin.write(next)));
      }
      return true;
    },
  };
  return { stdin, stdout, out: () => out };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function waitFor(predicate, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

test("a run that writes SUMMARY.md and accepts Gate 4 completes: exit 0, one invocation, a full record", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    const { code } = await h.run(args(h, "r1"));
    assert.equal(code, 0);
    assert.equal(h.calls().length, 1);
    assert.ok(h.calls()[0].argv.includes("--skip-git-repo-check"), "greenfield passes --skip-git-repo-check");

    const recs = h.records("r1");
    assert.ok(recs.every((r) => r.v === 1));
    assert.equal(recs[0].kind, "invocation_start");
    assert.equal(recs.at(-1).kind, "run_end");
    const start = recs[0];
    assert.equal(start.run_id, "r1");
    assert.equal(start.mode, "fresh");
    assert.equal(start.policy, "gpt-plus-flash");
    assert.deepEqual(start.pin, { model: "gpt-5.6-terra", effort: "high" });
    assert.equal(start.gates, "auto-approve");
    assert.equal(start.max_turns, 12);
    assert.equal(typeof start.pid, "number");
    assert.equal(start.pgid, start.pid);
    const end = recs.find((r) => r.kind === "invocation_end");
    assert.equal(end.exit_status, 0);
    assert.equal(end.ended_by, "exit");
    assert.deepEqual(end.turns, { started: 1, completed: 1, failed: 0 });
    assert.equal(end.incomplete, false);
    assert.deepEqual(recs.at(-1), { ...recs.at(-1), outcome: "completed", exit_code: 0 });

    const m = h.manifest("r1");
    assert.equal(m.completed, true);
    assert.equal(m.outcome, "completed");
    assert.equal(m.exit_code, 0);
    assert.equal(m.driver_auth, "chatgpt");
    assert.deepEqual(m.thread_ids, [THREAD]);
    assert.equal(m.codex_invocations, 1);
    assert.equal(m.driver_turns, 1);
    assert.equal(m.driver_cost_complete, true);
    for (const key of ["run_id", "policy", "gates", "pin", "started_at", "ended_at", "codex_exit_status", "cost_cap_stop", "driver_cost_usd_modeled", "pin_rejection", "events_captured", "codex_warnings", "outcome_reason"]) {
      assert.ok(key in m, `driver-manifest keeps ${key}`);
    }

    const rows = h.rows("r1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "complete");
    assert.equal(rows[0].task_id, "driver-i1-t1");
    assert.equal(rows[0].routing.policy_name, "gpt-plus-flash");

    const log = readFileSync(join(h.runDirOf("r1"), "orchestrator.log"), "utf-8");
    assert.match(log, /run\.start run_id=r1/);
    assert.match(log, /run\.end run_id=r1 outcome=completed/);
    assert.ok(existsSync(join(h.runDirOf("r1"), "skills", "pipeline.md")));
  } finally {
    h.cleanup();
  }
});

test("SUMMARY.md alone does not complete a run: Gate 4 has to be accepted too", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ summary: true, gates: [{ gate: 3, decision: "auto-approved" }] }]);
    const { code } = await h.run(args(h, "r1", "--max-turns=1"));
    assert.equal(code, 3);
    assert.equal(h.manifest("r1").outcome, "max_turns");
  } finally {
    h.cleanup();
  }
});

test("a SUMMARY.md left by an earlier run is refused, never read as this run's completion", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, "out"), { recursive: true });
    writeFileSync(join(h.root, "out", "SUMMARY.md"), "# an old run\n");
    withScenario(h, "r2", [COMPLETE]);
    const stale = await h.run(args(h, "r2", "--output-dir=out"));
    assert.equal(stale.code, 2);
    assert.match(stale.err, /already holds SUMMARY\.md/);

    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(args(h, "r1"))).code, 0);
    const again = await h.run(args(h, "r1"));
    assert.equal(again.code, 2);
    assert.match(again.err, /already has a record.*--resume=r1/);
    assert.equal(h.calls().length, 1, "neither refusal spawned codex");
  } finally {
    h.cleanup();
  }
});

test("max_turns: exit 3 after --max-turns invocations, each resume carrying the gate mode", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", []);
    const { code, out } = await h.run(args(h, "r1", "--max-turns", "2"));
    assert.equal(code, 3);
    const calls = h.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].argv.slice(0, 3), ["exec", "resume", THREAD]);
    assert.ok(calls[1].argv.at(-1).includes(`Gate mode for this invocation: ${GATE_MODES["auto-approve"]}`));
    const m = h.manifest("r1");
    assert.equal(m.completed, false);
    assert.equal(m.outcome, "max_turns");
    assert.equal(m.exit_code, 3);
    assert.equal(m.codex_invocations, 2);
    assert.match(
      out,
      new RegExp(`Continue: +node '${escapeRe(RUN_MJS)}' --resume=r1 --project-root='${escapeRe(h.root)}'$`, "m"),
      "the absolute run.mjs path, so the line runs from any directory",
    );
  } finally {
    h.cleanup();
  }
});

test("auto-abort: an aborted gate ends the run at exit 4 and is never resumed", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, artifact: "requirements.md", decision: "aborted", note: "auto-abort" }] }]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-abort", "--max-turns=5"]);
    assert.equal(code, 4);
    assert.equal(h.calls().length, 1);
    const end = h.records("r1").at(-1);
    assert.equal(end.outcome, "aborted");
    assert.equal(end.deliberate, true);
    assert.match(end.reason, /gate 1 aborted: auto-abort/);
    const log = readFileSync(join(h.runDirOf("r1"), "orchestrator.log"), "utf-8");
    assert.match(log, /run\.end run_id=r1 outcome=aborted driver_outcome=aborted/);
  } finally {
    h.cleanup();
  }
});

test("a gate line written as {status} is read the same as {decision}", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, status: "aborted" }] }]);
    assert.equal((await h.run(args(h, "r1"))).code, 4);
  } finally {
    h.cleanup();
  }
});

test("a preflight halt ends the run at exit 4 with its halt_reason", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ preflight: { ok: false, halt_reason: "gemini-flash is unreachable" } }]);
    const { code } = await h.run(args(h, "r1"));
    assert.equal(code, 4);
    assert.equal(h.calls().length, 1);
    const end = h.records("r1").at(-1);
    assert.equal(end.outcome, "halted");
    assert.equal(end.reason, "gemini-flash is unreachable");
  } finally {
    h.cleanup();
  }
});

test("a refused write stops the run; a refusal older than the invocation does not", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, ".sdlc", "local"), { recursive: true });
    writeFileSync(
      join(h.root, ".sdlc", "local", "guard-decisions.jsonl"),
      JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", decision: "deny", path: "old.ts", reason: "old" }) + "\n",
    );
    withScenario(h, "r1", [{}, { guardDeny: { path: "src/x.ts", reason: "off-limits", run_id: "r1" } }]);
    const { code } = await h.run(args(h, "r1", "--max-turns=3"));
    assert.equal(code, 4);
    assert.equal(h.calls().length, 2, "the old deny did not stop invocation 1");
    const end = h.records("r1").at(-1);
    assert.equal(end.outcome, "refused");
    assert.equal(end.reason, "src/x.ts: off-limits");
  } finally {
    h.cleanup();
  }
});

test("stop.json naming what the person must decide ends the run as stopped", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ stop: { reason: "the brief contradicts itself", needs: "which of the two goals wins" } }]);
    assert.equal((await h.run(args(h, "r1"))).code, 4);
    assert.equal(h.calls().length, 1);
    assert.equal(h.records("r1").at(-1).outcome, "stopped");
    assert.equal(h.records("r1").at(-1).reason, "the brief contradicts itself (needs: which of the two goals wins)");
  } finally {
    h.cleanup();
  }
});

test("a stop.json with no needs is a progress note: the run resumes and completes", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ stop: { reason: "security review and Gate 4 remain" } }, COMPLETE]);
    assert.equal((await h.run(args(h, "r1"))).code, 0);
    assert.equal(h.calls().length, 2);
    assert.deepEqual(h.calls()[1].argv.slice(0, 3), ["exec", "resume", THREAD]);
    assert.equal(h.records("r1").at(-1).outcome, "completed");
  } finally {
    h.cleanup();
  }
});

test("two stop.json progress notes in a row stop the run", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ stop: { reason: "phases remain" } }, { stop: { reason: "phases still remain" } }]);
    assert.equal((await h.run(args(h, "r1"))).code, 4);
    assert.equal(h.calls().length, 2);
    assert.equal(h.records("r1").at(-1).outcome, "stopped");
    assert.equal(h.records("r1").at(-1).reason, "phases still remain");
  } finally {
    h.cleanup();
  }
});

test("a rejected pin ends the run at exit 1", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ failTurn: "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] bad", exit: 1 }]);
    const { code, err } = await h.run(args(h, "r1"));
    assert.equal(code, 1);
    assert.equal(h.records("r1").at(-1).outcome, "pin_rejected");
    assert.match(err, /rejected the pinned model or effort/);
  } finally {
    h.cleanup();
  }
});

test("codex's fallback-metadata warning on a completed run is a warning, not a rejection", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ fixture: "exec1", ...COMPLETE }]);
    assert.equal((await h.run(args(h, "r1"))).code, 0);
    const m = h.manifest("r1");
    assert.equal(m.pin_rejection, null);
    assert.match(m.codex_warnings[0], /Defaulting to fallback metadata/);
  } finally {
    h.cleanup();
  }
});

test("the cost cap is checked before every spawn and after every invocation", async () => {
  const h = harness();
  try {
    const capped = (cap) => (name) => ({ ...presetPolicy(name), hard_cost_cap_usd: cap });
    withScenario(h, "r1", [{ telemetry: [{ cost_usd: 0.6 }] }]);
    const first = await h.run(args(h, "r1"), { loadPolicy: capped(0.5) });
    assert.equal(first.code, 4);
    assert.equal(h.calls().length, 1);
    assert.equal(h.manifest("r1").outcome, "cost_cap");
    assert.match(h.manifest("r1").cost_cap_stop, /COST_CAP_EXCEEDED/);

    const resumed = await h.run(["--project-root", h.root, "--resume=r1"], { loadPolicy: capped(0.5) });
    assert.equal(resumed.code, 4);
    assert.equal(h.calls().length, 1, "a resume into a capped folder spawns nothing");

    withScenario(h, "r2", [COMPLETE]);
    assert.equal((await h.run(args(h, "r2"), { loadPolicy: capped(0) })).code, 4);
    assert.equal(h.calls().length, 1, "a fresh run already at its cap spawns nothing");
  } finally {
    h.cleanup();
  }
});

test("a failed turn's message reaches the stop reason when codex's stderr says nothing", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ failTurn: "You've hit your usage limit. Try again at 1:53 PM.", exit: 1 }]);
    const { code, out } = await h.run(args(h, "r1"));
    assert.equal(code, 1);
    const end = h.records("r1").at(-1);
    assert.equal(end.outcome, "codex_failed");
    assert.equal(end.reason, "codex exited 1: You've hit your usage limit. Try again at 1:53 PM.");
    assert.match(out, /codex_failed — codex exited 1: You've hit your usage limit/);
  } finally {
    h.cleanup();
  }
});

test("a codex failure shows codex's stderr, keeps it in driver-stderr.log, and exits 1", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ stderr: "fake-codex: Not inside a trusted directory\n", failTurn: "stream disconnected", exit: 1 }]);
    const { code, err } = await h.run(args(h, "r1"));
    assert.equal(code, 1);
    assert.match(err, /codex\[1\]: fake-codex: Not inside a trusted directory/);
    assert.match(err, /last lines codex wrote to stderr:\n {4}fake-codex: Not inside a trusted directory/);
    const log = readFileSync(join(h.runDirOf("r1"), "driver-stderr.log"), "utf-8");
    assert.match(log, /^--- invocation 1 \S+ fresh ---\nfake-codex: Not inside a trusted directory\n$/);
    const end = h.records("r1").find((r) => r.kind === "invocation_end");
    assert.ok(end.stderr_tail.endsWith("fake-codex: Not inside a trusted directory\n"));
    assert.equal(h.records("r1").at(-1).outcome, "codex_failed");
    const m = h.manifest("r1");
    assert.equal(m.driver_turns_incomplete, 1);
    assert.equal(m.driver_cost_complete, false);
    const [row] = h.rows("r1");
    assert.equal(row.status, "incomplete");
    assert.equal(row.incomplete_reason, "turn.failed: stream disconnected");
    assert.equal(row.cost_usd, null);
  } finally {
    h.cleanup();
  }
});

test("a codex binary that cannot be launched is recorded as a spawn error", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    const missing = (bin, a, opts) => spawn(join(h.work, "no-such-codex"), a, opts);
    const { code } = await h.run(args(h, "r1"), { spawnFn: missing });
    assert.equal(code, 1);
    const end = h.records("r1").find((r) => r.kind === "invocation_end");
    assert.equal(end.ended_by, "spawn_error");
    assert.match(h.records("r1").at(-1).reason, /could not launch/);
    assert.equal(h.manifest("r1").driver_auth, "unknown");
  } finally {
    h.cleanup();
  }
});

test("--resume continues the same folder, needs no brief, and prices the thread once", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ fixture: "exec1" }]);
    assert.equal((await h.run(args(h, "r1", "--max-turns=1"))).code, 3);
    const startedAt = h.manifest("r1").started_at;
    unlinkSync(join(h.root, "brief.md"));

    withScenario(h, "r1", [{ fixture: "exec2" }]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1", "--max-turns=1"])).code, 3);
    withScenario(h, "r1", [{ fixture: "exec3", ...COMPLETE }]);
    assert.equal((await h.run(["--project-root", h.root, `--resume=${THREAD}`])).code, 0, "a thread id finds the run too");

    const calls = h.calls();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].argv.slice(0, 3), ["exec", "resume", THREAD]);
    assert.ok(calls[1].argv.includes("--skip-git-repo-check"), "the recorded mode carries over");
    const starts = h.records("r1").filter((r) => r.kind === "invocation_start");
    assert.deepEqual(starts.map((s) => s.invocation), [1, 2, 3]);
    assert.equal(starts[1].resume_after, "max_turns");
    assert.equal(starts[1].gates, "auto-approve", "the recorded gate mode carries over");
    assert.equal(h.records("r1").filter((r) => r.kind === "run_end").length, 3);

    const m = h.manifest("r1");
    assert.equal(m.started_at, startedAt, "a resume keeps the run's start");
    assert.equal(m.codex_invocations, 3);
    assert.equal(m.driver_cost_usd_modeled, 0.01494, "the last running total, not the sum of all three");
    assert.deepEqual(h.rows("r1").map((r) => r.input_tokens + r.input_tokens_cached), [1000, 3000, 5000]);
    assert.equal(new Set(h.rows("r1").map((r) => r.task_id)).size, 3);
  } finally {
    h.cleanup();
  }
});

test("a resumed run keeps its policy, and a completed run is not resumed", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{}]);
    assert.equal((await h.run(args(h, "r1", "--max-turns=1"))).code, 3);
    const other = await h.run(["--project-root", h.root, "--resume=r1", "--policy=gpt-seat-plus-flash"]);
    assert.equal(other.code, 2);
    assert.match(other.err, /keeps its policy/);
    const otherMode = await h.run(["--project-root", h.root, "--resume=r1", "--mode=brownfield"]);
    assert.equal(otherMode.code, 2);
    assert.equal(h.calls().length, 1);

    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1"])).code, 0);
    const done = await h.run(["--project-root", h.root, "--resume=r1"]);
    assert.equal(done.code, 2);
    assert.match(done.err, /already completed/);
    assert.equal(h.calls().length, 2);
  } finally {
    h.cleanup();
  }
});

test("an aborted gate from an earlier invocation does not stop a later resume", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, decision: "aborted" }] }]);
    assert.equal((await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-abort"])).code, 4);
    withScenario(h, "r1", [{}]);
    const { code } = await h.run(["--project-root", h.root, "--resume=r1", "--gates=auto-approve", "--max-turns=1"]);
    assert.equal(code, 3, "only evidence from this invocation counts");
    const starts = h.records("r1").filter((r) => r.kind === "invocation_start");
    assert.equal(starts[1].resume_after, "aborted");
    assert.equal(starts[1].gates, "auto-approve");
  } finally {
    h.cleanup();
  }
});

test("SIGTERM mid-turn: codex's group is signalled, the record is written, exit 143, and --resume picks it up", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 6000 }]);
    const signals = new EventEmitter();
    const running = h.run(args(h, "r1"), { signals });
    assert.ok(
      await waitFor(() => h.records("r1").some((r) => r.kind === "codex" && r.event.type === "turn.started")),
      "the record is on disk while codex runs",
    );
    signals.emit("SIGTERM");
    const { code } = await running;
    assert.equal(code, 143);
    assert.ok(h.log().some((l) => l.signal === "SIGTERM"), "codex received the forwarded signal");
    const pid = h.records("r1")[0].pid;
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "codex is gone");

    const end = h.records("r1").find((r) => r.kind === "invocation_end");
    assert.equal(end.ended_by, "driver_signal");
    assert.equal(end.signal, "SIGTERM");
    const runEnd = h.records("r1").at(-1);
    assert.deepEqual([runEnd.outcome, runEnd.deliberate, runEnd.exit_code], ["interrupted", false, 143]);
    const [row] = h.rows("r1");
    assert.equal(row.status, "incomplete");
    assert.equal(row.incomplete_reason, "driver signal SIGTERM mid-turn");

    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1"])).code, 0);
    assert.deepEqual(h.calls()[1].argv.slice(0, 3), ["exec", "resume", THREAD]);
  } finally {
    h.cleanup();
  }
});

test("a signal after the conductor finished the run leaves it completed, exit 0, with its accepted status kept", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ ...COMPLETE, sleepMs: 6000, sleepAfterTurn: true }]);
    const signals = new EventEmitter();
    const running = h.run(args(h, "r1"), { signals });
    assert.ok(
      await waitFor(() => h.records("r1").some((r) => r.kind === "codex" && r.event.type === "turn.completed")),
      "the conductor wrote its completion evidence and codex has not exited yet",
    );
    signals.emit("SIGTERM");
    const { code, out } = await running;
    assert.equal(code, 0);
    assert.ok(h.log().some((l) => l.signal === "SIGTERM"), "codex still received the forwarded signal");
    const end = h.records("r1").find((r) => r.kind === "invocation_end");
    assert.equal(end.ended_by, "driver_signal");
    const runEnd = h.records("r1").at(-1);
    assert.deepEqual([runEnd.outcome, runEnd.exit_code], ["completed", 0]);
    assert.match(runEnd.reason, /SIGTERM arrived after the run finished/);
    assert.equal(h.manifest("r1").outcome, "completed");
    const manifest = JSON.parse(readFileSync(join(h.runDirOf("r1"), "manifest.json"), "utf-8"));
    assert.equal(manifest.status, "auto-approved", "the run end does not overwrite Phase 9's accepted status");
    assert.doesNotMatch(out, /Continue:/);

    const again = await h.run(["--project-root", h.root, "--resume=r1"]);
    assert.equal(again.code, 2);
    assert.match(again.err, /already completed/);
    assert.equal(h.calls().length, 1, "nothing more is spent");
  } finally {
    h.cleanup();
  }
});

test("--resume keeps the run's --code-dir and --brief: another path is refused before spending, the same one is accepted", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{}]);
    assert.equal((await h.run(args(h, "r1", "--max-turns=1"))).code, 3);
    writeFileSync(join(h.root, "other.md"), "# Other\n");
    for (const [flag, recorded] of [["--code-dir=app", join(h.root, "src")], ["--brief=other.md", join(h.root, "brief.md")]]) {
      const r = await h.run(["--project-root", h.root, "--resume=r1", flag]);
      assert.equal(r.code, 2, flag);
      assert.match(r.err, new RegExp(`${escapeRe(flag)} resolves to .*not run r1's ${escapeRe(recorded)}; a resumed run keeps its`));
    }
    assert.equal(h.calls().length, 1, "refused before any codex call");

    withScenario(h, "r1", [COMPLETE]);
    const same = await h.run(["--project-root", h.root, "--resume=r1", "--code-dir=src", "--brief=brief.md"]);
    assert.equal(same.code, 0, same.err);
    const starts = h.records("r1").filter((r) => r.kind === "invocation_start");
    assert.deepEqual(new Set(starts.map((s) => s.code_dir)), new Set([join(h.root, "src")]));
    assert.deepEqual(new Set(starts.map((s) => s.brief_path)), new Set([join(h.root, "brief.md")]));
  } finally {
    h.cleanup();
  }
});

test("a codex that ignores SIGTERM is killed after the grace period", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 8000, ignoreTerm: true }]);
    const signals = new EventEmitter();
    const t0 = Date.now();
    const running = h.run(args(h, "r1"), { signals, killGraceMs: 300 });
    await waitFor(() => h.records("r1").some((r) => r.kind === "codex" && r.event.type === "turn.started"));
    signals.emit("SIGTERM");
    assert.equal((await running).code, 143);
    assert.ok(Date.now() - t0 < 6000, "it did not wait for codex to finish on its own");
    assert.equal(h.records("r1").find((r) => r.kind === "invocation_end").signal, "SIGKILL");
  } finally {
    h.cleanup();
  }
});

test("a real SIGTERM to the run.mjs process stops codex and exits 143", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 6000 }]);
    const wrapper = join(h.work, "codex");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const driver = spawn(process.execPath, [RUN_MJS, ...args(h, "r1"), `--codex-bin=${wrapper}`], {
      cwd: h.root,
      env: h.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise((r) => driver.on("close", (code, signal) => r({ code, signal })));
    assert.ok(await waitFor(() => h.records("r1").some((r) => r.kind === "codex" && r.event.type === "turn.started")));
    driver.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 143);
    const pid = h.records("r1")[0].pid;
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the detached codex group was signalled too");
    assert.equal(h.records("r1").at(-1).outcome, "interrupted");
  } finally {
    h.cleanup();
  }
});

test("--gates=prompt without a terminal is refused before anything is spent", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    for (const argv of [
      ["--project-root", h.root, "--run-id=r1", "--mode=greenfield"],
      ["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=prompt"],
    ]) {
      const { code, err } = await h.run(argv);
      assert.equal(code, 2);
      assert.match(err, /--gates=auto-approve/);
      assert.match(err, /--gates=auto-abort/);
    }
    assert.equal(h.calls().length, 0);
    assert.ok(!existsSync(h.runDirOf("r1")), "nothing was written either");
  } finally {
    h.cleanup();
  }
});

test("with a terminal, a pending gate is relayed and its answer resumes the thread without using a turn", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [
      { gates: [{ gate: 1, artifact: "requirements.md", decision: "pending" }], message: "HITL Gate 1 — Requirements Approval" },
      { gates: [{ gate: 1, decision: "approved" }, { gate: 4, decision: "accepted" }], summary: true },
    ]);
    const t = terminal(["approved\n"]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--max-turns=1"], { stdin: t.stdin, stdout: t.stdout });
    assert.equal(code, 0);
    assert.match(t.out(), /HITL Gate 1 — Requirements Approval/);
    assert.match(t.out(), /Gate 1 — reply approved, revise: <comments>, or abort:/);
    const calls = h.calls();
    assert.equal(calls.length, 2, "the gate answer did not count toward --max-turns=1");
    assert.ok(calls[1].argv.at(-1).startsWith("Gate 1 answer from the person: approved"));
    assert.deepEqual(calls[1].argv.slice(0, 3), ["exec", "resume", THREAD]);
    assert.equal(h.records("r1").filter((r) => r.kind === "invocation_start")[1].gate_answer, true);
  } finally {
    h.cleanup();
  }
});

test("no answer at a gate (end of input) aborts the run", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 2, artifact: "design.md", decision: "pending" }] }]);
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.end();
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield"], { stdin });
    assert.equal(code, 4);
    assert.equal(h.records("r1").at(-1).reason, "no answer at gate 2");
    const gates = readLines(join(h.runDirOf("r1"), "gates.jsonl"));
    const { ts, ...written } = gates.at(-1);
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "run.mjs stamps the line it writes");
    assert.deepEqual(written, { gate: 2, artifact: null, decision: "aborted", note: "no answer at the terminal", recorded_by: "run.mjs" });
  } finally {
    h.cleanup();
  }
});

test("a non-git folder needs --mode=greenfield; brownfield needs git and gets no --skip-git-repo-check", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    const refused = await h.run(["--project-root", h.root, "--run-id=r1", "--gates=auto-approve"]);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /not a git repository.*--mode=greenfield/);
    assert.equal(h.calls().length, 0);

    mkdirSync(join(h.root, ".git"));
    const brown = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=brownfield", "--gates=auto-approve"], { isGitRepo: () => true });
    assert.equal(brown.code, 0);
    assert.ok(!h.calls()[0].argv.includes("--skip-git-repo-check"));
    assert.equal(h.records("r1")[0].code_dir, h.root, "brownfield code goes to the repo root");
  } finally {
    h.cleanup();
  }
});

test("a run with no --mode is handled as brownfield, and its code goes to the repo root", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, ".git"));
    const r = await h.run(["--project-root", h.root, "--run-id=r1", "--gates=auto-approve", "--dry-run"], { isGitRepo: () => true });
    assert.equal(r.code, 0, r.err);
    const plan = JSON.parse(r.out);
    assert.equal(plan.code_dir, h.root);
    assert.ok(!plan.argv.includes("--skip-git-repo-check"));
  } finally {
    h.cleanup();
  }
});

test("a modeled row lands as soon as its turn completes, and the regenerated file has no duplicates", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 1500, sleepAfterTurn: true, ...COMPLETE }]);
    const running = h.run(args(h, "r1"));
    assert.ok(await waitFor(() => h.rows("r1").length === 1), "the row is on disk before codex exits");
    assert.equal(h.records("r1").some((r) => r.kind === "invocation_end"), false);
    assert.equal((await running).code, 0);
    assert.deepEqual(h.rows("r1").map((r) => r.task_id), ["driver-i1-t1"]);
  } finally {
    h.cleanup();
  }
});

test("a relative --output-dir given from another directory lands under --project-root", async () => {
  const h = harness();
  try {
    const runDir = join(h.root, "records", "run1");
    h.scenario([COMPLETE], { runDir });
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve", "--output-dir=records/run1"], { cwd: h.work });
    assert.equal(code, 0);
    assert.ok(existsSync(join(runDir, "driver-events.jsonl")));
    assert.ok(!existsSync(join(h.work, "records")));
  } finally {
    h.cleanup();
  }
});

test("a stdout line that is not JSON is kept, truncated to 4096 characters", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ events: [`not json ${"x".repeat(5000)}`], ...COMPLETE }]);
    assert.equal((await h.run(args(h, "r1"))).code, 0);
    const unparsed = h.records("r1").find((r) => r.kind === "stdout_unparsed");
    assert.equal(unparsed.line.length, 4096);
    assert.ok(unparsed.line.startsWith("not json "));
  } finally {
    h.cleanup();
  }
});

test("input typed before a gate's question never answers it, at the first gate or a later one", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [
      { gates: [{ gate: 1, artifact: "requirements.md", decision: "pending" }], message: "Gate 1 block" },
      { gates: [{ gate: 1, decision: "approved" }, { gate: 2, artifact: "design.md", decision: "pending" }], message: "Gate 2 block", sleepMs: 600 },
      { gates: [{ gate: 2, decision: "approved" }, { gate: 4, decision: "accepted" }], summary: true },
    ]);
    const t = terminal([
      // The answer to Gate 1, then a stray Enter while codex works on the design.
      (stdin) => {
        stdin.write("approved\n");
        setTimeout(() => stdin.write("\n"), 150);
      },
      "revise: add rate limits\n",
    ]);
    t.stdin.write("typed before any gate\n");
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout });
    assert.equal(code, 0);
    const calls = h.calls();
    assert.equal(calls.length, 3);
    assert.ok(calls[1].argv.at(-1).startsWith("Gate 1 answer from the person: approved\n"));
    assert.ok(calls[2].argv.at(-1).startsWith("Gate 2 answer from the person: revise: add rate limits\n"));
    assert.equal(t.out().match(/\(ignored 1 line typed before this question\)/g)?.length, 2);
    const gates = readLines(join(h.runDirOf("r1"), "gates.jsonl"));
    assert.ok(!gates.some((g) => g.recorded_by === "run.mjs"), "the driver recorded no decision for the person");
  } finally {
    h.cleanup();
  }
});

test("under prompt, a question from the conductor is relayed and its answer does not use a turn", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [
      { question: "Which job type: docs or bugfix?", message: "Which job type should this run do: docs or bugfix?" },
      { gates: [{ gate: 4, decision: "accepted" }], summary: true },
    ]);
    const t = terminal(["bugfix\n"]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--max-turns=1"], { stdin: t.stdin, stdout: t.stdout });
    assert.equal(code, 0);
    assert.match(t.out(), /── The conductor has a question for you ──\nWhich job type should this run do: docs or bugfix\?\nYour answer: /);
    const calls = h.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].argv.at(-1).startsWith("Answer from the person to your question: bugfix\n"));
    assert.equal(h.records("r1").filter((r) => r.kind === "invocation_start")[1].gate_answer, true);
  } finally {
    h.cleanup();
  }
});

test("no answer to a question aborts; an unattended run whose conductor asks one stops at exit 4", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ question: "Which job type?" }]);
    const t = terminal([null]);
    assert.equal((await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout })).code, 4);
    assert.deepEqual(
      [h.records("r1").at(-1).outcome, h.records("r1").at(-1).reason],
      ["aborted", "no answer to the conductor's question"],
    );

    withScenario(h, "r2", [{ question: "Which job type?" }]);
    assert.equal((await h.run(args(h, "r2", "--max-turns=5"))).code, 4);
    assert.equal(h.calls().length, 2, "the unattended run was not resumed into the same question");
    const end = h.records("r2").at(-1);
    assert.equal(end.outcome, "stopped");
    assert.match(end.reason, /nobody can answer under --gates=auto-approve: Which job type\?/);
  } finally {
    h.cleanup();
  }
});

test("resuming an auto-aborted run with --gates=auto-approve tells the conductor to go past the stop", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, decision: "aborted", note: "auto-abort" }] }]);
    assert.equal((await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-abort"])).code, 4);
    withScenario(h, "r1", [COMPLETE]);
    const resumed = await h.run(["--project-root", h.root, "--resume=r1", "--gates=auto-approve", "--max-turns=3"]);
    assert.equal(resumed.code, 0);
    assert.equal(h.calls().length, 2, "one invocation, not --max-turns of them");
    const prompt = h.calls()[1].argv.at(-1);
    assert.match(prompt, /last stopped on purpose \(aborted: gate 1 aborted: auto-abort\)/);
    assert.match(prompt, /resumed it with --gates=auto-approve: they chose to continue past that stop/);
    assert.doesNotMatch(prompt, /say why again/);
  } finally {
    h.cleanup();
  }
});

test("a resumed conductor that stops again with a new record ends the resume at once", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, decision: "aborted" }] }]);
    assert.equal((await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-abort"])).code, 4);
    withScenario(h, "r1", [{ gates: [{ gate: 1, decision: "aborted", note: "still auto-abort" }] }]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1", "--max-turns=5"])).code, 4);
    withScenario(h, "r1", [{ stop: { reason: "the brief needs a decision from the person", needs: "which goal wins" } }]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1", "--gates=auto-approve", "--max-turns=5"])).code, 4);
    assert.equal(h.calls().length, 3);
    assert.equal(h.records("r1").at(-1).outcome, "stopped");
    const starts = h.records("r1").filter((r) => r.kind === "invocation_start");
    assert.deepEqual(starts.map((s) => s.gates), ["auto-abort", "auto-abort", "auto-approve"]);
  } finally {
    h.cleanup();
  }
});

test("the Continue line for a custom --output-dir names it, and running that line continues the same folder", async () => {
  const h = harness();
  try {
    const runDir = join(h.root, "records", "run1");
    h.scenario([{ fixture: "exec1" }], { runDir });
    const first = await h.run(args(h, "r1", "--output-dir=records/run1", "--max-turns=1"));
    assert.equal(first.code, 3);
    const line = first.out.split("\n").find((l) => l.includes("Continue:"));
    assert.ok(line.includes(` --output-dir='${runDir}'`), line);
    const argv = line.match(/--[a-z-]+=(?:'[^']*'|\S+)/g).map((a) => a.replace(/='(.*)'$/, "=$1"));

    h.scenario([{ fixture: "exec2" }, { fixture: "exec3", ...COMPLETE }], { runDir });
    assert.equal((await h.run(argv)).code, 0);
    assert.ok(!existsSync(join(h.root, ".sdlc", "runs")), "no second run folder");
    const m = JSON.parse(readFileSync(join(runDir, "driver-manifest.json"), "utf-8"));
    assert.equal(m.codex_invocations, 3);
    assert.deepEqual(m.driver_cost_flags, [], "priced from this folder's own earlier total");
    assert.equal(m.driver_cost_usd_modeled, 0.01494);
  } finally {
    h.cleanup();
  }
});

test("a run folder inside the code directory is refused before anything is spent", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    for (const extra of [["--output-dir=src"], ["--output-dir=src/records"], ["--output-dir=out", "--code-dir=out/app"], ["--output-dir=.sdlc/local"]]) {
      const { code, err } = await h.run(args(h, "r1", ...extra));
      assert.equal(code, 2, extra.join(" "));
      assert.match(err, /inside/);
    }
    assert.equal(h.calls().length, 0);
  } finally {
    h.cleanup();
  }
});

test("a fresh run renders its playbooks even when its folder already holds a skills/ copy", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.runDirOf("r1"), "skills"), { recursive: true });
    writeFileSync(join(h.runDirOf("r1"), "skills", "pipeline.md"), "stale\n");
    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(args(h, "r1"))).code, 0);
    assert.notEqual(readFileSync(join(h.runDirOf("r1"), "skills", "pipeline.md"), "utf-8"), "stale\n");
  } finally {
    h.cleanup();
  }
});

test("a run the cap stopped before its first spawn resumes with the policy, mode and gates it started with", async () => {
  const h = harness();
  try {
    const seen = [];
    const capped = (cap) => (name) => {
      seen.push(name);
      return { ...presetPolicy(name), hard_cost_cap_usd: cap };
    };
    withScenario(h, "r2", [COMPLETE]);
    assert.equal((await h.run(args(h, "r2", "--policy=gpt-seat-plus-flash"), { loadPolicy: capped(0) })).code, 4);
    assert.deepEqual(h.records("r2").map((r) => r.kind), ["run_end"]);

    assert.equal((await h.run(["--project-root", h.root, "--resume=r2"], { loadPolicy: capped(10) })).code, 0);
    assert.deepEqual(seen, ["gpt-seat-plus-flash", "gpt-seat-plus-flash"]);
    const start = h.records("r2").find((r) => r.kind === "invocation_start");
    assert.deepEqual(
      [start.policy, start.run_mode, start.gates, start.mode, start.resume_after],
      ["gpt-seat-plus-flash", "greenfield", "auto-approve", "fresh", "cost_cap"],
    );
    assert.ok(h.calls()[0].argv.includes("--skip-git-repo-check"));
  } finally {
    h.cleanup();
  }
});

test("a resume after a driver that left no run_end records resume_after killed", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{}]);
    assert.equal((await h.run(args(h, "r1", "--max-turns=1"))).code, 3);
    appendFileSync(
      join(h.runDirOf("r1"), "driver-events.jsonl"),
      JSON.stringify({ v: 1, kind: "invocation_start", run_id: "r1", invocation: 2, at: new Date().toISOString(), mode: "resume", resume_thread_id: THREAD, resume_after: "max_turns", policy: "gpt-plus-flash", gates: "auto-approve" }) + "\n",
    );
    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1"])).code, 0);
    const last = h.records("r1").filter((r) => r.kind === "invocation_start").at(-1);
    assert.equal(last.invocation, 3);
    assert.equal(last.resume_after, "killed");
  } finally {
    h.cleanup();
  }
});

test("a second signal kills codex at once, without waiting out the grace period", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 8000, ignoreTerm: true }]);
    const signals = new EventEmitter();
    const running = h.run(args(h, "r1"), { signals, killGraceMs: 20_000 });
    assert.ok(await waitFor(() => h.records("r1").some((r) => r.kind === "codex" && r.event.type === "turn.started")));
    signals.emit("SIGTERM");
    assert.ok(await waitFor(() => h.log().some((l) => l.signal === "SIGTERM")), "codex got the first signal and ignored it");
    const t0 = Date.now();
    signals.emit("SIGTERM");
    assert.equal((await running).code, 143, "the exit code names the first signal");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(h.records("r1").find((r) => r.kind === "invocation_end").signal, "SIGKILL");
  } finally {
    h.cleanup();
  }
});

test("Ctrl-C while the driver waits at a relayed gate exits 130 as interrupted, recording no gate decision", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, artifact: "requirements.md", decision: "pending" }] }]);
    const signals = new EventEmitter();
    const t = terminal([() => signals.emit("SIGINT")]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout, signals });
    assert.equal(code, 130);
    const end = h.records("r1").at(-1);
    assert.deepEqual([end.outcome, end.exit_code], ["interrupted", 130]);
    assert.equal(h.calls().length, 1);
    const gates = readLines(join(h.runDirOf("r1"), "gates.jsonl"));
    assert.ok(!gates.some((g) => g.recorded_by === "run.mjs"));
  } finally {
    h.cleanup();
  }
});

test("a driver that dies on an unexpected error takes codex's process group with it", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 8000 }]);
    const events = join(h.runDirOf("r1"), "driver-events.jsonl");
    const script = join(h.work, "dies.mjs");
    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { EventEmitter } from "node:events";',
        'import { existsSync, readFileSync } from "node:fs";',
        "const { main } = await import(process.env.RUN_MJS_URL);",
        "const quiet = { write: () => true };",
        "main(JSON.parse(process.env.DRIVER_ARGV), {",
        "  cwd: process.env.DRIVER_ROOT, env: process.env, stdin: { isTTY: false }, signals: new EventEmitter(),",
        "  stdout: quiet, stderr: quiet,",
        "  spawnFn: (bin, a, o) => spawn(process.execPath, [process.env.FAKE_CODEX, ...a], o),",
        "});",
        "const t = setInterval(() => {",
        '  if (existsSync(process.env.EVENTS) && readFileSync(process.env.EVENTS, "utf-8").includes(\'"turn.started"\')) {',
        "    clearInterval(t);",
        '    throw new Error("an unexpected error in the driver");',
        "  }",
        "}, 25);",
      ].join("\n"),
    );
    const driver = spawn(process.execPath, [script], {
      env: {
        ...h.env,
        RUN_MJS_URL: pathToFileURL(RUN_MJS).href,
        DRIVER_ARGV: JSON.stringify(args(h, "r1")),
        DRIVER_ROOT: h.root,
        FAKE_CODEX: FAKE,
        EVENTS: events,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const code = await new Promise((r) => driver.on("close", r));
    assert.notEqual(code, 0);
    const pid = h.records("r1")[0].pid;
    assert.ok(await waitFor(() => isGone(pid), 3000), "codex did not outlive the driver");
    assert.equal(h.records("r1").some((r) => r.kind === "run_end"), false);

    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1"])).code, 0);
    assert.equal(h.records("r1").filter((r) => r.kind === "invocation_start").at(-1).resume_after, "killed");
  } finally {
    h.cleanup();
  }
});

function fakeWrapper(h) {
  const wrapper = join(h.work, "codex");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

const turnStarted = (h, id) => h.records(id).some((r) => r.kind === "codex" && r.event.type === "turn.started");

test("with its output pipes gone (a closed terminal), SIGHUP is still forwarded and recorded, and the driver exits 129", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 6000 }]);
    const driver = spawn(process.execPath, [RUN_MJS, ...args(h, "r1"), `--codex-bin=${fakeWrapper(h)}`], {
      cwd: h.root,
      env: h.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((r) => driver.on("exit", (code, signal) => r({ code, signal })));
    assert.ok(await waitFor(() => turnStarted(h, "r1")));
    driver.stdout.destroy();
    driver.stderr.destroy();
    await sleep(100);
    driver.kill("SIGHUP");
    assert.deepEqual(await exited, { code: 129, signal: null });
    assert.ok(h.log().some((l) => l.signal === "SIGHUP"), "codex got the forwarded signal, not the exit hook's SIGKILL");
    const end = h.records("r1").find((r) => r.kind === "invocation_end");
    assert.deepEqual([end.ended_by, end.signal], ["driver_signal", "SIGHUP"]);
    const runEnd = h.records("r1").at(-1);
    assert.deepEqual([runEnd.kind, runEnd.outcome, runEnd.exit_code], ["run_end", "interrupted", 129]);
    assert.equal(h.manifest("r1").outcome, "interrupted");
  } finally {
    h.cleanup();
  }
});

test("a dead output pipe does not stop a run: codex's stderr and the run log still reach the run folder", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ sleepMs: 400, stderr: "fake-codex: a warning\n", ...COMPLETE }]);
    const driver = spawn(process.execPath, [RUN_MJS, ...args(h, "r1"), `--codex-bin=${fakeWrapper(h)}`], {
      cwd: h.root,
      env: h.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((r) => driver.on("exit", (code) => r(code)));
    assert.ok(await waitFor(() => turnStarted(h, "r1")));
    driver.stdout.destroy();
    driver.stderr.destroy();
    assert.equal(await exited, 0);
    assert.match(readFileSync(join(h.runDirOf("r1"), "driver-stderr.log"), "utf-8"), /fake-codex: a warning/);
    assert.match(readFileSync(join(h.runDirOf("r1"), "orchestrator.log"), "utf-8"), /run\.end/);
    assert.equal(h.records("r1").at(-1).outcome, "completed");
  } finally {
    h.cleanup();
  }
});

test("a terminal that closes at a relayed gate ends the run as interrupted, not as an aborted gate", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, artifact: "requirements.md", decision: "pending" }] }]);
    const signals = new EventEmitter();
    // The read fails first; the hangup signal lands a moment later.
    const t = terminal([
      (stdin) => {
        stdin.destroy(new Error("read EIO"));
        setTimeout(() => signals.emit("SIGHUP"), 30);
      },
    ]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout, signals });
    assert.equal(code, 129);
    assert.deepEqual([h.records("r1").at(-1).outcome, h.records("r1").at(-1).exit_code], ["interrupted", 129]);
    const gates = readLines(join(h.runDirOf("r1"), "gates.jsonl"));
    assert.ok(!gates.some((g) => g.recorded_by === "run.mjs"), "no gate decision was invented");
  } finally {
    h.cleanup();
  }
});

test("a run over its cap when a gate is waiting ends as cost_cap without asking the gate", async () => {
  const h = harness();
  try {
    const capped = (name) => ({ ...presetPolicy(name), hard_cost_cap_usd: 50 });
    withScenario(h, "r1", [
      { gates: [{ gate: 1, artifact: "requirements.md", decision: "pending" }], message: "Gate 1 block", telemetry: [{ cost_usd: 60, provenance: "vendor" }] },
      { gates: [{ gate: 1, decision: "approved" }] },
    ]);
    const t = terminal(["approved\n"]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout, loadPolicy: capped });
    assert.equal(code, 4);
    assert.equal(h.calls().length, 1);
    assert.doesNotMatch(t.out(), /is waiting for your answer/);
    const end = h.records("r1").at(-1);
    assert.equal(end.outcome, "cost_cap");
    assert.match(end.reason, /^COST_CAP_EXCEEDED[\s\S]* Gate 1 is still waiting for an answer\.$/);
    assert.deepEqual(readLines(join(h.runDirOf("r1"), "gates.jsonl")).map((g) => g.decision), ["pending"]);
  } finally {
    h.cleanup();
  }
});

test("abort typed at a gate ends the run, recorded once, whether or not the conductor records it", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, artifact: "requirements.md", decision: "pending" }], message: "Gate 1 block" }, {}, {}, {}]);
    const t = terminal(["abort: wrong product\n"]);
    const { code } = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--max-turns=3"], { stdin: t.stdin, stdout: t.stdout });
    assert.equal(code, 4);
    assert.equal(h.calls().length, 2, "the answer reached the conductor, and nothing ran after it");
    assert.ok(h.calls()[1].argv.at(-1).startsWith("Gate 1 answer from the person: abort: wrong product"));
    const end = h.records("r1").at(-1);
    assert.deepEqual([end.outcome, end.reason], ["aborted", "gate 1 aborted at the terminal"]);
    const { ts: _ts, ...typed } = readLines(join(h.runDirOf("r1"), "gates.jsonl")).at(-1);
    assert.deepEqual(typed, {
      gate: 1,
      artifact: null,
      decision: "aborted",
      note: "the person answered abort at the terminal",
      recorded_by: "run.mjs",
    });

    withScenario(h, "r2", [
      { gates: [{ gate: 2, artifact: "design.md", decision: "pending" }] },
      { gates: [{ gate: 2, decision: "aborted", note: "the person aborted" }] },
    ]);
    const t2 = terminal(["abort\n"]);
    const second = await h.run(["--project-root", h.root, "--run-id=r2", "--mode=greenfield"], { stdin: t2.stdin, stdout: t2.stdout });
    assert.equal(second.code, 4);
    assert.equal(h.records("r2").at(-1).reason, "gate 2 aborted: the person aborted");
    const gates = readLines(join(h.runDirOf("r2"), "gates.jsonl"));
    assert.equal(gates.filter((g) => g.decision === "aborted").length, 1);
    assert.ok(!gates.some((g) => g.recorded_by === "run.mjs"));
  } finally {
    h.cleanup();
  }
});

test("--resume is refused while another driver process still runs the run, and accepted once it is gone", async () => {
  const h = harness();
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const otherExited = new Promise((r) => other.on("exit", r));
  try {
    const startLine = (id, at) =>
      JSON.stringify({ v: 1, kind: "invocation_start", run_id: id, invocation: 2, at, mode: "resume", resume_thread_id: THREAD, policy: "gpt-plus-flash", gates: "auto-approve", driver_pid: other.pid }) + "\n";

    withScenario(h, "r1", [{}]);
    assert.equal((await h.run(args(h, "r1", "--max-turns=1"))).code, 3);
    appendFileSync(join(h.runDirOf("r1"), "driver-events.jsonl"), startLine("r1", new Date().toISOString()));
    withScenario(h, "r1", [COMPLETE]);
    const refused = await h.run(["--project-root", h.root, "--resume=r1"]);
    assert.equal(refused.code, 2);
    assert.match(refused.err, new RegExp(`still being driven by process ${other.pid} .*kill ${other.pid}`));
    assert.equal(h.calls().length, 1, "nothing was spawned");

    if (process.platform !== "win32") {
      // The pid now belongs to a process that started long after the record: the driver it named is gone.
      withScenario(h, "r2", [{}]);
      assert.equal((await h.run(args(h, "r2", "--max-turns=1"))).code, 3);
      appendFileSync(join(h.runDirOf("r2"), "driver-events.jsonl"), startLine("r2", "2000-01-01T00:00:00.000Z"));
      withScenario(h, "r2", [COMPLETE]);
      assert.equal((await h.run(["--project-root", h.root, "--resume=r2"])).code, 0);
    }

    other.kill("SIGKILL");
    await otherExited;
    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1"])).code, 0);
    assert.equal(h.records("r1").filter((r) => r.kind === "invocation_start").at(-1).resume_after, "killed");
  } finally {
    other.kill("SIGKILL");
    h.cleanup();
  }
});

const readManifest = (h, id) => JSON.parse(readFileSync(join(h.runDirOf(id), "manifest.json"), "utf-8"));

test("every run end leaves a code-written manifest.json; a max_turns stop has status incomplete and no SUMMARY.md", async () => {
  const h = harness();
  try {
    const telemetry = [{ ts: new Date().toISOString(), pass: "r1", phase: "requirements_analysis", model: "gpt-5.6-terra", provenance: "vendor", cost_usd: 0.25, input_tokens: 10, input_tokens_cached: 0, output_tokens: 5 }];
    withScenario(h, "r1", [{ telemetry, gates: [{ gate: 1, decision: "auto-approved" }] }]);
    assert.equal((await h.run(args(h, "r1", "--max-turns=1"))).code, 3);
    const m = readManifest(h, "r1");
    assert.equal(m.written_by, "plugin/scripts/write-manifest.mjs");
    assert.equal(m.status, "incomplete");
    assert.equal(m.route, "headless");
    assert.equal(m.run_id, "r1");
    assert.equal(m.pass, "r1");
    assert.equal(m.policy, "gpt-plus-flash");
    assert.equal(m.policy_name, "gpt-plus-flash");
    assert.equal(m.totals.dispatched_cost_usd, 0.25);
    assert.equal(m.driver.outcome, "max_turns");
    assert.equal(m.totals.driver_cost_usd_modeled, h.manifest("r1").driver_cost_usd_modeled);
    assert.equal(m.summary, null);
    assert.ok(!existsSync(join(h.runDirOf("r1"), "SUMMARY.md")), "only Phase 9 produces SUMMARY.md");
  } finally {
    h.cleanup();
  }
});

test("a completed run's SUMMARY.md is rendered again with the conductor's modeled cost, and says who accepted it", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    assert.equal((await h.run(args(h, "r1"))).code, 0);
    const m = readManifest(h, "r1");
    assert.equal(m.status, "auto-approved", "the gate mode approved Gate 4, not a person");
    assert.equal(m.driver.outcome, "completed");
    assert.equal(m.driver.driver_turns, 1);
    const summary = readFileSync(join(h.runDirOf("r1"), "SUMMARY.md"), "utf-8");
    const cost = h.manifest("r1").driver_cost_usd_modeled;
    // No session file in this CODEX_HOME: the collector books the exec stream and says so.
    assert.ok(summary.includes(`Conductor (driver) cost, modeled from driver-usage.json: $${cost.toFixed(4)}. Booked from the exec stream`), summary);
    assert.doesNotMatch(summary, /still going/);
    assert.match(summary, /Status: \*\*auto-approved\*\*/);

    const t = terminal(["accept\n"]);
    withScenario(h, "r2", [
      { gates: [{ gate: 4, decision: "pending" }], summary: true },
      { gates: [{ gate: 4, decision: "accepted" }], summary: true, summaryStatus: "accepted" },
    ]);
    const run2 = await h.run(["--project-root", h.root, "--run-id=r2", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout });
    assert.equal(run2.code, 0);
    assert.equal(readManifest(h, "r2").status, "accepted");
  } finally {
    h.cleanup();
  }
});

test("a manifest.json the run end cannot write is a warning: the run keeps its exit code", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 1, decision: "auto-approved" }], blockManifest: true }]);
    const { code, err } = await h.run(args(h, "r1", "--max-turns=1"));
    assert.equal(code, 3);
    assert.match(err, /manifest\.json was not written: /);
    assert.equal(h.records("r1").at(-1).kind, "run_end");
    assert.equal(h.manifest("r1").outcome, "max_turns", "driver-manifest.json is still rebuilt");
  } finally {
    h.cleanup();
  }
});

test("a SUMMARY.md the conductor wrote by hand does not complete the run, and the run end says why", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [{ gates: [{ gate: 4, decision: "auto-approved" }], handSummary: true }]);
    const { code, err } = await h.run(args(h, "r1", "--max-turns=1"));
    assert.equal(code, 3);
    assert.match(err, /SUMMARY\.md does not count as the final report: SUMMARY\.md was not written by plugin\/scripts\/write-manifest\.mjs/);
    assert.equal(readManifest(h, "r1").summary, null);
  } finally {
    h.cleanup();
  }
});

test("Phase 9's provisional SUMMARY.md does not end the run: the re-run after Gate 4 does", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [
      { gates: [{ gate: 4, decision: "auto-approved" }], summary: true, summaryStatus: null },
      { summary: true, summaryStatus: "auto-approved" },
    ]);
    const { code, out } = await h.run(args(h, "r1", "--max-turns=2"));
    assert.equal(code, 0);
    assert.equal(h.calls().length, 2, "the turn that left a provisional summary was resumed");
    assert.match(out, /run r1: completed — write-manifest\.mjs wrote SUMMARY\.md and Gate 4 was auto-approved/);
    assert.match(h.calls()[1].argv.at(-1), /run that command again with --status=accepted or --status=auto-approved/);
  } finally {
    h.cleanup();
  }
});

test("a completed run's reason names the Gate 4 decision: auto-approved unattended, accepted by a person", async () => {
  const h = harness();
  try {
    withScenario(h, "r1", [COMPLETE]);
    const run1 = await h.run(args(h, "r1"));
    assert.equal(run1.code, 0);
    const auto = "write-manifest.mjs wrote SUMMARY.md and Gate 4 was auto-approved";
    assert.equal(h.records("r1").at(-1).reason, auto);
    assert.equal(h.manifest("r1").outcome_reason, auto);
    assert.equal(readManifest(h, "r1").driver.outcome_reason, auto);
    assert.ok(run1.out.includes(`run r1: completed — ${auto}`), run1.out);
    assert.ok(readFileSync(join(h.runDirOf("r1"), "report.md"), "utf-8").includes(`completed (exit 0) — ${auto}`));

    const t = terminal(["accept\n"]);
    withScenario(h, "r2", [
      { gates: [{ gate: 4, decision: "pending" }], summary: true },
      { gates: [{ gate: 4, decision: "accepted" }], summary: true, summaryStatus: "accepted" },
    ]);
    const run2 = await h.run(["--project-root", h.root, "--run-id=r2", "--mode=greenfield"], { stdin: t.stdin, stdout: t.stdout });
    assert.equal(run2.code, 0);
    assert.equal(h.manifest("r2").outcome_reason, "write-manifest.mjs wrote SUMMARY.md and Gate 4 was accepted");
  } finally {
    h.cleanup();
  }
});
