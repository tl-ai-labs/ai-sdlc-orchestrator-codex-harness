/**
 * Delegation evidence. Inventory the workdir before and after the worker
 * runs; diff into added/modified/removed. Records "files that changed while
 * the agent worked" — not "files the agent wrote" (no per-tool attribution;
 * cannot rule out another writer in the same window).
 *
 * `diffInventories` and `buildDelegationRecord` are pure. `takeInventory`
 * uses a real temp directory in its tests — mocking fs would agree with a
 * symlink loop or an unreadable file that a real walk wouldn't.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Never descended into. Machine-generated dirs (npm install fills node_modules)
 * would bury the real changes; .sdlc is where evidence lands — walking it
 * would make each delegation report the previous one's receipt.
 */
export const INVENTORY_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  ".sdlc",
]);

/**
 * Files larger than this get a size surrogate instead of a content digest.
 * Above any source file, below anything worth streaming. `hashed: false`
 * records the trade — a byte-length-preserving change to a big file would
 * be missed (rounding error for build/media, impossible for source).
 */
export const HASH_BYTE_CAP = 2 * 1024 * 1024;

/**
 * File cap. Guard against being pointed at a home directory. `truncated: true`
 * rides into the diff so a partial list is never read as complete.
 */
export const INVENTORY_FILE_CAP = 20_000;

export interface InventoryEntry {
  /** Path relative to the inventoried root, with `/` separators on every OS. */
  path: string;
  size: number;
  /** Content digest, or a size surrogate for files over HASH_BYTE_CAP. */
  digest: string;
  /** False when `digest` is the size surrogate rather than a content hash. */
  hashed: boolean;
}

export interface Inventory {
  root: string;
  entries: InventoryEntry[];
  /** True when INVENTORY_FILE_CAP stopped the walk before it finished. */
  truncated: boolean;
  /** Paths that could not be read at all, with the reason. Rare, and evidence. */
  unreadable: { path: string; reason: string }[];
}

const EMPTY_INVENTORY = (root: string): Inventory => ({
  root,
  entries: [],
  truncated: false,
  unreadable: [],
});

/**
 * Walk a directory and fingerprint every file. `exclude` takes ABSOLUTE
 * paths, used for the worker's own out-dir (SDK writes session state there
 * while the agent runs — otherwise every delegation reports its own evidence
 * as a change). Symlinks recorded by target, never followed (no loop risk).
 * Never throws; unreadable paths land in `unreadable` and the walk continues.
 */
export function takeInventory(root: string, opts: { exclude?: string[] } = {}): Inventory {
  const inv = EMPTY_INVENTORY(root);
  const excluded = (opts.exclude ?? []).filter(Boolean);
  const isExcluded = (abs: string) =>
    excluded.some((ex) => abs === ex || abs.startsWith(ex.endsWith(sep) ? ex : ex + sep));

  const walk = (dir: string) => {
    if (inv.truncated) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (err: any) {
      inv.unreadable.push({ path: rel(root, dir), reason: reason(err) });
      return;
    }
    for (const name of names) {
      if (inv.truncated) return;
      const abs = join(dir, name);
      if (isExcluded(abs)) continue;
      let st;
      try {
        // lstat, not stat: stat resolves symlinks; a link aimed at its own
        // ancestor would then recurse until the stack ran out.
        st = lstatSync(abs, { throwIfNoEntry: true });
      } catch (err: any) {
        // A vanished file is the normal case — the agent may be writing
        // temporaries while the after-inventory runs.
        inv.unreadable.push({ path: rel(root, abs), reason: reason(err) });
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(abs);
        } catch (err: any) {
          inv.unreadable.push({ path: rel(root, abs), reason: reason(err) });
        }
        if (!push(inv, { path: rel(root, abs), size: 0, digest: `symlink:${target}`, hashed: false })) return;
        continue;
      }
      if (st.isDirectory()) {
        if (INVENTORY_SKIP_DIRS.has(name)) continue;
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue; // sockets, fifos, devices
      if (!push(inv, fingerprint(root, abs, st.size))) return;
    }
  };

  walk(root);
  inv.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return inv;
}

/** Returns false once the cap is hit — caller stops walking. */
function push(inv: Inventory, entry: InventoryEntry): boolean {
  if (inv.entries.length >= INVENTORY_FILE_CAP) {
    inv.truncated = true;
    return false;
  }
  inv.entries.push(entry);
  return true;
}

