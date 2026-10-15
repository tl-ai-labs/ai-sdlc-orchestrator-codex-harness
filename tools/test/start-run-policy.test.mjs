/** start-run.mjs resolves the policy the bridge does, and starts nothing unless the session runs the driver pin. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main as startMain } from "../../plugin/codex/start-run.mjs";
import { main as endMain } from "../../plugin/codex/end-run.mjs";
import { sessionHome } from "./fixtures/session-home.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICIES = join(REPO_ROOT, "plugin", "config", "policies");
const CLAUDE_POLICIES = join(REPO_ROOT, "tools", "test", "fixtures", "policies", "claude");
const THREAD = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
const NOW = Date.parse("2026-10-13T10:15:00Z");
const homes = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

function home(threads = [THREAD], opts) {
  const h = sessionHome(threads, opts);
  homes.push(h);
  return h;
}
const PIN_HOME = home();

function sink() {
  let text = "";
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

function project({ override, defaultPolicy } = {}) {
  const base = mkdtempSync(join(tmpdir(), "start-run-policy-"));
  const root = join(base, "app");
  mkdirSync(root);
  writeFileSync(join(root, "brief.md"), "# Project Brief — x\n");
  if (override !== undefined) writeFileSync(join(root, "routing-policy.yaml"), override);
  if (defaultPolicy !== undefined) {
    mkdirSync(join(root, ".sdlc"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "project.json"), JSON.stringify({ default_policy: defaultPolicy }));
  }
  return { root, done: () => rmSync(base, { recursive: true, force: true }) };
}

function renamed(name) {
  return readFileSync(join(POLICIES, "gpt-plus-flash.yaml"), "utf-8").replace(/^name: .*$/m, `name: ${name}`);
}

async function start(root, argv, env = { CODEX_HOME: PIN_HOME, CODEX_THREAD_ID: THREAD }) {
  const stdout = sink();
  const stderr = sink();
  const code = await startMain(argv, {
    cwd: root, env, now: () => NOW, rand: () => "abc123", isGitRepo: () => true, gitToplevel: () => null, stdout, stderr,
  });
  return { code, out: stdout.text, err: stderr.text };
}

const runJson = (root, id) => JSON.parse(readFileSync(join(root, ".sdlc", "runs", id, "run.json"), "utf-8"));
const runsDir = (root) => join(root, ".sdlc", "runs");

test("the policy comes from routing-policy.yaml, then --policy, then the project default, then gpt-plus-flash", async () => {
  const cases = [
    [{}, [], "gpt-plus-flash", "builtin-default", "default"],
    [{ defaultPolicy: "gpt-seat-plus-flash" }, [], "gpt-seat-plus-flash", "project-default", "project.json"],
    [{ defaultPolicy: "gpt-seat-plus-flash.yaml" }, [], "gpt-seat-plus-flash", "project-default", "project.json"],
    [{ defaultPolicy: "gpt-seat-plus-flash" }, ["--policy=gpt-plus-flash-38"], "gpt-plus-flash-38", "flag", "--policy"],
    [{ override: renamed("my-custom") }, ["--policy=gpt-seat-plus-flash"], "my-custom", "project-override", "routing-policy.yaml"],
  ];
  for (const [setup, flags, name, source, label] of cases) {
    const p = project(setup);
    try {
      const r = await start(p.root, ["--mode=greenfield", "--run-id=r1", ...flags]);
      assert.equal(r.code, 0, r.err);
      const run = runJson(p.root, "r1");
      assert.equal(run.policy, name, JSON.stringify(setup));
      assert.equal(run.policy_source, source);
      assert.match(run.policy_sha256, /^[0-9a-f]{64}$/);
      assert.ok(r.out.includes(`policy: ${name} (from ${label})\n`), r.out);
      if (source === "project-override") {
        assert.equal(run.policy_path, join(p.root, "routing-policy.yaml"));
        assert.match(r.err, /is used instead of --policy=gpt-seat-plus-flash/);
      }
    } finally { p.done(); }
  }
});

test("a policy the bridge would refuse is refused before a run folder exists", async () => {
  const cases = [
    [{}, ["--policy=no-such-policy"], /Policy 'no-such-policy' not found at/],
    [{}, ["--policy=../x"], /is not a policy name/],
    [{}, ["--policy=opus-plus-flash"], /Policy 'opus-plus-flash' not found at/],
    [{ override: readFileSync(join(CLAUDE_POLICIES, "opus-plus-flash.yaml"), "utf-8") }, [], /names an Anthropic adapter \(builtin-anthropic\)/],
    [{ override: "version: 1\n" }, [], /routing-policy\.yaml/],
  ];
  for (const [setup, flags, re] of cases) {
    const p = project(setup);
    try {
      const r = await start(p.root, ["--mode=greenfield", ...flags]);
      assert.equal(r.code, 2, flags.join(" "));
      assert.match(r.err, re);
      assert.doesNotMatch(r.err, /start-run: run:/);
      assert.equal(existsSync(runsDir(p.root)), false);
    } finally { p.done(); }
  }
});

test("a session on another model starts no run and says how to switch", async () => {
  const p = project();
  try {
    const r = await start(p.root, ["--mode=greenfield"], { CODEX_HOME: home([THREAD], { model: "gpt-6.1-sol" }), CODEX_THREAD_ID: THREAD });
    assert.equal(r.code, 1);
    assert.match(r.err, /^start-run: no run started: this session must run gpt-5\.6-terra at effort high\./m);
    assert.match(r.err, /this session runs gpt-6\.1-sol/);
    assert.match(r.err, /\/model, choose gpt-5\.6-terra and effort high/);
    assert.match(r.err, /codex -s danger-full-access -m gpt-5\.6-terra -c model_reasoning_effort="high"/);
    assert.equal(existsSync(runsDir(p.root)), false, "a refused start leaves no run folder");
  } finally { p.done(); }
});

test("a session whose model cannot be read starts no run", async () => {
  const p = project();
  try {
    const noThread = await start(p.root, ["--mode=greenfield"], { CODEX_HOME: PIN_HOME });
    assert.equal(noThread.code, 1);
    assert.match(noThread.err, /unverified \(CODEX_THREAD_ID is not set/);
    assert.match(noThread.err, /codex -s danger-full-access -m gpt-5\.6-terra -c model_reasoning_effort="high"/);

    const noRollout = await start(p.root, ["--mode=greenfield"], { CODEX_HOME: home([]), CODEX_THREAD_ID: THREAD });
    assert.equal(noRollout.code, 1);
    assert.match(noRollout.err, /no rollout file for thread/);
    assert.equal(existsSync(runsDir(p.root)), false);
  } finally { p.done(); }
});

test("a turn with no effort runs codex's default level, which is not the pin's high", async () => {
  const p = project();
  try {
    const unset = home([THREAD], { effort: null });
    writeFileSync(join(unset, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-terra", default_reasoning_level: "medium" }] }));
    const r = await start(p.root, ["--mode=greenfield"], { CODEX_HOME: unset, CODEX_THREAD_ID: THREAD });
    assert.equal(r.code, 1);
    assert.match(r.err, /effort medium \(codex default\)/);

    const unknown = await start(p.root, ["--mode=greenfield"], { CODEX_HOME: home([THREAD], { effort: null }), CODEX_THREAD_ID: THREAD });
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /effort for gpt-5\.6-terra is not recorded/);
    assert.equal(existsSync(runsDir(p.root)), false);
  } finally { p.done(); }
});

test("a resume keeps the policy it started on and checks the session again", async () => {
  const p = project();
  try {
    assert.equal((await start(p.root, ["--mode=greenfield", "--run-id=r1"])).code, 0);
    const runDir = join(runsDir(p.root), "r1");
    const endOut = sink();
    assert.equal(await endMain([`--run-dir=${runDir}`, "--outcome=stopped", "--reason=x"], { cwd: p.root, stdout: endOut, stderr: sink() }), 0);
    const before = readFileSync(join(runDir, "run.json"), "utf-8");

    const other = await start(p.root, ["--resume=r1"], { CODEX_HOME: home(["t2"], { model: "gpt-6.1-sol" }), CODEX_THREAD_ID: "t2" });
    assert.equal(other.code, 1);
    assert.equal(readFileSync(join(runDir, "run.json"), "utf-8"), before, "a refused resume leaves run.json as it was");

    writeFileSync(join(p.root, "routing-policy.yaml"), renamed("my-custom"));
    const overridden = await start(p.root, ["--resume=r1"]);
    assert.equal(overridden.code, 2);
    assert.match(overridden.err, /--resume refused: the policy name differs/);
    rmSync(join(p.root, "routing-policy.yaml"));

    const again = await start(p.root, ["--resume=r1"]);
    assert.equal(again.code, 0, again.err);
    assert.equal(runJson(p.root, "r1").policy, "gpt-plus-flash");
  } finally { p.done(); }
});
