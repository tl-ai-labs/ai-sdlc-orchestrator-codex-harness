/**
 * The report against driver-usage.json files whose interactive conductor
 * shares a thread with another run, or left this run's turns in a thread
 * run.json never started: every left-out thread is named, and dropped
 * conductor turns make the run total a floor.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main, readRun, summarize } from "../../plugin/scripts/report.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(REPO_ROOT, "plugin", "mcp", "model-dispatch");
const { measureDriverUsage } = await import(join(SERVER, "dist", "sessionUsage.js"));
const { loadPolicyFromPath } = await import(join(SERVER, "dist", "policy.js"));
const { SyntheticRollout, inside, marker, u, writeJsonl } = await import(join(SERVER, "test", "fixtures", "syntheticRollout.mjs"));
const POLICY = loadPolicyFromPath(join(REPO_ROOT, "plugin", "config", "policies", "gpt-plus-flash.yaml"));
const CONDUCTOR = "01a2000e-0000-7000-8000-0000000000c1";
const ELSEWHERE = "01a2000e-0000-7000-8000-0000000000c2";
const WORKER = "01a2000e-0000-7000-8000-0000000000e1";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function project(...ids) {
  const root = mkdtempSync(join(tmpdir(), "report-excluded-"));
  dirs.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const runs = ids.map((id) => {
    const dir = join(root, "p", ".sdlc", "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { home, runs };
}

function collect(run, home) {
  const m = measureDriverUsage({ runDir: run, policy: POLICY, codexHome: home });
  assert.equal(m.ok, true, m.message);
  writeFileSync(join(run, "driver-usage.json"), JSON.stringify(m.report, null, 2) + "\n");
  return m.report;
}

function report(dir, args = []) {
  const out = [];
  const status = main([dir, ...args], { out: (s) => out.push(s), err: () => {} }, "report.mjs");
  assert.equal(status, 0);
  return out.join("\n");
}

test("conductor turns in a thread run.json never started are named, and the run total is a floor", () => {
  const { home, runs: [run] } = project("r1");
  const c = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui" });
  const c1 = c.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(10_000) }] });
  c.write(home);
  const e = new SyntheticRollout({ threadId: ELSEWHERE, originator: "codex-tui", start: "2026-10-13T11:00:00.000Z" });
  const e1 = e.turn({ text: "carry on", responses: [{ usage: u(90_000) }] });
  e.write(home);
  const w = new SyntheticRollout({ threadId: WORKER });
  const w1 = w.turn({ responses: [{ usage: u(5000) }] });
  w.write(home);
  writeFileSync(join(run, "run.json"), JSON.stringify({ route: "interactive", starts: [{ codex_thread_id: CONDUCTOR }] }));
  writeJsonl(join(run, "telemetry.jsonl"), [{ phase: "codegen", cost_usd: 0, provenance: "modeled", codex_thread_id: WORKER }]);
  writeJsonl(join(run, "driver-session.jsonl"), [
    marker(CONDUCTOR, inside(c1), "start_run"),
    marker(ELSEWHERE, inside(e1)),
    marker(WORKER, inside(w1)),
  ]);
  collect(run, home);

  const out = report(run);
  const flat = out.replace(/\s+/g, " ");
  assert.ok(
    flat.includes(`Left out ${ELSEWHERE} (run.json records no start of this run in it); ${WORKER} (a codex-cli dispatch of this run ran in it`),
    flat,
  );
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.0200/);
  assert.match(out, new RegExp(`This run's turns in 1 conductor thread \\(${ELSEWHERE}\\) are left out, as run\\.json records no start of this run there, so the run cost is at least this\\.`));
  const md = report(run, ["--markdown"]);
  assert.ok(md.includes(`- Left out: \`${ELSEWHERE}\` (run.json records no start of this run in it); \`${WORKER}\` (a codex-cli dispatch`), md);

  const summary = summarize(readRun(run));
  assert.deepEqual(
    summary.driver.excluded_threads.map((x) => [x.thread_id, x.conductor_turns_left_out]),
    [[ELSEWHERE, true], [WORKER, false]],
  );
  assert.equal(summary.totals.run_total_bound, "floor");
});

test("a left-out worker thread alone keeps the total exact", () => {
  const { home, runs: [run] } = project("r1");
  const c = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui" });
  const c1 = c.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(10_000) }] });
  c.write(home);
  writeJsonl(join(run, "telemetry.jsonl"), [{ phase: "codegen", cost_usd: 0, provenance: "modeled", codex_thread_id: WORKER }]);
  writeJsonl(join(run, "driver-session.jsonl"), [marker(CONDUCTOR, inside(c1), "start_run"), marker(WORKER, inside(c1, 2))]);
  collect(run, home);
  const out = report(run);
  assert.match(out, /Left out\s+01a2000e-0000-7000-8000-0000000000e1/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.0200/);
  assert.doesNotMatch(out, /at least/);
});

test("a window that skips another run's turns says how many it left out", () => {
  const { home, runs: [a, b] } = project("run-a", "run-b");
  const r = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui" });
  const a1 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
  const b1 = r.turn({ text: "$mmo-codex:docs", responses: [{ usage: u(50_000) }] });
  const a2 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(2000) }] });
  r.write(home);
  writeJsonl(join(a, "driver-session.jsonl"), [marker(CONDUCTOR, inside(a1), "start_run"), marker(CONDUCTOR, inside(a2), "start_run")]);
  writeJsonl(join(b, "driver-session.jsonl"), [marker(CONDUCTOR, inside(b1), "start_run")]);
  assert.equal(collect(a, home).tokens.input_tokens, 3000);
  const out = report(a);
  assert.match(out, /Window\s+\S+ → \S+ \(1 turn inside it is another run's or no run's, and not counted\)/);
  assert.match(out, /Modeled cost\s+\$0\.0060/);
});
