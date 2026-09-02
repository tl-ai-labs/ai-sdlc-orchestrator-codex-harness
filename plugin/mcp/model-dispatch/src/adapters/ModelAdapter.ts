/**
 * ModelAdapter — every model implements this so the orchestrator can call
 * any of them uniformly.
 */

import type { ExecutionResult, ModelConfig, RunContext, TaskPacket } from "../types.js";

export interface ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;

  /**
   * Where this adapter's `cost_usd` comes from. Omitted means `vendor` — the
   * adapter reports real vendor-metered usage. An adapter that can only
   * derive cost (the codex-cli path, where the CLI reports tokens but no
   * money) declares `modeled` so telemetry and the run report label it
   * honestly instead of presenting a calculation as a bill.
   */
  readonly costProvenance?: "vendor" | "estimated" | "modeled";

  /**
   * Execute one TaskPacket. `cacheContext` keys an optional context cache
   * (Gemini). `runContext` says WHERE the run is happening — ignored by
   * completion adapters; required by adapters that delegate to an agent.
   */
  execute(
    packet: TaskPacket,
    cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult>;
}

export type AdapterFactory = (config: ModelConfig) => ModelAdapter;
