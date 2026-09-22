/**
 * BuiltinAnthropicAdapter — direct @anthropic-ai/sdk calls with prompt
 * caching on the system block. Under `--auth=estimated` the orchestrator
 * runs the direct tier in-session and this adapter is never constructed;
 * under `--auth=vendor` it is.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { log } from "../log.js";

// Fallback when the policy YAML omits max_output_tokens_absolute. 32000 is
// the current Opus 4.7 output ceiling.
const CLAUDE_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 32000;

const MAX_DOUBLINGS = 3;

export class BuiltinAnthropicAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private client: Anthropic;
  private cachedSystem = "";

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    const envKey = config.auth?.env ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[envKey];
    if (!apiKey) {
      throw new Error(`${envKey} not set for BuiltinAnthropicAdapter (model ${config.id})`);
    }
    this.client = new Anthropic({ apiKey });
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    // Stable inputs lift into the system block with `cache_control:
    // ephemeral`; cache-read is billed at ~10% of input, so a doubling-loop
    // retry re-pays output tokens only.
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? CLAUDE_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;

    const attempts: AttemptRecord[] = [];
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    // Doubling loop; returns attempts[] so the caller can emit one telemetry
    // event per attempt with a shared task_id.
    for (let attemptNumber = 1; attemptNumber <= MAX_DOUBLINGS + 1; attemptNumber++) {
      const attemptStart = Date.now();
      const baseReq: any = {
        model: this.modelConfig.model_name,
        max_tokens: ceiling,
        system: stableBlock
          ? [{ type: "text", text: stableBlock, cache_control: { type: "ephemeral" } } as any]
          : undefined,
        messages: [{ role: "user", content: userPrompt }],
      };

      log("debug", "api.anthropic.request", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        max_tokens: ceiling,
        system_bytes: stableBlock ? Buffer.byteLength(stableBlock) : 0,
        messages_bytes: Buffer.byteLength(userPrompt),
        cache_control: stableBlock ? "ephemeral" : undefined,
      });

      let resp: any;
      let vendorError: string | undefined;
      try {
        // Some Claude versions reject `temperature` with 400; send with it,
        // retry without on that specific error (at most one extra request
        // per model, first use only).
        try {
          resp = await this.client.messages.create({ ...baseReq, temperature: 0.2 });
        } catch (e: any) {
          const msg = String(e?.message ?? e ?? "");
          const status = e?.status ?? e?.response?.status;
          const rejectsTemperature = status === 400 && /temperature/i.test(msg);
          if (!rejectsTemperature) throw e;
          resp = await this.client.messages.create(baseReq);
        }
        log("debug", "api.anthropic.response", {
          packet_id: packet.id,
          model_name: this.modelConfig.model_name,
          stop_reason: resp.stop_reason,
          usage: JSON.stringify(resp.usage ?? {}),
          http_status: 200,
        });
      } catch (err: any) {
        vendorError = err?.message ?? String(err);
        log("debug", "api.anthropic.response", {
          packet_id: packet.id,
          model_name: this.modelConfig.model_name,
          http_status: err?.status ?? err?.response?.status,
        });
        const failTokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        const attempt: AttemptRecord = {
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, this.modelConfig.pricing),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: vendorError,
        };
        attempts.push(attempt);
        // Not an output-cap; no reason to double.
        return this.finalizeResult(attempts, /*parsed*/ null, /*cacheHit*/ false, "vendor_error");
      }

      const text = resp.content
        .map((b: any) => ("text" in b ? b.text : ""))
        .join("\n")
        .trim();

      const usage = resp.usage as any;
      const attemptTokens = {
        input: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
        input_cached: usage?.cache_read_input_tokens ?? 0,
        output: usage?.output_tokens ?? estimateTokens(text),
      };
      const stopReason = resp.stop_reason as string | undefined;
      const hitOutputCap = stopReason === "max_tokens";

      const attempt: AttemptRecord = {
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: stopReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, this.modelConfig.pricing),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
      };
      attempts.push(attempt);

      if (!hitOutputCap) {
        // Genuine completion — parse and return.
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, attemptTokens.input_cached > 0, "success");
      }

      // Hit output cap. Double if there's headroom and retries remain.
      const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
      const atModelAbsolute = nextCeiling <= ceiling; // clamp collapsed
      const doublingsExhausted = attemptNumber > MAX_DOUBLINGS;
      if (doublingsExhausted || atModelAbsolute) {
        // `_budget_exhausted`: raise the initial ceiling on the next run.
        // `_at_model_absolute`: packet too big for this model.
        const truncatedParsed = { raw: text, _truncated: true };
        return this.finalizeResult(
          attempts,
          truncatedParsed,
          attemptTokens.input_cached > 0,
          atModelAbsolute
            ? "output_cap_at_model_absolute"
            : "output_cap_doubling_budget_exhausted",
        );
      }
      ceiling = nextCeiling;
    }

    // Unreachable; the loop always returns. Kept for TS control flow.
    return this.finalizeResult(attempts, null, false, "output_cap_doubling_budget_exhausted");
  }

  private finalizeResult(
    attempts: AttemptRecord[],
    parsed: any,
    cacheHit: boolean,
    terminalReason:
      | "success"
      | "output_cap_doubling_budget_exhausted"
      | "output_cap_at_model_absolute"
      | "vendor_error",
  ): ExecutionResult {
    // Sum across attempts so the top-level totals reflect what was billed
    // for the packet, not just the final attempt.
    const totalTokens = attempts.reduce(
      (acc, a) => ({
        input: acc.input + a.tokens.input,
        input_cached: acc.input_cached + a.tokens.input_cached,
        output: acc.output + a.tokens.output,
      }),
      { input: 0, input_cached: 0, output: 0 },
    );
    const totalCost = attempts.reduce((s, a) => s + a.cost_usd, 0);
    const totalLatency = attempts.reduce((s, a) => s + a.latency_ms, 0);
    const finalAttempt = attempts[attempts.length - 1];
    return {
      result: parsed,
      tokens: totalTokens,
      cost_usd: totalCost,
      latency_ms: totalLatency,
      cache_hit: cacheHit,
      success: terminalReason === "success",
      error: finalAttempt?.error,
      attempts,
      terminal_reason: terminalReason,
    };
  }
}

