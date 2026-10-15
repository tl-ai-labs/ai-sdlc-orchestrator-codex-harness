import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectDriverUsage,
  inferProjectRoot,
  parseCollectorArgs,
  recordedPolicy,
  resolveCollectorPolicy,
} from "../../../scripts/collect-driver-usage.mjs";
import { SyntheticRollout, driverEventLines, inside, marker, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "..", "scripts", "collect-driver-usage.mjs");
const CONDUCTOR = "01a2000b-0000-7000-8000-0000000000c1";
const WORKER = "01a2000b-0000-7000-8000-0000000000e1";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const run = join(project, ".sdlc", "runs", "20261013-100000-greenfield-abc123");
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  return { root, home, project, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** An interactive conductor session with one worker codex_exec thread in the same CODEX_HOME. */
function interactiveRun(s) {
  const r = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui", source: "vscode" });
  const command = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(10000, 8000, 100) }] });
  const gate = r.turn({ text: "approve", responses: [{ usage: u(20000, 18000, 200) }] });
  r.write(s.home);
  const w = new SyntheticRollout({ threadId: WORKER });
  w.turn({ responses: [{ usage: u(16680, 0, 5264) }] });
  w.write(s.home);
  writeJsonl(join(s.run, "driver-session.jsonl"), [marker(CONDUCTOR, inside(command)), marker(CONDUCTOR, inside(gate))]);
  return { command, gate };
}

const cli = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8", env: { PATH: process.env.PATH, ...env } });

test("parseCollectorArgs accepts --k=v and --k v, repeats --thread, and refuses what it does not know", () => {
  const a = parseCollectorArgs(["/r", "--codex-home", "/h", `--thread=${CONDUCTOR}`, "--thread", WORKER, "--from-conductor", "--dry-run"]);
  assert.deepEqual(a, { runDir: "/r", threads: [CONDUCTOR, WORKER], fromConductor: true, dryRun: true, codexHome: "/h" });
  for (const bad of [[], ["/r", "--bogus"], ["/r", "--policy"], ["/r", "--route=sideways"], ["/r", "/s"], ["/r", "--policy=a", "--policy-path=b"], ["/r", "--dry-run=yes"], ["/r", "--thread=bad"]]) {
    assert.throws(() => parseCollectorArgs(bad), (err) => err.name === "Error" || err.constructor.name === "UsageError", bad.join(" "));
  }
  assert.throws(() => parseCollectorArgs(["/r", "--thread", "../x"]), /--thread '\.\.\/x' is not a codex thread id/);
});

test("the project root is read off the run folder's position", () => {
  assert.equal(inferProjectRoot("/p/.sdlc/runs/r1"), "/p");
  assert.equal(inferProjectRoot("/p/.sdlc"), "/p");
  assert.equal(inferProjectRoot("/p/out"), null);
});

test("the policy is the one the run recorded, else the default, and a project override wins over a name", () => {
  const s = sandbox();
  try {
    assert.equal(resolveCollectorPolicy({ runDir: s.run }).name, "gpt-plus-flash");
    writeJsonl(join(s.run, "driver-session.jsonl"), [{ ...marker(CONDUCTOR, "2026-10-13T10:00:00.000Z"), policy: "gpt-seat-plus-flash" }]);
    assert.equal(recordedPolicy(s.run), "gpt-seat-plus-flash");
    assert.equal(resolveCollectorPolicy({ runDir: s.run }).name, "gpt-seat-plus-flash");
    const shipped = readFileSync(join(HERE, "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml"), "utf-8");
    writeFileSync(join(s.project, "routing-policy.yaml"), shipped.replace(/^name: .*$/m, "name: project-override"));
    assert.equal(resolveCollectorPolicy({ runDir: s.run }).name, "project-override");
  } finally {
    s.done();
  }
});

