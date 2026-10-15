/**
 * Driver (conductor) token usage from a run's driver-events.jsonl.
 *
 * On codex 0.160.1, `turn.completed.usage` is the thread's running total, and
 * `codex exec resume` restores it in the next process. A thread is therefore
 * priced from consecutive differences of its totals; summing the totals bills
 * every earlier invocation again.
 */
import { fixedDriverPriceFn, priceDriverTokens, type DriverPriceFn, type PricedTokens, type TokenBuckets } from "./driverPricing.js";
import { computeCostUsd, round6 } from "./pricing.js";
import type { ModelPricing, PriceBasis, PriceTierLabel } from "./types.js";

export const USAGE_BUCKETS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

export type UsageBucket = (typeof USAGE_BUCKETS)[number];
export type DriverUsage = Record<UsageBucket, number>;

export const ZERO_USAGE: DriverUsage = Object.freeze({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
});

/** One line of driver-events.jsonl (format v1), or a legacy bare codex event wrapped as one. */
export interface DriverRecord {
  v?: number;
  kind: string;
  invocation?: number;
  thread_id?: string | null;
  received_at?: string | null;
  event?: Record<string, unknown>;
  legacy?: boolean;
  [key: string]: unknown;
}

export type DriverTurnFlag = "baseline_unknown" | "cumulative_reset" | "zero_usage" | "no_thread_id";

export interface DriverTurn {
  invocation: number;
  /** 1-based within its invocation. */
  turn: number;
  thread_id: string | null;
  status: "complete" | "incomplete";
  incomplete_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** The thread's running total as codex reported it; null for an incomplete turn. */
  cumulative: DriverUsage | null;
  /** What this turn added to the thread; null for an incomplete turn. */
  delta: DriverUsage | null;
  flags: DriverTurnFlag[];
  /**
   * An incomplete turn's tokens are in the delta of this later complete turn on
   * the same thread. Set when that turn arrives, so a live reader sees null first.
   */
  covered_by?: { invocation: number; turn: number } | null;
}

export function normalizeUsage(raw: unknown): DriverUsage {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...ZERO_USAGE };
  for (const b of USAGE_BUCKETS) {
    const n = src[b];
    out[b] = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  }
  return out;
}

function isZero(u: DriverUsage): boolean {
  return USAGE_BUCKETS.every((b) => u[b] === 0);
}

function minus(a: DriverUsage, b: DriverUsage): DriverUsage {
  const out = { ...ZERO_USAGE };
  for (const k of USAGE_BUCKETS) out[k] = a[k] - b[k];
  return out;
}

function anyBelow(a: DriverUsage, b: DriverUsage): boolean {
  return USAGE_BUCKETS.some((k) => a[k] < b[k]);
}

/**
 * Wraps parsed JSON objects as records. A file written before format v1 holds
 * bare codex events; those get a synthetic invocation_start at each
 * thread.started, since that is the only invocation boundary they carry.
 */
export function toDriverRecords(objects: unknown[]): DriverRecord[] {
  const out: DriverRecord[] = [];
  let legacyInvocation = 0;
  let legacyThread: string | null = null;
  for (const obj of objects) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    if (o.v !== undefined && typeof o.kind === "string") {
      out.push(o as DriverRecord);
      continue;
    }
    if (typeof o.type !== "string") continue;
    const { ts, ...event } = o;
    if (o.type === "thread.started" || legacyInvocation === 0) {
      legacyInvocation += 1;
      out.push({ v: 1, kind: "invocation_start", invocation: legacyInvocation, mode: "fresh", legacy: true });
    }
    if (o.type === "thread.started" && typeof o.thread_id === "string") legacyThread = o.thread_id;
    out.push({
      v: 1,
      kind: "codex",
      invocation: legacyInvocation,
      thread_id: legacyThread,
      received_at: typeof ts === "string" ? ts : null,
      event,
      legacy: true,
    });
  }
  return out;
}

