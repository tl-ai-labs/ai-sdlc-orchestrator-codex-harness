#!/usr/bin/env node
/**
 * The record `$mmo-codex:revert` reads: which files a brownfield run changed and how to put each one back. Code writes
 * it, never the model: write-contract.mjs starts it at the freeze and closes it when the run ends, and the write hook
 * snapshots a file before the run's first allowed write to it. Closing it reconciles against `git status` and the
 * run's commits, so a write the hook could not see (a shell edit, a lockfile rewrite, an agent worker) is still recorded.
 *
 * Usage (every mode takes --run-id=<id> [--project-root=<dir>]; --name=value or --name value):
 *   node write-provenance.mjs --init [--intent=<id>]
 *   node write-provenance.mjs --before --path=<file> [--packet-id=<id>]
 *   node write-provenance.mjs --after --path=<file>
 *   node write-provenance.mjs --finalize
 *   node write-provenance.mjs --plan          prints the revert plan as JSON
 *
 * --init, --before, --after and --finalize fail open: a failure warns on stderr and exits 0. --plan exits 2 when it
 * has no plan to give, and says why.
 *
 * Record: <project-root>/.sdlc/runs/<run-id>/provenance.json, backups in backups/ beside it.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isRunId, runDirFor } from "./lib/run-id.mjs";
import { CONTRACT_MAX_BYTES, FROZEN_FILE, liveLock, readContract, readLock, readRegular } from "./lib/contract-lock.mjs";
import { firstMatch } from "./lib/off-limits.mjs";
import { realPath } from "./lib/write-guard.mjs";
import { log as mmoLog } from "./lib/log.mjs";

export const PROVENANCE_FILE = "provenance.json";
export const BACKUPS_DIR = "backups";
/** Bounds the start-of-run dirt list and the paths one finalize adds, so the record stays readable. */
export const PATH_CAP = 5000;
/** Bounds the files one folder removal snapshots, so the hook answers before Codex runs the call. */
export const FOLDER_SNAPSHOT_CAP = 200;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const PROVENANCE_MAX_BYTES = 64 * 1024 * 1024;

export class ProvenanceRefusal extends Error {
  constructor(message) {
    super(message);
    this.code = "PROVENANCE_REFUSED";
  }
}

export const provenancePath = (root, runId) => join(runDirFor(root, runId), PROVENANCE_FILE);
const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString();
const toPosix = (p) => p.split(sep).join("/");
const shaBytes = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/** A full SHA-1 or SHA-256 object id, or null: the record's commits end up in git argv and in shell commands. */
const commitId = (v) => (typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v) ? v : null);

function requireRunId(runId) {
  if (!isRunId(runId)) {
    throw new ProvenanceRefusal(`the run id must be letters, digits, '.', '_' or '-', not starting with a dot; got ${JSON.stringify(runId ?? null)}`);
  }
}

// ── git, scoped to the project folder ─────────────────────────────────────

/**
 * A project folder with its real path, and a git environment that cannot wander into an enclosing repository, never
 * takes the index lock from under the conductor's own git calls, and reads a path as itself, not as a glob.
 */
function context(root) {
  const given = resolve(String(root ?? process.cwd()));
  const real = realpathSync.native(given);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(real), GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE"]) delete env[k];
  return { root: given, real, env };
}

/** Bounded, because the write hook waits on it before Codex runs the call. */
const GIT_TIMEOUT_MS = 15_000;
const git = (ctx, args, opts = {}) =>
  spawnSync("git", ["-C", ctx.real, ...args], { encoding: "utf8", env: ctx.env, maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, ...opts });