test("the policy file the run recorded wins over a name while it still exists", () => {
  const s = sandbox();
  try {
    const shipped = readFileSync(join(HERE, "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml"), "utf-8");
    const priced = join(s.root, "priced-policy.yaml");
    writeFileSync(priced, shipped.replace(/^name: .*$/m, "name: priced-at-start"));
    const thread = "01a2000b-0000-7000-8000-0000000000d2";
    writeJsonl(join(s.run, "driver-events.jsonl"), [
      { v: 1, kind: "invocation_start", invocation: 1, at: "2026-10-13T10:00:00.000Z", mode: "fresh", policy: "gpt-seat-plus-flash", policy_path: priced },
      { v: 1, kind: "codex", invocation: 1, thread_id: thread, event: { type: "thread.started", thread_id: thread } },
    ]);
    writeFileSync(join(s.project, "routing-policy.yaml"), shipped.replace(/^name: .*$/m, "name: added-later"));
    assert.equal(recordedPolicy(s.run), priced);
    assert.equal(resolveCollectorPolicy({ runDir: s.run }).name, "priced-at-start");
    rmSync(priced);
    assert.equal(recordedPolicy(s.run), "gpt-seat-plus-flash", "a recorded file that is gone falls back to the recorded name");

    const session = join(s.project, ".sdlc", "runs", "20261013-110000-greenfield-def456");
    mkdirSync(session, { recursive: true });
    writeFileSync(priced, shipped.replace(/^name: .*$/m, "name: priced-at-start"));
    writeFileSync(join(session, "run.json"), JSON.stringify({ route: "interactive", policy: "priced-at-start", policy_path: priced }));
    assert.equal(resolveCollectorPolicy({ runDir: session }).name, "priced-at-start", "an interactive run's run.json names the file");
  } finally {
    s.done();
  }
});

test("an interactive run's driver-usage.json carries the conductor only, not the worker thread", () => {
  const s = sandbox();
  try {
    const { command, gate } = interactiveRun(s);
    const res = collectDriverUsage(s.run, { codexHome: s.home, env: {}, now: () => "2026-10-13T12:00:00.000Z" });
    assert.equal(res.ok, true);
    const written = JSON.parse(readFileSync(join(s.run, "driver-usage.json"), "utf-8"));
    for (const key of ["source", "thread_ids", "window", "turns", "cost_usd_modeled", "unpriced", "cross_check"]) {
      assert.ok(key in written, key);
    }
    assert.deepEqual(written.thread_ids, [CONDUCTOR]);
    assert.deepEqual(written.turns.map((t) => t.turn_id), [command.id, gate.id]);
    assert.equal(written.tokens.input_tokens, 30000);
    assert.equal(written.route, "interactive");
    assert.equal(written.provenance, "modeled");
    assert.equal(written.policy.name, "gpt-plus-flash");
    assert.equal(written.collected_at, "2026-10-13T12:00:00.000Z");
    assert.equal(written.cross_check, null);
  } finally {
    s.done();
  }
});

test("a re-run rewrites the file whole and changes nothing but collected_at", () => {
  const s = sandbox();
  try {
    interactiveRun(s);
    collectDriverUsage(s.run, { codexHome: s.home, env: {}, now: () => "2026-10-13T12:00:00.000Z" });
    const first = JSON.parse(readFileSync(join(s.run, "driver-usage.json"), "utf-8"));
    collectDriverUsage(s.run, { codexHome: s.home, env: {}, now: () => "2026-10-13T13:00:00.000Z" });
    const second = JSON.parse(readFileSync(join(s.run, "driver-usage.json"), "utf-8"));
    assert.deepEqual({ ...second, collected_at: null }, { ...first, collected_at: null });
    assert.notEqual(second.collected_at, first.collected_at);
  } finally {
    s.done();
  }
});

test("--from-conductor marks the closing turn so it falls inside the window", () => {
  const s = sandbox();
  try {
    interactiveRun(s);
    const r = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui", source: "vscode" });
    r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(10000, 8000, 100) }] });
    r.turn({ text: "approve", responses: [{ usage: u(20000, 18000, 200) }] });
    const closing = r.turn({ text: "approve gate 4", responses: [{ usage: u(5000, 4000, 50) }], end: null });
    r.write(s.home);
    const res = collectDriverUsage(s.run, {
      codexHome: s.home,
      env: { CODEX_THREAD_ID: CONDUCTOR },
      fromConductor: true,
      now: () => inside(closing, 2),
    });
    assert.equal(res.ok, true);
    assert.equal(res.report.turns.at(-1).turn_id, closing.id);
    assert.equal(res.report.window.provisional, true);
    assert.match(res.report.cost_source, /PROVISIONAL/);
    const markers = readFileSync(join(s.run, "driver-session.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(markers.at(-1).tool, "collect_driver_usage");
  } finally {
    s.done();
  }
});

