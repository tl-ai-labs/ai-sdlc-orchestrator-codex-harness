/**
 * Central env reader for the script layer (docs/brownfield-v1-planning/plan.md
 * D4 — specified, never built until now). Consolidates the reads that used
 * to be copy-pasted per script: project-root resolution, and the MMO_*
 * logging env vars' precedence. Importable freely within plugin/scripts/**
 * (one ESM layer) — the MCP server cannot import this (§3), so
 * plugin/mcp/model-dispatch/src/log.ts re-implements resolveLogLevel's
 * precedence independently.
 */
import { spawnSync } from "node:child_process";

const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);

/**
 * The command layer resolves the project root once and passes it down
 * (--project-root=<abs-path>); scripts invoked without it fall back to
 * `git rev-parse --show-toplevel`, then cwd. Mirrors write-provenance.mjs's
 * resolveProjectRoot — the SiteNotes bug (a stale cwd silently writing into
 * the wrong git worktree) is exactly why --project-root should always be
 * passed rather than relying on this fallback.
 */
export function resolveProjectRoot(explicit) {
  if (explicit) return explicit;
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return process.cwd();
}

/**
 * Highest precedence first: a per-call argument (passed explicitly by the
 * caller, since the MCP server process starts once per session and cannot
 * re-read its env mid-session), MMO_LOG_LEVEL, MMO_VERBOSE, MMO_DEBUG, the
 * legacy SDLC_DEBUG (warns once), default info.
 */
export function resolveLogLevel(env = process.env, explicit) {
  if (explicit && LEVELS.has(explicit)) return { level: explicit, legacyUsed: false };
  const named = env.MMO_LOG_LEVEL?.trim().toLowerCase();
  if (named && LEVELS.has(named)) return { level: named, legacyUsed: false };
  if (env.MMO_VERBOSE === "1") return { level: "debug", legacyUsed: false };
  if (env.MMO_DEBUG === "1") return { level: "debug", legacyUsed: false };
  if (env.SDLC_DEBUG === "1") return { level: "debug", legacyUsed: true };
  return { level: "info", legacyUsed: false };
}
