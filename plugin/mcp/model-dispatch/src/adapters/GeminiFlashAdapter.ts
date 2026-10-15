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
  RunContext,
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
import { DispatchPricer, priceFields, refusedResult, type Clock } from "./dispatchPricer.js";
import { answeredWithError, describeVendorFailure, neverSent } from "./vendorFailure.js";
import { dispatchTimeoutMs, startDeadline, type Deadline } from "./deadline.js";
import type { Priced } from "../prices.js";

// Fallback when the policy YAML omits max_output_tokens_absolute. 8192 is
// the current Gemini 3.5 Flash ceiling.
const GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 8192;

const MAX_DOUBLINGS = 3;

// One hour comfortably covers a full pass.
const CACHE_TTL_SECONDS = 3600;

export interface GeminiFlashOptions {
  clock?: Clock;
  /** A test stub; otherwise the door is picked from credentials. */
  transport?: GeminiTransport;
}

export class GeminiFlashAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private transport: GeminiTransport;
  /** Which door was picked — surfaced in errors and setup logs. */
  readonly backendChoice: BackendChoice;
  private readonly pricer: DispatchPricer;
  private cachingAvailable = true;
  private cacheNamesByKey = new Map<string, string>(); // cacheContext -> cachedContentName
  private cacheHeader = ""; // the stable text we cache (set once via primeCache)

  constructor(config: ModelConfig, options: GeminiFlashOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    if (options.transport) {
      this.transport = options.transport;
      this.backendChoice = { backend: options.transport.backend, reason: "injected transport" };
    } else {
      // Throws at construction (before any premium spend) if neither door works.
      const { transport, choice } = buildGeminiTransport(config.auth?.env ?? "GEMINI_API_KEY");
      this.transport = transport;
      this.backendChoice = choice;
    }
    this.pricer = new DispatchPricer(config, options.clock);
  }

  /**
   * The card a dispatch on `date` bills, with the +10% regional surcharge for
   * the resolved endpoint. Priced per dispatch, never at construction: the
   * bridge keeps adapters for its whole life, and a list entry can end while
   * it runs.
   */
  pricingOn(date: Date = this.pricer.now()): { unpriced: true; reason: string } | { unpriced: false; price: Priced; billed: ModelPricing } {
    const price = this.pricer.price(date);
    if (price.unpriced) return { unpriced: true, reason: price.reason };
    const billed = applyVertexSurcharge(price.pricing, {
      backend: this.transport.backend,
      location: this.transport.location,
      modelName: this.modelConfig.model_name,
    });
    return { unpriced: false, price, billed };
  }

  /** The billed card for a dispatch now; undefined when nothing prices the model today. */
  get billedPricing(): ModelPricing | undefined {
    const r = this.pricingOn();
    return r.unpriced ? undefined : r.billed;
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

  async execute(packet: TaskPacket, cacheContext?: string, runContext?: RunContext): Promise<ExecutionResult> {
    const deadline = startDeadline(dispatchTimeoutMs(this.modelConfig), runContext?.signal);
    try {
      return await this.dispatch(packet, deadline, cacheContext, runContext);
    } finally {
      deadline.clear();
    }
  }

  private async dispatch(
    packet: TaskPacket,
    deadline: Deadline,
    cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult> {
    const cacheName = cacheContext ? this.cacheNamesByKey.get(cacheContext) : undefined;
    const cacheHit = !!cacheName;
    const userPrompt = buildUserPrompt(packet, !cacheHit ? this.cacheHeader : "");

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;

    // `__free_text__` marker means the caller wants markdown, not JSON.
    // Skip JSON mode; the marker never reaches the vendor (400 on unknown).
    const wantsJson = packet.outputSchema && !(packet.outputSchema as any).__free_text__;

    const attempts: AttemptRecord[] = [];
    const record = (attempt: AttemptRecord) => {
      attempts.push(attempt);
      runContext?.onAttempt?.(attempt);
    };
    // Any attempt priced from tokens the vendor did not report; summarised on the result.
    let usedEstimate = false;
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    const dispatchDate = this.pricer.now();
    const priced = this.pricingOn(dispatchDate);
    if (priced.unpriced) return refusedResult(this.modelConfig, dispatchDate, priced.reason, ceiling);
    const { billed } = priced;
    const priceTags = priceFields(priced.price);

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
          abortSignal: deadline.signal,
        });
      } catch (err: any) {
        const failure = describeVendorFailure(err);
        // Google bills only a request it answered with 200. Vertex AI: "Requests returning any
        // other response codes, such as 4xx and 5xx codes, aren't charged for the input or
        // output" (https://cloud.google.com/vertex-ai/generative-ai/pricing). The Gemini API: "If
        // your request fails with a 400 or 500 error, you won't be charged for the tokens used"
        // (https://ai.google.dev/gemini-api/docs/billing). A connection lost with no answer may
        // still have been served, so it keeps the prompt as an estimate.
        const unbilled = answeredWithError(failure) || neverSent(failure);
        const failTokens = unbilled
          ? { input: 0, input_cached: 0, output: 0 }
          : { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        record({
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, billed),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: deadline.expired
            ? `dispatch deadline of ${dispatchTimeoutMs(this.modelConfig) / 1000}s reached (the leaf's worker_timeout_sec): ${err?.message ?? err}`
            : (err?.message ?? String(err)),
          ...failure,
          ...priceTags,
          ...(unbilled ? {} : { cost_provenance: "estimated" as const, usage_complete: false as const }),
        });
        return this.finalizeResult(attempts, null, cacheHit, "vendor_error", usedEstimate || !unbilled);
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
      const missingOutputUsage =
        usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined;
      const attemptEstimated =
        (usage.cachedContentTokenCount === undefined && cacheHit) ||
        usage.promptTokenCount === undefined ||
        missingOutputUsage;
      if (attemptEstimated) usedEstimate = true;
      const outputTokens = missingOutputUsage ? estimateTokens(text) : billedOutputTokens(usage);
      const attemptTokens = {
        input: Math.max(0, promptTokens - cachedTokens),
        input_cached: cachedTokens,
        output: outputTokens,
      };

      // Only MAX_TOKENS triggers doubling. STOP/SAFETY/RECITATION/OTHER are
      // genuine terminations.
      const finishReason = outcome.finishReason;
      const hitOutputCap = finishReason === "MAX_TOKENS";

      record({
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: finishReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, billed),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
        ...priceTags,
        ...(attemptEstimated ? { cost_provenance: "estimated" as const } : {}),
      });

      if (!hitOutputCap) {
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, cacheHit, "success", usedEstimate);
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
          usedEstimate,
        );
      }
      ceiling = nextCeiling;
    }

    return this.finalizeResult(attempts, null, cacheHit, "output_cap_doubling_budget_exhausted", usedEstimate);
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
    /** True when any attempt priced tokens from `estimateTokens`; see ExecutionResult.cost_provenance. */
    usedEstimate = false,
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
      ...(usedEstimate ? { cost_provenance: "estimated" as const } : {}),
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
