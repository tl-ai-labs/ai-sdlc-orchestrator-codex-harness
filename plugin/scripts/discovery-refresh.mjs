#!/usr/bin/env node
/**
 * Discovery staleness helper. Compares the recorded baseline against the
 * current git state + stack-manifest mtimes and prints a JSON decision
 * that the discovery subagent consumes to pick between:
 *
 *   cached      — nothing material changed; reuse the baseline verbatim
 *   incremental — small delta; re-scan only affected groups
 *   full        — significant change (new language, policy edit, or no
 *                 usable baseline); redo the full scan
 *
 * Fail-safe: on any error (missing baseline, malformed JSON, git not
 * available, unreadable manifests) return "full" — safer to over-scan
 * than to miss real changes.
 *
 * Usage:
 *   node discovery-refresh.mjs
 *   node discovery-refresh.mjs --baseline .sdlc/baseline/current.json
 *
 * Output on stdout:
 *   { "decision": "cached"|"incremental"|"full",
 *     "reason": "...",
 *     "git_head_baseline": "...",
 *     "git_head_current": "...",
 *     "delta_files": ["..."],
 *     "manifests_changed": ["package.json"],
 *     "baseline_age_commits": 4,
 *     "policy_changed": false }
 *
 * Exit codes:
 *   0 — decision printed on stdout
 *   1 — could not print a decision at all (misuse / catastrophic failure)
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";

const BASELINE_REL = ".sdlc/baseline/current.json";
const POLICY_REL = ".sdlc/policy.yaml";

// Known stack manifests. If any of these are in the delta or their mtime
// exceeds the baseline built_at, we redo groups 3-4 (stacks + test cmd).
const STACK_MANIFESTS = [
  "package.json", "pnpm-workspace.yaml", "nx.json", "turbo.json", "lerna.json", "rush.json",
  "pyproject.toml", "requirements.txt", "Pipfile", "Pipfile.lock",
  "go.mod",
  "Cargo.toml",
  "build.gradle", "build.gradle.kts", "pom.xml",
  "Gemfile", "Gemfile.lock",
  "composer.json",
  "mix.exs",
];

// A language appearing that wasn't there before → decision: full.
const LANGUAGE_MANIFESTS = new Set([
  "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "build.gradle",
  "build.gradle.kts", "pom.xml", "Gemfile", "composer.json", "mix.exs",
]);

// AI/agent config paths. If a new one appears, always do a full refresh so
// group-6 findings and off_limits stay accurate.
const AI_CONFIG_PATHS = [
  ".claude/", ".mcp.json", ".cursor/", ".cursorrules",
  ".aider.conf.yml", ".aider.conf.yaml",
  ".continue/", ".github/copilot-instructions.md",
  ".roo/", "routing-policy.yaml",
];

function findBaselinePath(explicit, start = process.cwd()) {
  if (explicit) return resolve(explicit);
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const candidate = join(dir, BASELINE_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function findRepoRoot(baselinePath) {
  // baseline lives at <root>/.sdlc/baseline/current.json → up three
  return resolve(baselinePath, "..", "..", "..");
}

function gitCmd(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, err: r.stderr?.trim() ?? String(r.status) };
  return { ok: true, out: (r.stdout ?? "").trim() };
}

function emitAndExit(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(0);
}

function fullBecause(reason, extras = {}) {
  emitAndExit({ decision: "full", reason, delta_files: [], manifests_changed: [], baseline_age_commits: null, policy_changed: false, ...extras });
}

function parseArgs(argv) {
  const args = { baseline: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline" || a === "-b") args.baseline = argv[++i] ?? null;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const baselinePath = findBaselinePath(args.baseline);
  if (!baselinePath) fullBecause("no .sdlc/baseline/current.json found — first-time-in-this-repo");

  const root = findRepoRoot(baselinePath);

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    fullBecause(`baseline unreadable or malformed (${e?.message ?? "parse error"})`);
  }

  if (typeof baseline?.schema_version !== "number") {
    fullBecause("baseline has no schema_version — treating as unusable");
  }

  const baselineHead = baseline?.git?.head;
  const baselineBuiltAt = baseline?.built_at;
  if (!baselineHead || typeof baselineHead !== "string") {
    fullBecause("baseline missing git.head");
  }

  // Current git state
  const currentHead = gitCmd(root, ["rev-parse", "HEAD"]);
  if (!currentHead.ok) fullBecause(`git rev-parse failed (${currentHead.err})`);

  // Fast path: same HEAD + no manifest touched since baseline built_at → cached.
  // Manifest mtime is the safety net for uncommitted stack changes (git-diff
  // would miss them). See plan §14.4 risk note.
  //
  // Grace period rationale: `built_at` in the baseline JSON is ISO-8601 with
  // second precision, but fs mtimes are millisecond precision. A file created
  // in the same second as the baseline was written can therefore have a
  // fractional-second-larger mtime than the truncated built_at, causing false
  // "changed" hits. 2s also absorbs filesystem timestamp imprecision (HFS+,
  // some NFS mounts) that would otherwise flag untouched files as changed.
  const MTIME_GRACE_MS = 2000;
  const manifestsChanged = [];
  const builtAtMs = baselineBuiltAt ? Date.parse(baselineBuiltAt) : NaN;

  for (const m of STACK_MANIFESTS) {
    const p = join(root, m);
    if (!existsSync(p)) continue;
    try {
      const s = statSync(p);
      if (!Number.isNaN(builtAtMs) && s.mtimeMs > builtAtMs + MTIME_GRACE_MS) manifestsChanged.push(m);
    } catch { /* ignore */ }
  }

  // Policy edit → always full (routing may have changed which cascades everywhere)
  let policyChanged = false;
  const policyPath = join(root, POLICY_REL);
  if (existsSync(policyPath)) {
    try {
      const s = statSync(policyPath);
      if (!Number.isNaN(builtAtMs) && s.mtimeMs > builtAtMs + MTIME_GRACE_MS) policyChanged = true;
    } catch { /* ignore */ }
  }
  if (policyChanged) {
    emitAndExit({
      decision: "full",
      reason: ".sdlc/policy.yaml was edited since baseline was built",
      git_head_baseline: baselineHead,
      git_head_current: currentHead.out,
      delta_files: [],
      manifests_changed: manifestsChanged,
      baseline_age_commits: null,
      policy_changed: true,
    });
  }

  if (currentHead.out === baselineHead && manifestsChanged.length === 0) {
    emitAndExit({
      decision: "cached",
      reason: "git HEAD unchanged and no stack manifest mtime changed since baseline",
      git_head_baseline: baselineHead,
      git_head_current: currentHead.out,
      delta_files: [],
      manifests_changed: [],
      baseline_age_commits: 0,
      policy_changed: false,
    });
  }

  // Diff the committed history. Uncommitted working-tree changes are caught
  // by the mtime path above; this catches real commits since baseline.
  let deltaFiles = [];
  let ageCommits = null;
  if (currentHead.out !== baselineHead) {
    const diff = gitCmd(root, ["diff", "--name-only", `${baselineHead}..HEAD`]);
    if (diff.ok) {
      deltaFiles = diff.out.split("\n").map((s) => s.trim()).filter(Boolean);
    } else {
      // Baseline SHA unreachable (rebase/force-push destroyed history).
      fullBecause(`baseline sha ${baselineHead} unreachable in current history — likely rebase or force-push`, {
        git_head_baseline: baselineHead,
        git_head_current: currentHead.out,
      });
    }
    const rev = gitCmd(root, ["rev-list", "--count", `${baselineHead}..HEAD`]);
    if (rev.ok) ageCommits = parseInt(rev.out, 10) || 0;
  }

  // New language appearing → full (adaptive profile / adapter selection must re-run).
  const newLanguage = deltaFiles.find((f) => LANGUAGE_MANIFESTS.has(f) && !baseline?.stacks?.some((s) => s.manifest === f));
  if (newLanguage) {
    emitAndExit({
      decision: "full",
      reason: `new language manifest appeared: ${newLanguage}`,
      git_head_baseline: baselineHead,
      git_head_current: currentHead.out,
      delta_files: deltaFiles,
      manifests_changed: manifestsChanged,
      baseline_age_commits: ageCommits,
      policy_changed: false,
    });
  }

  // New AI/agent config appearing → full (off_limits must be recomputed).
  const newAiConfig = deltaFiles.find((f) => AI_CONFIG_PATHS.some((p) => f === p.replace(/\/$/, "") || f.startsWith(p)));
  if (newAiConfig) {
    emitAndExit({
      decision: "full",
      reason: `new AI/agent config appeared: ${newAiConfig}`,
      git_head_baseline: baselineHead,
      git_head_current: currentHead.out,
      delta_files: deltaFiles,
      manifests_changed: manifestsChanged,
      baseline_age_commits: ageCommits,
      policy_changed: false,
    });
  }

  // Otherwise → incremental. Discovery agent re-scans only affected groups.
  emitAndExit({
    decision: "incremental",
    reason: `${deltaFiles.length} files changed since baseline (${ageCommits ?? "?"} commits)`,
    git_head_baseline: baselineHead,
    git_head_current: currentHead.out,
    delta_files: deltaFiles,
    manifests_changed: manifestsChanged,
    baseline_age_commits: ageCommits,
    policy_changed: false,
  });
}

try {
  main();
} catch (e) {
  // Absolute last-resort: something we didn't anticipate. Print full so the
  // caller doesn't rely on a stale baseline it wasn't warned about.
  process.stdout.write(JSON.stringify({
    decision: "full",
    reason: `discovery-refresh crashed: ${e?.message ?? String(e)}`,
  }) + "\n");
  process.exit(0);
}
