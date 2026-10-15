import { dirname } from "node:path";
import { round6 } from "./pricing.js";
import { driverSpendForCap, type DriverSpendOptions, type DriverSpendSource } from "./sessionUsage.js";
import { readEvents } from "./telemetry.js";
import type { Policy } from "./types.js";

export const COST_CAP_EXCEEDED = "COST_CAP_EXCEEDED";

export interface RecordedSpend {
  dispatched_usd: number;
  /** The modeled part of dispatched_usd: provenance `modeled`, or a seat adapter's floor (`adapter_provenance: modeled`). */
  dispatched_modeled_usd: number;
  /** The conductor's own tokens, always modeled. */
  driver_usd: number;
  driver_source: DriverSpendSource;
  driver_note: string | null;
  /** Parts of the conductor's spend driver_usd leaves out. */
  driver_not_counted: string[];
  /** A conductor thread is recorded, but its spend could not be read, so driver_usd is 0. */
  driver_unmeasured: boolean;
  total_usd: number;
}

const DRIVER_SOURCE_LABEL: Record<DriverSpendSource, string> = {
  "driver-cost-modeled": "driver-cost-modeled.jsonl",
  "driver-usage": "driver-usage.json",
  "session-file": "the codex session file",
  "exec-stream": "the codex exec stream",
  unpriced: "",
  none: "",
};

export function describeSpend(spend: RecordedSpend, telemetryPath: string): string {
  const modeled = spend.dispatched_modeled_usd > 0 ? `; $${spend.dispatched_modeled_usd.toFixed(4)} of it modeled` : "";
  const dispatched = `$${spend.dispatched_usd.toFixed(4)} dispatched (${telemetryPath}${modeled})`;
  if (spend.driver_source === "unpriced" || spend.driver_source === "none") {
    const why = spend.driver_source === "unpriced" ? "not priced" : "not measured";
    const note = spend.driver_note?.replace(/[.\s]+$/, "");
    return `${dispatched}; conductor ${why}${note ? `: ${note}` : ""}`;
  }
  const left = spend.driver_not_counted.length > 0 ? `; not counted: ${spend.driver_not_counted.join(", ")}` : "";
  return `${dispatched} + $${spend.driver_usd.toFixed(4)} conductor (modeled from ${DRIVER_SOURCE_LABEL[spend.driver_source]}${left})`;
}

/** The bridge's warning for a conductor figure the cap could not count, or null when it counted one. */
export function driverCapWarning(spend: RecordedSpend): { event: string; reason: string | null } | null {
  if (spend.driver_source === "unpriced") return { event: "cost_cap.driver_unpriced", reason: spend.driver_note };
  if (spend.driver_unmeasured) return { event: "cost_cap.driver_unmeasured", reason: spend.driver_note };
  return null;
}

export class CostCapExceededError extends Error {
  readonly code = COST_CAP_EXCEEDED;
  readonly dispatchedUsd: number;
  readonly driverUsd: number;
  readonly driverSource: DriverSpendSource;
  constructor(
    readonly recordedUsd: number,
    readonly capUsd: number,
    readonly policyName: string,
    readonly telemetryPath: string,
    readonly spend?: RecordedSpend,
  ) {
    const recorded = spend ? describeSpend(spend, telemetryPath) : `recorded in ${telemetryPath}`;
    super(
      `${COST_CAP_EXCEEDED}: $${recordedUsd.toFixed(4)} is already recorded for this run, at or above ` +
        `hard_cost_cap_usd $${capUsd} for policy '${policyName}': ${recorded}. ` +
        `No further dispatch is allowed for this run. Raise the cap in the policy to continue.`,
    );
    this.name = "CostCapExceededError";
    this.dispatchedUsd = spend?.dispatched_usd ?? recordedUsd;
    this.driverUsd = spend?.driver_usd ?? 0;
    this.driverSource = spend?.driver_source ?? "none";
  }
}

/** Dispatched work only. Every provenance counts: the cap guards spend, so modeled and estimated figures are not exempt. */
export function recordedCostUsd(telemetryPath: string): number {
  return dispatchedSpend(telemetryPath).total;
}

function dispatchedSpend(telemetryPath: string): { total: number; modeled: number } {
  let total = 0;
  let modeled = 0;
  for (const ev of readEvents(telemetryPath)) {
    if (typeof ev.cost_usd !== "number" || !Number.isFinite(ev.cost_usd)) continue;
    total += ev.cost_usd;
    // The cost report's rule (plugin/scripts/lib/cost-provenance.mjs).
    if (ev.provenance === "modeled" || ev.adapter_provenance === "modeled") modeled += ev.cost_usd;
  }
  return { total, modeled };
}

/**
 * Dispatched spend from telemetry.jsonl plus the conductor's modeled spend
 * from the same run folder. A driver figure that cannot be read counts as
 * zero rather than blocking the dispatch; the dispatched part still applies.
 */
export function recordedSpend(policy: Policy, telemetryPath: string, opts: DriverSpendOptions = {}): RecordedSpend {
  const dispatched = dispatchedSpend(telemetryPath);
  let driver;
  try {
    driver = driverSpendForCap(dirname(telemetryPath), policy, opts);
  } catch (err) {
    driver = {
      usd: 0,
      source: "none" as const,
      note: `the conductor's spend could not be read: ${(err as Error)?.message ?? err}`,
      not_counted: [],
      unmeasured: true,
    };
  }
  return {
    dispatched_usd: round6(dispatched.total),
    dispatched_modeled_usd: round6(dispatched.modeled),
    driver_usd: driver.usd,
    driver_source: driver.source,
    driver_note: driver.note,
    driver_not_counted: driver.not_counted,
    driver_unmeasured: driver.unmeasured,
    total_usd: round6(dispatched.total + driver.usd),
  };
}

/**
 * The one check the bridge (before each dispatch) and run.mjs (between
 * invocations) share. Throws once recorded spend has reached the cap; the
 * call that crosses it is allowed to finish, since its cost is unknown until
 * it returns. Returns the spend it compared, or null when there is no cap.
 */
export function assertUnderCostCap(
  policy: Policy,
  telemetryPath: string | undefined,
  opts: DriverSpendOptions = {},
): RecordedSpend | null {
  const cap = policy.hard_cost_cap_usd;
  if (typeof cap !== "number" || !telemetryPath) return null;
  const spend = recordedSpend(policy, telemetryPath, opts);
  if (spend.total_usd >= cap) throw new CostCapExceededError(spend.total_usd, cap, policy.name, telemetryPath, spend);
  return spend;
}
