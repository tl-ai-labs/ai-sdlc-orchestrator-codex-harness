/**
 * The conductor priced and reported through one path, on both routes: run.mjs
 * and end-run.mjs price it from the dated list, collect it from the codex
 * session file at the run end, cross-check it token for token against the
 * exec stream, and write report.md. Offline: a stand-in codex writes the
 * session file a real one would.
 */
import "./lib/stand-ins.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../../plugin/codex/run.mjs";
import { main as startMain } from "../../plugin/codex/start-run.mjs";
import { main as endMain } from "../../plugin/codex/end-run.mjs";
import { REPORT_SCRIPT } from "../../plugin/scripts/report.mjs";
import { SyntheticRollout, u, writeJsonl } from "../../plugin/mcp/model-dispatch/test/fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-codex.mjs");
const THREAD = "01a1340d-41da-7e31-84cd-b0907e9bc31f";
const WORKER = "01a1340d-41da-7e31-84cd-00000000e0e0";

const fakeSpawn = (bin, args, opts) => spawn(process.execPath, [FAKE, ...args], opts);
const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
/** The list's standard card for gpt-5.6-terra: 2.00 / 0.20 / 12.00 per 1M. */
const standard = (x) => ((x.input_tokens - (x.cached_input_tokens ?? 0)) * 2 + (x.cached_input_tokens ?? 0) * 0.2 + x.output_tokens * 12) / 1e6;

function harness() {
  const root = mkdtempSync(join(tmpdir(), "run-cost-"));
  const work = mkdtempSync(join(tmpdir(), "run-cost-work-"));
  const codexHome = mkdtempSync(join(tmpdir(), "run-cost-home-"));
  writeFileSync(join(root, "brief.md"), "# Brief\n");
  const scenarioPath = join(work, "scenario.json");
  const env = { ...process.env, CODEX_HOME: codexHome, FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: join(work, "fake.log") };
  const runDir = join(root, ".sdlc", "runs", "r1");
  return {
    root,
    codexHome,
    runDir,
    scenario(steps) {
      writeFileSync(scenarioPath, JSON.stringify({ runDir, projectRoot: root, steps }));
      try { unlinkSync(`${scenarioPath}.state`); } catch { /* first scenario */ }
    },
    spawned: () => existsSync(join(work, "fake.log")),
    async run(extra = [], deps = {}) {
      let out = "";
      let err = "";
      const code = await main(["--project-root", root, "--run-id=r1", "--mode=greenfield", "--gates=auto-approve", "--codex-bin=fake-codex", ...extra], {
        cwd: root,
        env,
        spawnFn: fakeSpawn,
        stdin: { isTTY: false },
        signals: new EventEmitter(),
        stdout: { write: (s) => ((out += s), true) },
        stderr: { write: (s) => ((err += s), true) },
        ...deps,
      });
      return { code, out, err };
    },
    cleanup() {
      for (const d of [root, work, codexHome]) rmSync(d, { recursive: true, force: true });
    },
  };
}

const GATES_DONE = [{ gate: 1, decision: "auto-approved" }, { gate: 4, decision: "auto-approved" }];
const FIRST = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 };
const SECOND = { input_tokens: 3000, cached_input_tokens: 900, output_tokens: 70, reasoning_output_tokens: 20 };

