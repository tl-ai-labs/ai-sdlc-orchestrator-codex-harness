/**
 * The report's totals: a run total of dispatched plus driver, a
 * vendor-metered total that holds only vendor and estimated events, a
 * modeled total for seat and driver figures, and a row for every phase.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main, readRun, render, summarize, SDLC_PHASES } from "../../plugin/scripts/report.mjs";
import { PHASES } from "../../plugin/mcp/model-dispatch/dist/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function event(overrides = {}) {
  return {
    ts: "2026-10-13T10:00:00Z", pass: "r1", phase: "codegen", task_type: "x", task_id: "t",
    model: "gemini-3.7-flash", provenance: "vendor", routing: { policy_name: "gpt-plus-flash" },
    input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.01, success: true,
    ...overrides,
  };
}
const driverTurn = (overrides = {}) => event({
  phase: "driver_loop", model: "gpt-5.6-terra", provenance: "modeled", status: "complete", ...overrides,
});
const jsonl = (rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + (rows.length ? "\n" : "");

const dirs = [];
function makeRun({ telemetry = [], driver = null, stream = null, driverManifest = null, driverUsage = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "report-totals-"));
  dirs.push(dir);
  if (telemetry.length) writeFileSync(join(dir, "telemetry.jsonl"), jsonl(telemetry));
  if (driver) writeFileSync(join(dir, "driver-cost-modeled.jsonl"), jsonl(driver));
  if (stream) writeFileSync(join(dir, "driver-events.jsonl"), jsonl(stream));
  if (driverManifest) writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify(driverManifest));
  if (driverUsage) writeFileSync(join(dir, "driver-usage.json"), JSON.stringify(driverUsage));
  return dir;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function report(dir, args = []) {
  const out = [], err = [];
  const status = main([dir, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, "report.mjs");
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}
const both = (dir) => [report(dir).stdout, report(dir, ["--markdown"]).stdout];
const lineOf = (out, label) => out.split("\n").find((l) => l.includes(label));

// ── phase rows ───────────────────────────────────────────────────────

test("discovery and change_plan get rows in pipeline order and count as SDLC work", () => {
  const dir = makeRun({
    telemetry: [
      event({ phase: "codegen", cost_usd: 0.03 }),
      event({ phase: "change_plan", cost_usd: 0.2 }),
      event({ phase: "discovery", cost_usd: 0.1 }),
    ],
  });
  const out = report(dir).stdout;
  const at = (p) => out.search(new RegExp(`^  ${p}\\s`, "m"));
  assert.ok(at("discovery") > 0 && at("discovery") < at("change_plan") && at("change_plan") < at("codegen"), out);
  assert.match(out, /SDLC total\s+3\s+\$0\.3300/);
  assert.doesNotMatch(out, /Runner overhead/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /\| `discovery` \| V \| 1 \|/);
  assert.match(md, /\| `change_plan` \| V \| 1 \|/);
});

test("overhead phases are listed one by one under Runner overhead", () => {
  const dir = makeRun({
    telemetry: [
      event({ phase: "codegen", cost_usd: 0.03 }),
      event({ phase: "final_report", cost_usd: 0.02 }),
      event({ phase: "debug", cost_usd: 0.04 }),
    ],
  });
  const out = report(dir).stdout;
  assert.match(out, /Runner overhead\s+2\s+\$0\.0600/);
  assert.match(out, /^ {4}debug\s+V\s+1\s+.*\$0\.0400$/m, "an overhead row is indented under its total");
  assert.match(out, /^ {4}final_report\s+V\s+1\s+.*\$0\.0200$/m);
  assert.ok(out.indexOf("    debug") < out.indexOf("    final_report"), "known overhead phases keep a fixed order");
  assert.match(out, /Dispatched total\s+3\s+\$0\.0900/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /\| ↳ `debug` \| V \| 1 \| .* \| \$0\.0400 \|/);
  assert.match(md, /\| \*\*Dispatched total\*\* \| \| 3 \| \| \*\*\$0\.0900\*\* \|/);
});

test("every phase the bridge can dispatch has a place in the report", () => {
  const phases = [...PHASES];
  assert.ok(phases.length >= 13, `${phases.length} phases in types.ts`);
  const dir = makeRun({ telemetry: phases.map((phase, i) => event({ phase, task_id: `t${i}`, cost_usd: 0.001 })) });
  const r = summarize(readRun(dir));
  const shown = [...r.dispatched.phases, ...r.dispatched.overhead_phases].map((p) => p.phase).sort();
  assert.deepEqual(shown, [...phases].sort());
  for (const p of ["discovery", "change_plan"]) assert.ok(SDLC_PHASES.includes(p), `${p} is SDLC work`);
});

// ── vendor-metered, estimated, modeled, unlabelled ──────────────────

test("a modeled seat event stays out of the vendor-metered total", () => {
  const dir = makeRun({
    telemetry: [
      event({ phase: "codegen", cost_usd: 0.03 }),
      event({ phase: "senior_code_review", provenance: "modeled", model: "gpt-5.6-terra", cost_usd: 0.05 }),
    ],
  });
  for (const out of both(dir)) {
    assert.match(out, /Vendor-metered total\s*\|?\s*\$0\.0300/);
    assert.doesNotMatch(out, /Vendor-metered total\s*\|?\s*\$0\.0800/);
  }
  const out = report(dir).stdout;
  assert.match(out, /Dispatched total\s+2\s+\$0\.0800/);
  assert.match(lineOf(out, "of which dispatched"), /\$0\.0500$/);
  assert.doesNotMatch(out, /Dispatched work — vendor-metered/, "the dispatched section is not all vendor-metered");
});

test("estimated events count as vendor-metered and are named; unlabelled events are in neither total", () => {
  const dir = makeRun({
    telemetry: [
      event({ cost_usd: 0.075 }),
      event({ provenance: "estimated", cost_usd: 0.0015 }),
      event({ provenance: "modeled", cost_usd: 0.08 }),
      event({ provenance: undefined, cost_usd: 0.004 }),
    ],
    driver: [],
  });
  const out = report(dir).stdout;
  assert.match(out, /Vendor-metered total\s+\$0\.0765/);
  assert.match(out, /of which estimated \(no usage block returned\)\s+\$0\.0015/);
  assert.match(out, /Modeled \(seat\) total\s+\$0\.0800/);
  assert.match(out, /Unlabelled provenance\s+\$0\.0040/);
  assert.match(out, /Dispatched total\s+4\s+\$0\.1605/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.1605/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /\| ↳ estimated \(no usage block returned\) \| \$0\.0015 \|/);
  assert.match(md, /\| Unlabelled provenance \| \$0\.0040 \|/);
});

test("with no estimated or unlabelled events those lines are left out", () => {
  const dir = makeRun({ telemetry: [event()], driver: [] });
  for (const out of both(dir)) {
    assert.doesNotMatch(out, /of which estimated|↳ estimated/);
    assert.doesNotMatch(out, /Unlabelled provenance/);
  }
});

// ── run total ────────────────────────────────────────────────────────

test("the run total is dispatched plus driver, with the modeled parts named", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.99 })],
  });
  const out = report(dir).stdout;
  assert.match(out, /Driver loop — modeled\s+\$0\.9900/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$1\.0400/);
  assert.match(out, /Vendor-metered total\s+\$0\.0500/);
  assert.match(out, /Modeled \(seat\) total\s+\$0\.9900/);
  assert.match(lineOf(out, "of which driver loop"), /\$0\.9900$/);
  assert.match(out, /Modeled figures are token counts at the price list's rates, not a bill\./);
  assert.doesNotMatch(out, /at least/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /^## Run total$/m);
  assert.match(md, /\| \*\*Run total = dispatched \+ driver\*\* \| \*\*\$1\.0400\*\* \|/);
  assert.match(md, /\| Driver loop — modeled \| \$0\.9900 \|/);
  assert.match(md, /\| Modeled \(seat\) total \| \$0\.9900 \|/);
});

test("with no driver record the run has no total, and the dispatched figure is not passed off as one", () => {
  const dir = makeRun({ telemetry: [event({ cost_usd: 0.05 })] });
  for (const out of both(dir)) {
    assert.match(out, /Run total = dispatched \+ driver\**\s*\|?\s*\**not measured/);
    assert.doesNotMatch(out, /Run total = dispatched \+ driver\**\s*\|?\s*\**(at least )?\$/);
    assert.match(out, /Driver loop — modeled\s*\|?\s*not measured/);
    assert.match(out, /this run has no total/);
    assert.match(out, /it is not the run's cost/);
  }
});

test("a driver file with no turns gives a run total of dispatched plus nothing", () => {
  const dir = makeRun({ telemetry: [event({ cost_usd: 0.05 })], driver: [] });
  const out = report(dir).stdout;
  assert.match(out, /No driver turns recorded/);
  assert.match(out, /Driver loop — modeled\s+\$0\.0000/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.0500/);
});

test("summarize: the parts add up to the totals exactly", () => {
  const dir = makeRun({
    telemetry: [
      event({ cost_usd: 0.1 }), event({ cost_usd: 0.2 }),
      event({ provenance: "estimated", cost_usd: 0.0000004 }),
      event({ provenance: "modeled", cost_usd: 0.3 }),
      event({ phase: "debug", provenance: "none", cost_usd: 0 }),
      event({ provenance: "unknown-label", cost_usd: 0.7 }),
      event({ cost_usd: Number.NaN }), event({ cost_usd: "0.5" }),
    ],
    driver: [driverTurn({ cost_usd: 0.1 }), driverTurn({ cost_usd: 0.2 })],
  });
  const r = summarize(readRun(dir));
  const t = r.totals;
  const micro = (v) => Math.round(v * 1e6);
  assert.equal(t.dispatched_usd, 1.3);
  assert.equal(t.driver_usd, 0.3);
  assert.equal(t.run_total_usd, 1.6);
  assert.equal(micro(t.run_total_usd), micro(t.dispatched_usd) + micro(t.driver_usd));
  assert.equal(micro(t.dispatched_usd), micro(r.dispatched.sdlc.cost_usd) + micro(r.dispatched.overhead.cost_usd));
  const parts = Object.values(r.dispatched.by_provenance).reduce((s, v) => s + micro(v.cost_usd), 0);
  assert.equal(parts, micro(t.dispatched_usd), "provenance subtotals sum to the dispatched total");
  assert.equal(micro(t.vendor_metered_usd) + micro(t.modeled_usd) + micro(t.unlabelled_usd), micro(t.run_total_usd));
  assert.equal(t.vendor_metered_usd, 0.3);
  assert.equal(t.modeled_usd, 0.6);
  assert.equal(t.unlabelled_usd, 0.7);
  assert.equal(r.dispatched.by_provenance.vendor.calls, 4, "a non-finite cost still counts as a call");
});

// ── incomplete driver turns ──────────────────────────────────────────

const floored = (out) => {
  assert.match(out, /Incomplete turns\s+1\s+\(no usage reported; the cost is a floor\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.5500/);
  assert.match(out, /1 driver turn reported no usage, so the run cost is at least this\./);
};

test("a turn that started and never completed in driver-events.jsonl makes the run total a floor", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 })],
    stream: [{ type: "turn.started" }, { type: "turn.completed", usage: {} }, { type: "turn.started" }],
  });
  floored(report(dir).stdout);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /\| codex exec --json turn usage \| 1 \| 1 \| .* \| \$0\.5000 \|/);
  assert.match(md, /\*\*at least \$0\.5500\*\*/);
});

