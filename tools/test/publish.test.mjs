/**
 * Guards public-facing identity. This repository is public from day one, so
 * these are mechanical facts nobody should have to remember: the package is
 * named after the repo it ships from, no internal bookkeeping leaks, no
 * personal contact details are embedded, and nothing still points at the
 * repository this one was ported from as if it were this one.
 *
 * None of these break a run. They break trust in a public artifact, which is
 * harder to repair.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (...p) => JSON.parse(readFileSync(join(ROOT, ...p), "utf8"));
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

/** The repository this code is published from — derived, never restated by hand. */
const DESTINATION = "ai-sdlc-orchestrator-codex-harness";

/** The repository this was ported FROM. Legitimate to reference, but only as a source. */
const ORIGIN = "ai-sdlc-orchestrator-claude-code-harness";

test("the package is named after the repository it ships from", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, DESTINATION);
  assert.match(pkg.repository.url, new RegExp(`/${DESTINATION}\\.git$`));
});

test("the lockfile agrees with the package it locks", () => {
  // npm writes the package name into the lockfile in two places. A rename
  // that updates package.json alone leaves a lockfile naming a repo nobody
  // can clone — and `npm ci` is the first command a fresh install runs.
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(lock.name, pkg.name, "package-lock.json root name is stale");
  assert.equal(lock.packages[""].name, pkg.name, "package-lock.json self-entry name is stale");
});

test("the plugin manifest points at the repository that hosts it", () => {
  const plugin = readJson("plugin", ".codex-plugin", "plugin.json");
  assert.ok(
    plugin.homepage.endsWith(DESTINATION),
    `plugin homepage is ${plugin.homepage} — a link a reader will click and find nothing at`,
  );
  assert.ok(plugin.repository.endsWith(DESTINATION));
});

test("no internal bookkeeping files ship", () => {
  for (const name of ["CHANGELOG.md", "NEXT_STEPS.md", ".DS_Store", "TODO.md"]) {
    assert.ok(!existsSync(join(ROOT, name)), `${name} must not ship in a public repo`);
  }
});

test("licensing is attributed to the organisation and NOTICE names this project", () => {
  assert.match(read("LICENSE"), /Tilicho Labs/);
  const notice = read("NOTICE");
  assert.match(notice, /Tilicho Labs/);
  assert.match(notice, /Codex Harness/, "NOTICE must name this harness, not the one it was ported from");
});

/**
 * Every text file a reader can see, excluding build output, dependencies and
 * git internals. Walked rather than shelled out to git, so the check works in
 * an exported copy too — which means the skip list is a hand-maintained
 * mirror of .gitignore and has to grow whenever the repo gains a new kind of
 * installed-not-authored directory.
 */
function textFiles(dir = ROOT, acc = []) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "__pycache__", ".sdlc"]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) textFiles(full, acc);
    else if (/\.(md|json|ya?ml|mjs|js|ts)$/.test(entry.name) && statSync(full).size < 512_000) acc.push(full);
  }
  return acc;
}

test("no file claims to BE the repository this one was ported from", () => {
  // Referencing the origin as a source is correct and expected. Claiming its
  // identity — in package metadata, or a clone command a reader would run —
  // is not.
  const offenders = [];
  for (const file of textFiles()) {
    const rel = relative(ROOT, file);
    if (rel === "package-lock.json") continue; // registry metadata, not authored
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(new RegExp(`git clone\\s+\\S*${ORIGIN}`, "g"))) {
      offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "these files tell a reader to clone the wrong repository");
});

test("no other organisation repository is referenced as this project's home", () => {
  const pattern = /github\.com\/tl-ai-labs\/([a-z0-9-]+)/g;
  const strays = new Map();
  for (const file of textFiles()) {
    const rel = relative(ROOT, file);
    for (const [, repo] of readFileSync(file, "utf8").matchAll(pattern)) {
      // The origin repo is a legitimate reference: this is a port of it.
      if (repo !== DESTINATION && repo !== ORIGIN) strays.set(rel, repo);
    }
  }
  assert.deepEqual([...strays], [], "these files link to an unrelated organisation repository");
});

test("no personal contact details are embedded in shipped files", () => {
  // Authored files carry no individual's address; the organisation's own
  // domain is the correct point of contact and is allowed.
  const email = /[a-z0-9._%+-]+@(?!example\.)(?!tilicho\.in)[a-z0-9.-]+\.[a-z]{2,}/gi;
  const found = [];
  for (const file of textFiles()) {
    const rel = relative(ROOT, file);
    if (rel === "package-lock.json") continue;
    if (rel.startsWith("plugin/mcp/model-dispatch/package-lock.json")) continue;
    if (rel.startsWith("plugin/policy-console/package-lock.json")) continue;
    for (const [address] of readFileSync(file, "utf8").matchAll(email)) found.push(`${rel}: ${address}`);
  }
  assert.deepEqual(found, [], "these files carry a personal or third-party email address");
});

test("no Anthropic credential is named anywhere a user would configure (D9)", () => {
  // The carried adapters and their replay-fixture policies legitimately name
  // Anthropic models. What must never appear is an instruction to obtain or
  // set an Anthropic credential.
  const offenders = [];
  for (const file of textFiles()) {
    const rel = relative(ROOT, file);
    // Carried policy fixtures and the dormant adapters are exempt by design.
    if (rel.startsWith("plugin/config/policies/opus")) continue;
    if (rel.includes("Anthropic") || rel.includes("ClaudeCli")) continue;
    if (rel.startsWith("plugin/mcp/model-dispatch/test/")) continue;
    if (rel === "tools/test/publish.test.mjs") continue; // this file names the patterns
    const text = readFileSync(file, "utf8");
    // `\b` before `set` so "unset ANTHROPIC_API_KEY" — which appears in a
    // carried code comment explaining preflight — is not read as an
    // instruction to set one.
    if (/export ANTHROPIC_API_KEY|\bset ANTHROPIC_API_KEY|get an? Anthropic (API )?key/i.test(text)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], "codex setup must never ask for an Anthropic credential");
});
