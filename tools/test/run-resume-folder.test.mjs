/**
 * A resumed session whose first prompt named another run folder is told this
 * run's folder and run id, on every resume, so it writes where the driver
 * looks for its Gate 4.
 */
import "./lib/stand-ins.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main, playbooksNote, RESUME_PROMPT, resumePrompt, runFolderNote } from "../../plugin/codex/run.mjs";
import { movedRunFolder } from "../../plugin/codex/run-folder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-codex.mjs");
const THREAD = "01a1340d-41da-7e31-84cd-b0907e9bc31f";
const OTHER_THREAD = "0f0f0f0f-0000-7000-8000-00000000abcd";
const COMPLETE = { gates: [{ gate: 1, decision: "auto-approved" }, { gate: 4, decision: "auto-approved" }], summary: true };

const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];

function harness() {
  const root = mkdtempSync(join(tmpdir(), "resume-folder-"));
  const work = mkdtempSync(join(tmpdir(), "resume-folder-work-"));
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const scenarioPath = join(work, "scenario.json");
  const logPath = join(work, "fake.log");
  const env = { ...process.env, CODEX_HOME: join(work, "codex-home"), FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: logPath };
  const runDirOf = (id) => join(root, ".sdlc", "runs", id);
  return {
    root,
    runDirOf,
    scenario(steps, extra = {}) {
      writeFileSync(scenarioPath, JSON.stringify({ projectRoot: root, steps, ...extra }));
      try { unlinkSync(`${scenarioPath}.state`); } catch { /* first scenario */ }
    },
    prompts: () => readLines(logPath).filter((l) => l.argv?.[0] === "exec").map((l) => l.argv.at(-1)),
    records: (id) => readLines(join(runDirOf(id), "driver-events.jsonl")),
    async run(argv) {
      let out = "";
      let err = "";
      const code = await main(argv, {
        cwd: root,
        env,
        spawnFn: (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], opts),
        stdin: { isTTY: false },
        signals: new EventEmitter(),
        stdout: { write: (s) => ((out += s), true) },
        stderr: { write: (s) => ((err += s), true) },
      });
      return { code, out, err };
    },
    cleanup() {
      for (const d of [root, work]) rmSync(d, { recursive: true, force: true });
    },
  };
}

test("a thread no run folder records is told the new folder and run id on every resume", async () => {
  const h = harness();
  try {
    const dir = h.runDirOf("r9");
    h.scenario([{}, {}], { runDir: dir });
    const r = await h.run(["--project-root", h.root, `--resume=${OTHER_THREAD}`, "--run-id=r9", "--mode=greenfield", "--gates=auto-approve", "--max-turns=2"]);
    assert.equal(r.code, 3, r.err);
    const prompts = h.prompts();
    assert.equal(prompts.length, 2);
    for (const p of prompts) {
      assert.ok(p.startsWith(`This run's folder is now '${dir}' and its run id is r9;`), p.slice(0, 200));
      assert.ok(p.includes(join(dir, "skills")), "it names where its playbooks are");
    }
    assert.ok(existsSync(join(dir, "skills", "pipeline.md")), "the playbooks are rendered for this folder");
    assert.equal(h.records("r9").find((x) => x.kind === "invocation_start").output_dir, dir);

    // A later driver process on that folder still tells it: the session's own first prompt has not changed.
    h.scenario([COMPLETE], { runDir: dir });
    const again = await h.run(["--project-root", h.root, "--resume=r9"]);
    assert.equal(again.code, 0, again.err);
    assert.ok(h.prompts()[2].startsWith(`This run's folder is now '${dir}'`));
  } finally {
    h.cleanup();
  }
});

test("a resume of the folder its session was started in says nothing about the folder", async () => {
  const h = harness();
  try {
    h.scenario([{}, COMPLETE], { runDir: h.runDirOf("r1") });
    const first = await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve", "--max-turns=1"]);
    assert.equal(first.code, 3, first.err);
    assert.equal(h.records("r1")[0].output_dir, h.runDirOf("r1"));
    assert.equal((await h.run(["--project-root", h.root, "--resume=r1"])).code, 0);
    const resumed = h.prompts()[1];
    assert.ok(resumed.startsWith(RESUME_PROMPT), resumed.slice(0, 200));
    assert.ok(!resumed.includes("This run's folder is now"));
    assert.ok(!resumed.includes("The plugin changed since"), "playbooks the plugin would render the same are not news");
  } finally {
    h.cleanup();
  }
});

