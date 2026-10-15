/** A run started from a `$mmo-codex:*` skill: start-run.mjs creates and renders it, end-run.mjs records how it ended. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { main as startMain, parseStartArgs, START_FLAGS } from "../../plugin/codex/start-run.mjs";
import { main as endMain, reportScript } from "../../plugin/codex/end-run.mjs";
import { checkCompleted, INTERACTIVE_OUTCOMES } from "../../plugin/codex/interactive-run.mjs";
import { finalizeRun } from "../../plugin/codex/run-finalize.mjs";
import { resolveRun, RUN_RECORD_FILES } from "../../plugin/codex/run-folder.mjs";
import { isMain } from "../../plugin/scripts/lib/is-main.mjs";
import { sessionHome } from "./fixtures/session-home.mjs";
import { acceptedSummary } from "./fixtures/accepted-summary.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugin");
const START = join(PLUGIN_ROOT, "codex", "start-run.mjs");
const MMO_LOG = join(PLUGIN_ROOT, "scripts", "mmo-log.mjs");
const THREAD = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
const NOW = Date.parse("2026-10-13T10:15:00Z");
/** Every session these tests start from runs the driver pin. */
const SESSION_HOME = sessionHome([THREAD, "second-thread"]);
after(() => rmSync(SESSION_HOME, { recursive: true, force: true }));

function sink() {
  let text = "";
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

function project(name = "app") {
  const base = mkdtempSync(join(tmpdir(), "interactive-run-"));
  const root = join(base, `my ${name}`);
  mkdirSync(root);
  return { base, root, done: () => rmSync(base, { recursive: true, force: true }) };
}

function greenfield(root) {
  writeFileSync(join(root, "brief.md"), "# Project Brief — x\n");
}

async function start(root, argv, { env, ...extra } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await startMain(argv, {
    cwd: root,
    env: { CODEX_HOME: SESSION_HOME, CODEX_THREAD_ID: THREAD, ...env },
    now: () => NOW,
    rand: () => "abc123",
    isGitRepo: () => true,
    gitToplevel: () => null,
    stdout,
    stderr,
    ...extra,
  });
  return { code, out: stdout.text, err: stderr.text };
}

async function end(root, argv, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await endMain(argv, { cwd: root, now: () => NOW + 60_000, stdout, stderr, ...extra });
  return { code, out: stdout.text, err: stderr.text };
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));

test("a greenfield start renders the playbooks with real paths and records the interactive route", async () => {
  const p = project();
  try {
    greenfield(p.root);
    const r = await start(p.root, ["--mode=greenfield", "--policy=gpt-plus-flash"]);
    assert.equal(r.code, 0, r.err);
    const runId = "20261013-101500-greenfield-abc123";
    const runDir = join(p.root, ".sdlc", "runs", runId);

    const run = readJson(join(runDir, "run.json"));
    assert.equal(run.route, "interactive");
    assert.equal(run.run_id, runId);
    assert.equal(run.mode, "greenfield");
    assert.equal(run.policy, "gpt-plus-flash");
    assert.equal(run.policy_source, "flag");
    assert.equal(run.policy_path, join(PLUGIN_ROOT, "config", "policies", "gpt-plus-flash.yaml"));
    assert.deepEqual(run.pin, { model: "gpt-5.6-terra", effort: "high" });
    assert.equal(run.code_dir, join(p.root, "src"));
    assert.equal(run.brief_path, join(p.root, "brief.md"));
    assert.equal(run.plugin_root, PLUGIN_ROOT);
    assert.equal(run.outcome, null);
    assert.deepEqual(run.starts, [{
      at: new Date(NOW).toISOString(), codex_thread_id: THREAD, resume: false, gates: "prompt",
      session_model: { model: "gpt-5.6-terra", effort: "high", effort_source: "turn" },
    }]);

    const pipeline = readFileSync(join(runDir, "skills", "pipeline.md"), "utf-8");
    assert.doesNotMatch(pipeline, /\{\{[A-Z_]+\}\}/);
    assert.ok(pipeline.includes(`node '${PLUGIN_ROOT}/codex/dispatch.mjs'`));
    assert.ok(pipeline.includes(`--telemetry='${runDir}/telemetry.jsonl'`));
    assert.ok(pipeline.includes(`node '${PLUGIN_ROOT}/codex/end-run.mjs' --run-dir='${runDir}' --outcome=<outcome>`), "the playbook carries this run's end command");
    assert.ok(pipeline.includes(`--event=phase.start --run-dir='${runDir}' --run-id=${runId} --phase=<phase>`));
    for (const f of ["brownfield-guide.md", "discovery.md", "roles/architect.md"]) assert.ok(existsSync(join(runDir, "skills", f)), f);

    const log = readFileSync(join(runDir, "orchestrator.log"), "utf-8");
    assert.match(log, new RegExp(`run\\.start run_id=${runId} route=interactive mode=greenfield policy=gpt-plus-flash gates=prompt`));
    assert.match(log, new RegExp(`thread_id=${THREAD}`));

    assert.match(r.out, new RegExp(`^run_id: ${runId}$`, "m"));
    assert.ok(r.out.includes(`playbook: ${join(runDir, "skills", "pipeline.md")}\n`));
    assert.ok(r.out.includes(`end_run: node '${PLUGIN_ROOT}/codex/end-run.mjs' --run-dir='${runDir}' --outcome=<outcome>`));
    assert.match(r.out, /^gates: prompt — The user is in this session\./m);
    assert.doesNotMatch(r.out, /^brownfield_guide:/m);
  } finally { p.done(); }
});

