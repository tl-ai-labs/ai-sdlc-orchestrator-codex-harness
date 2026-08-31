import type { ModelPricing } from "./types.js";

export function computeCostUsd(
  tokens: { input: number; input_cached: number; output: number },
  pricing: ModelPricing
): number {
  // `tokens.input` is the FRESH-priced count; `tokens.input_cached` is the
  // discounted cache-read count. The two are DISJOINT — never subtract one
  // from the other.
  const inputFreshCost  = (tokens.input        / 1_000_000) * pricing.input;
  const inputCachedCost = (tokens.input_cached / 1_000_000) * pricing.input_cached;
  const outputCost      = (tokens.output       / 1_000_000) * pricing.output;
  return round6(inputFreshCost + inputCachedCost + outputCost);
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Approximate token count for a string, within ~10% of true tokenizer output
 * for English + code. Used only for telemetry and cost estimation on the
 * direct tier, where per-call vendor `usage` is not visible.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}