function gitHead(ctx) {
  const r = git(ctx, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function commitsBetween(ctx, from, to) {
  if (!from || !to || from === to) return [];
  const r = git(ctx, ["rev-list", "--reverse", `${from}..${to}`]);
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
}

const inSdlc = (rel) => { const l = rel.toLowerCase(); return l === ".sdlc" || l.startsWith(".sdlc/"); };

/** Paths the run's commits changed: once committed, a write the hook did not see is gone from `git status`. */
function committedPaths(ctx, from, to) {
  if (!to || from === to) return [];
  const r = from
    ? git(ctx, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", from, to])
    : git(ctx, ["ls-tree", "-r", "-z", "--name-only", to]);
  return r.status === 0 && !r.error ? r.stdout.split("\0").filter((p) => p && !inSdlc(p)) : [];
}

/** Whether the file on disk is what `head` holds, through the repo's eol and clean filters. */
const matchesCommit = (ctx, head, rel) =>
  git(ctx, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", head, "--", rel], { stdio: "ignore" }).status === 0;

/** Every path `git status` lists as changed or untracked (both sides of a rename), or null without git. */
function changedPaths(ctx) {
  const r = git(ctx, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (r.status !== 0 || r.error) return null;
  const out = [];
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && i + 1 < parts.length) out.push(parts[++i]);
  }
  return [...new Set(out)].filter((p) => p && !inSdlc(p));
}

/** The file's bytes at `head`, or null when `head` does not hold it. */
function headBlob(ctx, head, rel) {
  if (!head) return null;
  if (git(ctx, ["cat-file", "-e", `${head}:${rel}`], { stdio: "ignore" }).status !== 0) return null;
  const r = git(ctx, ["show", `${head}:${rel}`], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

const fileSha = (abs) => { const b = readRegular(abs); return b ? shaBytes(b) : null; };

// ── the record file ───────────────────────────────────────────────────────

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs fn holding `<file>.lock`; hook calls run in parallel. A lock older than LOCK_STALE_MS is a dead writer's. */
function withLock(file, fn) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; }
      } catch { /* its owner just released it */ }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another writer`);
      sleep(10);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

function readProv(file) {
  const bytes = readRegular(file, PROVENANCE_MAX_BYTES);
  if (!bytes) return null;
  try {
    const v = JSON.parse(bytes.toString("utf8"));
    return v && typeof v === "object" && Array.isArray(v.files_touched) ? v : null;
  } catch { return null; }
}

function writeProv(file, prov) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prov, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, file);
}

const present = (file) => { try { lstatSync(file); return true; } catch { return false; } };

/** The project's state when the record opens: HEAD, and every changed or untracked file with its hash. */
function opening(ctx, runId, { intent, openedBy, now }) {
  const changed = changedPaths(ctx);
  const dirty = changed === null ? null : {};
  for (const rel of (changed ?? []).slice(0, PATH_CAP)) dirty[rel] = fileSha(join(ctx.real, rel));
  return {
    schema_version: 1,
    run_id: runId,
    intent: intent ?? null,
    started_at: nowIso(now),
    opened_by: openedBy,
    git_head_before: gitHead(ctx),
    git_head_after: null,
    commits: [],
    finalized_at: null,
    reopened: [],
    dirty_at_start: dirty,
    dirty_at_start_truncated: (changed?.length ?? 0) > PATH_CAP,
    files_touched: [],
    unrecorded_changes: [],
  };
}

function noteUnrecorded(prov, rel, reason, now) {
  prov.unrecorded_changes ??= [];
  if (!prov.unrecorded_changes.some((u) => u.path === rel)) prov.unrecorded_changes.push({ path: rel, reason, at: nowIso(now) });
}

// ── what a path is ────────────────────────────────────────────────────────

/**
 * `path` as a regular file (or a file not there yet) inside the project, relative to its real root, or null: outside
 * the project, under `.sdlc/` or `.git/`, a folder, a link, a pipe or a device. A link is never followed, so a backup
 * never copies bytes from outside the project.
 */
function locate(ctx, path) {
  if (typeof path !== "string" || !path) return null;
  const given = isAbsolute(path) ? path : `${ctx.root}${sep}${path}`;
  const name = basename(given);
  if (!name || name === "." || name === "..") return null;
  let parent;
  try { parent = realpathSync.native(dirname(given)); } catch { parent = realPath(dirname(given)); }
  let abs = join(parent, name);
  let st = null;
  try { st = lstatSync(abs); } catch { /* not there yet */ }
  if (st && !st.isFile()) return null;
  if (st) { try { abs = realpathSync.native(abs); } catch { /* keep the joined path */ } }
  const rel = toPosix(relative(ctx.real, abs));
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  const low = rel.toLowerCase();
  if (inSdlc(rel) || low === ".git" || low.startsWith(".git/")) return null;
  return { rel, abs };
}

/** `path` as a folder inside the project (not the project itself, `.sdlc/` or `.git/`), relative to its real root, or null. */
function locateFolder(ctx, path) {
  if (typeof path !== "string" || !path) return null;
  const given = isAbsolute(path) ? path : `${ctx.root}${sep}${path}`;
  let abs;
  try {
    if (!lstatSync(given).isDirectory()) return null;
    abs = realpathSync.native(given);
  } catch { return null; }
  const rel = toPosix(relative(ctx.real, abs));
  if (!rel || outside(rel)) return null;
  const low = rel.toLowerCase();
  if (inSdlc(rel) || low === ".git" || low.startsWith(".git/")) return null;
  return { rel, abs };
}

/** A collision-free flat name: `a/b.ts` and `a__b.ts` differ in the hash suffix. */
export function backupName(rel) {
  const hash = createHash("sha256").update(rel).digest("hex");
  const flat = rel.replace(/[\\/]/g, "__");
  if (Buffer.byteLength(flat) <= 200) return `${flat}.${hash.slice(0, 8)}`;
  const ext = extname(rel);
  return `${hash.slice(0, 32)}${Buffer.byteLength(ext) <= 16 ? ext : ""}`;
}

function writeBackup(ctx, runId, rel, bytes, mode) {
  const dir = join(runDirFor(ctx.root, runId), BACKUPS_DIR);
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link`);
  // Copies of uncommitted files stay out of git whatever the project's .gitignore says. No backup is named .gitignore.
  try { writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o644 }); } catch { /* already there */ }
  const dest = join(dir, backupName(rel));
  writeFileSync(dest, bytes, { mode: (mode ?? 0o644) & 0o777 });
  return toPosix(relative(ctx.root, dest));
}