test("a brownfield start resolves the repo, keeps the record canonical and points at the guide", async () => {
  const p = project("repo");
  try {
    const sub = join(p.root, "pkg");
    mkdirSync(sub);
    const r = await start(sub, ["--mode=brownfield", "--intent=bugfix"], { gitToplevel: () => p.root });
    assert.equal(r.code, 0, r.err);
    const runId = "20261013-101500-bugfix-abc123";
    const runDir = join(p.root, ".sdlc", "runs", runId);
    const run = readJson(join(runDir, "run.json"));
    assert.equal(run.project_root, p.root);
    assert.equal(run.code_dir, p.root);
    assert.equal(run.intent, "bugfix");
    assert.equal(run.brief_path, join(runDir, "intent_brief.md"));
    const guide = readFileSync(join(runDir, "skills", "brownfield-guide.md"), "utf-8");
    assert.match(guide, new RegExp(`run_id: ${runId}`));
    assert.ok(r.out.includes(`brownfield_guide: ${join(runDir, "skills", "brownfield-guide.md")}\n`));
    assert.ok(r.out.includes(`Next: read ${join(runDir, "skills", "brownfield-guide.md")} and follow it.`));
  } finally { p.done(); }
});

test("a brownfield start in a real git repository works without injected checks", async () => {
  const p = project("git");
  try {
    if (spawnSync("git", ["init", "-q", p.root]).status !== 0) return;
    const stdout = sink();
    const stderr = sink();
    const env = { CODEX_HOME: SESSION_HOME, CODEX_THREAD_ID: THREAD };
    const code = await startMain(["--mode=brownfield"], { cwd: p.root, env, stdout, stderr });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /^run_id: \d{8}-\d{6}-brownfield-[0-9a-f]{6}$/m);
  } finally { p.done(); }
});

test("start-run refuses before writing anything when the run cannot start", async () => {
  const p = project();
  try {
    const cases = [
      [["--mode=greenfield"], /no brief at/],
      [["--policy=gpt-plus-flash"], /--mode=greenfield or --mode=brownfield is required/],
      [["--mode=sideways"], /--mode=sideways is not one of/],
      [["--mode=greenfield", "--intent=bugfix", "--brief=x.md"], /no brief at|--intent applies to brownfield/],
      [["--mode=brownfield", "--intent=nope"], /--intent=nope is not one of/],
      [["--mode=brownfield", "--brief=b.md"], /--brief is for greenfield/],
      [["--mode=greenfield", "--output-dir=out"], /--output-dir is a run\.mjs flag/],
      [["--mode=brownfield", "--seed=fix it"], /--seed is a run\.mjs flag/],
      [["--mode=greenfield", "--gates=maybe"], /--gates=maybe is not one of/],
      [["--mode=greenfield", "--run-id=../x"], /cannot name a folder/],
      [["--mode=greenfield", "stray"], /unexpected argument 'stray'/],
      [["--mode=greenfield", "--policy"], /--policy needs a value/],
    ];
    for (const [argv, re] of cases) {
      const r = await start(p.root, argv);
      assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.err, re, argv.join(" "));
    }
    const notGit = await start(p.root, ["--mode=brownfield"], { isGitRepo: () => false });
    assert.equal(notGit.code, 2);
    assert.match(notGit.err, /is not a git repository\. Brownfield needs git/);
    assert.equal(existsSync(join(p.root, ".sdlc")), false, "a refused start leaves no folder behind");
  } finally { p.done(); }
});

