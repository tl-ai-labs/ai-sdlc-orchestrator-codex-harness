/**
 * The headless run's closing driver line: its incomplete turns are named the
 * way the report's booking prices them, beside the figure that booking gives.
 */
import "./lib/stand-ins.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { driverLines } from "../../plugin/codex/run.mjs";
import { runCost } from "../../plugin/codex/run-finalize.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "report", "driver-usage");
// driver-manifest.json after bookCollectedUsage: the exec stream's incomplete count is kept.
const manifest = (over = {}) => ({ codex_invocations: 2, driver_turns: 1, driver_turns_incomplete: 1, driver_cost_usd_modeled: 0.14, ...over });

test("a killed turn the session file priced is not called unknown next to a figure that holds it", () => {
  const cost = runCost(join(FIXTURES, "headless-killed-last"));
  assert.deepEqual([cost.driver_turns_incomplete, cost.driver_turns_incomplete_unpriced, cost.driver_bound], [1, 0, "exact"]);
  const [line] = driverLines(manifest({ driver_cost_complete: true }), null, cost);
  assert.equal(line, "invocations 2, turns 1 (1 incomplete: priced from the session file), driver cost (modeled) $0.1400");
});

test("a killed turn no session file holds is called not priced, and the figure is a floor", () => {
  const cost = runCost(join(FIXTURES, "headless-no-session-killed"));
  assert.deepEqual([cost.driver_turns_incomplete, cost.driver_turns_incomplete_unpriced, cost.driver_bound], [1, 1, "floor"]);
  const [line] = driverLines(manifest({ driver_cost_usd_modeled: 0.05, driver_cost_complete: false }), null, cost);
  assert.equal(line, "invocations 2, turns 1 (1 incomplete: not priced, cost not known, not $0), driver cost (modeled) at least $0.0500");
});

test("some incomplete turns priced and some not are counted apart", () => {
  const cost = { driver_usd_modeled: 0.2, driver_bound: "floor", driver_turns_incomplete: 3, driver_turns_incomplete_unpriced: 1 };
  const [line] = driverLines(manifest({ driver_turns_incomplete: 3 }), null, cost);
  assert.equal(line, "invocations 2, turns 1 (3 incomplete: 2 priced from the session file; 1 not priced, cost not known, not $0), driver cost (modeled) at least $0.2000");
});

test("with no booking to read, the line falls back on driver-manifest.json's own completeness", () => {
  assert.equal(
    driverLines(manifest({ driver_cost_complete: true }), null, null)[0],
    "invocations 2, turns 1 (1 incomplete: priced from the session file), driver cost (modeled) $0.1400",
  );
  assert.equal(
    driverLines(manifest({ driver_cost_complete: false }), null, null)[0],
    "invocations 2, turns 1 (1 incomplete: not priced, cost not known, not $0), driver cost (modeled) at least $0.1400",
  );
  assert.equal(driverLines(manifest({ driver_turns_incomplete: 0 }), null, null)[0], "invocations 2, turns 1, driver cost (modeled) $0.1400");
});
