/**
 * Environment sanitation for the plugin install route.
 *
 * plugin.json declares the MCP server's env as `"${NAME}"` pass-throughs.
 * When the host never set a variable, the child receives the literal
 * `${NAME}` string, not an empty value. The literal is truthy, so every
 * downstream credential check reads it as "set" — this module strips such
 * values before anything else runs.
 */

/** `${NAME}` and nothing else. Anchored so a real value containing `$` survives. */
export const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** True when a value carries no information: absent, empty, or `${NAME}`. */
export function isUnusableEnvValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === "" || UNEXPANDED_PLACEHOLDER.test(trimmed);
}

/**
 * Variables plugin.json declares as pass-throughs, and the only ones we touch.
 * Kept in sync by hand with DECLARED_ENV in plugin/codex/verify-setup.mjs.
 * No ANTHROPIC_API_KEY (D9) — the official codex policy's judgment worker
 * bills OPENAI_API_KEY via the openai adapter instead.
 */
export const PLUGIN_DECLARED_ENV = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  "MMO_SELECT",
  // No SDLC_SELECT. The source declares it as a compat shim for installs
  // predating its own sdlc→mmo rename; this repo is new, so no such install
  // exists to be compatible with, and the manifest does not declare it.
  // server.ts keeps its own read-side shim (carried engine code, harmless) —
  // this list is only about which manifest pass-throughs get sanitized.
  "GEMINI_WORKER_PYTHON",
  "MMO_LOG_LEVEL",
  "MMO_VERBOSE",
  "MMO_LOG_PREFIX",
] as const;

/**
 * Sanitize exactly the plugin-declared variables in place. Call once at
 * process entry, before any adapter is constructed or SDK imported for use.
 * In-place because @google/genai reads GOOGLE_CLOUD_* from process.env inside
 * library code we cannot hand a cleaned copy to.
 */
export function sanitizePluginEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of PLUGIN_DECLARED_ENV) {
    if (key in env && isUnusableEnvValue(env[key])) {
      removed.push(key);
      delete env[key];
    }
  }
  return removed;
}
