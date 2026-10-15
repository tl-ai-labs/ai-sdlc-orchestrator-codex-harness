/** The skills agree with the driver on the run folder, the run id, gate state and where tests run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "skills");
const read = (name) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf-8");

test("the brownfield guide takes the run id and run folder it is handed", () => {
  const guide = read("brownfield-guide");
  assert.match(guide, /run_id: \{\{RUN_ID\}\}/);
  assert.match(guide, /output_dir: \{\{OUTPUT_DIR\}\}/);
  assert.doesNotMatch(guide, /YYYYMMDD-HHMMSS-<intent>-<slug>/, "the guide no longer mints its own id");
});

test("no run.mjs example passes --output-dir for brownfield, or the shared .sdlc as a run folder", () => {
  for (const name of ["brownfield-guide", "pass"]) {
    const text = read(name);
    assert.doesNotMatch(text, /--output-dir=\.sdlc\b/, name);
    for (const block of text.split(/\n(?=\S)/).filter((b) => b.includes("run.mjs") && b.includes("--mode=brownfield"))) {
      assert.doesNotMatch(block, /--output-dir/, `${name}: brownfield keeps the canonical folder`);
    }
  }
});

test("gate-pending state lives in the run folder, and gates follow the instruction given", () => {
  const pipeline = read("pipeline");
  assert.match(pipeline, /<output_dir>\/state\.json/);
  assert.doesNotMatch(pipeline, /\.sdlc\/local\/state\.json/);
  assert.doesNotMatch(read("brownfield-guide"), /\.sdlc\/local\/state\.json/);
  assert.match(pipeline, /follow the gate instruction you were\s+given/);
  assert.match(pipeline, /<output_dir>\/discovery\.md/);
});

test("greenfield Phase 7 runs the tests from the code directory, not the run folder", () => {
  const pipeline = read("pipeline");
  assert.match(pipeline, /```bash\ncd '<code_dir>'\n/);
  assert.doesNotMatch(pipeline, /```bash\ncd '?<output_dir>'?\n/);
  assert.match(pipeline, /cp \.env\.test '<that folder, absolute>\/\.env'/, "a code folder with a space stays one cp target");
});

test("the pass skill documents the exit codes run.mjs returns", () => {
  const pass = read("pass");
  for (const code of ["| 0 |", "| 1 |", "| 2 |", "| 3 |", "| 4 |", "| 128+n |"]) assert.ok(pass.includes(code), code);
  assert.match(pass, /--resume=<id>/);
});