/** The earlier record for this file: the same path, or the same file under another case on a case-blind disk. */
function earlierRecord(ctx, prov, loc) {
  const exact = prov.files_touched.find((r) => r.path === loc.rel);
  if (exact) return exact;
  const low = loc.rel.toLowerCase();
  let ino = null;
  try { ino = statSync(loc.abs).ino; } catch { return null; }
  return prov.files_touched.find((r) => {
    if (typeof r.path !== "string" || r.path.toLowerCase() !== low) return false;
    try { return statSync(join(ctx.real, r.path)).ino === ino; } catch { return false; }
  }) ?? null;
}

/**
 * The pre-run state of a file the run is about to write. A tracked file that was clean when the run started is put
 * back from git, even when something the hook did not see changed it since; a file that was dirty or untracked at the
 * start, or that git does not hold, is copied to a backup.
 */
function snapshot(ctx, prov, runId, loc, { packetId, by, now }) {
  const st = (() => { try { return lstatSync(loc.abs); } catch { return null; } })();
  const bytes = st ? readRegular(loc.abs) : null;
  const exists = !!st;
  const rec = {
    path: loc.rel, existed_before: exists, sha_before: bytes ? shaBytes(bytes) : null, sha_after: null,
    tracked_in_git: false, dirty_before: false, backup_path: null, packet_id: packetId ?? null, written_at: null,
    recorded_by: by,
  };
  const backup = () => {
    if (!bytes) return;
    try { rec.backup_path = writeBackup(ctx, runId, loc.rel, bytes, st?.mode); }
    catch (e) { mmoLog("warn", "provenance.backup_failed", { run_id: runId, path: loc.rel, error: e?.message ?? String(e) }); }
  };

  const start = prov.dirty_at_start;
  if (start && typeof start === "object" && !prov.dirty_at_start_truncated) {
    const head = commitId(prov.git_head_before);
    if (Object.hasOwn(start, loc.rel)) {
      const startSha = start[loc.rel];
      rec.tracked_in_git = !!head && git(ctx, ["cat-file", "-e", `${head}:${loc.rel}`], { stdio: "ignore" }).status === 0;
      rec.dirty_before = true;
      if (!exists && startSha === null) { rec.existed_before = false; return rec; }
      rec.existed_before = true;
      if (exists) backup();
      if (rec.sha_before !== startSha) {
        if (!exists) rec.sha_before = startSha;
        noteUnrecorded(prov, loc.rel, "uncommitted before the run, and changed before its first recorded write by a write the hook did not see", now);
      }
      return rec;
    }
    const inHead = !!head && git(ctx, ["cat-file", "-e", `${head}:${loc.rel}`], { stdio: "ignore" }).status === 0;
    if (inHead) {
      rec.existed_before = true;
      rec.tracked_in_git = true;
      const unchanged = exists && git(ctx, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", head, "--", loc.rel], { stdio: "ignore" }).status === 0;
      if (!unchanged) {
        const blob = headBlob(ctx, head, loc.rel);
        rec.sha_before = blob ? shaBytes(blob) : null;
        noteUnrecorded(prov, loc.rel, "changed before its first recorded write by a write the hook did not see; restored from git", now);
      }
      return rec;
    }
    if (exists) { rec.dirty_before = true; backup(); }
    return rec;
  }

  if (!exists) return rec;
  rec.tracked_in_git = git(ctx, ["ls-files", "--error-unmatch", "--", loc.rel], { stdio: "ignore" }).status === 0;
  const dirty = !rec.tracked_in_git || git(ctx, ["status", "--porcelain", "--", loc.rel]).stdout?.trim().length > 0;
  rec.dirty_before = dirty;
  if (dirty) backup();
  return rec;
}

// ── the record's lifecycle ────────────────────────────────────────────────

/** Opens the run's record, or with `reopen` reopens a closed one for a resumed run. Idempotent. */
export function initProvenance({ root, runId, intent = null, reopen = false, now } = {}) {
  requireRunId(runId);
  const ctx = context(root);
  const file = provenancePath(ctx.root, runId);
  return withLock(file, () => {
    const prov = readProv(file);
    if (!prov) {
      if (present(file)) throw new Error(`${file} is not a readable provenance record; it is left as it is`);
      const fresh = opening(ctx, runId, { intent, openedBy: "init", now });
      writeProv(file, fresh);
      mmoLog("debug", "provenance.init", { run_id: runId, path: file });
      return fresh;
    }
    let changed = false;
    if (reopen && prov.finalized_at) {
      prov.finalized_at = null;
      prov.git_head_after = null;
      prov.reopened = [...(Array.isArray(prov.reopened) ? prov.reopened : []), nowIso(now)];
      for (const r of prov.files_touched) r.sha_after = null;
      changed = true;
    }
    if (intent && !prov.intent) { prov.intent = intent; changed = true; }
    if (changed) writeProv(file, prov);
    return prov;
  });
}

/** Opens the record in `file` for a snapshot, or null when it is closed. Call holding the lock. */
function openForSnapshot(ctx, file, runId, by, now) {
  const prov = readProv(file);
  if (!prov && present(file)) throw new Error(`${file} is not a readable provenance record`);
  if (prov?.finalized_at) return null;
  return prov ?? opening(ctx, runId, { intent: null, openedBy: by, now });
}

/**
 * The file's record after one more write: the earlier record reopened for its end hash, or a new snapshot. With
 * `dirtyOnly`, a file with no earlier record is recorded only when its pre-run content went to a backup.
 */
function touch(ctx, prov, runId, loc, { packetId = null, by, now, dirtyOnly = false }) {
  const earlier = earlierRecord(ctx, prov, loc);
  if (earlier) {
    const reopen = earlier.sha_after !== null || earlier.written_at !== null || (packetId && earlier.packet_id !== packetId);
    if (reopen) {
      earlier.sha_after = null;
      earlier.written_at = null;
      if (packetId) earlier.packet_id = packetId;
    }
    return { rec: earlier, changed: reopen };
  }
  const rec = snapshot(ctx, prov, runId, loc, { packetId, by, now });
  if (dirtyOnly && !rec.backup_path) return { rec: null, changed: false };
  prov.files_touched.push(rec);
  mmoLog("debug", "provenance.before", { run_id: runId, path: rec.path, recorded_by: by, backup: rec.backup_path ?? undefined });
  return { rec, changed: true };
}

/**
 * Records the pre-run state of `path` before the run writes it. The run's first snapshot of a file stands: a later
 * write keeps it, so revert restores the original and not an earlier attempt. `dirtyOnly` is for a write the hook is
 * not sure of: it records only a file whose uncommitted or untracked content a backup keeps, because close-out finds a
 * change to any other file from git. Returns the record, or null when the path is not recorded (outside the project,
 * under .sdlc/ or .git/, not a regular file) or the record is closed.
 */
export function recordBefore({ root, runId, path, packetId = null, by = "cli", dirtyOnly = false, now } = {}) {
  requireRunId(runId);
  const ctx = context(root);
  const loc = locate(ctx, path);
  if (!loc) return null;
  const file = provenancePath(ctx.root, runId);
  return withLock(file, () => {
    const prov = openForSnapshot(ctx, file, runId, by, now);
    if (!prov) return null;
    const { rec, changed } = touch(ctx, prov, runId, loc, { packetId, by, now, dirtyOnly });
    if (changed) writeProv(file, prov);
    return rec;
  });
}

/**
 * Records the files in a folder before the run removes it: first each file `git status` listed under it at the start
 * (backed up), then each file git tracks there, up to FOLDER_SNAPSHOT_CAP new snapshots. Returns how many files under
 * the folder are on record, or 0 when the folder is not recorded or the record is closed.
 */
export function recordFolderBefore({ root, runId, path, by = "cli", now } = {}) {
  requireRunId(runId);
  const ctx = context(root);
  const dir = locateFolder(ctx, path);
  if (!dir) return 0;
  const file = provenancePath(ctx.root, runId);
  return withLock(file, () => {
    const prov = openForSnapshot(ctx, file, runId, by, now);
    if (!prov) return 0;
    const under = (rel) => rel.startsWith(`${dir.rel}/`);
    const start = prov.dirty_at_start && typeof prov.dirty_at_start === "object" ? Object.keys(prov.dirty_at_start) : [];
    const listed = git(ctx, ["ls-files", "-z", "--", dir.rel]);
    const tracked = listed.status === 0 && !listed.error ? listed.stdout.split("\0").filter(Boolean) : [];
    let on = 0;
    let fresh = 0;
    let changed = false;
    for (const rel of new Set([...start.filter(under), ...tracked.filter(under)])) {
      const loc = locate(ctx, join(ctx.real, rel));
      if (!loc) continue;
      const known = !!earlierRecord(ctx, prov, loc);
      if (!known && fresh >= FOLDER_SNAPSHOT_CAP) {
        noteUnrecorded(prov, `${dir.rel}/`, `removed with more than ${FOLDER_SNAPSHOT_CAP} files to snapshot in it; the rest have none`, now);
        changed = true;
        break;
      }
      const r = touch(ctx, prov, runId, loc, { by, now });
      on++;
      if (!known) fresh++;
      changed ||= r.changed;
    }
    if (changed) writeProv(file, prov);
    return on;
  });
}

/** Fills in the file's hash after a write. finalize does this for every record the run left open. */
export function recordAfter({ root, runId, path, now } = {}) {
  requireRunId(runId);
  const ctx = context(root);
  const loc = locate(ctx, path);
  if (!loc) return null;
  const file = provenancePath(ctx.root, runId);
  if (!present(file)) return null;
  return withLock(file, () => {
    const prov = readProv(file);
    if (!prov || prov.finalized_at) return null;
    const rec = earlierRecord(ctx, prov, loc);
    if (!rec) return null;
    rec.sha_after = fileSha(loc.abs);
    rec.written_at = nowIso(now);
    writeProv(file, prov);
    return rec;
  });
}

/**
 * Closes the run's record: every open record gets the file's hash at the end of the run, and `git status` and the
 * run's commits are reconciled against what the hook recorded. A path changed with no snapshot is added (restorable
 * from git, or new), or, when it was uncommitted, ignored or otherwise there before the run, listed in
 * unrecorded_changes. Returns null when the run has no record; a closed record is returned as it is.
 */
export function finalizeProvenance({ root, runId, now } = {}) {
  requireRunId(runId);
  const ctx = context(root);
  const file = provenancePath(ctx.root, runId);
  if (!present(file)) return null;
  return withLock(file, () => {
    const prov = readProv(file);
    if (!prov) throw new Error(`${file} is not a readable provenance record`);
    if (prov.finalized_at) return prov;
    const at = nowIso(now);
    for (const r of prov.files_touched) {
      if (r.sha_after === null || r.sha_after === undefined) {
        r.sha_after = fileSha(join(ctx.real, r.path));
        r.written_at ??= at;
      }
    }
    const before = commitId(prov.git_head_before);
    prov.git_head_after = gitHead(ctx);
    reconcile(ctx, prov, at, committedPaths(ctx, before, prov.git_head_after));
    prov.commits = commitsBetween(ctx, before, prov.git_head_after);
    prov.finalized_at = at;
    writeProv(file, prov);
    mmoLog("debug", "provenance.finalize", { run_id: runId, files: prov.files_touched.length, unrecorded: prov.unrecorded_changes?.length ?? 0 });
    return prov;
  });
}

/**
 * Older than the run: its birth time, or its modified time when that is earlier, is before the run's start. `git
 * status` never lists an ignored file, so a file a .gitignore change uncovers is not in dirty_at_start.
 */
function predates(st, startedAt) {
  const startedMs = Date.parse(startedAt);
  const born = Math.min(st.mtimeMs, st.birthtimeMs > 0 ? st.birthtimeMs : Infinity);
  return !Number.isFinite(startedMs) || born < startedMs;
}

function reconcile(ctx, prov, at, committed = []) {
  const changed = changedPaths(ctx);
  const start = prov.dirty_at_start;
  if (changed === null || !start || typeof start !== "object") return;
  const head = commitId(prov.git_head_before);
  const known = new Set(prov.files_touched.map((r) => r.path));
  let added = 0;
  const full = () => {
    if (added < PATH_CAP) return false;
    prov.reconcile_truncated = true;
    return true;
  };
  for (const rel of new Set([...changed, ...committed])) {
    if (known.has(rel) || full()) continue;
    const abs = join(ctx.real, rel);
    const st = (() => { try { return lstatSync(abs); } catch { return null; } })();
    if (st && !st.isFile()) {
      if (Object.hasOwn(start, rel)) continue;
      noteUnrecorded(prov, rel, `${st.isDirectory() ? "a folder (a submodule or nested repository)" : "a link"} changed; revert restores files only`, at);
      added++;
      continue;
    }
    const sha = fileSha(abs);
    if (Object.hasOwn(start, rel)) {
      if (start[rel] !== sha) { noteUnrecorded(prov, rel, "uncommitted before the run, and changed with no snapshot", at); added++; }
      continue;
    }
    if (prov.dirty_at_start_truncated) {
      noteUnrecorded(prov, rel, "changed with no snapshot, and the run's start state was not fully recorded", at);
      added++;
      continue;
    }
    const blob = headBlob(ctx, head, rel);
    if (blob === null && st && predates(st, prov.started_at)) {
      noteUnrecorded(prov, rel, "there before the run, but git status did not list it at the start (an ignored file, for example); revert leaves it", at);
      added++;
      continue;
    }
    prov.files_touched.push({
      path: rel, existed_before: blob !== null, sha_before: blob ? shaBytes(blob) : null, sha_after: sha,
      tracked_in_git: blob !== null, dirty_before: false, backup_path: null, packet_id: null, written_at: at,
      recorded_by: "finalize",
    });
    known.add(rel);
    added++;
  }
  const now = new Set(changed);
  for (const [rel, startSha] of Object.entries(start)) {
    if (known.has(rel) || now.has(rel) || full()) continue;
    if (fileSha(join(ctx.real, rel)) !== startSha) {
      noteUnrecorded(prov, rel, "uncommitted before the run, and changed with no snapshot", at);
      added++;
    }
  }
}

// ── the revert plan ───────────────────────────────────────────────────────

/** The live run that holds the project, or null. A revert while a run is live would be snapshotted by it. */
function liveRun(root) {
  const live = liveLock(root);
  if (live) return live.run_id;
  const c = readContract(root);
  if (c?.active === true && !readLock(root, c.run_id)?.ended_at) return isRunId(c.run_id) ? c.run_id : "?";
  return null;
}

function laterTouches(root, runId, startedAt) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(join(root, ".sdlc", "runs")); } catch { return out; }
  for (const name of names.filter((n) => isRunId(n) && n !== runId)) {
    const p = readProv(provenancePath(root, name));
    if (!p || typeof p.started_at !== "string" || !(typeof startedAt !== "string" || p.started_at > startedAt)) continue;
    for (const r of p.files_touched) out.set(r.path, [...(out.get(r.path) ?? []), name]);
  }
  return out;
}

