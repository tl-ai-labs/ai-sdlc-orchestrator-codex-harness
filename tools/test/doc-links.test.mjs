/**
 * Every local markdown link in the repo must resolve.
 *
 * This exists because the port shipped six dangling link targets at once,
 * and one of them mattered a great deal: `plugin/skills/brownfield-guide/
 * SKILL.md` pointed the conductor at `plugin/agents/discovery.md` for the
 * discovery procedure, and that file had never been ported — so the
 * discovery phase had no instructions at all. A dead link in a skill is not
 * a documentation nit; the conductor follows these at run time.
 *
 * Deliberately covers skills and prompts as well as docs, since those are
 * the ones a model reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FILES = globSync(
  ["*.md", "docs/**/*.md", "plugin/**/*.md", ".github/**/*.md"],
  { cwd: REPO_ROOT, exclude: (p) => p.includes("node_modules") },
);

/** Markdown links to a local path, minus anchors, mailto:, and URLs. */
function localLinks(text) {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1].split("#")[0])
    .filter((t) => t && !/^(https?:|mailto:|#)/.test(t));
}

test("the repo has markdown worth checking", () => {
  assert.ok(FILES.length > 20, `expected a real corpus, found ${FILES.length}`);
});

test("every local markdown link resolves to a file that exists", () => {
  const broken = [];
  for (const file of FILES) {
    const text = readFileSync(join(REPO_ROOT, file), "utf-8");
    for (const target of localLinks(text)) {
      // A leading slash means repo-root-relative in this repo's convention;
      // anything else is relative to the linking file.
      const base = target.startsWith("/") ? REPO_ROOT : join(REPO_ROOT, dirname(file));
      const resolved = normalize(join(base, target.replace(/^\//, "")));
      if (!existsSync(resolved)) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `dangling markdown links:\n  ${broken.join("\n  ")}`);
});

test("no skill or prompt links into plugin/agents/, which this port does not have", () => {
  // Claude Code subagent definitions did not survive the port: three became
  // packet-instruction roles under plugin/skills/pipeline/roles/, discovery
  // became a procedure beside the brownfield guide, and the orchestrator
  // became the conductor prompt plus the pipeline skill. A new reference to
  // plugin/agents/ means someone reintroduced the subagent assumption.
  const offenders = FILES.filter((f) =>
    readFileSync(join(REPO_ROOT, f), "utf-8").includes("plugin/agents/"),
  );
  assert.deepEqual(offenders, [], `these still reference plugin/agents/: ${offenders.join(", ")}`);
});
