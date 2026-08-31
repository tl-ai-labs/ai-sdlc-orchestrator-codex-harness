#!/usr/bin/env node
/**
 * Provenance writer for `/mmo:revert` (ticket §14.6).
 *
 * The orchestrator calls this around every Write/Edit in a brownfield run so the
 * revert command can restore the pre-run state. Schema matches the reader in
 * plugin/commands/revert.md — never drift.
 *
 * Contract:
 *   --init      — start a fresh provenance.json for a run (captures git_head_before)
 *   --before    — before a Write/Edit: compute sha_before + backup uncommitted files
 *   --after     — after a Write/Edit: fill in sha_after + written_at
 *   --finalize  — end of run: captures git_head_after + commits between the two heads
 *
 * State file: <repo-root>/.sdlc/runs/<run-id>/provenance.json
 * Backups:    <repo-root>/.sdlc/runs/<run-id>/backups/<escaped-path>
 *
 * All operations are fail-open: on unexpected error, log to stderr and exit 0 so a
 * misbehaving helper never blocks the pipeline (the write itself is what matters).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { log as mmoLog } from "./lib/log.mjs";

function parseArgs(argv) {
  const out = { mode: null, runId: null, path: null, packetId: null, intent: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Index-based to accept both `--flag=value` and `--flag value` forms.
    // Command files historically wrote the space form; without this, the
    // --project-root pass-through silently stayed null.
    if (a === "--init") out.mode = "init";
    else if (a === "--before") out.mode = "before";
    else if (a === "--after") out.mode = "after";
    else if (a === "--finalize") out.mode = "finalize";
    else if (a.startsWith("--run-id=")) out.runId = a.slice("--run-id=".length);
    else if (a === "--run-id") out.runId = argv[++i] ?? null;
    else if (a.startsWith("--path=")) out.path = a.slice("--path=".length);
    else if (a === "--path") out.path = argv[++i] ?? null;
    else if (a.startsWith("--packet-id=")) out.packetId = a.slice("--packet-id=".length);
    else if (a === "--packet-id") out.packetId = argv[++i] ?? null;
    else if (a.startsWith("--intent=")) out.intent = a.slice("--intent=".length);
    else if (a === "--intent") out.intent = argv[++i] ?? null;
    else if (a.startsWith("--project-root=")) out.projectRoot = a.slice("--project-root=".length);
    else if (a === "--project-root") out.projectRoot = argv[++i] ?? null;
  }
  return out;
}

function warn(msg) { process.stderr.write(`write-provenance: ${msg}\n`); }
function log(msg) { process.stderr.write(`write-provenance: ${msg}\n`); }
function failOpen(msg) { warn(msg); process.exit(0); }

/** First 16 hex chars of the digest, stripped of the "sha256:" label. */
function sha16Of(sha) {
  if (!sha) return undefined;
  return sha.replace(/^sha256:/, "").slice(0, 16);
}

/**
 * Where does per-run bookkeeping (`.sdlc/runs/<run-id>/provenance.json`) go?
 * The command layer knows — it's the project the user is running against.
 * That answer arrives here as `--project-root=<abs-path>`. When absent, fall
 * back to `git rev-parse` from cwd, then cwd itself. The command-layer path
 * is preferred because Bash cwd drifts across a session (an earlier `cd`,
 * a helper that shells out) and git-toplevel-from-cwd will follow, quietly
 * writing provenance into whichever git worktree the shell currently sits in.
 * That's the SiteNotes bug — closed by always passing --project-root.
 */
function resolveProjectRoot(explicit) {
  if (explicit) return explicit;
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return process.cwd();
}

