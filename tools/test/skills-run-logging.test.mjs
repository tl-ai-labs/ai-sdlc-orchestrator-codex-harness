/**
 * The pipeline playbook tells the conductor how to log phase boundaries, where every gate decision
 * is recorded, and how a run's end is recorded on each route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkCompleted, INTERACTIVE_OUTCOMES } from "../../plugin/codex/interactive-run.mjs";
import { renderedSkillPath, renderSkills } from "../../plugin/codex/render.mjs";
import { acceptedSummary } from "./fixtures/accepted-summary.mjs";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "skills");
const read = (p) => readFileSync(p, "utf-8");
const PIPELINE = join(SKILLS, "pipeline", "SKILL.md");
const BROWNFIELD = join(SKILLS, "brownfield-guide", "SKILL.md");

test("the Run logging section exists, names every outcome and the end command", () => {
  const text = read(PIPELINE);
  assert.match(text, /^## Run logging$/m);
  assert.match(text, /see "Run logging"\s+below/);
  const section = text.slice(text.indexOf("## Run logging"), text.indexOf("## Telemetry contract"));
  assert.match(section, /node '\{\{PLUGIN_ROOT\}\}\/codex\/end-run\.mjs' --run-dir='\{\{OUTPUT_DIR\}\}' --outcome=<outcome>/);
  assert.match(section, /node '\{\{PLUGIN_ROOT\}\}\/scripts\/mmo-log\.mjs' --event=phase\.start --run-dir='\{\{OUTPUT_DIR\}\}'/);
  for (const outcome of Object.keys(INTERACTIVE_OUTCOMES)) {
    assert.match(section, new RegExp(`^\\| \`${outcome}\` \\|`, "m"), `outcome ${outcome} is not in the table`);
  }
  assert.match(read(BROWNFIELD), /record the end \(`--outcome=aborted`\)/);
});

test("the guide records the end at every stop and at close-out, and says who records it on run.mjs", () => {
  const guide = read(BROWNFIELD);
  assert.match(guide, /\*\*Every stop ends the run's record\.\*\*/);
  assert.match(guide, /On the `run\.mjs` route the driver records it instead\./);
  assert.match(guide, /Record the end \(`--outcome=completed`, after Gate 4 is accepted\)/);
  const pipeline = read(PIPELINE);
  assert.match(pipeline, /\*\*Started by `run\.mjs`\*\* \(the run folder holds `driver-events\.jsonl`\)/);
  assert.match(pipeline, /\*\*Started from a `\$mmo-codex:\*` skill in a session\*\* \(the run folder holds `run\.json`\)/);
});

const JOB_ALIASES = ["bugfix", "deps", "docs", "feature-extend", "feature-new", "refactor", "test"];

