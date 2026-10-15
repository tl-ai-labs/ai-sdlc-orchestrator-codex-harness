/** The playbooks hand Phase 9 to write-manifest.mjs, and the command they give runs as written. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESUME_PROMPT, WRITE_MANIFEST_MJS, renderPrompt } from "../../plugin/codex/run.mjs";
// offline.test.mjs reads `read("codex", ...)` below as a codex call; the stand-ins answer that scan.
import "./lib/stand-ins.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");
const read = (...parts) => readFileSync(join(PLUGIN, ...parts), "utf-8");
const flat = (text) => text.replace(/\s+/g, " ");
const PIPELINE = read("skills", "pipeline", "SKILL.md");
const CONDUCTOR = read("codex", "prompts", "conductor.md");

const phase9 = (text) => text.slice(text.indexOf("### Phase 9"), text.indexOf("\n---", text.indexOf("### Phase 9")));

test("the pipeline's Phase 9 is the write-manifest.mjs command, and the model writes neither file", () => {
  const p9 = phase9(PIPELINE);
  assert.match(p9, /node '\{\{PLUGIN_ROOT\}\}\/scripts\/write-manifest\.mjs' '\{\{OUTPUT_DIR\}\}'/);
  assert.match(p9, /--run-id=\{\{RUN_ID\}\} --policy=\{\{POLICY\}\}/);
  assert.match(p9, /--summary/);
  assert.ok(flat(p9).includes("Do not write manifest.json or SUMMARY.md yourself"));
  assert.doesNotMatch(PIPELINE, /Build rollup manifest/);
  assert.doesNotMatch(PIPELINE, /write a brief `<output_dir>\/SUMMARY\.md`/);
  assert.doesNotMatch(PIPELINE, /say so in `SUMMARY\.md`/, "the summary is code's, so the model is not told to write into it");
  assert.doesNotMatch(flat(p9), /nothing was written/, "a failed run can leave a SUMMARY.md behind");
  assert.ok(flat(p9).includes("a `SUMMARY.md` it left behind does not count"));
});

test("Gate 4 re-runs Phase 9 with the acceptance, after the brownfield close-out", () => {
  const gate4 = flat(PIPELINE.slice(PIPELINE.indexOf("### Gate 4")));
  assert.match(gate4, /run the Phase 9 command again with `--status=accepted` added/);
  assert.match(gate4, /add `--status=auto-approved` instead/);
  assert.match(gate4, /`totals\.dispatched_cost_usd`/);
  const closeOut = read("skills", "brownfield-guide", "SKILL.md");
  const step7 = closeOut.slice(closeOut.indexOf("# 7. Close out"));
  const close = step7.indexOf("write-contract.mjs' --close");
  const rerun = step7.indexOf("--status=accepted");
  const end = step7.indexOf("Record the end (`--outcome=completed`");
  assert.ok(close > -1 && rerun > -1 && end > -1, "step 7 closes the contract, re-runs Phase 9 and records the end");
  assert.ok(close < rerun, "the contract is closed before the Phase 9 re-run that completes the run");
  assert.ok(rerun < end, "the end is recorded only after the completing re-run");
});

test("the conductor prompt gives the same command and the same rule", () => {
  assert.match(CONDUCTOR, /node '\{\{PLUGIN_ROOT\}\}\/scripts\/write-manifest\.mjs' '\{\{OUTPUT_DIR\}\}'/);
  assert.ok(flat(CONDUCTOR).includes("Do not write manifest.json or SUMMARY.md yourself"));
  assert.match(flat(CONDUCTOR), /run the same command again with `--status=accepted`/);
  assert.doesNotMatch(CONDUCTOR, /do not write `SUMMARY\.md`/);
});

test("a resumed conductor is told the Phase 9 command, which exists", () => {
  assert.ok(RESUME_PROMPT.includes(`node '${WRITE_MANIFEST_MJS}'`));
  assert.ok(flat(RESUME_PROMPT).includes("do not write manifest.json or SUMMARY.md yourself"));
  assert.match(RESUME_PROMPT, /and any close-out your playbook gives is done, run that command again/, "the completing re-run comes after the close-out");
  assert.ok(existsSync(WRITE_MANIFEST_MJS));
});

test("the Phase 9 command, rendered as the driver renders the playbook, runs and writes both files", () => {
  const root = mkdtempSync(join(tmpdir(), "phase9 cmd-"));
  try {
    const runDir = join(root, ".sdlc", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "telemetry.jsonl"), JSON.stringify({ ts: "2026-10-13T10:00:00.000Z", phase: "codegen", model: "m", cost_usd: 0.5, input_tokens: 1, input_tokens_cached: 0, output_tokens: 1, provenance: "vendor" }) + "\n");
    const rendered = renderPrompt(phase9(PIPELINE), {
      PLUGIN_ROOT: PLUGIN,
      OUTPUT_DIR: runDir,
      RUN_ID: "r1",
      POLICY: "gpt-plus-flash",
      PROJECT_ROOT: root,
      CODE_DIR: join(root, "src"),
    });
    const command = /```\n(node [\s\S]*?)\n```/.exec(rendered)[1];
    const r = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8"));
    assert.equal(m.run_id, "r1");
    assert.equal(m.totals.dispatched_cost_usd, 0.5);
    assert.ok(existsSync(join(runDir, "SUMMARY.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
