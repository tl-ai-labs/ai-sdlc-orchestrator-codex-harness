/** A bridge build older than its source is reported by verify-setup and at the start of both run routes. */
import "./lib/stand-ins.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BUILD_SLACK_MS, rebuildCommand, staleBridgeBuild, staleBuildWarning } from "../../plugin/codex/bridge-build.mjs";
import { evaluate } from "../../plugin/codex/verify-setup.mjs";
import { main as runMain } from "../../plugin/codex/run.mjs";
import { main as startMain } from "../../plugin/codex/start-run.mjs";
import { sessionHome } from "./fixtures/session-home.mjs";

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const T0 = new Date("2026-10-13T09:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);

function pluginRoot() {
  const root = mkdtempSync(join(tmpdir(), "bridge-build-"));
  temps.push(root);
  const server = join(root, "mcp", "model-dispatch");
  const put = (rel, when) => {
    const path = join(server, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x\n");
    utimesSync(path, when, when);
  };
  put("src/server.ts", T0);
  put("src/adapters/OpenAIAdapter.ts", T0);
  put("src/shims.d.ts", at(60_000));
  put("dist/server.js", at(1000));
  put("dist/adapters/OpenAIAdapter.js", at(1000));
  return { root, put };
}

test("a build newer than every source file matches; a .d.ts is not built and is left out", () => {
  assert.equal(staleBridgeBuild(pluginRoot().root), null);
});

test("an edited or added source file makes the build stale, past a copy's few milliseconds", () => {
  const p = pluginRoot();
  p.put("src/server.ts", at(1000 + BUILD_SLACK_MS - 500));
  assert.equal(staleBridgeBuild(p.root), null, "within the slack a copied tree can carry");
  p.put("src/server.ts", at(60_000));
  p.put("src/costCap.ts", T0);
  const stale = staleBridgeBuild(p.root);
  assert.deepEqual(stale.files, ["src/costCap.ts", "src/server.ts"]);
  const line = staleBuildWarning(stale, p.root);
  assert.match(line, /^the dispatch bridge's build is older than its source \(src\/costCap\.ts, src\/server\.ts\)/);
  assert.ok(line.endsWith(rebuildCommand(p.root)));
  assert.match(rebuildCommand(p.root), /^node '.*\/codex\/verify-setup\.mjs' --fix$/);
});

test("no build at all is left to the mcp-build check", () => {
  const p = pluginRoot();
  rmSync(join(p.root, "mcp", "model-dispatch", "dist"), { recursive: true });
  assert.equal(staleBridgeBuild(p.root), null);
});

test("verify-setup warns about a stale build and --fix repairs it, without blocking a run", () => {
  const base = {
    nodeMajor: 22,
    codexCli: { present: true, version: [0, 160, 1] },
    codexLogin: { loggedIn: true },
    hasNodeModules: true,
    hasDist: true,
    env: { OPENAI_API_KEY: "sk-x", GEMINI_API_KEY: "g-x" },
    policy: { name: "gpt-plus-flash", selected: true, source: "project-default", usesOpenAiKey: true },
  };
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
  const state = evaluate({ ...base, staleBuild: { files } });
  const problem = state.problems.find((x) => x.id === "mcp-build-stale");
  assert.equal(problem.severity, "warning");
  assert.match(problem.message, /older than its source \(src\/a\.ts, src\/b\.ts, src\/c\.ts, and 1 more\)/);
  assert.match(problem.fix, /--fix/);
  assert.equal(state.ok, true);
  assert.equal(evaluate({ ...base, staleBuild: null }).problems.some((x) => x.id === "mcp-build-stale"), false);
});

const STALE = { serverDir: "/plugin/mcp/model-dispatch", files: ["src/server.ts"] };

function sink() {
  let text = "";
  return { write: (s) => ((text += s), true), get text() { return text; } };
}

test("run.mjs warns at the start of a run whose bridge build is stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-build-run-"));
  temps.push(root);
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const run = async (staleBuild) => {
    const out = sink();
    const err = sink();
    const code = await runMain(["--project-root", root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve", "--codex-bin=fake-codex", "--dry-run"], {
      cwd: root, stdin: { isTTY: false }, signals: new EventEmitter(), stdout: out, stderr: err, staleBuild: () => staleBuild,
    });
    return { code, err: err.text };
  };
  const stale = await run(STALE);
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.err, /^run: the dispatch bridge's build is older than its source \(src\/server\.ts\), so this run would use the old bridge\. Rebuild it with node '.*verify-setup\.mjs' --fix$/m);
  assert.doesNotMatch((await run(null)).err, /build is older/);
});

test("start-run prints the warning as a line the skill relays, and in --json", async () => {
  const base = mkdtempSync(join(tmpdir(), "bridge-build-start-"));
  temps.push(base);
  const root = join(base, "app");
  mkdirSync(root);
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const thread = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
  const home = sessionHome([thread]);
  temps.push(home);
  const start = async (argv) => {
    const out = sink();
    const err = sink();
    const code = await startMain(argv, {
      cwd: root, env: { CODEX_HOME: home, CODEX_THREAD_ID: thread }, now: () => Date.parse("2026-10-13T10:15:00Z"),
      rand: () => "abc123", isGitRepo: () => true, gitToplevel: () => null, stdout: out, stderr: err, staleBuild: () => STALE,
    });
    return { code, out: out.text, err: err.text };
  };
  const text = await start(["--mode=greenfield", "--run-id=r1"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out.split("\n")[1], /^warning: the dispatch bridge's build is older than its source \(src\/server\.ts\)/);
  const json = await start(["--mode=greenfield", "--run-id=r2", "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.equal(JSON.parse(json.out).warnings.length, 1);
});