function rendered() {
  const runDir = mkdtempSync(join(tmpdir(), "gate-record-"));
  renderSkills(runDir, {
    PLUGIN_ROOT: "/plugin", PROJECT_ROOT: "/proj", OUTPUT_DIR: runDir, CODE_DIR: "/proj/src",
    BRIEF_PATH: "/proj/brief.md", POLICY: "gpt-plus-flash", RUN_ID: "r1",
  });
  return {
    runDir,
    pipeline: read(renderedSkillPath(runDir, "pipeline")),
    guide: read(renderedSkillPath(runDir, "brownfield-guide")),
    done: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

test("the rendered playbook has the conductor record every gate in this run's gates.jsonl on both routes", () => {
  const r = rendered();
  try {
    const delivery = r.pipeline.slice(r.pipeline.indexOf("**Gate delivery.**"), r.pipeline.indexOf("### Gate 0"));
    assert.match(delivery, /in a session, the `gates:` line the start script printed/);
    assert.match(delivery, /On both routes, append every gate decision, Gate 0 included, as a new line to/);
    assert.ok(delivery.includes(`\`${join(r.runDir, "gates.jsonl")}\``), "the record names this run's own gates.jsonl");
    assert.doesNotMatch(delivery, /on the `run\.mjs` route, record the gate in/, "the record is not tied to one route");

    const shape = JSON.parse(/```json\n(.*)\n```/.exec(delivery)[1]);
    assert.deepEqual(Object.keys(shape), ["gate", "artifact", "decision", "note", "ts"]);
    acceptedSummary(r.runDir);
    for (const [decision, ok] of [["accepted", true], ["auto-approved", true], ["rejected", false]]) {
      assert.ok(shape.decision.split("|").includes(decision), decision);
      writeFileSync(join(r.runDir, "gates.jsonl"), JSON.stringify({ ...shape, gate: 4, decision }) + "\n");
      assert.equal(checkCompleted(r.runDir).ok, ok, `a Gate 4 line in the documented shape with ${decision}`);
    }

    const gate0 = r.guide.slice(r.guide.indexOf("# 5. Gate 0"), r.guide.indexOf("# 6. Run the pipeline"));
    assert.ok(gate0.includes(`Record the answer as a Gate 0 line in\n\`${join(r.runDir, "gates.jsonl")}\``));
    const step6 = r.guide.slice(r.guide.indexOf("# 6. Run the pipeline"), r.guide.indexOf("# 7. Close out"));
    assert.match(step6, /in a session, the `gates:` line the start script printed/);
    assert.ok(step6.includes(`\`${join(r.runDir, "gates.jsonl")}\``));
  } finally { r.done(); }
});

test("every session entry skill names the start script's gates: line as the gate instruction and gates.jsonl as the record", () => {
  for (const name of ["brownfield", ...JOB_ALIASES, "pass"]) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    const flat = text.replace(/\s+/g, " ");
    assert.match(flat, /The `gates:` line (it prints|the start script printed) is your gate instruction for this run\./, name);
    assert.match(flat, /record each decision as a new line in `gates\.jsonl` in the run folder/, name);
  }
  assert.match(read(join(SKILLS, "greenfield", "SKILL.md")), /Record each decision as a new line in `gates\.jsonl` in the run folder/);
});

test("greenfield and pass map the playbook's <output_dir> and <code_dir> to what the start script printed", () => {
  for (const name of ["greenfield", "pass"]) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    for (const re of [
      /`run_id:` the printed `run_id`/,
      /`output_dir:` the printed `run_dir`\. Wherever the playbook says `<output_dir>`/,
      /`code_dir:` the printed `code_dir`/,
      /`brief_path:` the printed `brief`/,
      /`telemetry_path:` `telemetry\.jsonl` in the run folder/,
    ]) {
      assert.match(text, re, `${name}: ${re}`);
    }
  }
});

test("the rendered gate log commands run as written and put each gate in orchestrator.log", () => {
  const pluginRoot = join(SKILLS, "..");
  const runDir = mkdtempSync(join(tmpdir(), "gate log "));
  try {
    renderSkills(runDir, {
      PLUGIN_ROOT: pluginRoot, PROJECT_ROOT: runDir, OUTPUT_DIR: runDir, CODE_DIR: runDir,
      BRIEF_PATH: join(runDir, "brief.md"), POLICY: "gpt-plus-flash", RUN_ID: "r1",
    }, pluginRoot);
    const pipeline = read(renderedSkillPath(runDir, "pipeline"));
    const section = pipeline.slice(pipeline.indexOf("## Run logging"), pipeline.indexOf("## Telemetry contract"));
    assert.doesNotMatch(section, /Gate decisions go to `gates\.jsonl`, not this log/);
    const command = (event) => section.split("\n").find((l) => l.includes(`--event=${event} `));
    for (const [event, line] of [
      ["gate.open", command("gate.open").replace("<N>", "2")],
      ["gate.resolved", command("gate.resolved").replace("<N>", "2").replace("<decision>", "approved")],
    ]) {
      assert.doesNotMatch(line, /[<>]/, `${event}: every slot is filled`);
      const r = spawnSync("/bin/sh", ["-c", line], { cwd: runDir, encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
    }
    const log = read(join(runDir, "orchestrator.log"));
    assert.match(log, /INFO +gate\.open run_id=r1 gate=2\n/);
    assert.match(log, /INFO +gate\.resolved run_id=r1 gate=2 decision=approved\n/);

    const gateRecord = pipeline.slice(pipeline.indexOf("**Gate record.**"), pipeline.indexOf("### Gate 0"));
    assert.match(gateRecord, /Log each gate's opening and resolution as "Run\s+logging" below says\./);
    assert.match(read(renderedSkillPath(runDir, "brownfield-guide")), /and log the gate \(`--gate=0`\) as its "Run logging" section says\./);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});