function currentGitHead(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function commitsBetween(root, from, to) {
  if (!from || !to) return [];
  const r = spawnSync("git", ["-C", root, "rev-list", "--reverse", `${from}..${to}`], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean);
}

function isTracked(root, absPath) {
  const rel = relative(root, absPath);
  const r = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore" });
  return r.status === 0;
}

function isDirty(root, absPath) {
  const rel = relative(root, absPath);
  const r = spawnSync("git", ["-C", root, "status", "--porcelain", "--", rel], { encoding: "utf8" });
  if (r.status !== 0) return false;
  return r.stdout.trim().length > 0;
}

function sha256Of(path) {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    return "sha256:" + createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

function provenancePath(root, runId) {
  return join(root, ".sdlc", "runs", runId, "provenance.json");
}

function readProv(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function writeProv(path, obj) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
}

function escapePathForBackup(rel) {
  return rel.replace(/[\/\\]/g, "__");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) failOpen("no mode given (--init / --before / --after / --finalize)");
  if (!args.runId) failOpen("--run-id=<id> is required");

  const root = resolveProjectRoot(args.projectRoot);
  const provPath = provenancePath(root, args.runId);

  if (args.mode === "init") {
    if (existsSync(provPath)) return; // idempotent
    writeProv(provPath, {
      schema_version: 1,
      run_id: args.runId,
      intent: args.intent ?? null,
      git_head_before: currentGitHead(root),
      git_head_after: null,
      commits: [],
      files_touched: [],
    });
    log(`init: ${provPath}`);
    return;
  }

  const prov = readProv(provPath) ?? {
    schema_version: 1, run_id: args.runId, intent: null,
    git_head_before: currentGitHead(root), git_head_after: null,
    commits: [], files_touched: [],
  };

  if (args.mode === "finalize") {
    prov.git_head_after = currentGitHead(root);
    prov.commits = commitsBetween(root, prov.git_head_before, prov.git_head_after);
    writeProv(provPath, prov);
    log(`finalize: ${prov.commits.length} commit(s) recorded`);
    mmoLog("debug", "provenance.finalize", { run_id: args.runId, path: provPath });
    return;
  }

  if (!args.path) failOpen(`--path=<file> is required for --${args.mode}`);
  const absPath = resolve(root, args.path);
  const relPath = relative(root, absPath);

  if (args.mode === "before") {
    const existed = existsSync(absPath);
    const tracked = existed && isTracked(root, absPath);
    const dirtyOrUntracked = existed && (!tracked || isDirty(root, absPath));

    let backupPath = null;
    if (dirtyOrUntracked) {
      const backupsDir = join(root, ".sdlc", "runs", args.runId, "backups");
      if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
      backupPath = join(backupsDir, escapePathForBackup(relPath));
      try { copyFileSync(absPath, backupPath); }
      catch (e) { warn(`backup failed for ${relPath}: ${e.message}`); backupPath = null; }
    }

    const shaBefore = existed ? sha256Of(absPath) : null;
    prov.files_touched.push({
      path: relPath,
      existed_before: existed,
      sha_before: shaBefore,
      sha_after: null,
      tracked_in_git: tracked,
      backup_path: backupPath ? relative(root, backupPath) : null,
      packet_id: args.packetId ?? null,
      written_at: null,
    });
    writeProv(provPath, prov);
    log(`before ${relPath} (backup=${backupPath ? "yes" : "no"})`);
    mmoLog("debug", "provenance.before", {
      run_id: args.runId,
      path: relPath,
      tracked_in_git: tracked,
      backup_path: backupPath ? relative(root, backupPath) : undefined,
      sha16: sha16Of(shaBefore),
    });
    return;
  }

  if (args.mode === "after") {
    for (let i = prov.files_touched.length - 1; i >= 0; i--) {
      const rec = prov.files_touched[i];
      if (rec.path === relPath && rec.sha_after === null) {
        rec.sha_after = sha256Of(absPath);
        rec.written_at = new Date().toISOString();
        writeProv(provPath, prov);
        log(`after  ${relPath}`);
        mmoLog("debug", "provenance.after", {
          run_id: args.runId,
          path: relPath,
          tracked_in_git: rec.tracked_in_git,
          backup_path: rec.backup_path,
          sha16: sha16Of(rec.sha_after),
        });
        return;
      }
    }
    warn(`after: no matching --before record for ${relPath}; ignoring`);
    return;
  }
}

try { main(); } catch (e) { failOpen(`unexpected error: ${e?.message ?? e}`); }
