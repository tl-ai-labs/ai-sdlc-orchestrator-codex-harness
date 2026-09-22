/**
 * MUST be imported before any SDK. Deletes plugin-declared env vars whose
 * value is the literal `${NAME}` placeholder — the state plugin.json's env
 * pass-throughs leave in the child process when the host never set the
 * variable. ES module evaluation order is the only guarantee this runs before
 * third-party trees (like @google/genai) read process.env.
 */
import { sanitizePluginEnv } from "./env.js";
import { log } from "./log.js";

const removed = sanitizePluginEnv();

if (removed.length > 0) {
  // stderr, never stdout: stdout is the MCP stdio transport and any stray byte
  // corrupts JSON-RPC framing. Names only, never values — the stripped set
  // includes API keys, and a partially-substituted placeholder could carry one.
  log("warn", "env.placeholder.strip", { names: removed.join(",") });
}
