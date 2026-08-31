/**
 * GeminiFlashAdapter — Gemini 3.5 Flash with explicit context caching for
 * the stable project header. Auth-agnostic: the two doors live behind
 * `GeminiTransport`, picked from credentials at construction. Falls back to
 * implicit caching if explicit cache creation fails.
 */

import type {
  AttemptRecord,
  ExecutionResult,
  ModelConfig,
  ModelPricing,
  TaskPacket,
} from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import {
  applyVertexSurcharge,
  billedOutputTokens,
  buildGeminiTransport,
  type BackendChoice,
  type GeminiTransport,
  type GenerateOutcome,
} from "./geminiTransports.js";

// Fallback when the policy YAML omits max_output_tokens_absolute. 8192 is
// the current Gemini 3.5 Flash ceiling.
const GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 8192;

const MAX_DOUBLINGS = 3;

// One hour comfortably covers a full pass.
const CACHE_TTL_SECONDS = 3600;

export class GeminiFlashAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private transport: GeminiTransport;
  /** Which door was picked — surfaced in errors and setup logs. */
  readonly backendChoice: BackendChoice;
  /** Policy pricing adjusted for a pinned Vertex region. Cost reports read from here. */
  readonly billedPricing: ModelPricing;
  private cachingAvailable = true;
  private cacheNamesByKey = new Map<string, string>(); // cacheContext -> cachedContentName
  private cacheHeader = ""; // the stable text we cache (set once via primeCache)

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    // Throws at construction (before any premium spend) if neither door works.
    const { transport, choice } = buildGeminiTransport(config.auth?.env ?? "GEMINI_API_KEY");
    this.transport = transport;
    this.backendChoice = choice;
    // Resolve the +10% regional surcharge once, here — never at call sites.
    this.billedPricing = applyVertexSurcharge(config.pricing, {
      backend: choice.backend,
      location: transport.location,
      modelName: config.model_name,
    });
  }

  /**
   * Prime the explicit context cache with the stable project header.
   * Call once at the start of a pass. cacheKey is e.g. "pass2:workforce-ops".
   */
  async primeCache(cacheKey: string, header: string): Promise<void> {
    this.cacheHeader = header;
    if (!this.cachingAvailable) return;
    try {
      const cacheName = await this.transport.createCache(
        this.modelConfig.model_name,
        cacheKey,
        header,
        CACHE_TTL_SECONDS,
      );
      if (cacheName) {
        this.cacheNamesByKey.set(cacheKey, cacheName);
      } else {
        // Transport says caching is unavailable (e.g. no resolvable project).
        this.cachingAvailable = false;
      }
    } catch {
      // Quota / model mismatch / minimum-token floor. Inline the header on
      // every call instead — more expensive, still completes.
      this.cachingAvailable = false;
    }
  }

  async execute(packet: TaskPacket, cacheContext?: string): Promise<ExecutionResult> {
    const cacheName = cacheContext ? this.cacheNamesByKey.get(cacheContext) : undefined;
    const cacheHit = !!cacheName;
    const userPrompt = buildUserPrompt(packet, !cacheHit ? this.cacheHeader : "");

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;

    // `__free_text__` marker means the caller wants markdown, not JSON.
    // Skip JSON mode; the marker never reaches the vendor (400 on unknown).
    const wantsJson = packet.outputSchema && !(packet.outputSchema as any).__free_text__;

    const attempts: AttemptRecord[] = [];
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    for (let attemptNumber = 1; attemptNumber <= MAX_DOUBLINGS + 1; attemptNumber++) {
      const attemptStart = Date.now();
      const generationConfig: any = {
        temperature: 0.2,
        maxOutputTokens: ceiling,
        ...(wantsJson ? { responseMimeType: "application/json" } : {}),
      };
      if (wantsJson) generationConfig.responseSchema = packet.outputSchema;

      let outcome: GenerateOutcome;
      try {
        outcome = await this.transport.generate({
          modelName: this.modelConfig.model_name,
          prompt: userPrompt,
          generationConfig,
          cachedContentName: cacheName,
        });
      } catch (err: any) {
        const failTokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        attempts.push({
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, this.billedPricing),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: err?.message ?? String(err),
        });
        return this.finalizeResult(attempts, null, cacheHit, "vendor_error");
      }

      const text = outcome.text;
      const usage = outcome.usage;

      // `cachedContentTokenCount` is a SUBSET of `promptTokenCount` — subtract
      // to get disjoint counts (fresh at full rate, cached at discounted).
      // Without this, cached tokens are billed twice.
      const cachedTokens =
        usage.cachedContentTokenCount ?? (cacheHit ? estimateTokens(this.cacheHeader) : 0);
      const promptTokens = usage.promptTokenCount ?? estimateTokens(userPrompt);
      // Output = candidates + thoughts (see billedOutputTokens). Estimate
      // stands in only when the vendor sent no usage block at all.
      const outputTokens =
        usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined
          ? estimateTokens(text)
          : billedOutputTokens(usage);
      const attemptTokens = {
        input: Math.max(0, promptTokens - cachedTokens),
        input_cached: cachedTokens,
        output: outputTokens,
      };

      // Only MAX_TOKENS triggers doubling. STOP/SAFETY/RECITATION/OTHER are
      // genuine terminations.
      const finishReason = outcome.finishReason;
      const hitOutputCap = finishReason === "MAX_TOKENS";

      attempts.push({
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: finishReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, this.billedPricing),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
      });

      if (!hitOutputCap) {
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, cacheHit, "success");
      }

      const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
      const atModelAbsolute = nextCeiling <= ceiling;
      const doublingsExhausted = attemptNumber > MAX_DOUBLINGS;
      if (doublingsExhausted || atModelAbsolute) {
        return this.finalizeResult(
          attempts,
          { raw: text, _truncated: true },
          cacheHit,
          atModelAbsolute
            ? "output_cap_at_model_absolute"
            : "output_cap_doubling_budget_exhausted",
        );
      }
      ceiling = nextCeiling;
    }

    return this.finalizeResult(attempts, null, cacheHit, "output_cap_doubling_budget_exhausted");
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

function buildUserPrompt(packet: TaskPacket, headerInline: string): string {
  const inputsBlock = packet.inputs
    .map((s) => `### ${s.path}  — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    headerInline ? `## Project header (inlined; cache miss)\n${headerInline}\n` : "",
    `## Task — ${packet.id} (${packet.phase} / ${packet.task_type})`,
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    inputsBlock || "_(none)_",
    ``,
    `### Acceptance criteria`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output`,
    `Respond with strictly valid JSON conforming to the provided response schema.`,
    `Do not include any prose, markdown, or commentary outside the JSON.`,
  ]
    .filter(Boolean)
    .join("\n");
}
