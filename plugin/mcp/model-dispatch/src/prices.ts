/**
 * The dated price list: the one place a per-token rate is written down.
 * Rates are USD per 1M tokens. `from` and `to` are inclusive UTC days; `to:
 * null` means no end date is published. A day no entry covers is unpriced,
 * never filled from a neighbouring entry or a similar model.
 */

import type { ModelPricing, PriceBasis, PriceTierLabel } from "./types.js";

export const PRICE_LIST_VERIFIED = "2026-10-13";

export const OPENAI_PRICING_URL = "https://platform.openai.com/docs/pricing";
export const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
export const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";

export interface RateCard {
  input: number;
  input_cached: number;
  output: number;
}

/** A request whose whole prompt, cached tokens included, is above `above_input_tokens` bills this card for every token. */
export interface PriceTier extends RateCard {
  above_input_tokens: number;
}

export interface PriceEntry extends RateCard {
  model: string;
  from: string;
  to: string | null;
  tiers?: readonly PriceTier[];
  source: string;
  verified: string;
}

const GEMINI_3X_INTRO_END = "2026-12-31";
const GEMINI_3X_STANDARD_FROM = "2027-01-01";
// The Gemini and Claude rows carry the latest check on record: the Gemini
// 3.7/3.8 re-pin of 2026-10-12, and the Claude harness's list of 2026-09-14.
const GEMINI_3X_VERIFIED = "2026-10-12";
const REFERENCE_LIST_VERIFIED = "2026-09-14";
const CLAUDE_FROM = "2026-01-01";

function gemini(model: string, from: string, to: string | null, input: number, cached: number, output: number, verified: string): PriceEntry {
  return { model, from, to, input, input_cached: cached, output, source: GEMINI_PRICING_URL, verified };
}