test("driver-events.jsonl v1 lines are unwrapped and invocation_end counts are read", () => {
  const codex = (type) => ({ v: 1, kind: "codex", invocation: 1, thread_id: "th", received_at: "x", event: { type } });
  const stream = [
    { v: 1, kind: "invocation_start", invocation: 1 },
    codex("turn.started"), codex("turn.completed"),
    { v: 1, kind: "invocation_end", invocation: 1, turns: { started: 1, completed: 1, failed: 0 } },
    { v: 1, kind: "invocation_start", invocation: 2 },
    { v: 1, kind: "stdout_unparsed", invocation: 2, line: "{\"type\":\"turn.started\"" },
    { v: 1, kind: "invocation_end", invocation: 2, turns: { started: 1, completed: 0, failed: 1 } },
  ];
  const dir = makeRun({ telemetry: [event({ cost_usd: 0.05 })], driver: [driverTurn({ cost_usd: 0.5 })], stream });
  floored(report(dir).stdout);
});

test("an incomplete row in driver-cost-modeled.jsonl makes the run total a floor", () => {
  for (const marker of [{ status: "incomplete", incomplete_reason: "turn_failed" }, { incomplete: true }]) {
    const dir = makeRun({
      telemetry: [event({ cost_usd: 0.05 })],
      driver: [driverTurn({ cost_usd: 0.5 }), driverTurn({ ...marker, status: marker.status, cost_usd: null, input_tokens: null, output_tokens: null })],
    });
    const out = report(dir).stdout;
    floored(out);
    assert.match(out, /^ {2}Turns\s+1$/m, "the incomplete row is not counted as a priced turn");
  }
});