test("a session first told another folder is told which one this run uses, and its playbooks are rendered again", async () => {
  const h = harness();
  try {
    const dir = h.runDirOf("r1");
    h.scenario([{}], { runDir: dir });
    assert.equal((await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve", "--max-turns=1"])).code, 3);
    const eventsPath = join(dir, "driver-events.jsonl");
    const old = join(h.root, "moved-from", "r1");
    writeFileSync(
      eventsPath,
      readFileSync(eventsPath, "utf-8").replace(JSON.stringify(dir).slice(1, -1), old.replace(/\\/g, "\\\\")),
    );
    writeFileSync(join(dir, "skills", "pipeline.md"), "stale\n");
    h.scenario([COMPLETE], { runDir: dir });
    const r = await h.run(["--project-root", h.root, "--resume=r1"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(h.prompts()[1].startsWith(`This run's folder is now '${dir}' and its run id is r1, not the folder '${old}' your first prompt named.`));
    assert.notEqual(readFileSync(join(dir, "skills", "pipeline.md"), "utf-8"), "stale\n");
  } finally {
    h.cleanup();
  }
});

test("a resume after the plugin changed renders the playbooks again and tells the session to re-read them", async () => {
  const h = harness();
  try {
    const dir = h.runDirOf("r1");
    h.scenario([{}], { runDir: dir });
    assert.equal((await h.run(["--project-root", h.root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve", "--max-turns=1"])).code, 3);
    const pipeline = join(dir, "skills", "pipeline.md");
    const current = readFileSync(pipeline, "utf-8");
    // A Phase 4 from before plan-packets.mjs: the playbook a run that stopped there was rendered with.
    writeFileSync(pipeline, current.replace(/### Phase 4 — plan_task_packets[\s\S]*?(?=### Phase 5)/, "### Phase 4 — plan_task_packets\n\n**Run metadata is yours, not the planner's.**\n\n"));
    h.scenario([COMPLETE], { runDir: dir });
    const r = await h.run(["--project-root", h.root, "--resume=r1"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(pipeline, "utf-8"), current, "the playbook is the plugin's again");
    const resumed = h.prompts()[1];
    assert.ok(resumed.startsWith(RESUME_PROMPT));
    assert.ok(resumed.includes(playbooksNote({ runDir: dir, names: ["pipeline"] })), resumed);
    assert.match(resumed, /pipeline\.md in '.*skills' were rendered again from it\. Read the playbook for the step you take up again/);
  } finally {
    h.cleanup();
  }
});

test("movedRunFolder reads the first invocation: a resumed thread is unknown, a fresh one is its own folder", () => {
  const dir = "/p/.sdlc/runs/r1";
  assert.deepEqual(movedRunFolder([], dir, { foreignThread: true }), { from: null });
  assert.equal(movedRunFolder([], dir), null);
  const start = (over) => ({ v: 1, kind: "invocation_start", invocation: 1, run_id: "r1", ...over });
  assert.equal(movedRunFolder([start({ mode: "fresh", output_dir: dir })], dir), null);
  assert.equal(movedRunFolder([start({ mode: "fresh" })], dir), null, "a record from before output_dir was kept");
  assert.deepEqual(movedRunFolder([start({ mode: "fresh", output_dir: "/old/r1" })], dir), { from: "/old/r1" });
  assert.deepEqual(movedRunFolder([start({ mode: "resume", resume_thread_id: THREAD })], dir), { from: null });
});

test("the folder note leads the resume prompt and the gate mode still closes it", () => {
  const p = resumePrompt("auto-approve", null, { runDir: "/p/r", runId: "r", from: null });
  assert.ok(p.startsWith(runFolderNote({ runDir: "/p/r", runId: "r" })));
  assert.ok(p.includes(RESUME_PROMPT));
  assert.match(p, /Gate mode for this invocation: You are running UNATTENDED/);
  assert.equal(resumePrompt("auto-approve").startsWith(RESUME_PROMPT), true);
});
