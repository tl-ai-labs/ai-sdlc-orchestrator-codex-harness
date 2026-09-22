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
import { dirname, join, resolve, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Markdown under the roots that matter, walked by hand.
 *
 * `fs.globSync` landed in Node 22 and this repo supports Node 20 — the CI
 * job pins it, package.json declares it, and env-checks.mjs enforces it. The
 * import threw `does not provide an export named 'globSync'` on the first CI
 * run this branch ever got, taking the whole file down before a single
 * assertion ran.
 */
function markdownUnder(rel) {
  const abs = join(REPO_ROOT, rel);
  const acc = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) acc.push(relative(REPO_ROOT, full));
    }
  };
  walk(abs);
  return acc;
}

const FILES = [
  ...readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name),
  ...["docs", "plugin", ".github", "examples"].flatMap(markdownUnder),
];

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

test("no markdown teaches the Claude harness's dead command syntax", () => {
  // `examples/workforce-ops/README.md` shipped `/mmo:pass --auth --study`
  // for the whole port: slash commands codex never expands, and two flags
  // run.mjs does not have. skills.test.mjs bans the same syntax but only
  // under plugin/skills/, and this file's glob did not reach examples/ —
  // so nothing caught it. Both gaps close here.
  const dead = [
    [/\/mmo:/, "'/mmo:' is Claude Code syntax; codex uses $mmo-codex:<name>"],
    [/--auth[= ]/, "'--auth' is a Claude-harness flag; the dispatcher takes --auth-mode"],
    [/--study[= ]/, "'--study' is a Claude-harness flag and does not exist here"],
  ];
  const offenders = [];
  for (const rel of FILES) {
    // The verification file is a historical record of the port itself and
    // quotes the source harness's surface on purpose.
    if (rel.startsWith("docs/verification/")) continue;
    // Inline spans (`...`) are stripped so a doc can name dead syntax as an
    // anti-example — the same escape hatch style.test.mjs gives. Fenced
    // blocks are NOT stripped: a runnable block is where the offender was.
    const text = readFileSync(join(REPO_ROOT, rel), "utf8")
      .split(/^```/m)
      .map((seg, i) => (i % 2 === 0 ? seg.replace(/`[^`\n]*`/g, "") : seg))
      .join("\n");
    for (const [re, why] of dead) {
      if (re.test(text)) offenders.push(`${rel}: ${why}`);
    }
  }
  assert.deepEqual(offenders, [], `dead command syntax:\n${offenders.join("\n")}`);
});
