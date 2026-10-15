/**
 * The write contract's lock: the record that proves a contract is the one write-contract.mjs froze.
 *
 * At Gate 0 write-contract.mjs writes the contract, a byte-for-byte copy of it in the run's folder
 * (`write-contract.frozen.json`) and a lock holding the SHA-256 of those bytes (`write-contract.lock.json`).
 * The lock is found by scanning the run folders, never by asking the contract which run it belongs to, so a
 * contract rewritten to name another run, or deleted, is still caught while the lock is live.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants as FS, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  renameSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRunId } from "./run-id.mjs";

export const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";
export const DECISIONS_REL_PATH = ".sdlc/local/guard-decisions.jsonl";
export const LOCK_FILE = "write-contract.lock.json";
export const FROZEN_FILE = "write-contract.frozen.json";
export const CONTRACT_MAX_BYTES = 128 * 1024;
export const LOCK_MAX_BYTES = 16 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const fingerprint = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const lockRelPath = (runId) => `.sdlc/runs/${runId}/${LOCK_FILE}`;
export const frozenRelPath = (runId) => `.sdlc/runs/${runId}/${FROZEN_FILE}`;

// Opened without blocking and without following a link: a named pipe where a record should be never stalls the hook.
const READ_FLAGS = FS.O_RDONLY | (FS.O_NONBLOCK ?? 0) | (FS.O_NOFOLLOW ?? 0);
const APPEND_FLAGS = FS.O_WRONLY | FS.O_APPEND | FS.O_CREAT | (FS.O_NONBLOCK ?? 0) | (FS.O_NOFOLLOW ?? 0);

/** A file's bytes when it is a regular file no larger than maxBytes, else null. */
export function readRegular(path, maxBytes = Infinity) {
  let fd;
  try { fd = openSync(path, READ_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n <= 0) break;
      at += n;
    }
    return buf.subarray(0, at);
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The last `maxBytes` of a regular file, else null. */
export function readRegularTail(path, maxBytes) {
  let fd;
  try { fd = openSync(path, READ_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, st.size - len);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Appends to a regular file (created when missing), never to a pipe or through a link. Returns whether it did. */
export function appendRegular(path, text) {
  let fd;
  try { fd = openSync(path, APPEND_FLAGS, 0o644); } catch { return false; }
  try {
    if (!fstatSync(fd).isFile()) return false;
    writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The root of the git project holding `start`: the nearest folder, `start` or above, with a `.git` file or folder. */
export function gitRoot(start) {
  let dir = resolve(String(start ?? "."));
  for (let i = 0; i < 256; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Writes a file whole or not at all: a reader never sees half a contract. */
export function writeWhole(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

export const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");

function parseObject(bytes) {
  if (!bytes) return null;
  try {
    const v = JSON.parse(bytes.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export const readContractBytes = (root) => readRegular(join(root, CONTRACT_REL_PATH), CONTRACT_MAX_BYTES);
export const readContract = (root) => parseObject(readContractBytes(root));

/** Whether anything at all sits at the run's lock path: a run freezes once. */
export function lockPresent(root, runId) {
  if (!isRunId(runId)) return false;
  try { lstatSync(join(root, lockRelPath(runId))); return true; } catch { return false; }
}

/** The run's lock as write-contract.mjs writes it, or null. */
export function readLock(root, runId) {
  if (!isRunId(runId)) return null;
  const v = parseObject(readRegular(join(root, lockRelPath(runId)), LOCK_MAX_BYTES));
  if (!v || v.run_id !== runId || !SHA256_RE.test(String(v.sha256))) return null;
  return v;
}

/** Every live lock of the project (no `ended_at`), in run-id order. */
export function liveLocks(root) {
  let names = [];
  try { names = readdirSync(join(root, ".sdlc", "runs")); } catch { return []; }
  return names.filter(isRunId).sort().map((n) => readLock(root, n)).filter((l) => l && !l.ended_at);
}

/** The project's live lock: null, the lock, or `{run_id, forged}` when more than one is live. */
export function liveLock(root) {
  const live = liveLocks(root);
  if (live.length === 0) return null;
  if (live.length > 1) {
    return { run_id: live[0].run_id, forged: `${live.length} runs hold a live write-contract lock (${live.map((l) => l.run_id).join(", ")})` };
  }
  return live[0];
}

/**
 * Why the project's contract cannot be trusted, or null. A live lock whose contract is missing, unreadable or no
 * longer byte-identical; two live locks; or an active contract that says it was frozen but whose run has no lock.
 * The reason names what changed and that the person decides; it names no way past the refusal.
 */
export function contractTampered(root, live = liveLock(root)) {
  const tail = "Every write is refused while that run is live. Stop and tell the person what changed it.";
  if (live?.forged) return `the write contract's lock cannot be trusted: ${live.forged}, and only one run at a time holds a project. ${tail}`;
  const bytes = readContractBytes(root);
  if (live) {
    if (bytes && fingerprint(bytes) === live.sha256) return null;
    const what = bytes ? "its bytes no longer match the lock" : "the file is gone, or is not a readable file";
    return `the write contract changed after run ${live.run_id} froze it (${what}). ${tail}`;
  }
  const contract = parseObject(bytes);
  if (contract?.active === true && typeof contract.frozen_at === "string" && !readLock(root, contract.run_id)) {
    return `the write contract says run ${String(contract.run_id)} froze it, but that run's lock is gone. ${tail}`;
  }
  return null;
}
