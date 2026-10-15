/**
 * Dispatch-time pricing shared by every adapter: one clock read per dispatch
 * (injectable, so a test can dispatch on 2027-01-01), a policy-block mismatch
 * logged once per adapter, and the refusal an adapter returns instead of
 * sending work nothing prices.
 */

import { log } from "../log.js";
import {
  effectivePricing,
  tierLabel,
  UnpricedModelError,
  type EffectivePricing,
  type Priced,
  type RequestSize,
} from "../prices.js";
import type { AttemptRecord, ExecutionResult, ModelConfig } from "../types.js";

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export class DispatchPricer {
  private readonly logged = new Set<string>();

  constructor(
    private readonly config: ModelConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  now(): Date {
    return this.clock();
  }

  price(date: Date, size: RequestSize = {}): EffectivePricing {
    const r = effectivePricing(this.config, date, size);
    for (const w of r.warnings) {
      this.once(`mismatch:${w}`, () =>
        log("warn", "pricing.policy_mismatch", { model_id: this.config.id, model_name: this.config.model_name, message: w }),
      );
    }
    if (r.unpriced) {
      log("warn", "pricing.unpriced", { model_id: this.config.id, model_name: this.config.model_name, message: r.reason });
    } else if (r.basis === "custom") {
      this.once("custom", () =>
        log("info", "pricing.custom", { model_id: this.config.id, model_name: this.config.model_name }),
      );
    }
    return r;
  }

  /** For an attempt inside a dispatch already priced on `date`, where unpriced would be a bug. */
  require(date: Date, size: RequestSize = {}): Priced {
    const r = this.price(date, size);
    if (r.unpriced) throw new UnpricedModelError(r.model_name, r.reason);
    return r;
  }

  private once(key: string, emit: () => void): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    emit();
  }
}

export function unpricedRefusal(config: ModelConfig, date: Date, reason: string): string {
  return (
    `unpriced: model '${config.id}' (${config.model_name}) has no price for a dispatch on ` +
    `${date.toISOString().slice(0, 10)}, so nothing was sent: ${reason}`
  );
}

/** The result an adapter returns, before any vendor call or spawn, for a model nothing prices. */
export function refusedResult(config: ModelConfig, date: Date, reason: string, ceiling: number): ExecutionResult {
  const error = unpricedRefusal(config, date, reason);
  const tokens = { input: 0, input_cached: 0, output: 0 };
  const attempt: AttemptRecord = {
    attempt_number: 1,
    ceiling_used: ceiling,
    hit_output_cap: false,
    tokens,
    cost_usd: 0,
    latency_ms: 0,
    success: false,
    error,
  };
  return {
    result: null,
    tokens,
    cost_usd: 0,
    latency_ms: 0,
    cache_hit: false,
    success: false,
    error,
    attempts: [attempt],
    terminal_reason: "vendor_error",
  };
}

/** The price fields an attempt record carries. */
export function priceFields(p: Priced): Pick<AttemptRecord, "price_basis" | "price_tier" | "price_verified"> {
  return { price_basis: p.basis, price_tier: tierLabel(p), price_verified: p.entry?.verified ?? null };
}