test("--dry-run with --from-conductor measures as if marked and leaves driver-session.jsonl alone", () => {
  const s = sandbox();
  try {
    interactiveRun(s);
    const r = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui", source: "vscode" });
    r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(10000, 8000, 100) }] });
    r.turn({ text: "approve", responses: [{ usage: u(20000, 18000, 200) }] });
    const closing = r.turn({ text: "approve gate 4", responses: [{ usage: u(5000, 4000, 50) }], end: null });
    r.write(s.home);
    const markersPath = join(s.run, "driver-session.jsonl");
    const before = readFileSync(markersPath, "utf-8");
    const res = collectDriverUsage(s.run, {
      codexHome: s.home,
      env: { CODEX_THREAD_ID: CONDUCTOR },
      fromConductor: true,
      dryRun: true,
      now: () => inside(closing, 2),
    });
    assert.equal(res.ok, true);
    assert.equal(res.written, false);
    assert.equal(res.report.turns.at(-1).turn_id, closing.id);
    assert.equal(readFileSync(markersPath, "utf-8"), before);
    assert.equal(existsSync(join(s.run, "driver-usage.json")), false);
  } finally {
    s.done();
  }
});

test("a headless run folder gets its cross-check", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: CONDUCTOR });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
    const b = r.turn({ responses: [{ usage: u(3000, 900, 70) }] });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-events.jsonl"), driverEventLines(CONDUCTOR, [{ turn: a }, { turn: b }]));
    const res = collectDriverUsage(s.run, { codexHome: s.home, env: {} });
    assert.equal(res.report.route, "headless");
    assert.equal(res.report.cross_check.verdict, "equal");
    assert.equal(res.report.verified, true);
  } finally {
    s.done();
  }
});

test("the CLI prints the token cross-check per thread and invocation, and the file records what it was measured from", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: CONDUCTOR });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50, 10) }] });
    const b = r.turn({ responses: [{ usage: u(3000, 900, 70, 20) }] });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-events.jsonl"), driverEventLines(CONDUCTOR, [{ turn: a }, { turn: b }]));
    const out = cli([s.run, `--codex-home=${s.home}`]);
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split("\n");
    assert.match(lines[1], /^token cross-check: equal, verified \(exec stream\/session file, difference\)$/);
    assert.equal(lines[2], `  thread ${CONDUCTOR}: equal; input 4000/4000 (0), cached input 1100/1100 (0), output 120/120 (0), reasoning 30/30 (0)`);
    assert.equal(lines[3], `  invocation 1 (${CONDUCTOR}): equal; input 1000/1000 (0), cached input 200/200 (0), output 50/50 (0), reasoning 10/10 (0)`);
    assert.equal(lines[4], `  invocation 2 (${CONDUCTOR}): equal; input 3000/3000 (0), cached input 900/900 (0), output 70/70 (0), reasoning 20/20 (0)`);
    const written = JSON.parse(readFileSync(join(s.run, "driver-usage.json"), "utf-8"));
    assert.equal(written.inputs["driver-events.jsonl"], readFileSync(join(s.run, "driver-events.jsonl")).length);
    assert.equal(written.inputs["driver-session.jsonl"], 0);
  } finally {
    s.done();
  }
});

test("nothing to measure writes nothing; the CLI exits 1 and names the way out", () => {
  const s = sandbox();
  try {
    const res = collectDriverUsage(s.run, { codexHome: s.home, env: {} });
    assert.equal(res.ok, false);
    assert.equal(res.code, "no_threads");
    const out = cli([s.run, `--codex-home=${s.home}`]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /--thread=<id>/);
    assert.equal(existsSync(join(s.run, "driver-usage.json")), false);
  } finally {
    s.done();
  }
});

test("the CLI writes the file and prints one line; --dry-run prints the report and writes nothing", () => {
  const s = sandbox();
  try {
    interactiveRun(s);
    const dry = cli([s.run, "--codex-home", s.home, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).thread_ids[0], CONDUCTOR);
    assert.equal(existsSync(join(s.run, "driver-usage.json")), false);
    const real = cli([s.run, `--codex-home=${s.home}`]);
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /^driver usage: \$0\.\d{6} modeled, session file \(interactive/);
    assert.ok(existsSync(join(s.run, "driver-usage.json")));
    const bad = cli([s.run, "--nope"]);
    assert.equal(bad.status, 2);
    const badThread = cli([join(s.root, "empty"), "--thread=bad"]);
    assert.equal(badThread.status, 2);
    assert.match(badThread.stderr, /--thread 'bad' is not a codex thread id/);
    assert.doesNotMatch(badThread.stderr, /no conductor thread recorded/);
  } finally {
    s.done();
  }
});

test("a session file under the real home is never needed: CODEX_HOME in the environment is honoured", () => {
  const s = sandbox();
  try {
    interactiveRun(s);
    const res = collectDriverUsage(s.run, { env: { CODEX_HOME: s.home } });
    assert.equal(res.ok, true);
    assert.equal(res.report.threads[0].rollout, "found");
  } finally {
    s.done();
  }
});