function claude(model: string, input: number, cached: number, output: number): PriceEntry {
  return {
    model,
    from: CLAUDE_FROM,
    to: null,
    input,
    input_cached: cached,
    output,
    source: ANTHROPIC_PRICING_URL,
    verified: REFERENCE_LIST_VERIFIED,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PRICE_LIST: readonly Readonly<PriceEntry>[] = deepFreeze([
  {
    model: "gpt-5.6-terra",
    from: "2026-08-09",
    to: null,
    input: 2.0,
    input_cached: 0.2,
    output: 12.0,
    tiers: [{ above_input_tokens: 272_000, input: 4.0, input_cached: 0.4, output: 18.0 }],
    source: OPENAI_PRICING_URL,
    verified: PRICE_LIST_VERIFIED,
  },
  gemini("gemini-3.8-flash", "2026-09-02", GEMINI_3X_INTRO_END, 0.75, 0.075, 3.75, GEMINI_3X_VERIFIED),
  gemini("gemini-3.8-flash", GEMINI_3X_STANDARD_FROM, null, 1.5, 0.15, 7.5, GEMINI_3X_VERIFIED),
  gemini("gemini-3.7-flash", "2026-08-13", GEMINI_3X_INTRO_END, 0.75, 0.075, 3.75, GEMINI_3X_VERIFIED),
  gemini("gemini-3.7-flash", GEMINI_3X_STANDARD_FROM, null, 1.5, 0.15, 7.5, GEMINI_3X_VERIFIED),
  gemini("gemini-3.5-flash", "2026-05-19", null, 1.5, 0.15, 9.0, REFERENCE_LIST_VERIFIED),
  claude("claude-opus-5", 5.0, 0.5, 25.0),
  claude("claude-opus-4-7", 5.0, 0.5, 25.0),
  claude("claude-sonnet-5", 2.0, 0.2, 10.0),
]);

const IDS_LONGEST_FIRST = [...new Set(PRICE_LIST.map((e) => e.model))].sort((a, b) => b.length - a.length);
// OpenAI snapshots are `-YYYY-MM-DD`, Anthropic snapshots `-YYYYMMDD`.
const SNAPSHOT_SUFFIX = /^(?:-(\d{4})-(\d{2})-(\d{2})|-(\d{4})(\d{2})(\d{2}))?$/;

/** The listed id a model name prices as: the id itself or the id plus a dated snapshot suffix. Anything else is null. */
export function resolveModel(name: unknown): string | null {
  if (typeof name !== "string") return null;
  for (const id of IDS_LONGEST_FIRST) {
    if (!name.startsWith(id)) continue;
    const m = SNAPSHOT_SUFFIX.exec(name.slice(id.length));
    if (!m) continue;
    const y = m[1] ?? m[4];
    if (y !== undefined && !isCalendarDay(Number(y), Number(m[2] ?? m[5]), Number(m[3] ?? m[6]))) continue;
    return id;
  }
  return null;
}

function isCalendarDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The UTC day a date prices on. A timestamp without a zone is refused (null):
 * its day would depend on this machine's clock setting.
 */
export function utcDay(date: unknown): string | null {
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  if (typeof date !== "string") return null;
  const dayOnly = DAY_ONLY.exec(date);
  if (dayOnly) return isCalendarDay(Number(dayOnly[1]), Number(dayOnly[2]), Number(dayOnly[3])) ? date : null;
  const ts = ZONED_TIMESTAMP.exec(date);
  if (!ts || !isCalendarDay(Number(ts[1]), Number(ts[2]), Number(ts[3]))) return null;
  const t = new Date(date);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

export function entriesFor(model: string): readonly Readonly<PriceEntry>[] {
  return PRICE_LIST.filter((e) => e.model === model);
}

/**
 * What is known about the size of the request being priced.
 * `requestInputTokens` is ONE request's whole prompt, cached tokens included.
 * `aggregateInputTokens` is the same count summed over several requests, so it
 * can prove no request crossed a tier but never that one did.
 * `estimated` marks a count the vendor did not report: it still picks the
 * card, but proves no tier either way.
 */
export interface RequestSize {
  requestInputTokens?: number | null;
  aggregateInputTokens?: number | null;
  estimated?: boolean;
}

export type PriceTierName = "standard" | "long_context";

export interface EntryRef {
  from: string;
  to: string | null;
  source: string;
  verified: string;
}

export interface Priced {
  unpriced: false;
  basis: PriceBasis;
  model_name: string;
  /** The card this request bills at. */
  pricing: RateCard;
  tier: PriceTierName;
  /** True when a tiered model's card was not proven by a vendor-reported count: a sum over several requests above the tier, or an estimate. */
  tier_unverified: boolean;
  /** The list entry that priced it; null for a custom price. */
  entry: EntryRef | null;
  warnings: string[];
}

export interface Unpriced {
  unpriced: true;
  model_name: string;
  reason: string;
  warnings: string[];
}

export type EffectivePricing = Priced | Unpriced;

/** The subset of a policy model that decides its price. */
export interface PricedModel {
  id?: string;
  model_name: string;
  pricing?: ModelPricing;
  pricing_override?: boolean;
}

/** A declared block rate further than this fraction from the list's standard card is a mismatch. */
export const POLICY_PRICE_TOLERANCE = 0.005;

const RATE_KEYS = ["input", "input_cached", "output"] as const;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function pickTier(entry: Readonly<PriceEntry>, size: RequestSize): { card: RateCard; tier: PriceTierName; unverified: boolean } {
  const picked = pickTierFromCount(entry, size);
  return size.estimated === true && (entry.tiers ?? []).length > 0 ? { ...picked, unverified: true } : picked;
}

function pickTierFromCount(entry: Readonly<PriceEntry>, size: RequestSize): { card: RateCard; tier: PriceTierName; unverified: boolean } {
  const standard = { input: entry.input, input_cached: entry.input_cached, output: entry.output };
  const tiers = entry.tiers ?? [];
  if (tiers.length === 0) return { card: standard, tier: "standard", unverified: false };
  if (finite(size.requestInputTokens)) {
    const crossed = tiers
      .filter((t) => size.requestInputTokens! > t.above_input_tokens)
      .sort((a, b) => b.above_input_tokens - a.above_input_tokens)[0];
    if (!crossed) return { card: standard, tier: "standard", unverified: false };
    return {
      card: { input: crossed.input, input_cached: crossed.input_cached, output: crossed.output },
      tier: "long_context",
      unverified: false,
    };
  }
  const lowest = Math.min(...tiers.map((t) => t.above_input_tokens));
  if (finite(size.aggregateInputTokens) && size.aggregateInputTokens <= lowest) {
    return { card: standard, tier: "standard", unverified: false };
  }
  return { card: standard, tier: "standard", unverified: true };
}

/** Why a lookup found no entry: the model is not listed, no entry covers the day, or the date is unreadable. */
export type LookupMiss = "unlisted" | "gap" | "bad_date";

/** The list entry covering `model` on `at`, or why there is none. */
export function lookupEntry(
  modelName: unknown,
  at: Date | string,
): { entry: Readonly<PriceEntry> } | { miss: LookupMiss; reason: string } {
  const id = resolveModel(modelName);
  if (!id) {
    return {
      miss: "unlisted",
      reason: `${JSON.stringify(modelName)} is not on the price list (plugin/mcp/model-dispatch/src/prices.ts)`,
    };
  }
  const day = utcDay(at);
  if (!day) {
    return {
      miss: "bad_date",
      reason: `invalid date ${JSON.stringify(at)}: expected YYYY-MM-DD or an ISO-8601 timestamp with a timezone`,
    };
  }
  const entries = entriesFor(id);
  const entry = entries.find((e) => e.from <= day && (e.to === null || day <= e.to));
  if (!entry) {
    const covered = entries.map((e) => `${e.from}..${e.to ?? "open"}`).join(", ");
    return { miss: "gap", reason: `no price for ${id} on ${day} (the list covers ${covered})` };
  }
  return { entry };
}

function differs(declared: number, listed: number): boolean {
  if (listed === 0) return declared !== 0;
  return Math.abs(declared - listed) > POLICY_PRICE_TOLERANCE * listed + 1e-12;
}

function blockMismatch(model: PricedModel, entry: Readonly<PriceEntry>): string | null {
  const block = model.pricing!;
  const off = RATE_KEYS.filter((k) => finite(block[k]) && differs(block[k], entry[k]));
  if (off.length === 0) return null;
  const card = (r: RateCard) => `${r.input}/${r.input_cached}/${r.output}`;
  return (
    `Policy model '${model.id ?? model.model_name}' (${model.model_name}): its pricing block ${card(block)} ` +
    `differs on ${off.join(", ")} from the price list ${card(entry)} (${entry.from}..${entry.to ?? "open"}, ` +
    `verified ${entry.verified}). The list price is billed; set pricing_override: true on this model to bill the block.`
  );
}

/**
 * The price of one request for a model on a day.
 *   1. A policy model with `pricing_override: true` bills its own block (basis `custom`).
 *   2. Otherwise the dated list bills it (basis `list`), tiered by request size.
 *      A declared block that differs from the list's standard card is ignored with a warning.
 *   3. Otherwise it is unpriced.
 */
export function effectivePricing(
  model: string | PricedModel,
  at: Date | string,
  size: RequestSize = {},
): EffectivePricing {
  const m: PricedModel = typeof model === "string" ? { model_name: model } : model;
  const warnings: string[] = [];

  if (m.pricing_override === true && m.pricing) {
    return {
      unpriced: false,
      basis: "custom",
      model_name: m.model_name,
      pricing: { input: m.pricing.input, input_cached: m.pricing.input_cached, output: m.pricing.output },
      tier: "standard",
      tier_unverified: false,
      entry: null,
      warnings,
    };
  }

  const found = lookupEntry(m.model_name, at);
  if ("miss" in found) {
    // A bad date is the caller's timestamp, which no list entry or override fixes.
    const hint =
      m.id && found.miss !== "bad_date"
        ? `; add its verified price entry to plugin/mcp/model-dispatch/src/prices.ts, or give policy model ` +
          `'${m.id}' a pricing block with pricing_override: true`
        : "";
    return { unpriced: true, model_name: m.model_name, reason: `${found.reason}${hint}`, warnings };
  }

  const { entry } = found;
  if (m.pricing) {
    const warning = blockMismatch(m, entry);
    if (warning) warnings.push(warning);
  }
  const picked = pickTier(entry, size);
  return {
    unpriced: false,
    basis: "list",
    model_name: m.model_name,
    pricing: picked.card,
    tier: picked.tier,
    tier_unverified: picked.unverified,
    entry: { from: entry.from, to: entry.to, source: entry.source, verified: entry.verified },
    warnings,
  };
}

export class UnpricedModelError extends Error {
  readonly code = "UNPRICED_MODEL";
  readonly model_name: string;
  constructor(modelName: string, reason: string) {
    super(`unpriced: ${reason}`);
    this.name = "UnpricedModelError";
    this.model_name = modelName;
  }
}

/** effectivePricing, throwing UnpricedModelError (code UNPRICED_MODEL) when nothing prices the model. */
export function requirePricing(model: string | PricedModel, at: Date | string, size: RequestSize = {}): Priced {
  const r = effectivePricing(model, at, size);
  if (r.unpriced) throw new UnpricedModelError(r.model_name, r.reason);
  return r;
}

/** The telemetry label for how a priced request's tier was decided. */
export function tierLabel(p: Priced): PriceTierLabel {
  return p.tier_unverified ? "unverified" : p.tier;
}

/** Whether any entry lists this model, on any day. The policy loader's check, which is date-free. */
export function isListedModel(modelName: unknown): boolean {
  return resolveModel(modelName) !== null;
}

/**
 * How a policy model's own `pricing:` block relates to what it bills:
 * `none` (no block), `equals_list`, `ignored_differs_from_list`,
 * `billed_pricing_override`, or `ignored_model_unpriced`.
 */
export type PricingBlockStatus =
  | "none"
  | "equals_list"
  | "ignored_differs_from_list"
  | "billed_pricing_override"
  | "ignored_model_unpriced";

export interface EffectivePriceView {
  priced_on: string;
  basis: PriceBasis | null;
  /** The standard card billed on `priced_on`, before the Vertex regional surcharge; null when unpriced. */
  rates: RateCard | null;
  tiers: PriceTier[];
  entry: EntryRef | null;
  unpriced_reason: string | null;
  pricing_block: PricingBlockStatus;
  warnings: string[];
}

export const EFFECTIVE_PRICES_NOTE =
  "Each models[].effective_price is what the dispatch server bills that model at on effective_prices_on: " +
  "the dated price list (plugin/mcp/model-dispatch/src/prices.ts), or the model's pricing block only under " +
  "pricing_override: true. A pricing block is documentation otherwise. A request above a tier's " +
  "above_input_tokens (cached tokens included) bills the tier's card for every token, and a Gemini leaf at a " +
  "non-global Vertex endpoint bills these rates x1.10.";

function viewOf(model: PricedModel, at: Date | string, day: string): EffectivePriceView {
  const r = effectivePricing(model, at, { requestInputTokens: 0 });
  const hasBlock = model.pricing != null;
  if (r.unpriced) {
    return {
      priced_on: day,
      basis: null,
      rates: null,
      tiers: [],
      entry: null,
      unpriced_reason: r.reason,
      pricing_block: hasBlock ? "ignored_model_unpriced" : "none",
      warnings: r.warnings,
    };
  }
  const found = r.basis === "list" ? lookupEntry(model.model_name, at) : null;
  const tiers = found && "entry" in found ? (found.entry.tiers ?? []).map((t) => ({ ...t })) : [];
  return {
    priced_on: day,
    basis: r.basis,
    rates: r.pricing,
    tiers,
    entry: r.entry,
    unpriced_reason: null,
    pricing_block:
      r.basis === "custom"
        ? "billed_pricing_override"
        : !hasBlock
          ? "none"
          : r.warnings.length > 0
            ? "ignored_differs_from_list"
            : "equals_list",
    warnings: r.warnings,
  };
}

/** load_policy's output: the policy unchanged, with each model's effective price for `at`. */
export function withEffectivePrices<P extends { models: PricedModel[] }>(policy: P, at: Date | string) {
  const day = utcDay(at) ?? String(at);
  return {
    effective_prices_on: day,
    effective_prices_note: EFFECTIVE_PRICES_NOTE,
    ...policy,
    models: policy.models.map((m) => ({ ...m, effective_price: viewOf(m, at, day) })),
  };
}