test("driver-manifest.json driver_turns_incomplete makes the run total a floor", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 })],
    driverManifest: { run_id: "r", driver_turns_incomplete: 1, driver_cost_complete: false },
  });
  floored(report(dir).stdout);
});

test("incomplete counts from several sources are not added together", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 }), driverTurn({ status: "incomplete", cost_usd: null })],
    stream: [{ type: "turn.started" }, { type: "turn.completed" }, { type: "turn.started" }],
    driverManifest: { run_id: "r", driver_turns_incomplete: 1 },
  });
  assert.equal(summarize(readRun(dir)).driver.turns_incomplete, 1);
});

test("driver_cost_complete false alone still makes the total a floor", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 })],
    driverManifest: { run_id: "r", driver_cost_complete: false },
  });
  const out = report(dir).stdout;
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.5500/);
  assert.match(out, /The driver cost is marked incomplete/);
});

test("a complete driver row with no cost is unpriced, and the total is a floor", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 }), driverTurn({ cost_usd: null })],
  });
  const out = report(dir).stdout;
  assert.match(out, /^ {2}Turns\s+1$/m, "Turns counts priced turns only");
  assert.match(out, /Unpriced\s+1 turn with no cost recorded/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.5500/);
});

// ── driver flags (driverUsage.ts DriverTurnFlag) ────────────────────

