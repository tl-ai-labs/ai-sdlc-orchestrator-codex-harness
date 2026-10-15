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
 *
 * A packet whose outputSchema OpenAI strict mode accepts (strictSchema.ts) is
 * sent as strict structured output, so the reply is held to the schema; any
 * other schema is only described in the prompt, since strict mode would refuse
 * the whole request over it.
 */

import OpenAI from "openai";
import type { AttemptRecord, ExecutionResult, ModelConfig, RunContext, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { log } from "../log.js";
import { DispatchPricer, priceFields, refusedResult, type Clock } from "./dispatchPricer.js";
import { answeredWithError, describeVendorFailure, neverSent, type VendorFailure } from "./vendorFailure.js";
import { dispatchTimeoutMs, startDeadline, type Deadline } from "./deadline.js";
import { strictSchemaProblems } from "./strictSchema.js";

// No published absolute output-token ceiling is pinned for gpt-5.6-terra as
// of this port; the official codex policy sets max_output_tokens_absolute
// explicitly (see plugin/config/policies/codex-official.yaml), so this
// fallback only applies to a hand-authored policy that omits the field.
const OPENAI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 32000;

const MAX_DOUBLINGS = 3;

/**
 * The SDK's default retry count. The client is built with maxRetries: 0 and
 * the adapter retries instead, so every request is its own recorded attempt;
 * a request the SDK resent itself would be billed with no record.
 */
const MAX_TRANSIENT_RETRIES = 2;

interface OpenAIAdapterOptions {
  client?: OpenAI;
  clock?: Clock;
  /** Milliseconds to wait before transient retry `retry` (0-based). */
  retryDelayMs?: (retry: number, err: unknown) => number;
}

export class OpenAIAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private client: OpenAI;
  private cachedSystem = "";
  private readonly pricer: DispatchPricer;
  private readonly retryDelayMs: (retry: number, err: unknown) => number;

  constructor(config: ModelConfig, options: OpenAIAdapterOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.pricer = new DispatchPricer(config, options.clock);
    this.retryDelayMs = options.retryDelayMs ?? sdkRetryDelayMs;
    if (options.client) {
      this.client = options.client;
    } else {
      const envKey = config.auth?.env ?? "OPENAI_API_KEY";
      const apiKey = process.env[envKey];
      if (!apiKey) {
        throw new Error(`${envKey} not set for OpenAIAdapter (model ${config.id})`);
      }
      this.client = new OpenAI({ apiKey, maxRetries: 0 });
    }
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket, _cacheContext?: string, runContext?: RunContext): Promise<ExecutionResult> {
    const deadline = startDeadline(dispatchTimeoutMs(this.modelConfig), runContext?.signal);
    try {
      return await this.dispatch(packet, deadline, runContext);
    } finally {
      deadline.clear();
    }
  }

  private async dispatch(packet: TaskPacket, deadline: Deadline, runContext?: RunContext): Promise<ExecutionResult> {
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? OPENAI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;
    const effort = this.modelConfig.reasoning?.effort;

    const attempts: AttemptRecord[] = [];
    const record = (attempt: AttemptRecord) => {
      attempts.push(attempt);
      runContext?.onAttempt?.(attempt);
    };
    // Any attempt priced from tokens the vendor did not report; summarised on the result.
    let usedEstimate = false;
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);
    let doublings = 0;
    let transientRetries = 0;
    let retryReason: AttemptRecord["retry_reason"];

    const dispatchDate = this.pricer.now();
    const listed = this.pricer.price(dispatchDate);
    if (listed.unpriced) return refusedResult(this.modelConfig, dispatchDate, listed.reason, ceiling);
    const format = strictFormat(packet);

    for (;;) {
      const attemptNumber = attempts.length + 1;
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
        ...(format ? { text: { format } } : {}),
      };

      log("debug", "api.openai.request", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        max_output_tokens: ceiling,
        reasoning_effort: effort,
        instructions_bytes: stableBlock ? Buffer.byteLength(stableBlock) : 0,
        input_bytes: Buffer.byteLength(userPrompt),
        output_format: format ? "json_schema" : "none",
      });

      let resp: OpenAI.Responses.Response;
      let vendorError: string | undefined;
      try {
        resp = await this.client.responses.create(req, { signal: deadline.signal });
        log("debug", "api.openai.response", {
          packet_id: packet.id,
          model_name: this.modelConfig.model_name,
          status: resp.status,
          usage: JSON.stringify(resp.usage ?? {}),
        });
      } catch (err: any) {
        vendorError = deadline.expired ? `${deadlineNote(this.modelConfig)}: ${err?.message ?? err}` : (err?.message ?? String(err));
        const failure = describeVendorFailure(err);
        log("debug", "api.openai.response", {
          packet_id: packet.id,
          model_name: this.modelConfig.model_name,
          http_status: failure.error_status ?? err?.response?.status,
          error_code: failure.error_code,
        });
        // A request that never left this machine reached nobody to bill. An answered error keeps
        // the estimate: OpenAI publishes no statement that a 4xx or 5xx is free.
        const unbilled = neverSent(failure);
        // With no answer at all the request may have been served in full, so the prompt is only a floor.
        const lowerBound = !unbilled && !answeredWithError(failure);
        const failTokens = unbilled
          ? { input: 0, input_cached: 0, output: 0 }
          : { input: estimateTokens(userPrompt + (stableBlock ?? "")), input_cached: 0, output: 0 };
        const failPrice = this.pricer.require(dispatchDate, { requestInputTokens: failTokens.input, estimated: true });
        const attempt: AttemptRecord = {
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, failPrice.pricing),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: vendorError,
          ...failure,
          ...priceFields(failPrice),
          ...(unbilled ? {} : { cost_provenance: "estimated" as const }),
          ...(lowerBound ? { usage_complete: false as const } : {}),
          ...(retryReason ? { retry_reason: retryReason } : {}),
        };
        record(attempt);
        if (transientRetries < MAX_TRANSIENT_RETRIES && !deadline.signal.aborted && retryable(err, failure)) {
          await pause(this.retryDelayMs(transientRetries, err), deadline.signal);
          transientRetries += 1;
          if (!deadline.signal.aborted) {
            if (!unbilled) usedEstimate = true;
            retryReason = "transient";
            continue;
          }
        }
        return this.finalizeResult(attempts, null, false, "vendor_error", usedEstimate || !unbilled);
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
      const attemptEstimated = !usage || usage.output_tokens === undefined;
      if (attemptEstimated) usedEstimate = true;
      const attemptTokens = {
        input: usage
          ? Math.max(0, (usage.input_tokens ?? 0) - cachedInput)
          : estimateTokens(userPrompt + (stableBlock ?? "")),
        input_cached: cachedInput,
        output: usage?.output_tokens ?? estimateTokens(text),
        output_reasoning: reasoningTokens,
      };
      const hitOutputCap = resp.incomplete_details?.reason === "max_output_tokens";
      const refusal = format && !hitOutputCap ? refusalText(resp) : null;
      // The >272K tier is decided per request on its whole prompt, cached tokens included.
      const promptTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
      const price = this.pricer.require(
        dispatchDate,
        promptTokens !== undefined
          ? { requestInputTokens: promptTokens }
          : { requestInputTokens: attemptTokens.input + attemptTokens.input_cached, estimated: true },
      );

      const attempt: AttemptRecord = {
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: resp.incomplete_details?.reason ?? resp.status,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, price.pricing),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap && refusal === null,
        ...(refusal !== null ? { error: `openai: the model refused the request under strict structured output: ${refusal || "(no reason given)"}` } : {}),
        ...priceFields(price),
        ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
        ...(attemptEstimated ? { cost_provenance: "estimated" as const } : {}),
        ...(retryReason ? { retry_reason: retryReason } : {}),
      };
      record(attempt);

      if (refusal !== null) {
        return this.finalizeResult(attempts, { refusal }, attemptTokens.input_cached > 0, "vendor_error", usedEstimate);
      }
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
      const doublingsExhausted = doublings >= MAX_DOUBLINGS;
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
      doublings += 1;
      retryReason = "output_cap";
    }
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

