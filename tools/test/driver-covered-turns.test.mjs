/**
 * A turn cut off mid-way reports no usage, but codex carries the thread's
 * running total into its next turn: once a later turn on the same thread
 * completes, the incomplete turn's tokens are in the figure, and the cost is
 * complete rather than a floor.
 */
import "./lib/stand-ins.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { driverTurns, parseDriverRecords, summarizeDriverTurns } from "../../plugin/mcp/model-dispatch/dist/driverUsage.js";
import { describeSpend, recordedSpend } from "../../plugin/mcp/model-dispatch/dist/costCap.js";
import { loadPolicyFromPath } from "../../plugin/mcp/model-dispatch/dist/policy.js";
import { modeledDriverCostRows } from "../../plugin/codex/telemetry/event-reader.mjs";
import { buildDriverManifest } from "../../plugin/codex/run-record.mjs";
import { regenerateDriverFiles, runCost } from "../../plugin/codex/run-finalize.mjs";
import { driverLines, main } from "../../plugin/codex/run.mjs";
import { readRun, render, summarize } from "../../plugin/scripts/report.mjs";
import { writeManifest } from "../../plugin/scripts/write-manifest.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex.mjs");
const POLICY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "config", "policies", "gpt-plus-flash.yaml");
const T = "019a0000-0000-7000-8000-0000000000a1";
const T2 = "019a0000-0000-7000-8000-0000000000b2";
const PIN = { model: "gpt-5.6-terra", effort: "high" };
const CARD = { input: 2, input_cached: 0.2, output: 12 };
const U = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 });
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** One record per invocation: `usage` completes its turn, none means it was cut off by SIGTERM. */
function recordsOf(invocations) {
  const lines = [];
  let clock = Date.parse("2026-10-13T10:00:00Z");
  const ts = () => new Date((clock += 1000)).toISOString();
  invocations.forEach((inv, i) => {
    const n = i + 1;
    const thread = inv.thread ?? T;
    const fresh = n === 1 || inv.fresh === true;
    const codex = (event) => lines.push({ v: 1, kind: "codex", invocation: n, thread_id: thread, received_at: ts(), event });
    lines.push({ v: 1, kind: "invocation_start", run_id: "r1", invocation: n, at: ts(), mode: fresh ? "fresh" : "resume", resume_thread_id: fresh ? null : thread, policy: "gpt-plus-flash" });
    codex({ type: "thread.started", thread_id: thread });
    codex({ type: "turn.started" });
    if (inv.usage) codex({ type: "turn.completed", usage: inv.usage });
    lines.push({
      v: 1, kind: "invocation_end", invocation: n, at: ts(), thread_id: thread,
      exit_status: inv.usage ? 0 : 143, signal: inv.usage ? null : "SIGTERM", ended_by: inv.usage ? "exit" : "driver_signal",
      turns: { started: 1, completed: inv.usage ? 1 : 0, failed: 0 },
    });
  });
  return lines;
}