function fingerprint(root: string, abs: string, size: number): InventoryEntry {
  const path = rel(root, abs);
  if (size > HASH_BYTE_CAP) return { path, size, digest: `size:${size}`, hashed: false };
  try {
    return {
      path,
      size,
      digest: createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16),
      hashed: true,
    };
  } catch {
    // Unreadable content, readable stat — size surrogate keeps
    // appearance/disappearance visible.
    return { path, size, digest: `size:${size}`, hashed: false };
  }
}

const rel = (root: string, abs: string) => relative(root, abs).split(sep).join("/") || ".";
const reason = (err: any) => String(err?.code ?? err?.message ?? err);

export interface InventoryDiff {
  added: string[];
  modified: string[];
  removed: string[];
  /** Files present in both inventories with an identical digest. */
  unchanged: number;
  /** Total files seen in the after-inventory. */
  scanned: number;
  /** True when either inventory hit the file cap, so the lists may be partial. */
  truncated: boolean;
  /** Paths neither inventory could read. Empty on a healthy run. */
  unreadable: string[];
}

/** Modification = digest change, not mtime change. */
export function diffInventories(before: Inventory, after: Inventory): InventoryDiff {
  const prior = new Map(before.entries.map((e) => [e.path, e]));
  const added: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const entry of after.entries) {
    const was = prior.get(entry.path);
    if (!was) added.push(entry.path);
    else if (was.digest !== entry.digest) modified.push(entry.path);
    else unchanged += 1;
    prior.delete(entry.path);
  }

  return {
    added,
    modified,
    removed: [...prior.keys()].sort(),
    unchanged,
    scanned: after.entries.length,
    truncated: before.truncated || after.truncated,
    unreadable: [
      ...new Set([...before.unreadable, ...after.unreadable].map((u) => u.path)),
    ].sort(),
  };
}

/** Schema tag; the report can meet records from older plugin versions. */
export const DELEGATION_RECORD_SCHEMA = "delegation-record/1";

export interface DelegationRecordInput {
  packet: { id: string; phase: string; task_type: string; module: string };
  modelId: string;
  modelName: string;
  workdir: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
  costUsd: number;
  tokens: { input: number; input_cached: number; output: number; output_reasoning?: number };
  /** The worker's usage sidecar, or null when it never wrote one. */
  sidecar: any;
  diff: InventoryDiff;
  /** Filenames, not paths — the record sits in the same directory as both. */
  briefFile: string;
  usageFile: string;
}

/**
 * Assemble the delegation JSON.
 *
 * `cable` comes from the sidecar (what the worker actually used), not the
 * adapter's configuration (what it intended). When they disagree, the
 * worker's is the ground truth.
 */
export function buildDelegationRecord(i: DelegationRecordInput): Record<string, unknown> {
  const sidecar = i.sidecar ?? {};
  return {
    schema: DELEGATION_RECORD_SCHEMA,
    task_id: i.packet.id,
    phase: i.packet.phase,
    task_type: i.packet.task_type,
    module: i.packet.module,
    model_id: i.modelId,
    model_name: i.modelName,
    cable: {
      sdk: sidecar.sdk ?? null,
      sdk_version: sidecar.sdk_version ?? null,
      vertex_project: sidecar.vertex_project ?? null,
      vertex_location: sidecar.vertex_location ?? null,
      thinking: sidecar.thinking ?? null,
    },
    workdir: i.workdir,
    started_at: i.startedAt,
    duration_ms: i.durationMs,
    success: i.success,
    error: i.error ?? null,
    cost_usd: i.costUsd,
    tokens: i.tokens,
    tool_calls: {
      // `count` is the true total; `sample` stops at the worker's recording cap.
      count: Number(sidecar.tool_call_count ?? 0),
      truncated: sidecar.tool_calls_truncated === true,
      sample: Array.isArray(sidecar.tool_calls) ? sidecar.tool_calls : [],
    },
    files: {
      added: i.diff.added,
      modified: i.diff.modified,
      removed: i.diff.removed,
      unchanged: i.diff.unchanged,
      scanned: i.diff.scanned,
      truncated: i.diff.truncated,
      unreadable: i.diff.unreadable,
    },
    artifacts: { brief: i.briefFile, usage: i.usageFile },
  };
}