// Stable across every packet in a pass; matched on basename so the heuristic
// survives the brief and output dir living at any repo path.
const STABLE_INPUT_BASENAMES = new Set([
  "brief.md",
  "requirements.md",
  "design.md",
  "security_review.md",
]);
export function isStableInput(input: { path: string; reason: string }): boolean {
  const basename = input.path.split("/").pop() ?? input.path;
  if (STABLE_INPUT_BASENAMES.has(basename)) return true;
  // Explicit orchestrator marking per orchestrator.md rule 6.
  return /\bstable\b/i.test(input.reason);
}

export function splitStableFromDynamic(
  packet: TaskPacket,
  extraCachedSystem: string,
): { stableBlock: string; userPrompt: string } {
  const stableInputs = packet.inputs.filter(isStableInput);
  const dynamicInputs = packet.inputs.filter((i) => !isStableInput(i));

  const stableParts: string[] = [];
  if (extraCachedSystem) stableParts.push(extraCachedSystem);
  if (stableInputs.length > 0) {
    stableParts.push("## Project reference (stable across the pass)");
    for (const s of stableInputs) {
      stableParts.push(`### ${s.path} — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``);
    }
  }
  const stableBlock = stableParts.join("\n\n");

  const dynamicInputsBlock = dynamicInputs
    .map((s) => `### ${s.path} — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");
  const userPrompt = [
    `## TaskPacket ${packet.id} (${packet.phase}/${packet.task_type})`,
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    dynamicInputsBlock || "_(none)_",
    ``,
    `### Acceptance`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output format`,
    `Respond with strictly valid JSON conforming to this schema:`,
    "```json",
    JSON.stringify(packet.outputSchema, null, 2),
    "```",
    `No prose outside the JSON object.`,
  ].join("\n");

  return { stableBlock, userPrompt };
}