test("a baseline_unknown row prices a resumed thread at its whole total, so the run total is a ceiling", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5, thread_id: "th", driver_flags: ["baseline_unknown"] }), driverTurn({ cost_usd: 0.1, thread_id: "th" })],
  });
  const out = report(dir).stdout;
  assert.match(out, /Flags\s+baseline_unknown \(1 turn\)/);
  assert.match(out, /Driver loop — modeled\s+at most \$0\.6000/);
  assert.match(out, /Run total = dispatched \+ driver\s+at most \$0\.6500/);
  assert.match(out, /1 driver turn resumed a thread with no earlier total in this run folder and was priced at the thread's whole running total, so the run cost is at most this\./);
  assert.doesNotMatch(out, /at least/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /- Flags: baseline_unknown \(1 turn\)/);
  assert.match(md, /\| \*\*Run total = dispatched \+ driver\*\* \| \*\*at most \$0\.6500\*\* \|/);
  assert.equal(summarize(readRun(dir)).totals.run_total_bound, "ceiling");
});

test("driver_cost_flags in driver-manifest.json count when the rows carry none", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 })],
    driverManifest: { run_id: "r", driver_cost_flags: ["cumulative_reset", "no_thread_id"] },
  });
  const out = report(dir).stdout;
  assert.match(out, /Flags\s+cumulative_reset, no_thread_id$/m);
  assert.match(out, /Run total = dispatched \+ driver\s+about \$0\.5500/);
  assert.match(out, /The thread's running total dropped on a driver turn, which was priced at the new total, so the figure can be higher or lower than this run spent\./);
});

