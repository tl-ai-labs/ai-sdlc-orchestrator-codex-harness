#!/usr/bin/env node
/**
 * Codex PreToolUse hook for the brownfield write contract, on `apply_patch` and `Bash`. The decision is in
 * plugin/scripts/lib/write-guard.mjs. Codex blocks a call only on a JSON deny on stdout, not on an exit code, and a
 * denied call leaves no trace in `codex exec --json`, so the hook records its own decisions. Any failure here allows
 * the call; the one deliberate refusal on doubt is a contract that changed after its run froze it.
 *
 * Before replying allow under a binding contract, the hook snapshots each file the call writes or removes into the
 * run's provenance record, so `$mmo-codex:revert` can put it back. A snapshot never changes the decision.
 */
import { existsSync, lstatSync } from "node:fs";
import {
  callCommand, decideCall, isLiteralWord, recordDecision, shellPatchTargets, WIRED_BY_RUN_FLAG,
} from "../../scripts/lib/write-guard.mjs";
import { recordBefore, recordFolderBefore } from "../../scripts/write-provenance.mjs";
import { log } from "../../scripts/lib/log.mjs";

const WIRED_BY = process.argv.includes(WIRED_BY_RUN_FLAG) ? "run" : "plugin";

function readStdinJson() {
  return new Promise((resolveP) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => {
      try { resolveP(JSON.parse(buf)); } catch { resolveP(null); }
    });
    // Some environments never close stdin.
    setTimeout(() => resolveP(null), 1500).unref();
  });
}

/**
 * Exits once the reply is flushed: stdin may never close, and a pipe write is asynchronous on macOS. An allow is an
 * empty reply: Codex reports a bare `permissionDecision: "allow"` as a failed hook run on every call.
 */
function reply(decision, reason) {
  if (decision !== "deny") {
    process.stdout.write("", () => process.exit(0));
    return;
  }
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

const isFolder = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

/** Records one target before the call; returns how many files that puts on record. A removed or copied-into folder records what is under it. */
function record(b) {
  const at = { root: b.root, runId: b.run_id, path: b.abs, by: "hook" };
  if (b.kind === "write") return recordBefore(at) ? 1 : 0;
  if (b.kind === "unsure") return recordBefore({ ...at, dirtyOnly: true }) ? 1 : 0;
  if (isFolder(b.abs)) return recordFolderBefore(at);
  return existsSync(b.abs) && recordBefore(at) ? 1 : 0;
}

/** Snapshots each target a binding contract cleared; returns how many files are on record. Never throws. */
function snapshot(call, out) {
  let n = 0;
  const seen = new Set();
  const patched = new Set(call.tool_name === "Bash" ? shellPatchTargets(callCommand(call)) : []);
  const targets = [
    ...out.bound.map((b) => ({ ...b, kind: "write" })),
    ...out.unsure.map((b) => ({ ...b, kind: "unsure" })),
    ...out.removed.map((b) => ({ ...b, kind: "remove" })),
    ...(out.folders ?? []).map((b) => ({ ...b, kind: "folder" })),
  ];
  for (const b of targets) {
    const key = `${b.root}\0${b.abs}`;
    if (seen.has(key) || !b.binds || !b.run_id) continue;
    seen.add(key);
    if (call.tool_name === "Bash" && !isLiteralWord(b.target) && !patched.has(b.target)) continue;
    try {
      n += record(b);
    } catch (e) {
      console.error(`[mmo-brownfield write-contract] WARN: no provenance snapshot of ${b.target}: ${e?.message ?? e}`);
      log("warn", "provenance.snapshot_failed", { run_id: b.run_id, path: b.target, wired_by: WIRED_BY });
    }
  }
  return n;
}

async function main() {
  const call = await readStdinJson();
  if (!call || typeof call !== "object") return reply("allow");
  const out = decideCall(call, { wiredBy: WIRED_BY });
  for (const w of out.warnings) console.error(`[mmo-brownfield write-contract] WARN: ${w}`);
  const row = out.record?.row;
  if (out.decision === "deny") {
    console.error(`[mmo-brownfield write-contract] DENY: ${out.reason}`);
    log("warn", "write.deny", { run_id: row?.run_id, path: row?.path, matched_rule: row?.matched_rule, wired_by: WIRED_BY });
  } else {
    log("debug", "write.allow", { run_id: row?.run_id, path: row?.path, wired_by: WIRED_BY });
    const n = snapshot(call, out);
    if (row && (out.bound.length || out.removed.length || out.folders?.length || n > 0)) row.snapshots = n;
  }
  recordDecision(out.record);
  reply(out.decision, out.reason);
}

main().catch((e) => {
  if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
  reply("allow");
});
