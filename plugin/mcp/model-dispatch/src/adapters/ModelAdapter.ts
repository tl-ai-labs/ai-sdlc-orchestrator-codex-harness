/**
 * ModelAdapter — every model implements this so the orchestrator can call
 * any of them uniformly.
 */

import type { ExecutionResult, ModelConfig, RunContext, TaskPacket } from "../types.js";

export interface ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;

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