const parsed = (lines) => parseDriverRecords(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const manifestOf = (records) =>
  buildDriverManifest(records, { runId: "r1", policyName: "gpt-plus-flash", pin: PIN, sandbox: "workspace-write", approvalPolicy: "never", pricing: CARD });
const incompleteOf = (turns) => turns.filter((t) => t.status === "incomplete");

test("a killed turn is covered by the next complete turn on its thread, and the driver cost is complete", () => {
  const records = parsed(recordsOf([{ usage: U(1000, 200, 50) }, {}, { usage: U(5000, 1000, 300) }]));
  const turns = driverTurns(records);
  assert.deepEqual(incompleteOf(turns).map((t) => t.covered_by), [{ invocation: 3, turn: 1 }]);
  assert.deepEqual(turns.at(-1).delta, U(4000, 800, 250), "the later delta holds the killed turn's tokens");
  const summary = summarizeDriverTurns(turns, CARD);
  assert.deepEqual([summary.turns_incomplete, summary.turns_incomplete_covered], [1, 1]);
  const m = manifestOf(records);
  assert.deepEqual([m.driver_turns_incomplete, m.driver_turns_incomplete_covered, m.driver_cost_complete], [1, 1, true]);
  const rows = modeledDriverCostRows(records, { runId: "r1", model: PIN.model, policyName: "gpt-plus-flash", pricing: CARD });
  assert.equal(rows.find((r) => r.status === "incomplete").covered_by, "driver-i3-t1");
  assert.equal(rows.filter((r) => r.status === "complete").every((r) => !("covered_by" in r)), true);
});

test("a killed last turn, a dropped total, or another thread leaves the killed turn uncovered", () => {
  for (const [label, invocations] of [
    ["last", [{ usage: U(1000, 200, 50) }, {}]],
    ["cumulative reset", [{ usage: U(1000, 200, 50) }, {}, { usage: U(400, 0, 20) }]],
    ["another thread", [{ usage: U(1000, 200, 50) }, {}, { usage: U(500, 0, 30), thread: T2, fresh: true }]],
  ]) {
    const records = parsed(recordsOf(invocations));
    assert.deepEqual(incompleteOf(driverTurns(records)).map((t) => t.covered_by), [null], label);
    const m = manifestOf(records);
    assert.deepEqual([m.driver_turns_incomplete_covered, m.driver_cost_complete], [0, false], label);
  }
});

test("a zero-usage turn carries nothing yet, so the next real total covers the killed turn", () => {
  const records = parsed(recordsOf([{ usage: U(1000, 200, 50) }, {}, { usage: U(0, 0, 0) }, { usage: U(5000, 1000, 300) }]));
  assert.deepEqual(incompleteOf(driverTurns(records)).map((t) => t.covered_by), [{ invocation: 4, turn: 1 }]);
});

function runFolder(invocations) {
  const runDir = mkdtempSync(join(tmpdir(), "covered-turns-"));
  temps.push(runDir);
  const lines = recordsOf(invocations);
  writeFileSync(join(runDir, "driver-events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  regenerateDriverFiles({
    runDir,
    runId: "r1",
    records: parsed(lines),
    driver: { pricing: CARD, model: PIN.model, policyName: "gpt-plus-flash", pin: PIN, sandbox: "workspace-write", approvalPolicy: "never", auth: "api_key" },
  });
  return runDir;
}

test("the report books a covered turn as priced: an exact figure, not a floor", () => {
  const covered = runFolder([{ usage: U(1000, 200, 50) }, {}, { usage: U(5000, 1000, 300) }]);
  const { driver, totals } = summarize(readRun(covered));
  assert.deepEqual([driver.turns_incomplete, driver.turns_incomplete_unpriced, driver.turns_incomplete_covered, driver.bound], [1, 0, 1, "exact"]);
  assert.equal(totals.driver_bound, "exact");
  assert.match(render(summarize(readRun(covered))), /Incomplete turns.*held in a later running total on the same thread/);
  const cost = runCost(covered);
  assert.equal(cost.driver_turns_incomplete_covered, 1);
  const m = JSON.parse(readFileSync(join(covered, "driver-manifest.json"), "utf-8"));
  const [line] = driverLines(m, null, cost);
  assert.match(line, /\(1 incomplete: in a later turn's running total\), driver cost \(modeled\) \$\d/);

  const last = runFolder([{ usage: U(1000, 200, 50) }, {}]);
  const tail = summarize(readRun(last)).driver;
  assert.deepEqual([tail.turns_incomplete_unpriced, tail.turns_incomplete_covered, tail.bound], [1, 0, "floor"]);
});

test("the cost-cap message does not list a covered turn as left out of the conductor figure", () => {
  const capMessage = (dir) => {
    const telemetry = join(dir, "telemetry.jsonl");
    writeFileSync(telemetry, "");
    const codexHome = mkdtempSync(join(tmpdir(), "covered-cap-home-"));
    temps.push(codexHome);
    return describeSpend(recordedSpend(loadPolicyFromPath(POLICY), telemetry, { codexHome }), telemetry);
  };
  const covered = capMessage(runFolder([{ usage: U(1000, 200, 50) }, {}, { usage: U(5000, 1000, 300) }]));
  assert.match(covered, /\$0\.0118 conductor \(modeled from driver-cost-modeled\.jsonl\)$/);
  assert.doesNotMatch(covered, /not counted/);
  assert.match(capMessage(runFolder([{ usage: U(1000, 200, 50) }, {}])), /not counted: 1 incomplete driver turn\(s\)\)$/);
});

test("with no booking, the closing line and SUMMARY.md read the manifest's covered count", () => {
  const m = { codex_invocations: 3, driver_turns: 3, driver_turns_incomplete: 2, driver_turns_incomplete_covered: 1, driver_cost_complete: false, driver_cost_usd_modeled: 0.01 };
  assert.equal(
    driverLines(m, null, null)[0],
    "invocations 3, turns 3 (2 incomplete: 1 in a later turn's running total; 1 not priced, cost not known, not $0), driver cost (modeled) at least $0.0100",
  );
  const dir = runFolder([{ usage: U(1000, 200, 50) }, {}, { usage: U(5000, 1000, 300) }]);
  const { manifest } = writeManifest({ runDir: dir, runId: "r1", policy: "gpt-plus-flash", projectRoot: dir, summary: true });
  assert.equal(manifest.totals.driver_turns_incomplete, 0);
  assert.equal(manifest.driver.driver_turns_incomplete_covered, 1);
  assert.doesNotMatch(readFileSync(join(dir, "SUMMARY.md"), "utf-8"), /floor/);
});

test("a run killed mid-turn and resumed ends with the full figure, not 'at least'", async () => {
  const root = mkdtempSync(join(tmpdir(), "covered-run-"));
  const work = mkdtempSync(join(tmpdir(), "covered-run-work-"));
  temps.push(root, work);
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const scenarioPath = join(work, "scenario.json");
  const runDir = join(root, ".sdlc", "runs", "r1");
  const env = { ...process.env, CODEX_HOME: mkdtempSync(join(work, "home-")), FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: join(work, "fake.log") };
  const scenario = (steps) => {
    writeFileSync(scenarioPath, JSON.stringify({ runDir, projectRoot: root, steps }));
    try { unlinkSync(`${scenarioPath}.state`); } catch { /* first scenario */ }
  };
  const run = async (argv, signals = new EventEmitter()) => {
    let out = "";
    const code = await main(argv, {
      cwd: root, env, signals, stdin: { isTTY: false },
      spawnFn: (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], opts),
      stdout: { write: (s) => ((out += s), true) },
      stderr: { write: () => true },
    });
    return { code, out };
  };
  const events = () => (existsSync(join(runDir, "driver-events.jsonl")) ? readFileSync(join(runDir, "driver-events.jsonl"), "utf-8") : "");

  scenario([{ usage: U(1000, 200, 50) }, { sleepMs: 6000 }]);
  const signals = new EventEmitter();
  const first = run(["--project-root", root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve"], signals);
  for (let i = 0; i < 400 && !/"invocation":2,[^\n]*"type":"turn.started"/.test(events()); i++) await new Promise((r) => setTimeout(r, 25));
  signals.emit("SIGTERM");
  assert.equal((await first).code, 143);

  scenario([{ gates: [{ gate: 1, decision: "auto-approved" }, { gate: 4, decision: "auto-approved" }], summary: true, usage: U(5000, 1000, 300) }]);
  const resumed = await run(["--project-root", root, "--resume=r1"]);
  assert.equal(resumed.code, 0);
  assert.match(resumed.out, /turns 3 \(1 incomplete: in a later turn's running total\), driver cost \(modeled\) \$\d/);
  assert.doesNotMatch(resumed.out, /at least/);
});