test("a named run id that already holds a record is refused, whichever route wrote it", async () => {
  const p = project();
  try {
    greenfield(p.root);
    assert.equal((await start(p.root, ["--mode=greenfield", "--run-id=r1"])).code, 0);
    const again = await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    assert.equal(again.code, 2);
    assert.match(again.err, /run r1 already has a record/);
    const headless = join(p.root, ".sdlc", "runs", "h1");
    mkdirSync(headless, { recursive: true });
    writeFileSync(join(headless, "driver-events.jsonl"), "{}\n");
    assert.equal((await start(p.root, ["--mode=greenfield", "--run-id=h1"])).code, 2);
  } finally { p.done(); }
});

test("completed needs an accepted Gate 4 and the SUMMARY.md Phase 9's re-run wrote; nothing is written until both are there", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    const before = readFileSync(join(runDir, "run.json"), "utf-8");

    let r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=completed"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /needs SUMMARY\.md in the run folder \(Phase 9\) and a Gate 4 line in gates\.jsonl/);
    assert.equal(readFileSync(join(runDir, "run.json"), "utf-8"), before);

    writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
    appendFileSync(join(runDir, "gates.jsonl"), '{"gate": 4, "decision": "accepted"}\n{"gate": 4, "decision": "rejected", "note": "fix the README"}\n');
    r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=completed"]);
    assert.equal(r.code, 2, "the latest Gate 4 line decides");
    assert.match(r.err, /Gate 4 accepted \(the latest Gate 4 line says 'rejected'\)/);

    appendFileSync(join(runDir, "gates.jsonl"), 'not json\n{"gate": "gate-4", "status": "approved", "run_id": "r1"}\n');
    r = await end(p.root, ["--run-dir=.sdlc/runs/r1", "--outcome=completed"]);
    assert.equal(r.code, 2, "a hand-written SUMMARY.md is not the final report");
    assert.match(r.err, /a SUMMARY\.md written by Phase 9's command \(SUMMARY\.md was not written by plugin\/scripts\/write-manifest\.mjs/);

    acceptedSummary(runDir, { status: "provisional" });
    r = await end(p.root, ["--run-dir=.sdlc/runs/r1", "--outcome=completed"]);
    assert.equal(r.code, 2, "Phase 9's first, provisional SUMMARY.md comes before Gate 4");
    assert.match(r.err, /Phase 9's command run again with --status=accepted after Gate 4 \(manifest\.json's status is provisional\)/);
    assert.equal(readFileSync(join(runDir, "run.json"), "utf-8"), before);

    acceptedSummary(runDir);
    r = await end(p.root, ["--run-dir=.sdlc/runs/r1", "--outcome=completed"]);
    assert.equal(r.code, 0, r.err);
    const run = readJson(join(runDir, "run.json"));
    assert.equal(run.outcome, "completed");
    assert.equal(run.deliberate, null);
    assert.equal(run.ended_at, new Date(NOW + 60_000).toISOString());
    assert.match(readFileSync(join(runDir, "orchestrator.log"), "utf-8"), /run\.end run_id=r1 route=interactive outcome=completed driver_outcome=completed/);
    assert.match(r.out, /^run r1: completed$/m);
    assert.doesNotMatch(r.out, /Continue:/);
    assert.equal(existsSync(join(runDir, "driver-cost-modeled.jsonl")), false, "an interactive run has no exec stream to model");
    assert.equal(existsSync(join(runDir, "driver-manifest.json")), false);
    const manifest = readJson(join(runDir, "manifest.json"));
    assert.deepEqual([manifest.route, manifest.status, manifest.driver], ["interactive", "accepted", null]);
    assert.equal(checkCompleted(runDir).ok, true, "the run end renders SUMMARY.md again and it still counts");

    r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=aborted", "--reason=too late"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /already completed/);
  } finally { p.done(); }
});

