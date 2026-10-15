/**
 * The one way the conductor's tokens are priced: the dated price list
 * (prices.ts) at the day each turn or response was spent. run.mjs's live
 * rows, the rebuilt driver files, the session-file collector and the cost cap
 * all price through here.
 */

import {
  effectivePricing,
  lookupEntry,
  PRICE_LIST_VERIFIED,
  tierLabel,
  utcDay,
  type PricedModel,
  type PriceTier,
  type RateCard,
} from "./prices.js";
import type { ModelPricing, Policy, PriceBasis, PriceTierLabel } from "./types.js";

/** One request's or one turn's usage, in codex's buckets: input includes cached, output includes reasoning. */
export interface TokenBuckets {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface PriceContext {
  /** Input tokens of the one request being priced, cached included. */
  requestInputTokens?: number;
  /** Input tokens summed over several requests: proves the standard card only below every tier. */
  aggregateInputTokens?: number;
  /** Set when the usage is a sum over requests. */
  aggregate?: boolean;
}

/** A card, and how the list chose it. Callers that pass their own price function may return a bare card. */
export interface DriverRate extends ModelPricing {
  basis?: PriceBasis;
  tier?: PriceTierLabel;
  /** The verified date of the list entry; null for a custom price. */
  verified?: string | null;
}

/** `at` is when the tokens were spent; null means now. Null back means nothing prices the model that day. */
export type DriverPriceFn = (model: string, at: string | null, ctx: PriceContext) => DriverRate | null;

/** The conductor as the price list sees it: the policy's driver block, else its legacy `gpt` entry. */
export function driverPricedModel(policy: Policy | null | undefined): PricedModel | null {
  const d = policy?.driver;
  if (d && typeof d.model_name === "string" && d.model_name) {
    return { id: "driver", model_name: d.model_name, pricing: d.pricing, pricing_override: d.pricing_override };
  }
  const gpt = policy?.models?.find((m) => m.id === "gpt");
  if (gpt && typeof gpt.model_name === "string" && gpt.model_name) {
    return { id: "gpt", model_name: gpt.model_name, pricing: gpt.pricing, pricing_override: gpt.pricing_override };
  }
  return null;
}

/**
 * Prices the policy's driver model from the list (or its block under
 * pricing_override), and any other model by its name alone.
 */
export function listDriverPriceFn(policy: Policy | null | undefined, now: () => Date = () => new Date()): DriverPriceFn {
  const driver = driverPricedModel(policy);
  return (model, at, ctx) => {
    const priced = driver && driver.model_name === model ? driver : { model_name: model };
    const size =
      typeof ctx.requestInputTokens === "number"
        ? { requestInputTokens: ctx.requestInputTokens }
        : { aggregateInputTokens: typeof ctx.aggregateInputTokens === "number" ? ctx.aggregateInputTokens : null };
    const p = effectivePricing(priced, at ?? now(), size);
    if (p.unpriced) return null;
    return { ...p.pricing, basis: p.basis, tier: tierLabel(p), verified: p.entry?.verified ?? null };
  };
}

/** A fixed card, for a caller that already holds one. Labelled custom: the list did not choose it. */
export function fixedDriverPriceFn(pricing: ModelPricing): DriverPriceFn {
  return () => ({ input: pricing.input, input_cached: pricing.input_cached, output: pricing.output, basis: "custom", tier: "standard", verified: null });
}

/** Fresh input is input minus cached; reasoning is inside output; a cache write is billed as the fresh input it is part of. */
export function bucketsCostUsd(u: TokenBuckets, p: ModelPricing): number {
  const fresh = Math.max(0, u.input_tokens - u.cached_input_tokens);
  return (fresh * p.input + u.cached_input_tokens * p.input_cached + u.output_tokens * p.output) / 1_000_000;
}

export interface PricedTokens {
  /** Unrounded; null when no card prices the model that day. */
  cost_usd: number | null;
  basis: PriceBasis | null;
  /** `long_context` when a response crossed a tier; `unverified` when a sum over responses could have. */
  tier: PriceTierLabel | null;
  verified: string | null;
  long_context_requests: number;
  unpriced_reason: string | null;
}

const BUCKET_KEYS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;

function minusClipped(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  const out = { ...a };
  for (const k of BUCKET_KEYS) out[k] = Math.max(0, a[k] - b[k]);
  return out;
}

function unpriced(model: string, at: string | null): PricedTokens {
  const day = at ? (utcDay(at) ?? at) : "today";
  return { cost_usd: null, basis: null, tier: null, verified: null, long_context_requests: 0, unpriced_reason: `no price for ${model} on ${day}` };
}

/**
 * Prices `usage` (one turn, or one invocation's share of a thread) spent at
 * `at`. With the session file's per-response usage for those tokens, a
 * response above a tier's threshold bills that tier's card and the rest bill
 * the standard one. Without it, the sum proves the standard card only while
 * it stays below every threshold; above one it is billed standard and
 * labelled `unverified`.
 */
export function priceDriverTokens(
  usage: TokenBuckets,
  model: string,
  at: string | null,
  priceFn: DriverPriceFn,
  requests: TokenBuckets[] | null = null,
): PricedTokens {
  if (requests && requests.length > 0) {
    const standard = priceFn(model, at, { requestInputTokens: 0 });
    if (!standard) return unpriced(model, at);
    let cost = 0;
    let long = 0;
    const longUsage: TokenBuckets = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    for (const r of requests) {
      const rate = priceFn(model, at, { requestInputTokens: r.input_tokens });
      if (!rate) return unpriced(model, at);
      if (rate.tier !== "long_context") continue;
      long += 1;
      cost += bucketsCostUsd(r, rate);
      for (const k of BUCKET_KEYS) longUsage[k] += r[k];
    }
    cost += bucketsCostUsd(minusClipped(usage, longUsage), standard);
    return {
      cost_usd: cost,
      basis: standard.basis ?? null,
      tier: long > 0 ? "long_context" : (standard.tier ?? null),
      verified: standard.verified ?? null,
      long_context_requests: long,
      unpriced_reason: null,
    };
  }
  const rate = priceFn(model, at, { aggregateInputTokens: usage.input_tokens, aggregate: true });
  if (!rate) return unpriced(model, at);
  return {
    cost_usd: bucketsCostUsd(usage, rate),
    basis: rate.basis ?? null,
    tier: rate.tier ?? null,
    verified: rate.verified ?? null,
    long_context_requests: 0,
    unpriced_reason: null,
  };
}

/** What driver-manifest.json records about the conductor's price: the list entry for the run's first day. */
export interface DriverPriceRecord {
  model: string;
  basis: PriceBasis | null;
  priced_on: string | null;
  rates: RateCard | null;
  tiers: PriceTier[];
  source: string | null;
  verified: string | null;
  entry_from: string | null;
  entry_to: string | null;
  unpriced_reason: string | null;
  warnings: string[];
}

export function driverPriceRecord(policy: Policy | null | undefined, model: string, at: Date | string): DriverPriceRecord {
  const driver = driverPricedModel(policy);
  const priced = driver && driver.model_name === model ? driver : { model_name: model };
  const p = effectivePricing(priced, at, { requestInputTokens: 0 });
  const day = utcDay(at);
  if (p.unpriced) {
    return {
      model, basis: null, priced_on: day, rates: null, tiers: [], source: null, verified: null,
      entry_from: null, entry_to: null, unpriced_reason: p.reason, warnings: p.warnings,
    };
  }
  const found = p.basis === "list" ? lookupEntry(model, at) : null;
  const tiers = found && "entry" in found ? (found.entry.tiers ?? []).map((t) => ({ ...t })) : [];
  return {
    model,
    basis: p.basis,
    priced_on: day,
    rates: p.pricing,
    tiers,
    source: p.entry?.source ?? null,
    verified: p.entry?.verified ?? null,
    entry_from: p.entry?.from ?? null,
    entry_to: p.entry?.to ?? null,
    unpriced_reason: null,
    warnings: p.warnings,
  };
}

export { PRICE_LIST_VERIFIED };
