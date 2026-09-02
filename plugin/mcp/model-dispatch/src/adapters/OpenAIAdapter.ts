/**
 * OpenAIAdapter — direct `openai` SDK calls against the Responses API, for
 * the GPT judgment worker (D9: the official codex policy's judgment tier).
 * Bills OPENAI_API_KEY server-side, independent of the codex CLI's own
 * driver-side login (ChatGPT seat or its own API key) — the two are
 * unrelated credentials for two different legs (Document B section 5).
 *
 * Mirrors BuiltinAnthropicAdapter's shape: same stable/dynamic input split,
 * same output-cap doubling loop, same attempts[] accounting. The mapping
 * differs where the vendors' APIs differ — Responses API reports
 * `incomplete_details.reason === "max_output_tokens"` where Anthropic
 * reports `stop_reason === "max_tokens"`, and cached/reasoning token counts
 * live under `usage.input_tokens_details` / `usage.output_tokens_details`.
 */

import OpenAI from "openai";
import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { log } from "../log.js";

// No published absolute output-token ceiling is pinned for gpt-5.6-terra as
// of this port; the official codex policy sets max_output_tokens_absolute
// explicitly (see plugin/config/policies/codex-official.yaml), so this
// fallback only applies to a hand-authored policy that omits the field.
const OPENAI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 32000;

const MAX_DOUBLINGS = 3;

interface OpenAIAdapterOptions {
  client?: OpenAI;
}

export class OpenAIAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private client: OpenAI;
  private cachedSystem = "";

  constructor(config: ModelConfig, options: OpenAIAdapterOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    if (options.client) {
      this.client = options.client;
    } else {
      const envKey = config.auth?.env ?? "OPENAI_API_KEY";
      const apiKey = process.env[envKey];
      if (!apiKey) {
        throw new Error(`${envKey} not set for OpenAIAdapter (model ${config.id})`);
      }
      this.client = new OpenAI({ apiKey });
    }
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? OPENAI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;
    const effort = this.modelConfig.reasoning?.effort;

    const attempts: AttemptRecord[] = [];
    // Set when an attempt has to price tokens the vendor did not report, so
    // the result can be labelled `estimated` rather than inheriting this
    // adapter's vendor-metered default.
    let usedEstimate = false;
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    for (let attemptNumber = 1; attemptNumber <= MAX_DOUBLINGS + 1; attemptNumber++) {
      const attemptStart = Date.now();
      const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
        model: this.modelConfig.model_name,
        instructions: stableBlock || undefined,
        input: userPrompt,
        max_output_tokens: ceiling,
        // Casting the pin through: this repo's shipped `openai` SDK types
        // only enumerate low/medium/high, but the codex CLI (same backend,
        // confirmed in docs/verification/p1-codex-runtime.md check 7) accepts
        // a wider live enum. "high" — this port's pin — is valid either way.
        reasoning: effort ? ({ effort } as OpenAI.Reasoning) : undefined,
      };

      log("debug", "api.openai.request", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        max_output_tokens: ceiling,
        reasoning_effort: effort,
        instructions_bytes: stableBlock ? Buffer.byteLength(stableBlock) : 0,
        input_bytes: Buffer.byteLength(userPrompt),
      });

      let resp: OpenAI.Responses.Response;
      let vendorError: string | undefined;
      try {
        resp = await this.client.responses.create(req);
        log("debug", "api.openai.response", {
          packet_id: packet.id,
          model_name: this.modelConfig.model_name,
          status: resp.status,
          usage: JSON.stringify(resp.usage ?? {}),
        });
      } catch (err: any) {
        vendorError = err?.message ?? String(err);
        log("debug", "api.openai.response", {
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
        return this.finalizeResult(attempts, null, false, "vendor_error", true);
      }

      const text = resp.output_text ?? "";
      const usage = resp.usage;
      const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
      // OpenAI reports `input_tokens` INCLUSIVE of the cached subset, while
      // computeCostUsd prices `input` and `input_cached` as disjoint buckets
      // and sums them. Handing it the inclusive total bills every cached
      // token twice. Anthropic's API reports these disjointly, which is why
      // the carried adapter needs no such subtraction and this one does.
      const cachedInput = usage?.input_tokens_details?.cached_tokens ?? 0;
      if (!usage || usage.output_tokens === undefined) usedEstimate = true;
      const attemptTokens = {
        input: usage
          ? Math.max(0, (usage.input_tokens ?? 0) - cachedInput)
          : estimateTokens(userPrompt + (stableBlock ?? "")),
        input_cached: cachedInput,
        output: usage?.output_tokens ?? estimateTokens(text),
        output_reasoning: reasoningTokens,
      };
      const hitOutputCap = resp.incomplete_details?.reason === "max_output_tokens";

      const attempt: AttemptRecord = {
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: resp.incomplete_details?.reason ?? resp.status,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, this.modelConfig.pricing),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
      };
      attempts.push(attempt);

      if (!hitOutputCap) {
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, attemptTokens.input_cached > 0, "success", usedEstimate);
      }

      const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
      const atModelAbsolute = nextCeiling <= ceiling;
      const doublingsExhausted = attemptNumber > MAX_DOUBLINGS;
      if (doublingsExhausted || atModelAbsolute) {
        const truncatedParsed = { raw: text, _truncated: true };
        return this.finalizeResult(
          attempts,
          truncatedParsed,
          attemptTokens.input_cached > 0,
          atModelAbsolute
            ? "output_cap_at_model_absolute"
            : "output_cap_doubling_budget_exhausted",
          usedEstimate,
        );
      }
      ceiling = nextCeiling;
    }

    return this.finalizeResult(attempts, null, false, "output_cap_doubling_budget_exhausted", usedEstimate);
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
    /** See ExecutionResult.cost_provenance — true when any attempt estimated. */
    usedEstimate = false,
  ): ExecutionResult {
    const totalTokens = attempts.reduce(
      (acc, a) => ({
        input: acc.input + a.tokens.input,
        input_cached: acc.input_cached + a.tokens.input_cached,
        output: acc.output + a.tokens.output,
        output_reasoning: (acc.output_reasoning ?? 0) + (a.tokens.output_reasoning ?? 0),
      }),
      { input: 0, input_cached: 0, output: 0, output_reasoning: 0 },
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
      ...(usedEstimate ? { cost_provenance: "estimated" as const } : {}),
    };
  }
}
