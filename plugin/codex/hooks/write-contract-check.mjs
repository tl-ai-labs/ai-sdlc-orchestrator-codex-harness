#!/usr/bin/env node
/**
 * Brownfield write-contract PreToolUse hook — codex edition.
 *
 * Refuses Write/Edit-equivalent operations against paths outside the
 * confirmed allowlist when brownfield mode is active. Silent no-op when no
 * active contract file exists — greenfield runs and non-plugin editing are
 * unaffected.
 *
 * Contract file: <repo-root>/.sdlc/local/write-contract.json
 *   { schema_version, active, mode, run_id, strict, allowlist, off_limits }
 *
 * REBUILT for codex, not ported verbatim, for two reasons verified live
 * (docs/verification/p1-codex-runtime.md, checks 1/6 and their follow-up):
 *
 *   1. Codex's model defaults to its native `apply_patch` tool for file
 *      edits — it refuses a shell-redirect write outright once told the
 *      workspace prefers the patch mechanism. A guard registered on
 *      matcher="Bash" alone would see almost none of a run's real writes.
 *      This hook is registered on BOTH `Bash` and `apply_patch` and extracts
 *      the target path differently for each: `apply_patch`'s target is
 *      embedded as OpenAI patch-format text in `tool_input.command` (no
 *      `file_path` field exists at all), one call can name several files,
 *      and `Bash`'s target is a shell redirect inside `tool_input.command`.
 *   2. Codex ignores a bare exit code — a `process.exit(1)` with no JSON
 *      reply does NOT block the call (verified live: the write went through
 *      anyway). The decision must be the JSON `hookSpecificOutput` shape on
 *      stdout; exit code is not the wire protocol here, unlike Claude Code's
 *      hook contract the source repo's version of this file relies on.
 *
 * Everything path-shaped below (contract lookup, repo-root resolution,
 * glob matching, cross-repo escape detection) is carried near-verbatim from
 * the source's plugin/scripts/write-contract-check.mjs — that logic has no
 * dependency on which agent issued the call.
 *
 * Fail-safe philosophy, unchanged: any bug in this hook must NOT block user
 * work. Parse failures, missing fields, unresolvable paths, an unparseable
 * command — all allow. The only denials are on known off-limits or
 * non-allowlist matches when the contract file itself parses cleanly, is
 * active, and a target path was actually extracted.
 *
 * Denied calls leave no trace in `codex exec --json` (verified live) — this
 * hook writes its own record to `.sdlc/local/guard-decisions.jsonl` next to
 * the contract file for every decision, allow or deny, so the audit trail
 * survives even though the event stream can't reconstruct it.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep, dirname, isAbsolute, join } from "node:path";
import { HARDCODED_OFF_LIMITS } from "../../scripts/lib/off-limits.mjs";
import { log } from "../../scripts/lib/log.mjs";

const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";
const GUARD_DECISIONS_REL_PATH = ".sdlc/local/guard-decisions.jsonl";

async function readStdinJson() {
  return await new Promise((resolveP) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => {
      try {
        resolveP(JSON.parse(buf));
      } catch {
        resolveP(null);
      }
    });
    // Some environments never close stdin; give up after a short beat and allow.
    setTimeout(() => resolveP(null), 1500).unref();
  });
}

/**
 * Walk from `start` up the filesystem until we find a directory containing
 * the given relative path. Returns the absolute contract path if found, else null.
 * Bounded to avoid pathological loops on unusual filesystems.
 */
