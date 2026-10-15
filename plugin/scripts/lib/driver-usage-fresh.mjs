import { statSync } from "node:fs";
import { join } from "node:path";

/** The append-only files driver-usage.json is measured from; the collector records each one's size in `inputs`. */
export const DRIVER_USAGE_INPUTS = ["driver-events.jsonl", "driver-session.jsonl"];

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * False once a file driver-usage.json was measured from has grown since: a
 * resumed run spent past the figure. A file with no `inputs` predates the
 * check and counts as fresh. Same rule as sessionUsage.ts driverUsageIsFresh.
 */
export function driverUsageIsFresh(runDir, usage) {
  const inputs = usage?.inputs;
  if (!inputs || typeof inputs !== "object") return true;
  return DRIVER_USAGE_INPUTS.every((f) => typeof inputs[f] !== "number" || inputs[f] === sizeOf(join(runDir, f)));
}
