// Imports nothing, so policy.ts (and run.mjs through dist/policy.js) can
// validate adapter ids without loading any vendor SDK.

export const ADAPTER_IDS = [
  "builtin-anthropic",
  "claude-cli",
  "openai",
  "codex-cli",
  "mcp:model-dispatch",
  "mcp:gemini-flash-server",
  "antigravity-worker",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

export const KNOWN_ADAPTER_IDS: ReadonlySet<string> = new Set(ADAPTER_IDS);

/** Adapters that call an Anthropic model. This harness runs none (D9). */
export const ANTHROPIC_ADAPTER_IDS: ReadonlySet<string> = new Set(["builtin-anthropic", "claude-cli"]);