test("zero_usage counts as missing only when no later total on the same thread carries it", () => {
  const carried = makeRun({
    driver: [driverTurn({ cost_usd: 0, thread_id: "th", driver_flags: ["zero_usage"] }), driverTurn({ cost_usd: 0.2, thread_id: "th" })],
  });
  assert.equal(summarize(readRun(carried)).totals.run_total_bound, "exact");
  assert.match(report(carried).stdout, /Flags\s+zero_usage \(1 turn\)/);
  const lost = makeRun({
    driver: [driverTurn({ cost_usd: 0.2, thread_id: "th" }), driverTurn({ cost_usd: 0, thread_id: "th", driver_flags: ["zero_usage"] })],
  });
  const out = report(lost).stdout;
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.2000/);
  assert.match(out, /The last driver turn on 1 thread reported zero usage, and no later total carries it/);
});

test("a ceiling and a floor together make the run total approximate", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [
      driverTurn({ cost_usd: 0.5, thread_id: "th", driver_flags: ["baseline_unknown"] }),
      driverTurn({ status: "incomplete", thread_id: "th", cost_usd: null, input_tokens: null, output_tokens: null }),
    ],
  });
  const out = report(dir).stdout;
  assert.match(out, /Run total = dispatched \+ driver\s+about \$0\.5500/);
  assert.match(out, /1 driver turn reported no usage, so that cost is missing from the figure\./);
  assert.match(out, /so the figure can count more than this run spent\./);
  assert.match(out, /Those pull in opposite directions/);
  assert.match(out, /Incomplete turns\s+1\s+\(no usage reported; their cost is missing from the figure\)/,
    "the driver section does not call an approximate figure a floor");
  assert.doesNotMatch(out, /the cost is a floor/);
  assert.match(report(dir, ["--markdown"]).stdout, /- Incomplete turns: no usage reported; their cost is missing from the figure/);
});

test("an incomplete turn with no ceiling reason keeps the driver section's floor note", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.5 }), driverTurn({ status: "incomplete", cost_usd: null, input_tokens: null, output_tokens: null })],
  });
  assert.match(report(dir).stdout, /Incomplete turns\s+1\s+\(no usage reported; the cost is a floor\)/);
});

test("flags on driver-cost-modeled.jsonl rows are ignored when driver-usage.json is booked", () => {
  const dir = makeRun({
    driver: [driverTurn({ cost_usd: 0.5, driver_flags: ["baseline_unknown"] })],
    driverUsage: { source: "session-file", cost_usd_modeled: 0.3, cost_complete: true, verified: true, turns: [] },
  });
  const r = summarize(readRun(dir));
  assert.deepEqual(r.driver.flags, {});
  assert.equal(r.totals.run_total_bound, "exact");
});

test("a dispatched call with partial usage makes its total and the run total a floor", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 }), event({ provenance: "estimated", usage_complete: false, cost_usd: 0.002 })],
    driver: [driverTurn({ cost_usd: 0.5 })],
  });
  const out = report(dir).stdout;
  assert.match(out, /Vendor-metered total\s+at least \$0\.0520/);
  assert.match(out, /Modeled \(seat\) total\s+\$0\.5000/, "the modeled part is unaffected");
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.5520/);
  assert.match(out, /1 dispatched call returned partial usage/);
});

test("a seat adapter's estimated floor counts as modeled, not vendor-metered", () => {
  const dir = makeRun({
    telemetry: [
      event({ cost_usd: 0.05 }),
      event({
        phase: "senior_code_review", model: "gpt-5.6-terra", provenance: "estimated",
        adapter_provenance: "modeled", usage_complete: false, cost_usd: 0.02,
      }),
      event({ provenance: "estimated", usage_complete: false, cost_usd: 0.004 }),
    ],
    driver: [driverTurn({ cost_usd: 0.5 })],
  });
  const out = report(dir).stdout;
  assert.match(out, /Vendor-metered total\s+at least \$0\.0540/);
  assert.match(out, /of which estimated \(no usage block returned\)\s+at least \$0\.0040/);
  assert.match(out, /Modeled \(seat\) total\s+at least \$0\.5200/);
  assert.match(out, /of which dispatched\s+at least \$0\.0200/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.5740/);
  const r = summarize(readRun(dir));
  assert.equal(r.totals.vendor_metered_usd, 0.054);
  assert.equal(r.totals.modeled_dispatched_usd, 0.02);
  assert.equal(r.dispatched.by_provenance.modeled.calls, 1);
  assert.equal(r.dispatched.phases.find((p) => p.phase === "senior_code_review").provenance, "M");
});

