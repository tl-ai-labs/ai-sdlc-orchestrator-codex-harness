/**
 * Shared off-limits pattern lists. Two consumers:
 *   - plugin/scripts/setup-policy.mjs writes OFF_LIMITS_DEFAULT to
 *     `.sdlc/project.json` so Gate 0 can name them once and skip repeating
 *     the constants each ticket.
 *   - plugin/scripts/write-contract-check.mjs uses HARDCODED_OFF_LIMITS as
 *     the pre-contract safety net: even without an active brownfield contract,
 *     always-sensitive paths (credentials, MCP config, plugin bookkeeping,
 *     other-AI-tool state) are refused.
 *
 * HARDCODED_OFF_LIMITS is a subset that MUST match the entries in
 * OFF_LIMITS_DEFAULT — this file exists so the two never drift again.
 * Everything in this file is a pattern the shared matchesAtAnyDepth() below
 * will match against a target at any nesting depth.
 */

/** The full project-wide default list, written to project.json by setup. */
export const OFF_LIMITS_DEFAULT = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".claude/settings.local.json",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".sdlc/**",
  ".git/**",
];

/** The pre-contract safety-net subset. Same list — sharing one source. */
export const HARDCODED_OFF_LIMITS = OFF_LIMITS_DEFAULT;
