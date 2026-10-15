import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";
import { AntigravityWorkerAdapter } from "./AntigravityWorkerAdapter.js";
import { ClaudeCliAdapter } from "./ClaudeCliAdapter.js";
import { OpenAIAdapter } from "./OpenAIAdapter.js";
import { CodexCliAdapter } from "./CodexCliAdapter.js";
import { KNOWN_ADAPTER_IDS, type AdapterId } from "./ids.js";
import { log } from "../log.js";

/**
 * Adapter registry, keyed on the policy YAML's `adapter:` field.
 *   builtin-anthropic  → Claude, direct SDK (needs ANTHROPIC_API_KEY). Dormant:
 *                        not in the official codex policy (D9), no Anthropic
 *                        credential in codex setup. Carried compiled+tested.
 *   claude-cli         → Claude, via local `claude -p` subprocess (Max subscription
 *                        OAuth). Dormant for the same reason as builtin-anthropic.
 *   openai             → GPT, direct SDK (needs OPENAI_API_KEY). The judgment
 *                        worker in the official codex policy (D9).
 *   codex-cli          → GPT, via a local `codex exec` subprocess on a ChatGPT
 *                        seat's login. Same model, no API key — but codex
 *                        reports no cost, so its figures are modeled rather
 *                        than metered. Fallback for running without a key.
 *   mcp:model-dispatch → Gemini as a model (one completion call)
 *   antigravity-worker → Gemini as an agent (Antigravity SDK session)
 */

/** MMO-D8 compat shim: a hand-authored policy may still use the pre-rename id. */
const LEGACY_GEMINI_ADAPTER_ID = "mcp:gemini-flash-server";
let legacyAdapterIdWarned = false;

// Typed against AdapterId, so tsc rejects an id in ids.ts with no factory here.
const ADAPTER_FACTORIES: Record<AdapterId, (config: ModelConfig) => ModelAdapter> = {
  "builtin-anthropic": (c) => new BuiltinAnthropicAdapter(c),
  "claude-cli": (c) => new ClaudeCliAdapter(c),
  openai: (c) => new OpenAIAdapter(c),
  "codex-cli": (c) => new CodexCliAdapter(c),
  "mcp:model-dispatch": (c) => new GeminiFlashAdapter(c),
  [LEGACY_GEMINI_ADAPTER_ID]: (c) => {
    if (!legacyAdapterIdWarned) {
      legacyAdapterIdWarned = true;
      log("warn", "policy.adapter.deprecated", { adapter_id_seen: LEGACY_GEMINI_ADAPTER_ID, canonical: "mcp:model-dispatch" });
    }
    return new GeminiFlashAdapter(c);
  },
  "antigravity-worker": (c) => new AntigravityWorkerAdapter(c),
};

export const REGISTERED_ADAPTER_IDS: readonly string[] = Object.keys(ADAPTER_FACTORIES);

export function createAdapter(config: ModelConfig): ModelAdapter {
  if (KNOWN_ADAPTER_IDS.has(config.adapter)) {
    return ADAPTER_FACTORIES[config.adapter as AdapterId](config);
  }
  throw new Error(
    `No adapter registered for '${config.adapter}'. Known adapters: ${REGISTERED_ADAPTER_IDS.join(", ")}.`,
  );
}

export type { ModelAdapter } from "./ModelAdapter.js";