function findContractPath(start) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const candidate = resolve(dir, CONTRACT_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Repo-relative path resolution + escape detection. Returns `{ rel, escapes }`
 * where `escapes: true` means the target resolves OUTSIDE the contract's repo
 * root. An escape is a category error — the run is trying to write outside
 * its own project — and gets a distinct deny message.
 */
function toRepoRelative(target, contractPath) {
  const repoRoot = resolve(contractPath, "..", "..", ".."); // .sdlc/local/write-contract.json → repo root
  const abs = resolve(repoRoot, target);
  let rel = relative(repoRoot, abs);
  if (sep !== "/") rel = rel.split(sep).join("/");
  return { rel, escapes: rel.startsWith("../") || rel === ".." };
}

/**
 * Minimal glob matcher. Supports:
 *   `**` — any characters including `/`
 *   `*`  — any characters except `/`
 *   `?`  — any single character except `/`
 *   Literal `/` and other characters.
 * No brace expansion, no character classes, no negation. That's enough for
 * repo scope patterns like `src/**`, `docs/*.md`, `apps/api/**`, `.env`.
 */
function matchGlob(path, pattern) {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern)) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern);
}

function firstMatch(path, patterns) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p === "string" && matchGlob(path, p)) return p;
  }
  return null;
}

function readContractSafe(path) {
  try {
    const st = statSync(path);
    if (st.size > 128 * 1024) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── codex-specific: target extraction from the two hookable tool shapes ──

/**
 * `apply_patch`'s `tool_input.command` is OpenAI's patch-format text, not a
 * unified diff: a `*** Begin Patch` / `*** End Patch` envelope containing one
 * or more `*** Add File: <path>` / `*** Update File: <path>` /
 * `*** Delete File: <path>` / `*** Move to: <path>` header lines. A single
 * call can touch several files (each gets its own header), and a rename
 * carries both the original `*** Update File:` path and a `*** Move to:`
 * destination — both are real write targets and both get checked.
 */
function extractApplyPatchTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  const headerRe = /^\*\*\*\s*(Add File|Update File|Delete File|Move to):\s*(.+)$/gm;
  let m;
  while ((m = headerRe.exec(command)) !== null) {
    const path = m[2].trim();
    if (path) targets.push(path);
  }
  return targets;
}

/**
 * `Bash`'s `tool_input.command` is a shell command line. Full shell parsing
 * is out of scope (same tradeoff the source's own glob matcher documents for
 * itself); this catches the common, unambiguous write shapes — redirects,
 * `tee`, `touch`, `cp`, and `mv` (destination only) — which cover the
 * overwhelming majority of file-creating shell commands. A command this
 * misses fails open (allowed), consistent with the fail-safe philosophy:
 * this heuristic is a real backstop, not a claim of exhaustive shell
 * parsing. Verified live (docs/verification/p1-codex-runtime.md) that a
 * bare `touch`/creation-without-redirect call, if unhandled, slips an empty
 * file past the contract even while a subsequent content-write to the same
 * path is correctly blocked — this function exists specifically to close
 * that gap, not as speculative hardening.
 */
function extractBashRedirectTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  // `>` / `>>`, optionally preceded by a file-descriptor number, not
  // preceded by `<`, `2`, or another `>` (so `2>&1` and `>>` are not double-
  // matched as two separate single-`>` redirects).
  const redirectRe = /(?:^|[\s;&|(])\d*>{1,2}\s*([^\s;&|()<>]+)/g;
  let m;
  while ((m = redirectRe.exec(command)) !== null) {
    const target = m[1].trim();
    // `&1`, `&2` etc. are fd duplications, not file targets.
    if (target && !/^&\d+$/.test(target)) targets.push(target);
  }
  const teeRe = /\btee\b\s+(?:-a\s+)?([^\s;&|()<>-][^\s;&|()<>]*)/g;
  while ((m = teeRe.exec(command)) !== null) {
    if (m[1]) targets.push(m[1].trim());
  }
  // `touch a b c` — every argument is a file it creates or updates.
  const touchRe = /\btouch\s+((?:-[a-zA-Z]+\s+)*(?:[^\s;&|()<>-][^\s;&|()<>]*\s*)+)/g;
  while ((m = touchRe.exec(command)) !== null) {
    for (const arg of m[1].trim().split(/\s+/)) if (arg) targets.push(arg);
  }
  // `cp [-flags] src... dest` / `mv [-flags] src dest` — only the last
  // (non-flag) argument is a write target; earlier ones are read, not
  // written. A trailing `/` dest (copy-into-directory) is intentionally
  // excluded — the actual created file's name isn't determined here, and
  // the directory itself is the more useful thing to gate at that point.
  const cpMvRe = /\b(?:cp|mv)\s+((?:-[a-zA-Z]+\s+)*(?:[^\s;&|()<>-][^\s;&|()<>]*\s*)+)/g;
  while ((m = cpMvRe.exec(command)) !== null) {
    const args = m[1].trim().split(/\s+/).filter(Boolean);
    const dest = args[args.length - 1];
    if (dest && !dest.endsWith("/")) targets.push(dest);
  }
  return targets;
}

/** Every candidate write target this call names, in the order found. */
function extractTargets(call) {
  const toolName = call?.tool_name;
  const command = call?.tool_input?.command;
  if (toolName === "apply_patch") return extractApplyPatchTargets(command);
  if (toolName === "Bash") return extractBashRedirectTargets(command);
  // Forward-compat / test convenience: a structured file_path field, the
  // shape the source repo's Claude-side hook used.
  const structured = call?.tool_input?.file_path ?? call?.tool_input?.path ?? call?.input?.file_path;
  return typeof structured === "string" && structured.length > 0 ? [structured] : [];
}

// ── D3: guard-decisions sidecar — the only record a denial leaves ──

async function recordDecision(contractPath, decision) {
  try {
    const repoRoot = contractPath ? resolve(contractPath, "..", "..", "..") : process.cwd();
    const sidecarPath = join(repoRoot, GUARD_DECISIONS_REL_PATH);
    await mkdir(dirname(sidecarPath), { recursive: true });
    await appendFile(sidecarPath, JSON.stringify({ ts: new Date().toISOString(), ...decision }) + "\n");
  } catch {
    // Sidecar writes are best-effort — never let a logging failure affect
    // the actual allow/deny decision or hang the hook.
  }
}

function reply(decision, reason) {
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(out));
}

