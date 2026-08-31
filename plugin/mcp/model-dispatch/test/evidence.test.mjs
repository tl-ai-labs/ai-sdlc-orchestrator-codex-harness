/**
 * Delegation receipt. Silent failure modes worth pinning:
 *   - inventory walks its own output dir → every delegation "changes" its
 *     own brief and sidecar;
 *   - walks node_modules after an install → real edits buried under 40k;
 *   - mtime-based modification → formatter fills receipt with non-changes;
 *   - count read from capped sample list → long sessions understated.
 *
 * Uses real temp trees, not a mocked fs (symlink loops, vanishing files —
 * failures a mock would agree with).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DELEGATION_RECORD_SCHEMA,
  HASH_BYTE_CAP,
  INVENTORY_SKIP_DIRS,
  buildDelegationRecord,
  diffInventories,
  takeInventory,
} from "../dist/delegation/evidence.js";

// ─── a scratch tree, torn down after each use ─────────────────────────

/** Build a directory from a {relativePath: contents} map and run `fn` on it. */
function withTree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "delegation-evidence-"));
  try {
    write(root, files);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, contents);
  }
}

const paths = (inv) => inv.entries.map((e) => e.path);

// ─── walking a directory ──────────────────────────────────────────────

test("every file is inventoried, at a path relative to the root and slash-separated", () => {
  withTree({ "a.ts": "1", "src/b.ts": "2", "src/deep/c.ts": "3" }, (root) => {
    // Sorted and relative, because the diff compares these strings across two
    // inventories and a report prints them. An absolute path would leak the
    // user's home directory into a file meant to be shared.
    assert.deepEqual(paths(takeInventory(root)), ["a.ts", "src/b.ts", "src/deep/c.ts"]);
  });
});

test("machine-generated directories are never descended", () => {
  withTree(
    {
      "app.ts": "real",
      "node_modules/left-pad/index.js": "noise",
      ".git/HEAD": "noise",
      "dist/app.js": "noise",
      "__pycache__/x.pyc": "noise",
    },
    (root) => {
      // An agent that runs `npm install` or a build would otherwise report tens
      // of thousands of changed files, and the dozen it actually wrote would be
      // unfindable in the receipt.
      assert.deepEqual(paths(takeInventory(root)), ["app.ts"]);
    },
  );
});

test("the skip list covers the directory the receipt itself falls back to", () => {
  // `.sdlc/delegation/` is where evidence lands when no telemetry path was
  // supplied. Walking it would make each delegation report the PREVIOUS
  // delegation's receipt as a file it changed.
  assert.equal(INVENTORY_SKIP_DIRS.has(".sdlc"), true);
});

test("an excluded absolute path is skipped, and its children with it", () => {
  withTree({ "app.ts": "real", "out/worker-task-tp1.md": "brief", "out/deep/save.json": "x" }, (root) => {
    // THE CONTAMINATION HAZARD. The worker's output directory can sit inside
    // the workspace, and the SDK writes its session transcript there WHILE the
    // agent runs. Without this exclusion every delegation reports its own
    // evidence as a file the agent changed — evidence corrupted by the act of
    // collecting it.
    const inv = takeInventory(root, { exclude: [join(root, "out")] });
    assert.deepEqual(paths(inv), ["app.ts"]);
  });
});

test("an exclusion matches on a path boundary, not on a prefix of a name", () => {
  withTree({ "out/a.ts": "x", "outbound/b.ts": "y" }, (root) => {
    // `outbound/` starts with the string `out` — excluding it too would silently
    // drop real work from the receipt.
    const inv = takeInventory(root, { exclude: [join(root, "out")] });
    assert.deepEqual(paths(inv), ["outbound/b.ts"]);
  });
});

