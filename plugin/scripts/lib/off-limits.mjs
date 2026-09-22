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
  ".codex/config.toml",
  ".codex/auth.json",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  // `.sdlc/local/**`, NOT `.sdlc/**`. The wider pattern is what the source
  // carries, and it is self-defeating here: `.sdlc/` is the harness's own
  // output directory, so blocking it stops the conductor writing the very
  // artifacts the run exists to produce — requirements.md, design.md,
  // packets.json, telemetry. Found by the first real end-to-end run, which
  // halted at the first packet write.
  //
  // What genuinely must stay tamper-proof is the enforcement state itself:
  // the write contract and the guard's own decision log. Those live under
  // `.sdlc/local/`, and that is what this protects.
  ".sdlc/local/**",
  ".git/**",
  // Codex's skill scan path. `verify-setup.mjs --fix` links the harness's own
  // skills in here, so these files ARE the conductor's operating instructions
  // — the pipeline state machine, the brownfield guide, the reviewer roles. A
  // run that could write here could rewrite the rules it is being judged by,
  // which is the same reason `.sdlc/local/**` and `.codex/config.toml` are on
  // this list. Nothing a run legitimately produces belongs here.
  ".agents/**",
];

/** The pre-contract safety-net subset. Same list — sharing one source. */
export const HARDCODED_OFF_LIMITS = OFF_LIMITS_DEFAULT;