async function allow(msg, ctx = {}) {
  if (msg && process.env.MMO_DEBUG === "1") {
    console.error(`[mmo-brownfield write-contract] ALLOW: ${msg}`);
  }
  log("debug", "write.allow", { run_id: ctx.runId, path: ctx.path, matched_rule: ctx.matchedRule });
  await recordDecision(ctx.contractPath, { decision: "allow", reason: msg, path: ctx.path, run_id: ctx.runId, matched_rule: ctx.matchedRule });
  reply("allow");
  process.exit(0);
}

async function deny(msg, ctx = {}) {
  console.error(`[mmo-brownfield write-contract] DENY: ${msg}`);
  log("warn", "write.deny", {
    run_id: ctx.runId,
    path: ctx.path,
    matched_off_limits_rule: ctx.matchedRule,
    strict: ctx.strict,
  });
  await recordDecision(ctx.contractPath, {
    decision: "deny",
    reason: msg,
    path: ctx.path,
    run_id: ctx.runId,
    matched_rule: ctx.matchedRule,
    tool_name: ctx.toolName,
  });
  reply("deny", msg);
  process.exit(0);
}

async function main() {
  const call = await readStdinJson();
  if (!call || typeof call !== "object") return allow("no parseable tool call on stdin");

  const targets = extractTargets(call);
  if (targets.length === 0) {
    return allow("no write target extracted from this tool call");
  }

  // Check every extracted target; the first denial wins and blocks the
  // whole call — a multi-file apply_patch touching one off-limits file
  // among several legitimate ones is refused entirely, not partially.
  for (const target of targets) {
    const verdict = await checkOneTarget(target, call);
    if (verdict.deny) {
      return deny(verdict.msg, { ...verdict.ctx, toolName: call.tool_name });
    }
  }
  return allow(`all ${targets.length} target(s) cleared`, { contractPath: findContractPath(process.cwd()) });
}

