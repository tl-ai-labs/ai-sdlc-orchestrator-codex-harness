/**
 * Guards the writing conventions established by the docs and comments
 * cleanup. AI-slop terms and third-person voice in USER-FACING docs regress
 * fast when new content lands from any tool; the tests below make those
 * regressions a failing npm test instead of a review debate.
 *
 * The rules live in CONTRIBUTING.md and AGENTS.md.
 *
 * SCOPE. Only these user-facing surfaces are checked:
 *   - README.md
 *   - CONTRIBUTING.md
 *   - docs/*.md (excluding walkthroughs/, which are historical records)
 *   - source-file comments and docstrings under plugin/ and tools/
 *
 * Deliberately excluded:
 *   - SETUP.md and plugin/{commands,agents,skills}/**.md are
 *     Codex-instruction files where "the user" is the correct third-person
 *     reference.
 *   - node_modules/, dist/, .venv/, .codex/, .sdlc/, src/, examples/ are
 *     dependencies, build artifacts, runtime state, or pipeline outputs.
 *   - This test file itself, since it names SLOP_TERMS entries as strings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(p, "utf8");

// Whole-word matched, case-insensitive.
const SLOP_TERMS = [
  "seamless",
  "seamlessly",
  "powerful",
  "leverage",
  "leverages",
  "leveraging",
  "unlock",
  "unlocks",
  "elegant",
  "elegantly",
  "production-grade",
  "battle-tested",
  "robust",
  "robustly",
  "thoughtful",
  "thoughtfully",
  "graceful",
  "gracefully",
  "as demonstrated",
  "in summary",
];

const THIRD_PERSON = [
  // Bare 'the user' in shipped docs, excluding possessive ("the user's ...")
  // and compound-adjective use ("the user-facing docs"). Backtick-wrap the
  // phrase (`the user`) when quoting the rule as an anti-example.
  /\bthe user\b(?!['-])/i,
  // "if user runs ..." — missing article, third-person.
  /\bif user\b/i,
  // First-person plural narrative voice: "we detect ...", "our runs check ...".
  // Restricted to the small verb list that flagged the brownfield docs, so
  // legitimate uses ("the two shipped are what the two shipped policies need")
  // are not caught.
  /\b(we|our)\s+(detect|tell|append|write|check|plan|see|found|do|read|run|wrote)\b/i,
];

// User-facing docs to scan. Written explicitly rather than walked, so adding
// a new user doc is a deliberate one-line change here.
function userFacingDocs() {
  const paths = [
    join(ROOT, "README.md"),
    join(ROOT, "CONTRIBUTING.md"),
    join(ROOT, "AGENTS.md"),
  ];
  const docsDir = join(ROOT, "docs");
  if (existsSync(docsDir)) {
    for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      paths.push(join(docsDir, entry.name));
    }
  }
  return paths.filter(existsSync);
}

// Skip predicates applied while walking plugin/ and tools/ for source-file
// scanning. Contained-path checks so nested node_modules under a run's src/
// tree also skip.
function isSkippedSourcePath(rel) {
  if (rel.includes("/node_modules/")) return true;
  if (rel.includes("/dist/")) return true;
  if (rel.includes("/.venv/")) return true;
  if (rel.includes("/__pycache__/")) return true;
  if (rel.startsWith("plugin/examples/")) return true;
  if (rel.endsWith(".test.mjs")) return true;
  return false;
}

function sourceFiles() {
  const acc = [];
  const roots = [join(ROOT, "plugin"), join(ROOT, "tools")];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(ROOT, full);
      if (isSkippedSourcePath(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mjs|py)$/.test(entry.name)) acc.push(full);
    }
  };
  for (const r of roots) walk(r);
  return acc;
}

// Strip markdown inline-code spans (`...`) before matching. This is what
// lets a doc quote a banned term as an anti-example without failing the check.
// Content inside code blocks (```...```) is stripped by paragraph earlier,
// but inline-only stripping per-line is enough for the patterns we care about.
function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, "");
}

function findSlop(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineCode(lines[i]);
    for (const term of SLOP_TERMS) {
      const pattern = new RegExp("\\b" + term + "\\b", "i");
      if (pattern.test(line)) {
        hits.push({ line: i + 1, term: term, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

function findThirdPerson(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineCode(lines[i]);
    for (const pattern of THIRD_PERSON) {
      if (pattern.test(line)) {
        hits.push({ line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

function formatSlopHit(rel, hit) {
  return rel + ":" + hit.line + "  [" + hit.term + "]  " + hit.text;
}

function formatVoiceHit(rel, hit) {
  return rel + ":" + hit.line + "  " + hit.text;
}

test("no AI-slop terms in user-facing docs", () => {
  const offenders = [];
  for (const file of userFacingDocs()) {
    const rel = relative(ROOT, file);
    for (const hit of findSlop(read(file))) {
      offenders.push(formatSlopHit(rel, hit));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Slop terms in shipped docs. Rewrite in plain factual voice; see AGENTS.md.",
  );
});

test("user-facing docs are written in the second person, not the third", () => {
  const offenders = [];
  for (const file of userFacingDocs()) {
    const rel = relative(ROOT, file);
    for (const hit of findThirdPerson(read(file))) {
      offenders.push(formatVoiceHit(rel, hit));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Third-person voice in user docs. Rewrite as "you do X"; see AGENTS.md.',
  );
});

test("no AI-slop terms in source-file comments and docstrings", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = relative(ROOT, file);
    for (const hit of findSlop(read(file))) {
      offenders.push(formatSlopHit(rel, hit));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Slop terms in source comments. Rewrite factually; see AGENTS.md.",
  );
});