test("a headless run end books the conductor from its session file, cross-checks it token for token, and writes report.md", async () => {
  const h = harness();
  try {
    // A nested codex-cli worker's session sits in the same codex home; it is never the conductor's.
    const worker = new SyntheticRollout({ threadId: WORKER });
    worker.turn({ responses: [{ usage: u(50_000, 0, 9000) }] });
    worker.write(h.codexHome);
    h.scenario([
      { gates: [{ gate: 1, decision: "auto-approved" }], rollout: [FIRST], telemetry: [{ phase: "senior_code_review", cost_usd: 0.01, provenance: "modeled", codex_thread_id: WORKER }] },
      { gates: GATES_DONE, summary: true, rollout: [SECOND] },
    ]);
    const r = await h.run();
    assert.equal(r.code, 0, r.err);

    const usage = readJson(join(h.runDir, "driver-usage.json"));
    assert.equal(usage.route, "headless");
    assert.deepEqual(usage.thread_ids, [THREAD]);
    assert.equal(usage.cross_check.verdict, "equal");
    assert.equal(usage.verified, true);
    const [thread] = usage.cross_check.threads;
    assert.deepEqual(thread.exec_stream_tokens, thread.session_tokens);
    assert.deepEqual(
      usage.cross_check.invocations.map((i) => [i.invocation, i.status, i.exec_delta.input_tokens, i.session_turn_tokens.input_tokens]),
      [[1, "equal", 1000, 1000], [2, "equal", 3000, 3000]],
    );
    const expected = r6(standard(FIRST) + standard(SECOND));
    assert.equal(usage.cost_usd_modeled, expected);
    assert.equal(usage.price_list_verified, "2026-10-13");

    const dm = readJson(join(h.runDir, "driver-manifest.json"));
    assert.match(dm.driver_cost_source, /^session file \+ exec stream \(every invocation equal\)/);
    assert.equal(dm.driver_verified, true);
    assert.equal(dm.driver_cost_usd_modeled, expected);
    assert.equal(dm.driver_cost_usd_exec_stream, expected, "the exec stream and the session file price the same tokens the same way");
    assert.deepEqual(dm.driver_price.rates, { input: 2, input_cached: 0.2, output: 12 });
    assert.equal(dm.driver_price.basis, "list");
    assert.equal(dm.price_list_verified, "2026-10-13");
    for (const row of readLines(join(h.runDir, "driver-cost-modeled.jsonl"))) {
      assert.deepEqual([row.price_basis, row.price_tier], ["list", "standard"], "each response's size is known from the session file");
    }

    const manifest = readJson(join(h.runDir, "manifest.json"));
    assert.equal(manifest.totals.driver_cost_usd_modeled, expected);
    assert.equal(manifest.totals.driver_cost_source, "driver-usage.json");
    assert.equal(manifest.driver.price_list_verified, "2026-10-13");

    const md = readFileSync(join(h.runDir, "report.md"), "utf-8");
    assert.match(md, /^### Token cross-check: exec stream against the session file$/m);
    assert.ok(md.includes(`| thread \`${THREAD}\` | equal | input | 4000 | 4000 | 0 |`), md);
    assert.ok(md.includes("| invocation 2 | equal | cached input | 900 | 900 | 0 |"), md);
    assert.ok(md.includes("| invocation 1 | equal | reasoning | 10 | 10 | 0 |"), md);
    assert.match(md, /\| Window \| \d{4}-\d{2}-\d{2}T[^|]+ → \d{4}-\d{2}-\d{2}T[^|]+ \(UTC, from driver-manifest\.json\) \|/);
    assert.match(md, /Price: gpt-5\.6-terra 2\.00 \/ 0\.20 \/ 12\.00 per 1M input \/ cached \/ output \(price list, verified 2026-10-13\); over 272,000 input tokens 4\.00 \/ 0\.40 \/ 18\.00/);
    const total = `$${(0.01 + expected).toFixed(4)}`;
    assert.ok(md.includes(`| **Run total = dispatched + driver** | **${total}** |`), md);

    assert.ok(r.out.includes(`Cost report: node '${REPORT_SCRIPT}' '${h.runDir}'`), r.out);
    assert.ok(r.out.includes(`report:      ${join(h.runDir, "report.md")}`), r.out);
    assert.match(r.out, /token cross-check: equal, verified/);
    assert.ok(r.out.includes(`run total (dispatched + driver): ${total}`), r.out);
    const log = readFileSync(join(h.runDir, "orchestrator.log"), "utf-8");
    assert.ok(log.includes(`run.cost run_id=r1 dispatched_usd=0.01 driver_usd_modeled=${expected} driver_bound=exact run_total_usd=${r6(0.01 + expected)} run_total_bound=exact`), log);
  } finally {
    h.cleanup();
  }
});

test("one response over 272,000 input tokens bills the long-context card for that response alone", async () => {
  const h = harness();
  try {
    const long = { input_tokens: 300_000, output_tokens: 100 };
    const short = { input_tokens: 10_000, output_tokens: 50 };
    h.scenario([{ gates: GATES_DONE, summary: true, rollout: [long, short] }]);
    assert.equal((await h.run()).code, 0);
    const [row] = readLines(join(h.runDir, "driver-cost-modeled.jsonl"));
    assert.deepEqual([row.price_tier, row.long_context_requests], ["long_context", 1]);
    // 300,000 in at $4.00/M and 100 out at $18.00/M, then 10,000 in at $2.00/M and 50 out at $12.00/M.
    const expected = r6((300_000 * 4 + 100 * 18 + 10_000 * 2 + 50 * 12) / 1e6);
    assert.equal(row.cost_usd, expected);
    const usage = readJson(join(h.runDir, "driver-usage.json"));
    assert.equal(usage.cost_usd_modeled, expected);
    assert.equal(usage.cross_check.exec_stream_cost_usd, expected, "the exec stream's own figure is priced with the same response sizes");
    assert.equal(readJson(join(h.runDir, "driver-manifest.json")).driver_cost_usd_exec_stream, expected);
  } finally {
    h.cleanup();
  }
});

test("with no session file, a summed turn above the threshold is billed standard, labelled tier unverified, and the run total is a floor", async () => {
  const h = harness();
  try {
    const summed = { input_tokens: 310_000, cached_input_tokens: 0, output_tokens: 150, reasoning_output_tokens: 0 };
    h.scenario([{ gates: GATES_DONE, summary: true, usage: summed }]);
    const r = await h.run();
    assert.equal(r.code, 0, r.err);
    const [row] = readLines(join(h.runDir, "driver-cost-modeled.jsonl"));
    assert.deepEqual([row.price_tier, row.cost_usd], ["unverified", r6(standard(summed))]);
    const usage = readJson(join(h.runDir, "driver-usage.json"));
    assert.equal(usage.source, "exec-stream");
    assert.equal(usage.tier_unverified_turns, 1);
    assert.match(usage.cost_source, /TIER UNVERIFIED: 1 turn\(s\)/);
    const md = readFileSync(join(h.runDir, "report.md"), "utf-8");
    assert.match(md, /\*\*Run total = dispatched \+ driver\*\* \| \*\*at least \$0\.6218\*\*/);
    assert.match(md, /1 driver turn summed more than a long-context threshold of input with no per-response sizes/);
    assert.match(r.out, /run total \(dispatched \+ driver\): at least \$0\.6218/);
  } finally {
    h.cleanup();
  }
});

test("a resume of a thread no run folder records subtracts the session file's earlier total, not the whole running total", async () => {
  const h = harness();
  try {
    const earlier = new SyntheticRollout({ threadId: THREAD, start: "2026-10-13T08:00:00.000Z" });
    earlier.turn({ responses: [{ usage: u(50_000, 10_000, 500) }] });
    earlier.write(h.codexHome);
    h.scenario([{ gates: GATES_DONE, summary: true, rollout: [FIRST] }]);
    const r = await h.run([`--resume=${THREAD}`]);
    assert.equal(r.code, 0, r.err);
    const [row] = readLines(join(h.runDir, "driver-cost-modeled.jsonl"));
    assert.equal(row.driver_flags, undefined, "the session file gives the baseline, so the turn is not flagged baseline_unknown");
    assert.equal(row.input_tokens, FIRST.input_tokens - FIRST.cached_input_tokens);
    assert.equal(row.cost_usd, r6(standard(FIRST)));
    const usage = readJson(join(h.runDir, "driver-usage.json"));
    assert.equal(usage.cross_check.exec_stream_baseline[THREAD], "session-file");
    assert.equal(usage.cross_check.verdict, "equal");
    assert.equal(usage.cost_usd_modeled, row.cost_usd);
  } finally {
    h.cleanup();
  }
});

test("a day the price list does not cover refuses the run before codex starts; --dry-run shows the price it would use", async () => {
  const h = harness();
  try {
    h.scenario([{ gates: GATES_DONE, summary: true }]);
    const early = await h.run([], { now: () => Date.parse("2026-08-01T00:00:00Z") });
    assert.equal(early.code, 2);
    assert.match(early.err, /the conductor's model cannot be priced, so its cost could not be modeled or capped: no price for gpt-5\.6-terra on 2026-08-01/);
    assert.equal(h.spawned(), false, "nothing was spent");
    const dry = await h.run(["--dry-run"]);
    assert.equal(dry.code, 0, dry.err);
    const plan = JSON.parse(dry.out);
    assert.deepEqual([plan.driver_price.model, plan.driver_price.basis, plan.driver_price.rates], ["gpt-5.6-terra", "list", { input: 2, input_cached: 0.2, output: 12 }]);
  } finally {
    h.cleanup();
  }
});

const SESSION_THREAD = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
const NOW = Date.parse("2026-10-13T10:15:00Z");

test("an interactive run end reads the conductor's session, leaves out a worker thread, and writes report.md", async () => {
  const base = mkdtempSync(join(tmpdir(), "interactive-cost-"));
  try {
    const root = join(base, "app");
    const home = join(base, "home");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "brief.md"), "# Brief\n");
    const conductor = new SyntheticRollout({ threadId: SESSION_THREAD, originator: "codex-tui", source: "vscode", start: "2026-10-13T10:14:58.000Z" });
    const command = conductor.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(10_000, 8000, 100) }] });
    const gate = conductor.turn({ text: "approve", responses: [{ usage: u(20_000, 18_000, 200) }] });
    conductor.write(home);
    const worker = new SyntheticRollout({ threadId: WORKER, start: "2026-10-13T10:15:00.020Z" });
    worker.turn({ responses: [{ usage: u(900_000, 0, 9000) }] });
    worker.write(home);

    const env = { CODEX_HOME: home, CODEX_THREAD_ID: SESSION_THREAD };
    const sink = () => { let text = ""; return { write: (s) => ((text += s), true), get text() { return text; } }; };
    const startOut = sink();
    const started = await startMain(["--mode=greenfield", "--run-id=r1"], {
      cwd: root, env, now: () => NOW, rand: () => "abc123", isGitRepo: () => true, gitToplevel: () => null, stdout: startOut, stderr: sink(),
    });
    assert.equal(started, 0, startOut.text);
    const runDir = join(root, ".sdlc", "runs", "r1");
    const markers = readLines(join(runDir, "driver-session.jsonl"));
    assert.deepEqual(markers.map((m) => [m.tool, m.thread_id, m.ts]), [["start_run", SESSION_THREAD, new Date(NOW).toISOString()]]);

    // A marker in the worker's thread (a nested exec inherits nothing of the conductor's, but a stray one must not count).
    writeJsonl(join(runDir, "driver-session.jsonl"), [...markers, { ts: new Date(Date.parse(gate.started_at) + 1).toISOString(), thread_id: WORKER, tool: "execute_with_model", policy: null, pid: 1 }]);
    writeJsonl(join(runDir, "telemetry.jsonl"), [{ phase: "codegen", cost_usd: 0.02, provenance: "modeled", codex_thread_id: WORKER }]);

    const out = sink();
    const code = await endMain([`--run-dir=${runDir}`, "--outcome=stopped", "--reason=stopped at gate 1"], { cwd: root, env, now: () => NOW + 60_000, stdout: out, stderr: sink() });
    assert.equal(code, 0, out.text);

    const usage = readJson(join(runDir, "driver-usage.json"));
    assert.equal(usage.route, "interactive");
    assert.deepEqual(usage.thread_ids, [SESSION_THREAD]);
    assert.deepEqual(usage.excluded_threads.map((e) => e.thread_id), [WORKER]);
    assert.match(usage.excluded_threads[0].reason, /codex-cli dispatch of this run ran in it/);
    assert.deepEqual(usage.turns.map((t) => t.turn_id), [command.id, gate.id], "the window opens at the command turn the start marker sits in");
    assert.equal(usage.cost_usd_modeled, r6(standard(u(10_000, 8000, 100)) + standard(u(20_000, 18_000, 200))));
    assert.equal(readLines(join(runDir, "driver-session.jsonl")).at(-1).tool, "collect_driver_usage", "the end step marks the closing turn");

    assert.ok(existsSync(join(runDir, "report.md")));
    assert.match(out.text, /driver cost \(modeled\): \$0\.\d{4}, session file \(interactive/);
    assert.match(out.text, /run total \(dispatched \+ driver\): /);
    assert.ok(out.text.includes(`report:      ${join(runDir, "report.md")}`), out.text);
    assert.match(readFileSync(join(runDir, "orchestrator.log"), "utf-8"), /run\.cost run_id=r1 route=interactive dispatched_usd=0\.02 /);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