/** Returns { deny: boolean, msg?, ctx? } for a single candidate path. */
async function checkOneTarget(target, call) {
  const cwd = typeof call.cwd === "string" ? call.cwd : process.cwd();
  const absTarget = isAbsolute(target) ? target : resolve(cwd, target);
  const targetNorm = absTarget.split(sep).join("/");

  const cwdContractPath = findContractPath(cwd);
  const cwdContract = cwdContractPath ? readContractSafe(cwdContractPath) : null;

  if (cwdContract && cwdContract.active === true) {
    const cwdRepoRoot = resolve(cwdContractPath, "..", "..", "..");
    const cwdRel = relative(cwdRepoRoot, absTarget).split(sep).join("/");
    if (cwdRel.startsWith("../") || cwdRel === "..") {
      const targetContract = findContractPath(dirname(absTarget));
      return {
        deny: true,
        msg:
          `${absTarget} resolves OUTSIDE the calling session's contracted repo ` +
          `(${cwdRepoRoot}). Cross-project writes are refused — a brownfield ` +
          `run can only write inside the repo whose contract it holds.` +
          (targetContract ? ` (Target has its own contract at ${targetContract}; ` +
            `run against that project explicitly if you meant to edit it.)` : ""),
        ctx: { contractPath: cwdContractPath, path: absTarget, runId: cwdContract.run_id },
      };
    }
  }

  const contractPath = findContractPath(dirname(absTarget)) ?? cwdContractPath;

  if (!contractPath) {
    const preHit = HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(targetNorm, p));
    if (preHit) {
      return {
        deny: true,
        msg:
          `${target} matches always-off-limits pattern "${preHit}" (no active brownfield contract; ` +
          `this is the pre-contract safety net for credentials, MCP config, other-AI-tool state, ` +
          `and plugin bookkeeping). If this write is legitimate, establish an explicit contract ` +
          `first, then re-issue.`,
        ctx: { contractPath: null, path: targetNorm, matchedRule: preHit },
      };
    }
    return { deny: false };
  }

  try {
    const st = statSync(contractPath);
    if (st.size > 128 * 1024) return { deny: false };
  } catch {
    return { deny: false };
  }

  let contract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8"));
  } catch {
    return { deny: false };
  }

  if (!contract || contract.active !== true) return { deny: false };

  const { rel } = toRepoRelative(target, contractPath);

  const offHit = firstMatch(rel, contract.off_limits);
  if (offHit) {
    if (contract.strict === false) {
      console.error(
        `[mmo-brownfield write-contract] WARN: ${rel} matches off-limits pattern "${offHit}". Allowed because contract.strict = false.`
      );
      return { deny: false };
    }
    return {
      deny: true,
      msg:
        `${rel} matches off-limits pattern "${offHit}" (run ${contract.run_id ?? "?"}). ` +
        `Re-open Gate 0 to move this path out of off-limits, or set contract.strict = false ` +
        `(equivalent to --strict-write=off) to bypass.`,
      ctx: { contractPath, path: rel, matchedRule: offHit, runId: contract.run_id, strict: contract.strict },
    };
  }

  const allowHit = firstMatch(rel, contract.allowlist);
  if (allowHit) return { deny: false };

  if (contract.strict === false) {
    console.error(
      `[mmo-brownfield write-contract] WARN: ${rel} is not in the confirmed allowlist. Allowed because contract.strict = false.`
    );
    return { deny: false };
  }
  return {
    deny: true,
    msg:
      `${rel} is not in the confirmed allowlist for run ${contract.run_id ?? "?"}. ` +
      `Re-open Gate 0 to expand scope to include this path, or set contract.strict = false ` +
      `(equivalent to --strict-write=off) to bypass.`,
    ctx: { contractPath, path: rel, runId: contract.run_id, strict: contract.strict },
  };
}

main().catch(async (e) => {
  // Unhandled error — fail-open. Better to permit a write than to wedge the user.
  if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
  reply("allow");
  process.exit(0);
});