test("a symlink pointing at its own ancestor is one line, not an infinite walk", () => {
  withTree({ "src/a.ts": "1" }, (root) => {
    symlinkSync(root, join(root, "src", "loop"), "dir");
    // Two things at once. The walk TERMINATES — links are never descended, so
    // this returns instead of recursing until the stack gives out, and a hung
    // inventory would hang a delegation that had already been paid for. And the
    // link is still VISIBLE: recorded by target, so creating one reads as an
    // addition rather than vanishing from the receipt entirely.
    const inv = takeInventory(root);
    assert.deepEqual(paths(inv), ["src/a.ts", "src/loop"]);
    assert.equal(inv.entries[1].digest, `symlink:${root}`);
  });
});

test("re-pointing a symlink is a modification; the tree it points into is not re-walked", () => {
  withTree({ "a.ts": "1", "b.ts": "2" }, (root) => {
    symlinkSync(join(root, "a.ts"), join(root, "link"), "file");
    const before = takeInventory(root);
    rmSync(join(root, "link"));
    symlinkSync(join(root, "b.ts"), join(root, "link"), "file");
    const diff = diffInventories(before, takeInventory(root));
    // Hashing through the link instead would report NO change here — both
    // targets are one byte and the digest of the link would be the digest of
    // whichever file it happened to resolve to, so a re-point that silently
    // changes what a build reads would leave no trace.
    assert.deepEqual(diff.modified, ["link"]);
  });
});

test("a missing root is an empty inventory, not a thrown error", () => {
  // The workspace can be gone by the time the after-inventory runs — a test
  // command that cleans up, a worker that removed a directory it created.
  // Evidence collection must not turn that into a failed delegation.
  const inv = takeInventory(join(tmpdir(), "delegation-evidence-does-not-exist"));
  assert.deepEqual(inv.entries, []);
  assert.equal(inv.unreadable.length, 1);
});

test("a file too large to hash is fingerprinted by size and says so", () => {
  withTree({ "big.bin": Buffer.alloc(HASH_BYTE_CAP + 1, 7) }, (root) => {
    const [entry] = takeInventory(root).entries;
    // Reading a large artifact into memory twice per delegation to discover it
    // did not change is not worth it. The record carries `hashed: false` so a
    // reader knows this one entry is size-only rather than content-checked.
    assert.equal(entry.hashed, false);
    assert.equal(entry.digest, `size:${HASH_BYTE_CAP + 1}`);
  });
});

// ─── comparing two inventories ────────────────────────────────────────

test("added, modified and removed are each reported, and the rest counted", () => {
  withTree({ "keep.ts": "same", "edit.ts": "before", "gone.ts": "x" }, (root) => {
    const before = takeInventory(root);
    write(root, { "edit.ts": "after", "new.ts": "fresh" });
    rmSync(join(root, "gone.ts"));
    const diff = diffInventories(before, takeInventory(root));

    assert.deepEqual(diff.added, ["new.ts"]);
    assert.deepEqual(diff.modified, ["edit.ts"]);
    assert.deepEqual(diff.removed, ["gone.ts"]);
    assert.equal(diff.unchanged, 1);
    assert.equal(diff.scanned, 3);
  });
});

test("a rewrite with identical content is not a modification", () => {
  withTree({ "a.ts": "same bytes" }, (root) => {
    const before = takeInventory(root);
    write(root, { "a.ts": "same bytes" }); // new mtime, same content
    const diff = diffInventories(before, takeInventory(root));
    // Judged on the digest, never on the timestamp. A formatter run over
    // untouched files, an `npm install` that rewrites a lockfile byte-for-byte,
    // or a `touch` inside a test script would otherwise fill the receipt with
    // changes nobody made — and the receipt's whole value is that its list is
    // short enough to read.
    assert.deepEqual(diff.modified, []);
    assert.equal(diff.unchanged, 1);
  });
});

test("truncation on either side taints the whole diff", () => {
  const inv = (over) => ({ root: "/w", entries: [], truncated: over, unreadable: [] });
  // A partial list read as a complete one understates what the agent did, and
  // looks exactly like a small, tidy delegation.
  assert.equal(diffInventories(inv(true), inv(false)).truncated, true);
  assert.equal(diffInventories(inv(false), inv(true)).truncated, true);
  assert.equal(diffInventories(inv(false), inv(false)).truncated, false);
});