// ── driver-usage.json ────────────────────────────────────────────────

test("driver-usage.json is booked in place of driver-cost-modeled.jsonl", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [driverTurn({ cost_usd: 0.4 })],
    driverUsage: {
      source: "session-file", thread_ids: ["th-a"], window: { start: "2026-10-13T10:00:00Z", end: "2026-10-13T10:30:00Z" },
      turns: 3, cost_usd_modeled: 0.45, unpriced: [],
      cross_check: { verdict: "differ", exec_stream_cost_usd: 0.4, session_cost_usd: 0.45 },
    },
  });
  const out = report(dir).stdout;
  assert.match(out, /Source\s+codex session file/);
  assert.match(out, /Thread\s+th-a/);
  assert.match(out, /Window\s+2026-10-13T10:00:00Z → 2026-10-13T10:30:00Z/);
  assert.match(out, /^ {2}Turns\s+3$/m);
  assert.match(out, /Modeled cost\s+\$0\.4500/);
  assert.match(out, /Verification\s+UNVERIFIED$/m, "the item 11 design's `differ` reads as a mismatch");
  assert.match(out, /Cross-check\s+UNVERIFIED: the exec stream disagrees with the session file \(exec stream \$0\.4000, session_cost_usd \$0\.4500\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.5000/);
  assert.match(out, /The driver figure is UNVERIFIED: the exec stream disagrees with the session file\./);
  assert.equal(summarize(readRun(dir)).driver.booked_from, "driver-usage.json");
});

test("driver-usage.json alone gives an interactive run a run total, and unpriced turns make it a floor", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driverUsage: {
      source: "session-file", thread_ids: ["th-b"], window: { start: "2026-10-13T09:00:00Z", end: null },
      turns: 4, cost_usd_modeled: 0.3, unpriced: [{ model: "gpt-6.1-sol", turns: 2 }], cross_check: null,
    },
  });
  const out = report(dir).stdout;
  assert.match(out, /Window\s+2026-10-13T09:00:00Z → open/);
  assert.match(out, /Unpriced\s+gpt-6\.1-sol \(2 turns\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.3500/);
  assert.match(out, /Unpriced driver turns \(gpt-6\.1-sol \(2 turns\)\) are not in the driver figure/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /\| codex session file \| 4 \| 0 \| — \| \$0\.3000 \|/);
  assert.match(md, /- Unpriced: gpt-6\.1-sol \(2 turns\)/);
});

test("a driver-usage.json without a cost figure is ignored", () => {
  const dir = makeRun({ telemetry: [event({ cost_usd: 0.05 })], driverUsage: { source: "session-file", turns: 2 } });
  assert.match(report(dir).stdout, /Run total = dispatched \+ driver\s+not measured/);
});

// ── renderings agree ─────────────────────────────────────────────────

test("--json prints the same figures the text report shows", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 }), event({ phase: "discovery", provenance: "modeled", cost_usd: 0.02 })],
    driver: [driverTurn({ cost_usd: 0.99 })],
  });
  const r = report(dir, ["--json"]);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.schema_version, 1);
  assert.equal(j.totals.run_total_usd, 1.06);
  assert.equal(j.totals.vendor_metered_usd, 0.05);
  assert.equal(j.totals.modeled_usd, 1.01);
  assert.equal(j.totals.run_total_is_floor, false);
  assert.deepEqual(j.dispatched.phases.map((p) => p.phase), ["discovery", "codegen"]);
  assert.deepEqual(JSON.parse(JSON.stringify(summarize(readRun(dir)))), j);
  assert.equal(render(summarize(readRun(dir))), report(dir).stdout);
});

test("no doc says the report never sums modeled and metered figures", () => {
  const docs = join(REPO_ROOT, "docs");
  const files = ["README.md", "SETUP.md", ...readdirSync(docs).filter((n) => n.endsWith(".md")).map((n) => join("docs", n))];
  const offenders = files.filter((f) => /never sum/i.test(readFileSync(join(REPO_ROOT, f), "utf8")));
  assert.deepEqual(offenders, [], "the run total adds them; only the vendor-metered total leaves modeled figures out");
});
