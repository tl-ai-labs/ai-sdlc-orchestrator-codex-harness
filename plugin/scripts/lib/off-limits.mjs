/**
 * Off-limits pattern lists and the one glob matcher every caller uses.
 *
 * OFF_LIMITS_DEFAULT is what setup writes to `.sdlc/project.json` and what
 * write-contract.mjs merges into every frozen contract. HARDCODED_OFF_LIMITS
 * is the narrow set the write hook refuses in every state, with or without a
 * contract: secrets, machine config and git's own store. Build output and
 * `.sdlc/local/**` stay out of it, because the plugin hook runs in every Codex
 * session on the machine, not only in harness runs.
 */

/** The full project-wide default list, written to project.json by setup. */
export const OFF_LIMITS_DEFAULT = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".codex/config.toml",
  ".codex/auth.json",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  // `.sdlc/local/**`, not `.sdlc/**`: `.sdlc/` is the harness's own output folder.
  ".sdlc/local/**",
  ".git/**",
  // The conductor's skill scan path: a run must not rewrite the rules it is judged by.
  ".agents/**",
];

/** Refused at any depth, in any case, whatever any contract says. A strict subset of OFF_LIMITS_DEFAULT. */
export const HARDCODED_OFF_LIMITS = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".codex/config.toml",
  ".codex/auth.json",
  ".git/**",
  ".agents/**",
];

/**
 * Names a write may create when no contract binds and nothing is at the path yet: the greenfield
 * test bootstrap copies `.env.test` to `.env`, and codegen emits `.env.example` and `.env.test`.
 */
export const CREATABLE_WHEN_ABSENT = [".env", ".env.example", ".env.test"];

const withoutDotSlash = (s) => s.replace(/^(?:\.\/)+/, "");

// The write contract's glob dialect: `**` any characters, and as a whole folder name zero or more folders, so
// `src/**/*.ts` takes `src/a.ts`; `*` any but `/`; `?` one character but `/`. A leading `./` names the project root.
// `ci` matches without regard to case (macOS and Windows disks treat `.ENV` and `.env` as one file).
export function matchGlob(path, pattern, { ci = false } = {}) {
  if (typeof path !== "string" || typeof pattern !== "string") return false;
  const p = withoutDotSlash(path);
  const g = withoutDotSlash(pattern);
  if (p === g || (ci && p.toLowerCase() === g.toLowerCase())) return true;
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/(?<=^|\/)\*\*\//g, "\x01")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x01/g, "(?:.*/)?")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`, ci ? "i" : "").test(p);
}

/** A base pattern (`.env`, `.git/**`) matched at any nesting depth, without regard to case. */
export function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern, { ci: true })) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern, { ci: true });
}

/**
 * The first HARDCODED_OFF_LIMITS pattern a path matches at any depth, or null. A `<folder>/**` pattern also takes the
 * folder's own name: a linked worktree's `.git` is a file that points git at its store.
 */
export function hardcodedHit(path) {
  return HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(path, p) || (p.endsWith("/**") && matchesAtAnyDepth(path, p.slice(0, -3)))) ?? null;
}

/** The first pattern of `patterns` a path matches, anchored at the project root, or null. */
export function firstMatch(path, patterns, { ci = false } = {}) {
  if (!Array.isArray(patterns)) return null;
  return patterns.find((p) => typeof p === "string" && matchGlob(path, p, { ci })) ?? null;
}