test("unreadable paths from both inventories are merged without duplicates", () => {
  const before = { root: "/w", entries: [], truncated: false, unreadable: [{ path: "locked", reason: "EACCES" }] };
  const after = { root: "/w", entries: [], truncated: false, unreadable: [{ path: "locked", reason: "EACCES" }, { path: "gone", reason: "ENOENT" }] };
  assert.deepEqual(diffInventories(before, after).unreadable, ["gone", "locked"]);
});

// ─── the record itself ────────────────────────────────────────────────

const recordInput = (over = {}) => ({
  packet: { id: "tp_codegen_012", phase: "codegen", task_type: "controller_handler", module: "auth" },
  modelId: "flash-agsdk-worker",
  modelName: "gemini-3.5-flash",
  workdir: "/w",
  startedAt: "2026-08-05T10:00:00.000Z",
  durationMs: 42_000,
  success: true,
  costUsd: 0.31,
  tokens: { input: 100, input_cached: 10, output: 50, output_reasoning: 5 },
  sidecar: null,
  diff: { added: [], modified: [], removed: [], unchanged: 0, scanned: 0, truncated: false, unreadable: [] },
  briefFile: "worker-task-tp_codegen_012.md",
  usageFile: "worker-usage-tp_codegen_012.json",
  ...over,
});

test("the record carries the id the telemetry event is keyed by", () => {
  // This is what lets the report join a receipt to its cost without
  // reconstructing the adapter's filename convention — which would be a fourth
  // hand-maintained copy of a rule that already exists in `evidenceStem`.
  const rec = buildDelegationRecord(recordInput());
  assert.equal(rec.task_id, "tp_codegen_012");
  assert.equal(rec.schema, DELEGATION_RECORD_SCHEMA);
});

test("the tool-call count is the drained total, not the length of the sample", () => {
  const rec = buildDelegationRecord(
    recordInput({
      sidecar: { tool_call_count: 41, tool_calls_truncated: true, tool_calls: [{ name: "read_file" }] },
    }),
  );
  // The list stops at the worker's own recording cap; the count does not.
  // Reading `sample.length` would report the longest, most expensive sessions
  // as the shortest ones.
  assert.equal(rec.tool_calls.count, 41);
  assert.equal(rec.tool_calls.truncated, true);
  assert.equal(rec.tool_calls.sample.length, 1);
});

test("the cable is quoted from the worker, and is null when it never wrote one", () => {
  const ran = buildDelegationRecord(
    recordInput({
      sidecar: {
        sdk: "google-antigravity",
        sdk_version: "1.1.4",
        vertex_project: "some-project",
        vertex_location: "asia-south1",
      },
    }),
  );
  // What the run ACTUALLY used, as reported by the process that made the call —
  // not what this adapter intended. When the two disagree the worker's answer
  // is the one worth keeping.
  assert.equal(ran.cable.sdk_version, "1.1.4");
  assert.equal(ran.cable.vertex_location, "asia-south1");

  const died = buildDelegationRecord(recordInput({ sidecar: null, success: false, error: "exited 1" }));
  // A worker killed before it wrote a sidecar leaves nulls, not an invented
  // project and region copied from configuration that was never exercised.
  assert.equal(died.cable.sdk, null);
  assert.equal(died.cable.vertex_project, null);
  assert.equal(died.success, false);
  assert.equal(died.error, "exited 1");
});

test("a failed delegation still records its cost and its file changes", () => {
  // The case a reader most needs a receipt for: money spent, files possibly
  // edited, and no successful answer to show for it.
  const rec = buildDelegationRecord(
    recordInput({
      success: false,
      error: "the agent worker was killed after 570s",
      costUsd: 0.44,
      diff: { added: ["src/half.ts"], modified: [], removed: [], unchanged: 3, scanned: 4, truncated: false, unreadable: [] },
    }),
  );
  assert.equal(rec.cost_usd, 0.44);
  assert.deepEqual(rec.files.added, ["src/half.ts"]);
});
