/** Gate 0 shows the policy the run already dispatches with, and a different one restarts the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderedSkillPath, renderSkills } from "../../plugin/codex/render.mjs";
import { sessionHome } from "./fixtures/session-home.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");
const read = (p) => readFileSync(p, "utf-8");

test("the rendered Gate 0 names this run's policy and restarts the run to change it", () => {
  const base = mkdtempSync(join(tmpdir(), "gate0 policy "));
  const project = join(base, "repo");
  mkdirSync(project);
  const thread = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
  const codexHome = sessionHome([thread]);
  try {
    const runDir = join(project, ".sdlc", "runs", "r1");
    renderSkills(runDir, {
      PLUGIN_ROOT, PROJECT_ROOT: project, OUTPUT_DIR: runDir, CODE_DIR: project,
      BRIEF_PATH: join(runDir, "intent_brief.md"), POLICY: "gpt-seat-plus-flash", RUN_ID: "r1",
    }, PLUGIN_ROOT);
    const guide = read(renderedSkillPath(runDir, "brownfield-guide"));
    const pipeline = read(renderedSkillPath(runDir, "pipeline"));

    const bullet = guide.slice(guide.indexOf("- **Policy** —"), guide.indexOf("- **Existing AI setup**"));
    assert.match(bullet, /show `gpt-seat-plus-flash`, the policy this run dispatches with/);
    assert.match(bullet, /end\s+this run \(`--outcome=aborted`, reason `restart with policy <name>`\)/);
    assert.match(bullet, /`--policy=<name>`/);
    assert.match(bullet, /\(from routing-policy\.yaml\)/);
    const template = pipeline.slice(pipeline.indexOf("> - **Policy:**"), pipeline.indexOf("> - **Existing AI setup:**"));
    assert.match(template, /`gpt-seat-plus-flash`, the policy every dispatch in this run uses/);
    for (const text of [bullet, template]) assert.doesNotMatch(text, /for this run only/);

    const restart = bullet.split("\n").map((l) => l.trim()).find((l) => l.includes("codex/start-run.mjs"))
      .replace(/^`|`,?$/g, "").replace("<confirmed intent>", "bugfix").replace("<name>", "gpt-plus-flash");
    assert.doesNotMatch(restart, /[<>{}]/, restart);
    assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
    const env = { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: thread };
    const r = spawnSync("/bin/sh", ["-c", restart], { cwd: project, env, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Started run \S+ \(interactive, brownfield, policy gpt-plus-flash\)\./m);
    const fresh = readdirSync(join(project, ".sdlc", "runs")).filter((d) => d !== "r1");
    assert.equal(fresh.length, 1);
    const run = JSON.parse(read(join(project, ".sdlc", "runs", fresh[0], "run.json")));
    assert.deepEqual([run.intent, run.policy, run.policy_source], ["bugfix", "gpt-plus-flash", "flag"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
