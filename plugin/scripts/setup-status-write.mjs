#!/usr/bin/env node
/**
 * Setup-status writer. The shepherd calls this at each section boundary so
 * `session-hydrate.mjs` on the next command can detect a mid-setup interruption
 * and resume from the pending section.
 *
 * The seven prompt-1 sections (SETUP.md):
 *   install, environment, repo-detection, credentials, repo-setup, policy, summary
 *
 * Usage:
 *   node setup-status-write.mjs --section=<name>   # mark section as done; recompute pending
 *   node setup-status-write.mjs --reset            # clear the file (new setup starting fresh)
 *   node setup-status-write.mjs --all-done         # mark all sections done; setup complete
 *
 * State file: <repo-root>/.sdlc/local/setup-status.json — gitignored (per-user, per-run).
 * Contract with session-hydrate.mjs: when `sections_pending` is non-empty, hydrate emits a
 * resume hint pointing at the first pending section.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SECTIONS = ["install", "environment", "repo-detection", "credentials", "repo-setup", "policy", "summary"];

function parseArgs(argv) {
  const out = { section: null, reset: false, allDone: false, projectRoot: null };
  // Index-based to accept both `--flag=value` and `--flag value` forms.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") out.reset = true;
    else if (a === "--all-done") out.allDone = true;
    else if (a.startsWith("--section=")) out.section = a.slice("--section=".length);
    else if (a === "--section") out.section = argv[++i] ?? null;
    else if (a.startsWith("--project-root=")) out.projectRoot = a.slice("--project-root=".length);
    else if (a === "--project-root") out.projectRoot = argv[++i] ?? null;
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`setup-status-write: ${msg}\n`);
  process.exit(1);
}

/**
 * Same trust-the-caller pattern as write-provenance.mjs::resolveProjectRoot.
 * The command layer knows which project the setup runs against; passing
 * --project-root avoids the cwd-drift bug that landed .sdlc/local/setup-status.json
 * in the plugin worktree instead of the target project.
 */
function resolveProjectRoot(explicit) {
  if (explicit) return explicit;
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return process.cwd();
}

function statusPath(root) {
  return join(root, ".sdlc", "local", "setup-status.json");
}

function readStatus(path) {
  if (!existsSync(path)) return { schema_version: 1, sections_done: [] };
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return { schema_version: 1, sections_done: [] }; }
}

function writeStatus(path, state) {
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o644 });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.section && !args.reset && !args.allDone) {
    fail("pass one of --section=<name>, --reset, or --all-done.");
  }

  const path = statusPath(resolveProjectRoot(args.projectRoot));

  if (args.reset) {
    writeStatus(path, {
      schema_version: 1,
      sections_done: [],
      sections_pending: [...SECTIONS],
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(`setup-status-write: reset ${path}\n`);
    return;
  }

  if (args.allDone) {
    writeStatus(path, {
      schema_version: 1,
      sections_done: [...SECTIONS],
      sections_pending: [],
      status: "complete",
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(`setup-status-write: setup complete (${path})\n`);
    return;
  }

  if (!SECTIONS.includes(args.section)) {
    fail(`unknown section "${args.section}". Known: ${SECTIONS.join(", ")}`);
  }

  const state = readStatus(path);
  const done = new Set([...(state.sections_done ?? []), args.section]);
  const pending = SECTIONS.filter((s) => !done.has(s));
  writeStatus(path, {
    schema_version: 1,
    sections_done: SECTIONS.filter((s) => done.has(s)),
    sections_pending: pending,
    timestamp: new Date().toISOString(),
  });
  process.stderr.write(`setup-status-write: marked "${args.section}" done; pending: ${pending.join(", ") || "(none)"}\n`);
}

main();
