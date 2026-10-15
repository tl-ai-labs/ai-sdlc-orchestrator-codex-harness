/** Both routes tell the conductor not to fetch toolchains or write helper scripts to drive the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderedSkillPath, renderPrompt, renderSkills } from "../../plugin/codex/render.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(REPO, "plugin");

function rules(text) {
  const at = text.indexOf("## The tools a run uses");
  assert.ok(at >= 0, "the section is there");
  const section = text.slice(at, text.indexOf("\n## ", at + 5));
  assert.match(section, /Do not fetch a\s+toolchain, runtime or\s+package manager yourself/);
  assert.match(section, /do not\s+write an executable helper \(a `\.py`, `\.sh` or `\.mjs` script\)/);
  assert.match(section, /`npm install` of the app's own dependencies/);
  return section;
}

test("the headless conductor prompt forbids fetched toolchains and helper scripts, and says how to stop", () => {
  const values = { PLUGIN_ROOT: PLUGIN, PROJECT_ROOT: "/p", OUTPUT_DIR: "/p/.sdlc/runs/r1", CODE_DIR: "/p/src", BRIEF_PATH: "/p/brief.md", POLICY: "gpt-plus-flash", RUN_ID: "r1", GATE_INSTRUCTION: "x", HANDOVER: "" };
  const section = rules(renderPrompt(readFileSync(join(PLUGIN, "codex", "prompts", "conductor.md"), "utf-8"), values));
  assert.ok(section.includes("/p/.sdlc/runs/r1/stop.json"));
});

test("the playbook a session renders carries the same rule", () => {
  const runDir = mkdtempSync(join(tmpdir(), "conductor-tools-"));
  try {
    renderSkills(runDir, { PLUGIN_ROOT: PLUGIN, PROJECT_ROOT: "/p", OUTPUT_DIR: runDir, CODE_DIR: "/p/src", BRIEF_PATH: "/p/brief.md", POLICY: "gpt-plus-flash", RUN_ID: "r1" }, PLUGIN);
    assert.match(rules(readFileSync(renderedSkillPath(runDir, "pipeline"), "utf-8")), /end the run with outcome `stopped`/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