/** A strict-mode refusal comes back as a message part that the SDK leaves out of `output_text`. */
export function refusalText(resp: OpenAI.Responses.Response): string | null {
  for (const item of resp.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") return part.refusal ?? "";
    }
  }
  return null;
}

/** Strict structured output for a schema strict mode accepts, else undefined: the request goes as it always has. */
export function strictFormat(packet: TaskPacket): OpenAI.Responses.ResponseFormatTextJSONSchemaConfig | undefined {
  if (strictSchemaProblems(packet.outputSchema).length > 0) return undefined;
  return {
    type: "json_schema",
    name: /^[A-Za-z0-9_-]{1,64}$/.test(packet.phase) ? packet.phase : "packet_output",
    schema: packet.outputSchema,
    strict: true,
  };
}

/**
 * The SDK's rule: a request with no answer at all, or a 408, 409, 429 or 5xx,
 * unless the vendor's x-should-retry header says otherwise. An error raised
 * after a 200 (a body that would not parse) is not resent.
 */
export function retryable(err: unknown, failure: VendorFailure): boolean {
  if (err instanceof OpenAI.APIUserAbortError) return false;
  const should = header(err, "x-should-retry");
  if (should === "true") return true;
  if (should === "false") return false;
  const status = failure.error_status;
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  return err instanceof OpenAI.APIConnectionError;
}

/** The SDK's backoff: the vendor's retry-after when under a minute, else 0.5 s doubling to 8 s, less up to 25% jitter. */
export function sdkRetryDelayMs(retry: number, err: unknown): number {
  let ms: number | undefined;
  const afterMs = parseFloat(header(err, "retry-after-ms") ?? "");
  if (!Number.isNaN(afterMs)) ms = afterMs;
  const after = header(err, "retry-after");
  if (after && !ms) {
    const sec = parseFloat(after);
    ms = Number.isNaN(sec) ? Date.parse(after) - Date.now() : sec * 1000;
  }
  if (ms && ms >= 0 && ms < 60_000) return ms;
  return Math.min(500 * 2 ** retry, 8000) * (1 - Math.random() * 0.25);
}

function header(err: any, name: string): string | undefined {
  const h = err?.headers;
  const v = typeof h?.get === "function" ? h.get(name) : h?.[name];
  return typeof v === "string" ? v : undefined;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function deadlineNote(config: ModelConfig): string {
  return `dispatch deadline of ${dispatchTimeoutMs(config) / 1000}s reached (the leaf's worker_timeout_sec)`;
}
