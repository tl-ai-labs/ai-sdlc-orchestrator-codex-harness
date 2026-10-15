/**
 * A dispatched call with partial usage makes every report line that sums it
 * a floor, the dispatched total included, in the text, markdown and --json.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRun, render, summarize } from "../../plugin/scripts/report.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function run({ telemetry, driver = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "report-bound-"));
  dirs.push(dir);
  writeFileSync(join(dir, "telemetry.jsonl"), jsonl(telemetry));
  if (driver.length) writeFileSync(join(dir, "driver-cost-modeled.jsonl"), jsonl(driver));
  return summarize(readRun(dir));
}

const event = (o) => ({ ts: "2026-10-13T10:00:00Z", phase: "codegen", task_id: "p1", model: "gemini-3.7-flash", input_tokens: 4000, input_tokens_cached: 0, output_tokens: 0, ...o });
// A Gemini call cut off at its deadline: the prompt estimate, at least what it spent.
const DEADLINE = event({ provenance: "estimated", usage_complete: false, success: false, cost_usd: 0.003 });
const DRIVER = { phase: "driver_loop", status: "complete", provenance: "modeled", thread_id: "t1", input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.0032 };

test("a partial dispatched call makes the dispatched total a floor beside the vendor-metered floor", () => {
  const r = run({ telemetry: [DEADLINE], driver: [DRIVER] });
  assert.deepEqual(
    [r.totals.dispatched_bound, r.totals.dispatched_is_floor, r.totals.estimated_is_floor, r.totals.vendor_metered_is_floor, r.totals.run_total_bound],
    ["floor", true, true, true, "floor"],
  );

  const text = render(r);
  assert.match(text, /Dispatched total\s+1\s+at least \$0\.0030/, "the dispatched table's total row");
  assert.match(text, /Run total\n\n\s+Dispatched total\s+at least \$0\.0030\n/);
  assert.match(text, /Run total = dispatched \+ driver\s+at least \$0\.0062/);
  assert.match(text, /of which estimated \(no usage block returned\)\s+at least \$0\.0030/);

  const md = render(r, { markdown: true });
  assert.ok(md.includes("| **Dispatched total** | | 1 | | **at least $0.0030** |"), md);
  assert.ok(md.includes("| Dispatched total | at least $0.0030 |"), md);
  assert.ok(md.includes("| ↳ estimated (no usage block returned) | at least $0.0030 |"), md);
});

test("a partial seat floor makes the modeled dispatched share a floor", () => {
  const seat = event({ provenance: "estimated", adapter_provenance: "modeled", usage_complete: false, model: "gpt-5.6-terra", cost_usd: 0.01 });
  const r = run({ telemetry: [seat, event({ task_id: "p2", provenance: "vendor", cost_usd: 0.001 })], driver: [DRIVER] });
  assert.deepEqual([r.totals.modeled_dispatched_is_floor, r.totals.vendor_metered_is_floor, r.totals.modeled_bound], [true, false, "floor"]);
  assert.match(render(r), /of which dispatched\s+at least \$0\.0100/);
  assert.ok(render(r, { markdown: true }).includes("| ↳ dispatched | at least $0.0100 |"));
});

test("with no driver measured, the dispatched-only sentence keeps the floor", () => {
  const r = run({ telemetry: [DEADLINE] });
  assert.equal(r.totals.run_total_usd, null);
  assert.match(render(r), /alone is at least \$0\.0030; it is not the run's cost\./);
  assert.match(render(r, { markdown: true }), /Dispatched work alone is at least \$0\.0030; it is not the run's cost\./);
});

test("complete usage leaves every dispatched line exact", () => {
  const r = run({ telemetry: [event({ provenance: "vendor", cost_usd: 0.003 })], driver: [DRIVER] });
  assert.deepEqual([r.totals.dispatched_bound, r.totals.dispatched_is_floor, r.totals.estimated_is_floor, r.totals.modeled_dispatched_is_floor], ["exact", false, false, false]);
  assert.match(render(r), /Run total\n\n\s+Dispatched total\s+\$0\.0030\n/);
  assert.doesNotMatch(render(r), /at least/);
});
