import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";
import { AntigravityWorkerAdapter } from "./AntigravityWorkerAdapter.js";
import { ClaudeCliAdapter } from "./ClaudeCliAdapter.js";
import { log } from "../log.js";

/**
 * Adapter registry, keyed on the policy YAML's `adapter:` field.
 *   builtin-anthropic  → Claude, direct SDK (needs ANTHROPIC_API_KEY)
 *   claude-cli         → Claude, via local `claude -p` subprocess (Max subscription OAuth)
 *   mcp:model-dispatch → Gemini as a model (one completion call)
 *   antigravity-worker → Gemini as an agent (Antigravity SDK session)
 */

/** MMO-D8 compat shim: a hand-authored policy may still use the pre-rename id. */
const LEGACY_GEMINI_ADAPTER_ID = "mcp:gemini-flash-server";
let legacyAdapterIdWarned = false;

export function createAdapter(config: ModelConfig): ModelAdapter {
  if (config.adapter === "builtin-anthropic") return new BuiltinAnthropicAdapter(config);
  if (config.adapter === "claude-cli") return new ClaudeCliAdapter(config);
  if (config.adapter === "mcp:model-dispatch") return new GeminiFlashAdapter(config);
  if (config.adapter === LEGACY_GEMINI_ADAPTER_ID) {
    if (!legacyAdapterIdWarned) {
      legacyAdapterIdWarned = true;
      log("warn", "policy.adapter.deprecated", { adapter_id_seen: LEGACY_GEMINI_ADAPTER_ID, canonical: "mcp:model-dispatch" });
    }
    return new GeminiFlashAdapter(config);
  }
  if (config.adapter === "antigravity-worker") return new AntigravityWorkerAdapter(config);
  throw new Error(
    `No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`,
  );
}

export type { ModelAdapter } from "./ModelAdapter.js";