test("completion evidence reads both gate-line shapes the conductor writes", () => {
  const p = project();
  try {
    acceptedSummary(p.root);
    for (const line of ['{"gate":4,"decision":"auto-approved"}', '{"gate":"4","status":"accepted"}', '{"gate":"Gate-4","decision":"Accept"}']) {
      writeFileSync(join(p.root, "gates.jsonl"), `${line}\n`);
      assert.equal(checkCompleted(p.root).ok, true, line);
    }
    writeFileSync(join(p.root, "gates.jsonl"), '{"gate":3,"decision":"approved"}\n');
    assert.equal(checkCompleted(p.root).ok, false);
  } finally { p.done(); }
});

test("a stop is recorded with its reason, and the run can be resumed from it", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1", "--policy=gpt-plus-flash"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");

    let r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=aborted"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--outcome=aborted needs --reason/);
    assert.equal((await end(p.root, [`--run-dir=${runDir}`, "--outcome=finished"])).code, 2);

    r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=aborted", "--reason=gate 1 aborted: wrong scope"]);
    assert.equal(r.code, 0, r.err);
    let run = readJson(join(runDir, "run.json"));
    assert.equal(run.outcome, "aborted");
    assert.equal(run.deliberate, true);
    assert.equal(run.reason, "gate 1 aborted: wrong scope");
    assert.match(
      readFileSync(join(runDir, "orchestrator.log"), "utf-8"),
      /WARN +run\.end run_id=r1 route=interactive outcome=aborted driver_outcome=aborted reason="gate 1 aborted: wrong scope"/,
    );
    assert.ok(r.out.includes(`Continue:    node '${START}' --resume=r1 --project-root='${p.root}'`));

    assert.equal((await start(p.root, ["--resume=r1", "--policy=gpt-seat-plus-flash"])).code, 2, "a resumed run keeps its policy");
    assert.equal((await start(p.root, ["--resume=r1", "--code-dir=lib"])).code, 2);
    r = await start(p.root, ["--resume=r1", "--gates=auto-abort"], { env: { CODEX_THREAD_ID: "second-thread" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Resumed run r1 /m);
    run = readJson(join(runDir, "run.json"));
    assert.equal(run.outcome, null);
    assert.equal(run.reason, null);
    assert.equal(run.gates, "auto-abort");
    assert.deepEqual(run.starts.map((s) => [s.codex_thread_id, s.resume]), [[THREAD, false], ["second-thread", true]]);
    const starts = readFileSync(join(runDir, "orchestrator.log"), "utf-8").split("\n").filter((l) => l.includes("run.start"));
    assert.equal(starts.length, 2);
    assert.match(starts[1], /resume=true/);

    assert.equal(INTERACTIVE_OUTCOMES.failed.deliberate, false);
    r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=failed", "--reason=bridge crashed"]);
    assert.match(readFileSync(join(runDir, "orchestrator.log"), "utf-8"), /outcome=failed driver_outcome=failed/);
  } finally { p.done(); }
});

