/**
 * Where the report takes a run's id, policy, timing and outcome from. Both
 * manifest spellings are read, the code-written driver-manifest.json ranks
 * first, and no cost figure is ever taken from a manifest.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identity, main, readRun, summarize } from "../../plugin/scripts/report.mjs";

function event(overrides = {}) {
  return {
    ts: "2026-10-13T10:00:00Z", pass: "tele-pass", phase: "codegen", task_id: "t", model: "gemini-3.7-flash",
    provenance: "vendor", routing: { policy_name: "gpt-seat-plus-flash" },
    input_tokens: 1000, output_tokens: 100, cost_usd: 0.01, ...overrides,
  };
}

const dirs = [];
function makeRun({ telemetry = [event()], driver = null, manifest = null, driverManifest = null, name = "folder-name" } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "report-identity-"));
  dirs.push(parent);
  const dir = join(parent, name);
  mkdirSync(dir);
  if (telemetry.length) writeFileSync(join(dir, "telemetry.jsonl"), telemetry.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (driver) writeFileSync(join(dir, "driver-cost-modeled.jsonl"), driver.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (manifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  if (driverManifest) writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify(driverManifest));
  return dir;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function report(dir, args = []) {
  const out = [];
  const status = main([dir, ...args], { out: (s) => out.push(s), err: () => {} }, "report.mjs");
  return { status, stdout: out.join("\n") };
}
const id = (dir) => identity(readRun(dir));

test("all three manifest spellings give the same report", () => {
  const spellings = [
    { run_id: "R7", policy: "gpt-seat-plus-flash" },
    { pass: "R7", policy_name: "gpt-seat-plus-flash" },
    { run_id: "R7", policy: { name: "gpt-seat-plus-flash" } },
  ];
  for (const args of [[], ["--markdown"]]) {
    const outs = spellings.map((manifest) => report(makeRun({ manifest }), args).stdout);
    assert.match(outs[0], /Run report — R7/);
    assert.match(outs[0], /Policy\W+gpt-seat-plus-flash/);
    assert.equal(outs[1], outs[0]);
    assert.equal(outs[2], outs[0]);
  }
});

test("driver-manifest.json outranks a model-written manifest", () => {
  const dir = makeRun({
    manifest: { run_id: "model-typed", policy: "gpt-plus-flash" },
    driverManifest: { run_id: "R8", policy: "gpt-plus-flash" },
    telemetry: [event({ routing: { policy_name: "gpt-plus-flash" } })],
  });
  assert.equal(id(dir).run_id, "R8");
  assert.equal(id(dir).policy, "gpt-plus-flash");
});

test("with no manifest the run id and policy come from telemetry.jsonl, never from the driver file", () => {
  const dir = makeRun({
    telemetry: [event({ pass: "R9", routing: { policy_name: "gpt-seat-plus-flash" } })],
    driver: [event({ phase: "driver_loop", provenance: "modeled", pass: "driver-pass", routing: { policy_name: "gpt-plus-flash" } })],
  });
  assert.equal(id(dir).run_id, "R9");
  assert.equal(id(dir).policy, "gpt-seat-plus-flash");
  assert.deepEqual(id(dir).policy_sources.map((s) => s.source), ["telemetry.jsonl"]);
  assert.doesNotMatch(report(dir).stdout, /Policy names disagree/);
});

test("with nothing to name it, the run is named after its folder", () => {
  const dir = makeRun({ telemetry: [event({ pass: undefined, routing: {} })], name: "20261013-120000-docs-abc123" });
  assert.equal(id(dir).run_id, "20261013-120000-docs-abc123");
  assert.equal(id(dir).policy, null);
  assert.match(report(dir).stdout, /Policy:\s+—/);
});

test("policy names that disagree are named in both renderings; agreeing names print nothing", () => {
  const disagree = makeRun({
    manifest: { run_id: "R", policy: "gpt-seat-plus-flash" },
    driverManifest: { run_id: "R", policy: "gpt-plus-flash" },
  });
  const text = report(disagree).stdout;
  assert.match(text, /! Policy names disagree: driver-manifest\.json says gpt-plus-flash; manifest\.json says gpt-seat-plus-flash; telemetry\.jsonl says gpt-seat-plus-flash/);
  assert.match(text, /Policy:\s+gpt-plus-flash/, "the header shows the policy that priced the driver");
  assert.match(report(disagree, ["--markdown"]).stdout, /> \*\*Policy names disagree:\*\* driver-manifest\.json says gpt-plus-flash/);

  const agree = makeRun({
    manifest: { run_id: "R", policy_name: "gpt-seat-plus-flash" },
    driverManifest: { run_id: "R", policy: "gpt-seat-plus-flash" },
  });
  for (const args of [[], ["--markdown"]]) assert.doesNotMatch(report(agree, args).stdout, /disagree/);
});

test("duration comes from driver-manifest.json start and end when the manifest has none", () => {
  const dir = makeRun({
    manifest: { run_id: "R", policy: "gpt-seat-plus-flash" },
    driverManifest: { run_id: "R", started_at: "2026-10-13T10:00:00Z", ended_at: "2026-10-13T10:12:05Z" },
  });
  assert.equal(id(dir).duration_sec, 725);
  assert.match(report(dir).stdout, /Duration:\s+12m 05s/);
  const fromManifest = makeRun({ manifest: { run_id: "R", duration_sec: 61 } });
  assert.match(report(fromManifest).stdout, /Duration:\s+1m 01s/);
  const wallClock = makeRun({ manifest: { run_id: "R", total_wall_clock_sec: 125 } });
  assert.equal(id(wallClock).duration_sec, 125);
});

test("no cost figure is read from manifest.json", () => {
  const plain = makeRun({ telemetry: [event({ cost_usd: 0.05 })], driver: [] });
  const stale = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    driver: [],
    manifest: {
      run_id: "folder-name", total_cost_usd: 9.99,
      totals: { dispatched_cost_usd: 9.99, driver_cost_usd_modeled: 4.2, by_provenance: { vendor: 9.99 } },
      phase_breakdown: { codegen: { cost_usd: 9.99 } },
    },
  });
  assert.deepEqual(summarize(readRun(stale)).totals, summarize(readRun(plain)).totals);
  assert.doesNotMatch(report(stale).stdout, /9\.99|4\.2/);
});

test("the outcome, exit code and reason from driver-manifest.json are in the header", () => {
  const dir = makeRun({ driverManifest: { run_id: "R", outcome: "max_turns", outcome_reason: "8 turns used", exit_code: 3 } });
  assert.match(report(dir).stdout, /Outcome:\s+max_turns \(exit 3\) — 8 turns used/);
  assert.match(report(dir, ["--markdown"]).stdout, /\| Outcome \| max_turns \(exit 3\) — 8 turns used \|/);
  const fromManifest = makeRun({ manifest: { run_id: "R", driver: { outcome: "completed", exit_code: 0 } } });
  assert.match(report(fromManifest).stdout, /Outcome:\s+completed \(exit 0\)/);
  assert.doesNotMatch(report(makeRun()).stdout, /Outcome:/);
});

test("codex warnings and the driver's sign-in are surfaced", () => {
  const dir = makeRun({
    driver: [event({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.2 })],
    driverManifest: {
      run_id: "R", driver_auth: "api_key",
      codex_warnings: ["Defaulting to fallback metadata", { message: "Reconnecting... 1/5" }],
    },
  });
  const out = report(dir).stdout;
  assert.match(out, /! Codex warnings during this run \(2\): Defaulting to fallback metadata \(and 1 more in driver-manifest\.json\)/);
  const seat = makeRun({
    driver: [event({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.2 })],
    driverManifest: { run_id: "R", driver_auth: "chatgpt" },
  });
  const seatOut = report(seat).stdout;
  assert.match(seatOut, /signed in with ChatGPT, so these tokens were not billed per token/);
  assert.match(seatOut, /NOT an amount anyone was billed/);
  assert.match(seatOut, /Modeled \(seat\) total\s+\$0\.2000/);
  const unknown = makeRun({
    driver: [event({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.2 })],
    driverManifest: { run_id: "R", driver_auth: "unknown" },
  });
  assert.doesNotMatch(report(unknown).stdout, /signed in with/);
  assert.match(report(unknown).stdout, /Modeled \(seat\) total/);
});

test("an API-key driver is described as billed per token, not as unbilled seat work", () => {
  const dir = makeRun({
    driver: [event({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.2 })],
    driverManifest: { run_id: "R", driver_auth: "api_key" },
  });
  const out = report(dir).stdout;
  assert.match(out, /signed in with an API key, so OpenAI bills these tokens; this\n {2}figure is computed from the token counts, not read from a bill\./);
  assert.doesNotMatch(out, /NOT an amount anyone was billed|ChatGPT seat/);
  assert.match(out, /^ {2}Modeled total\s+\$0\.2000$/m);
  assert.doesNotMatch(out, /Modeled \(seat\) total/);
  const md = report(dir, ["--markdown"]).stdout;
  assert.match(md, /> The driver signed in with an API key, so OpenAI bills these tokens/);
  assert.doesNotMatch(md, /not\*\* an amount anyone was billed|ChatGPT seat/);
  assert.match(md, /^\| Modeled total \| \$0\.2000 \|$/m);
});

test("a run that stopped before its first priced turn still reports", () => {
  const dir = makeRun({
    telemetry: [],
    driverManifest: { run_id: "R", outcome: "pin_rejected", exit_code: 1, pin_rejection: "[ReasoningEffortParam] invalid_enum_value" },
  });
  const r = report(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No dispatched calls recorded/);
  assert.match(r.stdout, /Outcome:\s+pin_rejected \(exit 1\)/);
  assert.match(r.stdout, /Pin rejected during this run: \[ReasoningEffortParam\]/);
  assert.match(r.stdout, /Run total = dispatched \+ driver\s+not measured/);
});
