/** The rendered playbooks are complete on their own: no placeholder left, and every relative link resolves beside the copy. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RENDERED_SKILLS, renderPrompt, renderSkills } from "../../plugin/codex/render.mjs";
import * as run from "../../plugin/codex/run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugin");
const VALUES = {
  PLUGIN_ROOT: "/plug in",
  PROJECT_ROOT: "/proj",
  OUTPUT_DIR: "/proj/.sdlc/runs/r1",
  CODE_DIR: "/proj/src",
  BRIEF_PATH: "/proj/brief.md",
  POLICY: "gpt-plus-flash",
  RUN_ID: "r1",
};

function withRendered(fn) {
  const dir = mkdtempSync(join(tmpdir(), "render-test-"));
  try {
    return fn(dir, renderSkills(dir, VALUES, PLUGIN_ROOT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("run.mjs renders with the same functions the start script uses", () => {
  assert.equal(run.renderPrompt, renderPrompt);
  assert.equal(run.renderSkills, renderSkills);
  assert.equal(run.RENDERED_SKILLS, RENDERED_SKILLS);
});

test("every rendered file exists in the plugin and renders with no placeholder left", () => {
  withRendered((dir, written) => {
    assert.equal(written.length, RENDERED_SKILLS.length, "every listed source ships");
    for (const path of written) {
      assert.doesNotMatch(readFileSync(path, "utf-8"), /\{\{[A-Z_]+\}\}/, path);
    }
  });
});

test("a placeholder the values do not cover names the file it came from", () => {
  assert.throws(() => renderPrompt("x {{NOPE}}", {}, "skills/pipeline/SKILL.md"), /skills\/pipeline\/SKILL\.md has unrendered placeholder\(s\): \{\{NOPE\}\}/);
});

test("every relative link in a rendered copy resolves beside it", () => {
  withRendered((dir, written) => {
    const broken = [];
    for (const path of written) {
      for (const m of readFileSync(path, "utf-8").matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split("#")[0];
        if (!target || /^(https?:|mailto:|\/)/.test(target)) continue;
        if (!existsSync(join(dirname(path), target))) broken.push(`${path.slice(dir.length)} -> ${target}`);
      }
    }
    assert.deepEqual(broken, []);
  });
});

test("the rendered playbooks never send the model back to a raw SKILL.md", () => {
  withRendered((dir, written) => {
    for (const path of written) {
      assert.doesNotMatch(readFileSync(path, "utf-8"), /\]\([^)]*SKILL\.md\)/, `${path} links to an unrendered skill`);
    }
    const guide = readFileSync(join(dir, "skills", "brownfield-guide.md"), "utf-8");
    assert.match(guide, /Follow the pipeline playbook, `\/proj\/\.sdlc\/runs\/r1\/skills\/pipeline\.md`/);
    assert.match(guide, /`\/plug in\/config\/intents\.json`/);
  });
});
