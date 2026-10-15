/**
 * Writes a dispatch's telemetry as each attempt returns rather than after
 * the whole call, so a client that stops waiting (driverClient's timeout,
 * dispatch.mjs closing the bridge, a signal) cannot drop attempts the vendor
 * already billed. The attempt still in flight at that moment is recorded once,
 * as an estimated lower bound.
 */

import { appendEvent } from "./telemetry.js";
import { estimateTokens } from "./pricing.js";
import { attemptEvent, resultAttempts, type DispatchIdentity } from "./dispatchEvents.js";
import type { AttemptRecord, ExecutionResult, TelemetryEvent } from "./types.js";

/** Prices the abandoned attempt's estimated input; returns $0 when nothing prices the model. */
export type PlaceholderPricer = (inputTokens: number) => Pick<
  AttemptRecord,
  "cost_usd" | "price_basis" | "price_tier" | "price_verified"
>;

/** What the abandoned attempt is assumed to have sent: the packet's instruction and inputs. */
export function packetPromptTokens(packet: DispatchIdentity["packet"]): number {
  return estimateTokens([packet.instruction, ...packet.inputs.map((s) => s.content)].join("\n"));
}

export class DispatchRecorder {
  readonly events: TelemetryEvent[] = [];
  private readonly written = new Set<number>();
  private lastCeiling: number | undefined;
  private abandonedBy: string | null = null;

  constructor(
    private readonly id: DispatchIdentity,
    private readonly telemetryPath: string | undefined,
    private readonly started: number,
    private readonly pricePlaceholder: PlaceholderPricer,
  ) {}

  get abandoned(): boolean {
    return this.abandonedBy !== null;
  }

  /** Idempotent per attempt number; nothing is recorded once the dispatch is abandoned. */
  record(att: AttemptRecord, result?: ExecutionResult): void {
    if (this.abandonedBy !== null || this.written.has(att.attempt_number)) return;
    this.written.add(att.attempt_number);
    this.lastCeiling = att.ceiling_used;
    this.write(attemptEvent(this.id, att, { ts: new Date().toISOString(), result }));
  }

  /** The attempts the adapter returned, minus those already recorded as they happened. */
  finish(result: ExecutionResult): void {
    for (const att of resultAttempts(result, this.id.packet.budget.maxOutputTokens)) this.record(att, result);
  }

  /** Records the attempt in flight as a lower bound; later attempts are not recorded. */
  abandon(reason: string): TelemetryEvent | null {
    if (this.abandonedBy !== null) return null;
    const inputTokens = packetPromptTokens(this.id.packet);
    const placeholder: AttemptRecord = {
      attempt_number: Math.max(0, ...this.written) + 1,
      ceiling_used: this.lastCeiling ?? this.id.packet.budget.maxOutputTokens,
      hit_output_cap: false,
      tokens: { input: inputTokens, input_cached: 0, output: 0 },
      latency_ms: Date.now() - this.started,
      success: false,
      error: `abandoned (${reason}): the client stopped waiting before this attempt returned; usage unknown`,
      ...this.pricePlaceholder(inputTokens),
      cost_provenance: "estimated",
      usage_complete: false,
    };
    const ev = attemptEvent(this.id, placeholder, { ts: new Date().toISOString() });
    this.write(ev);
    this.abandonedBy = reason;
    return ev;
  }

  private write(ev: TelemetryEvent): void {
    this.events.push(ev);
    if (this.telemetryPath) appendEvent(this.telemetryPath, ev);
  }
}
