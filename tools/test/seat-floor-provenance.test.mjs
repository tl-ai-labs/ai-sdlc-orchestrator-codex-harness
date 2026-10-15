/**
 * A codex-cli seat floor (provenance estimated, adapter_provenance modeled)
 * is booked as modeled by every reader of telemetry.jsonl: manifest.json,
 * SUMMARY.md, the cost report and the cost cap.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordedSpend, describeSpend } from "../../plugin/mcp/model-dispatch/dist/costCap.js";
import { readRun, render, summarize } from "../../plugin/scripts/report.mjs";
import { byProvenance, writeManifest } from "../../plugin/scripts/write-manifest.mjs";

const roots = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const event = (o) => ({
  ts: "2026-10-13T10:00:00.000Z", pass: "r1", phase: "senior_code_review", task_type: "review", task_id: "p1",
  module: "cross", model: "gpt-5.6-terra", routed_by: "orchestrator", input_tokens: 1000, input_tokens_cached: 0,
  output_tokens: 100, latency_ms: 10, retry_count: 0, ...o,
});
// A codex-cli turn that timed out: its prompt priced at the list's rates, never billed.
const SEAT_FLOOR = event({ provenance: "estimated", adapter_provenance: "modeled", usage_complete: false, success: false, cost_usd: 0.01 });
// 1000 in at $0.75/M and 100 out at $3.75/M on gemini-3.7-flash.
const GEMINI = event({ ts: "2026-10-13T10:01:00.000Z", phase: "codegen", task_id: "p2", model: "gemini-3.7-flash", provenance: "vendor", success: true, cost_usd: 0.001125 });

function seatRun() {
  const root = mkdtempSync(join(tmpdir(), "seat-floor-"));
  roots.push(root);
  const runDir = join(root, ".sdlc", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "telemetry.jsonl"), [SEAT_FLOOR, GEMINI].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { root, runDir };
}

test("manifest.json books a seat floor as modeled, not estimated", () => {
  const { root, runDir } = seatRun();
  const { manifest } = writeManifest({ runDir, runId: "r1", policy: "gpt-seat-plus-flash", projectRoot: root });
  assert.deepEqual(manifest.totals.by_provenance, { vendor: 0.001125, estimated: 0, modeled: 0.01, none: 0, unlabelled: 0 });
  assert.equal(manifest.totals.dispatched_cost_usd, 0.011125);
  assert.deepEqual(byProvenance([{ provenance: "estimated", cost_usd: 0.02 }]).estimated, 0.02, "a metered estimate stays estimated");
});

test("SUMMARY.md lists a seat floor on the modeled line", () => {
  const { root, runDir } = seatRun();
  writeManifest({ runDir, runId: "r1", policy: "gpt-seat-plus-flash", projectRoot: root, summary: true });
  const text = readFileSync(join(runDir, "SUMMARY.md"), "utf-8");
  assert.match(text, /\| ↳ vendor-metered \| \$0\.0011 \|/);
  assert.match(text, /\| ↳ modeled \(token counts at the dated price list's rates\) \| \$0\.0100 \|/);
  assert.doesNotMatch(text, /estimated \(no usage block returned\)/);
});

test("the manifest, the report and the cost cap give the same modeled share", () => {
  const { root, runDir } = seatRun();
  const { manifest } = writeManifest({ runDir, runId: "r1", policy: "gpt-seat-plus-flash", projectRoot: root });
  const report = summarize(readRun(runDir));
  const spend = recordedSpend({ name: "gpt-seat-plus-flash", hard_cost_cap_usd: 5 }, join(runDir, "telemetry.jsonl"), { codexHome: join(root, "home"), env: {} });

  assert.equal(report.totals.modeled_dispatched_usd, 0.01);
  assert.equal(report.dispatched.by_provenance.estimated.cost_usd, 0);
  assert.equal(manifest.totals.by_provenance.modeled, report.totals.modeled_dispatched_usd);
  assert.equal(spend.dispatched_modeled_usd, report.totals.modeled_dispatched_usd);
  assert.equal(spend.dispatched_usd, 0.011125, "the cap still counts every dispatched dollar");
  assert.match(describeSpend(spend, "telemetry.jsonl"), /\$0\.0111 dispatched \(telemetry\.jsonl; \$0\.0100 of it modeled\)/);
  assert.doesNotMatch(render(report), /of which estimated/);
});