/** A record written before dirty_before existed restores from git only when git holds exactly its pre-run bytes. */
function legacyClean(ctx, head, r) {
  const blob = headBlob(ctx, head, r.path);
  return blob !== null && shaBytes(blob) === r.sha_before;
}

const outside = (rel) => rel === ".." || rel.startsWith("../") || isAbsolute(rel);

/**
 * `{abs}` for a recorded path a revert command may write, or `{why}`. The record is protected only while its run is
 * live, so a path edited afterwards must not take a command outside the project, into .git/ or .sdlc/, or through a link.
 */
function revertTarget(ctx, rel) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return { why: "its recorded path is not a plain path inside the project" };
  }
  if (inSdlc(rel) || rel.toLowerCase().split("/").includes(".git")) return { why: "its recorded path is under .git/ or .sdlc/" };
  const abs = join(ctx.real, rel);
  if (outside(toPosix(relative(ctx.real, realPath(dirname(abs)))))) return { why: "its folder leads outside the project through a link" };
  let st = null;
  try { st = lstatSync(abs); } catch { /* not there now */ }
  if (st && !st.isFile()) return { why: "it is now a folder or a link, not a file" };
  return { abs };
}

/** The allowlist the run froze at Gate 0, or null when its frozen copy is missing or unreadable. */
function frozenAllowlist(root, runId) {
  const bytes = readRegular(join(runDirFor(root, runId), FROZEN_FILE), CONTRACT_MAX_BYTES);
  try {
    const list = JSON.parse(bytes?.toString("utf8") ?? "null")?.allowlist;
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

/**
 * Why a change only close-out found waits for the user's choice: git status or the run's commits show it, but no
 * snapshot saw the run write it, so the user may have made it while the run was going.
 */
function unseenConflict(rel, allowlist) {
  const why = "close-out found it in git status or the run's commits; the run was not seen writing it, so the change may be the user's";
  return allowlist && !firstMatch(rel, allowlist) ? `${why}, and it is outside the run's confirmed allowlist` : why;
}

/** The backup's absolute path when it lies in this run's backups/ folder inside the project, else null. */
function backupSource(ctx, runId, backupPath) {
  const prefix = `.sdlc/runs/${runId}/${BACKUPS_DIR}/`;
  if (typeof backupPath !== "string" || !backupPath.startsWith(prefix)) return null;
  const name = backupPath.slice(prefix.length);
  if (!name || name.includes("/") || name === "." || name === "..") return null;
  const abs = join(runDirFor(ctx.root, runId), BACKUPS_DIR, name);
  return outside(toPosix(relative(ctx.real, realPath(abs)))) ? null : abs;
}

/**
 * What putting the project back to its state before the run takes, file by file, with the command for each. Pure
 * reading: it changes nothing. Refused while a run is live, and for a run with no readable record.
 */
export function revertPlan({ root, runId } = {}) {
  requireRunId(runId);
  const ctx = context(root);
  const live = liveRun(ctx.root);
  if (live) throw new ProvenanceRefusal(`run ${live} is live and holds this project's write contract; revert after it ends.`);
  const file = provenancePath(ctx.root, runId);
  const prov = readProv(file);
  if (!prov) {
    throw new ProvenanceRefusal(`run ${runId} has no readable provenance record (${toPosix(relative(ctx.root, file))}), so there is nothing to revert from. Undo by hand with git diff.`);
  }

  const finalized = typeof prov.finalized_at === "string";
  const head = commitId(prov.git_head_before);
  const later = laterTouches(ctx.root, runId, prov.started_at);
  const allowlist = frozenAllowlist(ctx.root, runId);
  const files = prov.files_touched.map((r) => {
    const item = { path: r.path, action: "cannot", command: null, reason: null, conflict: null, recorded_by: r.recorded_by ?? null };
    const target = revertTarget(ctx, r.path);
    if (!target.abs) return { ...item, reason: target.why };
    const { abs } = target;
    const now = fileSha(abs);
    const exists = present(abs);
    if (later.has(r.path)) item.conflict = `a later run also wrote it (${later.get(r.path).join(", ")})`;
    else if (!finalized) item.conflict = "the run did not close, so its last state is unknown";
    else if ((r.sha_after ?? null) !== now) item.conflict = "it changed after the run";
    else if (r.recorded_by === "finalize") item.conflict = unseenConflict(r.path, allowlist);

    if (r.existed_before === false) {
      if (!exists) return { ...item, action: "none", reason: "the run's new file is already gone", conflict: null };
      return { ...item, action: "delete", command: `rm -f -- ${shq(abs)}` };
    }
    if (now !== null && now === r.sha_before) return { ...item, action: "none", reason: "already as it was before the run", conflict: null };
    if (r.backup_path) {
      const backupAbs = backupSource(ctx, runId, r.backup_path);
      if (!backupAbs) return { ...item, reason: `its backup_path ${JSON.stringify(r.backup_path)} is not in this run's backups/ folder` };
      if (fileSha(backupAbs) !== r.sha_before) return { ...item, reason: `its backup ${r.backup_path} is missing or does not match the pre-run hash` };
      return { ...item, action: "restore-backup", command: `mkdir -p -- ${shq(dirname(abs))} && cp -- ${shq(backupAbs)} ${shq(abs)}` };
    }
    const clean = r.dirty_before === false || (r.dirty_before === undefined && !!head && legacyClean(ctx, head, r));
    if (r.tracked_in_git && clean) {
      if (!head) return { ...item, reason: "the record names no commit to restore it from" };
      if (exists && matchesCommit(ctx, head, r.path)) return { ...item, action: "none", reason: "already as it was before the run", conflict: null };
      return { ...item, action: "git-checkout", command: `git --literal-pathspecs -C ${shq(ctx.real)} checkout ${shq(head)} -- ${shq(r.path)}` };
    }
    return { ...item, reason: "it held uncommitted or untracked content before the run and has no backup" };
  });
  const recorded = new Set(files.map((f) => f.path));
  return {
    run_id: runId,
    project_root: ctx.real,
    finalized,
    git_head_before: head,
    commits: Array.isArray(prov.commits) ? prov.commits.filter((c) => commitId(c)) : [],
    files,
    unrecorded_changes: (prov.unrecorded_changes ?? []).map((u) => ({ ...u, has_record: recorded.has(u.path) })),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const MODES = { "--init": "init", "--before": "before", "--after": "after", "--finalize": "finalize", "--plan": "plan" };
const VALUES = { "--run-id": "runId", "--path": "path", "--packet-id": "packetId", "--intent": "intent", "--project-root": "projectRoot" };

export function parseArgs(argv) {
  const out = { mode: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (MODES[a]) { out.mode = MODES[a]; continue; }
    const eq = a.indexOf("=");
    const key = VALUES[eq === -1 ? a : a.slice(0, eq)];
    if (!key) continue;
    out[key] = eq === -1 ? argv[++i] ?? null : a.slice(eq + 1);
  }
  return out;
}

/** The project the record belongs to: --project-root, else the git root above the working folder, else that folder. */
function projectRootOf(explicit) {
  if (explicit) return resolve(explicit);
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (msg) => stderr.write(`write-provenance: ${msg}\n`);
  const a = parseArgs(argv);
  if (a.mode === "plan") {
    try {
      stdout.write(JSON.stringify(revertPlan({ root: projectRootOf(a.projectRoot), runId: a.runId }), null, 2) + "\n");
      return 0;
    } catch (e) {
      say(e?.code === "PROVENANCE_REFUSED" ? e.message : `failed: ${e?.message ?? e}`);
      return 2;
    }
  }
  try {
    if (!a.mode) { say("no mode given (--init, --before, --after, --finalize or --plan)"); return 0; }
    const root = projectRootOf(a.projectRoot);
    if (a.mode === "init") {
      initProvenance({ root, runId: a.runId, intent: a.intent ?? null });
      say(`init: ${provenancePath(root, a.runId)}`);
    } else if (a.mode === "finalize") {
      const p = finalizeProvenance({ root, runId: a.runId });
      say(p ? `finalize: ${p.files_touched.length} file(s), ${p.unrecorded_changes?.length ?? 0} unrecorded change(s), ${p.commits.length} commit(s)` : "finalize: the run has no record");
    } else {
      if (!a.path) { say(`--path=<file> is required for --${a.mode}`); return 0; }
      const rec = a.mode === "before"
        ? recordBefore({ root, runId: a.runId, path: a.path, packetId: a.packetId ?? null, by: "cli" })
        : recordAfter({ root, runId: a.runId, path: a.path });
      say(rec ? `${a.mode} ${rec.path}${a.mode === "before" ? ` (backup=${rec.backup_path ? "yes" : "no"})` : ""}` : `${a.mode}: ${a.path} is not recorded`);
    }
  } catch (e) {
    say(e?.code === "PROVENANCE_REFUSED" ? e.message : `failed, nothing recorded: ${e?.message ?? e}`);
  }
  return 0;
}

const isDirectRun = (() => {
  try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isDirectRun) process.exitCode = main();