test("--resume refuses a completed run, a headless run and an unknown id", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    acceptedSummary(runDir);
    writeFileSync(join(runDir, "gates.jsonl"), '{"gate":4,"decision":"accepted"}\n');
    assert.equal((await end(p.root, [`--run-dir=${runDir}`, "--outcome=completed"])).code, 0);
    let r = await start(p.root, ["--resume=r1"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /already completed/);

    const headless = join(p.root, ".sdlc", "runs", "h1");
    mkdirSync(headless, { recursive: true });
    writeFileSync(join(headless, "driver-events.jsonl"), "{}\n");
    r = await start(p.root, ["--resume=h1"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /started by run\.mjs; continue it with node .*run\.mjs' --resume=h1/);
    assert.equal((await start(p.root, ["--resume=nope"])).code, 2);
  } finally { p.done(); }
});

test("--resume checks an --intent against intents.json when the run recorded none, keeps it, and refuses a change", async () => {
  const p = project();
  try {
    await start(p.root, ["--mode=brownfield", "--run-id=b1"]);
    const runDir = join(p.root, ".sdlc", "runs", "b1");
    const log = () => readFileSync(join(runDir, "orchestrator.log"), "utf-8");
    const stop = () => end(p.root, [`--run-dir=${runDir}`, "--outcome=stopped", "--reason=paused"]);
    assert.equal(readJson(join(runDir, "run.json")).intent, null);
    assert.equal((await stop()).code, 0);

    const before = readFileSync(join(runDir, "run.json"), "utf-8");
    const logBefore = log();
    let r = await start(p.root, ["--resume=b1", "--intent=bogus"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--intent=bogus is not one of .*bugfix/);
    assert.equal(readFileSync(join(runDir, "run.json"), "utf-8"), before, "a refused resume writes nothing");
    assert.equal(log(), logBefore);

    r = await start(p.root, ["--resume=b1", "--intent=bugfix"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^intent: bugfix$/m);
    assert.equal(readJson(join(runDir, "run.json")).intent, "bugfix");
    assert.match(log().split("\n").filter((l) => l.includes("run.start")).at(-1), /intent=bugfix .*resume=true/);

    assert.equal((await stop()).code, 0);
    r = await start(p.root, ["--resume=b1", "--intent=docs"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--intent=docs differs from run b1's intent \(bugfix\)/);
    r = await start(p.root, ["--resume=b1"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(readJson(join(runDir, "run.json")).intent, "bugfix", "a resume without --intent keeps the recorded one");

    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=g1"]);
    await end(p.root, [`--run-dir=${join(p.root, ".sdlc", "runs", "g1")}`, "--outcome=stopped", "--reason=paused"]);
    r = await start(p.root, ["--resume=g1", "--intent=bugfix"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--intent applies to brownfield runs/);
  } finally { p.done(); }
});

test("end-run refuses a folder with no interactive record", async () => {
  const p = project();
  try {
    const headless = join(p.root, ".sdlc", "runs", "h1");
    mkdirSync(headless, { recursive: true });
    writeFileSync(join(headless, "driver-events.jsonl"), "{}\n");
    let r = await end(p.root, [`--run-dir=${headless}`, "--outcome=stopped", "--reason=x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /started by run\.mjs, which records how its run ends itself/);
    r = await end(p.root, ["--outcome=stopped", "--reason=x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--run-dir=<path> is required/);
  } finally { p.done(); }
});

test("the run-end steps get the interactive context, and a failing one still leaves the record", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    let seen = null;
    let r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=halted", "--reason=preflight: no Gemini credentials"], {
      loadFinalize: async () => ({ finalizeRun: async (ctx) => { seen = ctx; } }),
    });
    assert.equal(r.code, 0);
    const { env: seenEnv, ...rest } = seen;
    assert.ok(seenEnv && typeof seenEnv === "object", "the run end gets the environment, so the collector can find the session");
    assert.deepEqual(rest, {
      route: "interactive",
      projectRoot: p.root,
      runDir,
      runId: "r1",
      mode: "greenfield",
      outcome: "halted",
      deliberate: true,
      reason: "preflight: no Gemini credentials",
      policyName: "gpt-plus-flash",
      codeDir: join(p.root, "src"),
    });
    r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=stopped", "--reason=x"], {
      loadFinalize: async () => ({ finalizeRun: async () => { throw new Error("manifest failed"); } }),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /the run's end is recorded, but a run-end step failed: manifest failed/);
    assert.equal(readJson(join(runDir, "run.json")).outcome, "stopped");
  } finally { p.done(); }
});

test("finalizeRun leaves the driver files alone on the interactive route and still writes manifest.json", async () => {
  const p = project();
  try {
    const ctx = { route: "interactive", projectRoot: p.root, runDir: p.root, runId: "r1", outcome: "aborted" };
    let out = await finalizeRun({ ...ctx, policyName: "gpt-plus-flash" });
    assert.equal(out.driverManifest, null);
    assert.equal(existsSync(join(p.root, "driver-manifest.json")), false);
    assert.equal(existsSync(join(p.root, "driver-cost-modeled.jsonl")), false);
    const m = readJson(join(p.root, "manifest.json"));
    assert.deepEqual([m.route, m.status, m.driver, m.policy], ["interactive", "aborted", null, "gpt-plus-flash"]);
    assert.equal(existsSync(join(p.root, "SUMMARY.md")), false, "only a completed run end renders SUMMARY.md");

    out = await finalizeRun({ ...ctx, env: { CODEX_HOME: join(p.root, "no-codex-home") } });
    assert.ok(out.notes.includes("manifest.json was not written: --policy is missing"), "a run with no policy recorded is a note, not a failed end");
    assert.ok(out.notes.some((n) => /^driver usage: not collected \(no conductor thread recorded/.test(n)), out.notes.join("\n"));
    assert.ok(out.notes.some((n) => /ran outside the codex session/.test(n)), "no CODEX_THREAD_ID: the closing turn has no marker, and the note says so");
  } finally { p.done(); }
});

test("end-run prints the run-end notes, such as a manifest.json it could not write, and still exits 0", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    const loadFinalize = async () => ({ finalizeRun: async () => ({ driverManifest: null, manifest: null, notes: ["manifest.json was not written: disk full"] }) });
    const r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=stopped", "--reason=x"], { loadFinalize });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^  manifest\.json was not written: disk full$/m);
  } finally { p.done(); }
});

test("the CLI prints the run and exits 0, or names the problem and exits 2", () => {
  const p = project();
  try {
    greenfield(p.root);
    const env = { ...process.env, CODEX_HOME: SESSION_HOME, CODEX_THREAD_ID: THREAD };
    let r = spawnSync("node", [START, "--mode=greenfield", "--json"], { cwd: p.root, env, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.route, "interactive");
    assert.ok(existsSync(join(result.run_dir, "run.json")));
    assert.equal(result.playbook, join(result.run_dir, "skills", "pipeline.md"));
    r = spawnSync("node", [START, "--mode=greenfield", "--brief=missing.md"], { cwd: p.root, env, encoding: "utf-8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^start-run: no brief at /m);
  } finally { p.done(); }
});

test("mmo-log --run-dir writes to that folder's log and keeps the flag out of the fields", () => {
  const p = project();
  try {
    const runDir = join(p.root, "custom run");
    const r = spawnSync("node", [MMO_LOG, "--event=phase.start", `--run-dir=${runDir}`, "--run-id=r1", "--phase=codegen", `--project-root=${p.root}`], {
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    const line = readFileSync(join(runDir, "orchestrator.log"), "utf-8");
    assert.match(line, /phase\.start run_id=r1 phase=codegen\n$/);
    assert.doesNotMatch(line, /run_dir/);
    assert.equal(existsSync(join(p.root, ".sdlc", "runs", "r1", "orchestrator.log")), false);
  } finally { p.done(); }
});

test("start-run's flag list matches what it parses", () => {
  for (const flag of START_FLAGS.value) assert.doesNotThrow(() => parseStartArgs([`--${flag}=x`]), flag);
  assert.deepEqual(parseStartArgs(["--mode", "greenfield", "--json"]), { mode: "greenfield", json: true });
});

test("start-run hands over the playbook's <output_dir>, <code_dir> and <telemetry_path>, and the gate record shape", async () => {
  const p = project();
  try {
    greenfield(p.root);
    const r = await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    assert.equal(r.code, 0, r.err);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    assert.ok(
      r.out.includes(
        `In the playbooks, <output_dir> is ${runDir}, <code_dir> is ${join(p.root, "src")}, ` +
          `and <telemetry_path> is ${join(runDir, "telemetry.jsonl")}.\n`,
      ),
      r.out,
    );
    assert.match(r.out, /^gates: prompt — .* Record every gate decision as a new line in gates\.jsonl in the run folder: \{"gate": N, /m);
  } finally { p.done(); }
});

test("ending a run again with the same outcome keeps the first record and runs only the run-end steps", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    let finalized = 0;
    const loadFinalize = async () => ({ finalizeRun: async () => { finalized += 1; } });
    const runEnds = () => readFileSync(join(runDir, "orchestrator.log"), "utf-8").split("\n").filter((l) => l.includes("run.end"));

    const argv = [`--run-dir=${runDir}`, "--outcome=aborted", "--reason=gate 1 aborted"];
    assert.equal((await end(p.root, argv, { loadFinalize })).code, 0);
    const first = readFileSync(join(runDir, "run.json"), "utf-8");
    const r = await end(p.root, argv, { loadFinalize, now: () => NOW + 120_000 });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`already recorded at ${new Date(NOW + 60_000).toISOString()}`));
    assert.equal(readFileSync(join(runDir, "run.json"), "utf-8"), first, "ended_at does not move");
    assert.equal(runEnds().length, 1);
    assert.equal(finalized, 2);

    acceptedSummary(runDir);
    writeFileSync(join(runDir, "gates.jsonl"), '{"gate": 4, "decision": "accepted"}\n');
    const completed = [`--run-dir=${runDir}`, "--outcome=completed"];
    assert.equal((await end(p.root, completed, { loadFinalize })).code, 0);
    const done = readFileSync(join(runDir, "run.json"), "utf-8");
    assert.equal((await end(p.root, completed, { loadFinalize, now: () => NOW + 180_000 })).code, 0);
    assert.equal(readFileSync(join(runDir, "run.json"), "utf-8"), done);
    assert.equal(runEnds().filter((l) => l.includes("outcome=completed")).length, 1);
  } finally { p.done(); }
});

test("end-run says when this install has no cost report script", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r1"]);
    const runDir = join(p.root, ".sdlc", "runs", "r1");
    const bare = join(p.base, "installed-plugin");
    mkdirSync(join(bare, "scripts"), { recursive: true });
    assert.equal(reportScript(bare), null);
    const r = await end(p.root, [`--run-dir=${runDir}`, "--outcome=stopped", "--reason=x"], { pluginRoot: bare });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`Cost report: none in this install; the run's telemetry is ${join(runDir, "telemetry.jsonl")}\n`), r.out);
    assert.doesNotMatch(r.out, /Cost report: node /);
  } finally { p.done(); }
});

test("run.mjs refuses a folder that holds a session run's record, and points at start-run --resume", async () => {
  const p = project();
  try {
    greenfield(p.root);
    await start(p.root, ["--mode=greenfield", "--run-id=r9"]);
    assert.ok(RUN_RECORD_FILES.includes("run.json"));
    assert.throws(
      () => resolveRun({ projectRoot: p.root, runIdFlag: "r9", mode: "greenfield" }),
      /run r9 already has a record from a codex session \(.*run\.json\); continue it from a session with start-run\.mjs --resume=r9, or choose a new --run-id\./,
    );
    assert.throws(
      () => resolveRun({ projectRoot: p.root, resume: "r9", mode: "greenfield" }),
      /--resume=r9: run r9 already has a record from a codex session .*start-run\.mjs --resume=r9\./,
    );
    assert.equal(existsSync(join(p.root, ".sdlc", "runs", "r9", "driver-events.jsonl")), false);
  } finally { p.done(); }
});

test("the start and end scripts run when reached through a symlinked plugin folder", () => {
  const p = project();
  try {
    greenfield(p.root);
    const link = join(p.base, "plugin-link");
    symlinkSync(PLUGIN_ROOT, link, "dir");
    const env = { ...process.env, CODEX_HOME: SESSION_HOME, CODEX_THREAD_ID: THREAD };
    let r = spawnSync("node", [join(link, "codex", "start-run.mjs"), "--mode=greenfield", "--json"], { cwd: p.root, env, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.ok(existsSync(join(result.run_dir, "run.json")));
    r = spawnSync("node", [join(link, "codex", "end-run.mjs"), `--run-dir=${result.run_dir}`, "--outcome=stopped", "--reason=x"], {
      cwd: p.root,
      env,
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^run ${result.run_id}: stopped — x$`, "m"));
  } finally { p.done(); }
});

test("isMain compares real paths, and is false for another script or none", () => {
  const p = project();
  try {
    const real = join(p.root, "cli.mjs");
    writeFileSync(real, "");
    const link = join(p.base, "cli-link.mjs");
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    assert.equal(isMain(url, real), true);
    assert.equal(isMain(url, link), true);
    assert.equal(isMain(url, START), false);
    assert.equal(isMain(url, undefined), false);
    assert.equal(isMain(url, join(p.base, "missing.mjs")), false);
  } finally { p.done(); }
});