/** Parses driver-events.jsonl text. A torn or malformed line is skipped: the file is appended to while it is read. */
export function parseDriverRecords(text: string): DriverRecord[] {
  const objects: unknown[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return toDriverRecords(objects);
}

interface OpenTurn {
  turn: number;
  started_at: string | null;
}

interface InvocationState {
  invocation: number;
  mode: string;
  thread: string | null;
  open: OpenTurn | null;
  turnCount: number;
}

export interface DriverTurnTrackerOptions {
  /** Known running totals for threads this folder has no earlier record of. */
  baselines?: Record<string, Partial<DriverUsage>>;
}

const NO_THREAD = "(no thread id)";

/**
 * Pairs each turn.started with the turn.completed or turn.failed that ends it,
 * within one invocation, and prices completed turns as differences of their
 * thread's running total. Feed records in file order; the same instance serves
 * a live reader (one record at a time) and a whole-file one.
 */
export class DriverTurnTracker {
  private readonly prev = new Map<string, DriverUsage>();
  private readonly seen = new Set<string>();
  /** Per thread, incomplete turns since its last running total. */
  private readonly uncovered = new Map<string, DriverTurn[]>();
  private readonly baselines: Record<string, Partial<DriverUsage>>;
  private inv: InvocationState | null = null;

  constructor(opts: DriverTurnTrackerOptions = {}) {
    this.baselines = opts.baselines ?? {};
  }

  push(rec: DriverRecord): DriverTurn[] {
    const done: DriverTurn[] = [];
    switch (rec.kind) {
      case "invocation_start": {
        this.closeOpen(done, "no invocation_end");
        const mode = rec.mode === "resume" ? "resume" : "fresh";
        const resumed = typeof rec.resume_thread_id === "string" ? rec.resume_thread_id : null;
        this.inv = {
          invocation: typeof rec.invocation === "number" ? rec.invocation : (this.inv?.invocation ?? 0) + 1,
          mode,
          thread: resumed,
          open: null,
          turnCount: 0,
        };
        if (resumed) this.noteThread(resumed);
        break;
      }
      case "codex":
        this.pushCodex(rec, done);
        break;
      case "invocation_end": {
        const endedBy = rec.ended_by;
        const reason =
          endedBy === "driver_signal"
            ? `driver signal ${String(rec.signal ?? "unknown")} mid-turn`
            : endedBy === "spawn_error"
              ? "codex failed to start"
              : `codex exited ${rec.exit_status ?? rec.signal ?? "unknown"} before turn.completed`;
        this.closeOpen(done, reason);
        this.inv = null;
        break;
      }
      default:
        break;
    }
    return done;
  }

  /** Closes a turn left open by a driver that never recorded the end of its invocation. */
  finish(): DriverTurn[] {
    const done: DriverTurn[] = [];
    this.closeOpen(done, "no invocation_end");
    this.inv = null;
    return done;
  }

  private ensureInvocation(rec: DriverRecord): InvocationState {
    if (!this.inv) {
      this.inv = {
        invocation: typeof rec.invocation === "number" ? rec.invocation : 1,
        mode: "fresh",
        thread: null,
        open: null,
        turnCount: 0,
      };
    }
    return this.inv;
  }

  private noteThread(thread: string): void {
    if (this.seen.has(thread)) return;
    this.seen.add(thread);
    const baseline = this.baselines[thread];
    if (baseline) this.prev.set(thread, normalizeUsage(baseline));
    else if (this.inv?.mode !== "resume") this.prev.set(thread, { ...ZERO_USAGE });
  }

  private pushCodex(rec: DriverRecord, done: DriverTurn[]): void {
    const inv = this.ensureInvocation(rec);
    const ev = (rec.event ?? {}) as Record<string, unknown>;
    const at = typeof rec.received_at === "string" ? rec.received_at : null;
    if (!inv.thread && typeof rec.thread_id === "string") {
      inv.thread = rec.thread_id;
      this.noteThread(rec.thread_id);
    }
    switch (ev.type) {
      case "thread.started":
        if (typeof ev.thread_id === "string") {
          inv.thread = ev.thread_id;
          this.noteThread(ev.thread_id);
        }
        break;
      case "turn.started":
        this.closeOpen(done, "turn.started again before turn.completed");
        inv.turnCount += 1;
        inv.open = { turn: inv.turnCount, started_at: at };
        break;
      case "turn.completed":
        done.push(this.completeTurn(inv, normalizeUsage(ev.usage), at));
        break;
      case "turn.failed": {
        const err = ev.error as { message?: unknown } | undefined;
        const message = typeof err?.message === "string" ? err.message : "no message";
        if (!inv.open) {
          inv.turnCount += 1;
          inv.open = { turn: inv.turnCount, started_at: at };
        }
        this.closeOpen(done, `turn.failed: ${message.slice(0, 300)}`, at);
        break;
      }
      default:
        break;
    }
  }

  private completeTurn(inv: InvocationState, usage: DriverUsage, at: string | null): DriverTurn {
    const open = inv.open ?? { turn: ++inv.turnCount, started_at: at };
    inv.open = null;
    const flags: DriverTurnFlag[] = [];
    if (!inv.thread) flags.push("no_thread_id");
    const key = inv.thread ?? NO_THREAD;
    if (!inv.thread && !this.seen.has(key)) {
      this.seen.add(key);
      this.prev.set(key, { ...ZERO_USAGE });
    }
    let delta: DriverUsage;
    if (isZero(usage)) {
      // codex reports zeros when no token update arrived; the next total still carries the real figure.
      flags.push("zero_usage");
      delta = { ...ZERO_USAGE };
    } else {
      const prev = this.prev.get(key);
      if (!prev) {
        flags.push("baseline_unknown");
        delta = usage;
      } else if (anyBelow(usage, prev)) {
        flags.push("cumulative_reset");
        delta = usage;
      } else {
        delta = minus(usage, prev);
      }
      this.prev.set(key, usage);
    }
    // A total that dropped may have lost them; zeros carry nothing yet, so the next total still can.
    if (inv.thread && !flags.includes("zero_usage")) {
      const covers = flags.includes("cumulative_reset") ? [] : (this.uncovered.get(inv.thread) ?? []);
      for (const t of covers) t.covered_by = { invocation: inv.invocation, turn: open.turn };
      this.uncovered.delete(inv.thread);
    }
    return {
      invocation: inv.invocation,
      turn: open.turn,
      thread_id: inv.thread,
      status: "complete",
      incomplete_reason: null,
      started_at: open.started_at,
      ended_at: at,
      cumulative: usage,
      delta,
      flags,
    };
  }

  private closeOpen(done: DriverTurn[], reason: string, at: string | null = null): void {
    const inv = this.inv;
    if (!inv?.open) return;
    const turn: DriverTurn = {
      invocation: inv.invocation,
      turn: inv.open.turn,
      thread_id: inv.thread,
      status: "incomplete",
      incomplete_reason: reason,
      started_at: inv.open.started_at,
      ended_at: at,
      cumulative: null,
      delta: null,
      flags: [],
      covered_by: null,
    };
    done.push(turn);
    if (inv.thread) this.uncovered.set(inv.thread, [...(this.uncovered.get(inv.thread) ?? []), turn]);
    inv.open = null;
  }
}

/** Every turn in a run's records, complete and incomplete, in order. */
export function driverTurns(records: DriverRecord[], opts: DriverTurnTrackerOptions = {}): DriverTurn[] {
  const tracker = new DriverTurnTracker(opts);
  const turns: DriverTurn[] = [];
  for (const rec of records) turns.push(...tracker.push(rec));
  turns.push(...tracker.finish());
  return turns;
}

export interface PricedUsage {
  /** Disjoint counts, the shape computeCostUsd takes: `input` is fresh input only. */
  tokens: { input: number; input_cached: number; output: number };
  reasoning: number;
  cost_usd: number;
}

/** input_tokens includes cached_input_tokens; output_tokens includes reasoning_output_tokens. */
export function priceUsage(usage: DriverUsage, pricing: ModelPricing): PricedUsage {
  const cached = usage.cached_input_tokens;
  const tokens = {
    input: Math.max(0, usage.input_tokens - cached),
    input_cached: cached,
    output: usage.output_tokens,
  };
  return { tokens, reasoning: usage.reasoning_output_tokens, cost_usd: computeCostUsd(tokens, pricing) };
}

/** How a run's driver turns are priced: the pin's model through one price function. */
export interface TurnPricing {
  model: string;
  priceFn: DriverPriceFn;
  /** The session file's per-response usage for a complete turn, when it is known. */
  requestsFor?: (turn: DriverTurn) => TokenBuckets[] | null;
  /** The day a turn with no timestamp of its own is priced on. */
  now?: () => string;
}

export interface PricedDriverTurn extends PriceLabels {
  tokens: { input: number; input_cached: number; output: number };
  reasoning: number;
  /** Rounded to the micro-dollar, as a driver row stores it; null when nothing prices the model that day. */
  cost_usd: number | null;
  priced_at: string | null;
  long_context_requests: number;
  unpriced_reason: string | null;
}

export interface PriceLabels {
  price_basis: PriceBasis | null;
  price_tier: PriceTierLabel | null;
  price_verified: string | null;
}

function asTurnPricing(p: ModelPricing | TurnPricing, model = "driver"): TurnPricing {
  return "priceFn" in p ? p : { model, priceFn: fixedDriverPriceFn(p) };
}

/** A complete turn priced at its own day; null for an incomplete one, whose usage never arrived. */
export function priceDriverTurn(turn: DriverTurn, pricing: ModelPricing | TurnPricing): PricedDriverTurn | null {
  if (turn.status !== "complete" || !turn.delta) return null;
  const p = asTurnPricing(pricing);
  const at = turn.ended_at ?? turn.started_at ?? p.now?.() ?? null;
  const requests = p.requestsFor?.(turn) ?? null;
  const priced: PricedTokens = priceDriverTokens(turn.delta, p.model, at, p.priceFn, requests);
  const split = priceUsage(turn.delta, { input: 0, input_cached: 0, output: 0 });
  return {
    tokens: split.tokens,
    reasoning: split.reasoning,
    cost_usd: priced.cost_usd === null ? null : round6(priced.cost_usd),
    priced_at: at,
    price_basis: priced.basis,
    price_tier: priced.tier,
    price_verified: priced.verified,
    long_context_requests: priced.long_context_requests,
    unpriced_reason: priced.unpriced_reason,
  };
}

export interface DriverUsageSummary {
  turns: number;
  turns_complete: number;
  turns_incomplete: number;
  /** Incomplete turns a later running total on the same thread carries, so they are in cost_usd. */
  turns_incomplete_covered: number;
  /** Complete turns no card priced; their cost is left out of cost_usd. */
  turns_unpriced: number;
  /** Turns whose summed input crossed a tier threshold with no per-response sizes to prove which card bills. */
  turns_tier_unverified: number;
  turns_long_context: number;
  cost_usd: number;
  thread_ids: string[];
  flags: DriverTurnFlag[];
}

export function summarizeDriverTurns(turns: DriverTurn[], pricing: ModelPricing | TurnPricing): DriverUsageSummary {
  const p = asTurnPricing(pricing);
  let cost = 0;
  let complete = 0;
  let unpriced = 0;
  let unverified = 0;
  let long = 0;
  const threads: string[] = [];
  const flags = new Set<DriverTurnFlag>();
  for (const t of turns) {
    if (t.thread_id && !threads.includes(t.thread_id)) threads.push(t.thread_id);
    for (const f of t.flags) flags.add(f);
    const priced = priceDriverTurn(t, p);
    if (!priced) continue;
    complete += 1;
    if (priced.cost_usd === null) unpriced += 1;
    else cost += priced.cost_usd;
    if (priced.price_tier === "unverified") unverified += 1;
    if (priced.price_tier === "long_context") long += 1;
  }
  return {
    turns: turns.length,
    turns_complete: complete,
    turns_incomplete: turns.length - complete,
    turns_incomplete_covered: turns.filter((t) => t.status === "incomplete" && t.covered_by).length,
    turns_unpriced: unpriced,
    turns_tier_unverified: unverified,
    turns_long_context: long,
    cost_usd: round6(cost),
    thread_ids: threads,
    flags: [...flags],
  };
}
