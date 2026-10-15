/**
 * Writes the run folders under fixtures/report/driver-usage/ that
 * report-driver-usage.test.mjs reads: synthetic rollouts measured by the
 * collector's own measureDriverUsage, one folder per case. Run it after a
 * change to the driver-usage.json shape, with the bridge built:
 *
 *   node tools/test/fixtures/report/driver-usage-gen.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const OUT = join(WT, "tools", "test", "fixtures", "report", "driver-usage");
const { measureDriverUsage } = await import(join(WT, "plugin/mcp/model-dispatch/dist/sessionUsage.js"));
const { SyntheticRollout, driverEventLines, inside, marker, u, writeJsonl } = await import(join(WT, "plugin/mcp/model-dispatch/test/fixtures/syntheticRollout.mjs"));
const { loadPolicyFromPath } = await import(join(WT, "plugin/mcp/model-dispatch/dist/policy.js"));
const POLICY = loadPolicyFromPath(join(WT, "plugin/config/policies/gpt-plus-flash.yaml"));
const T1 = "019a0000-0000-7000-8000-0000000000a1";
const T2 = "019a0000-0000-7000-8000-0000000000a2";

const telemetry = (pass) => [{
  ts: "2026-10-13T10:00:30.000Z", pass, phase: "codegen", task_type: "x", task_id: "t1",
  model: "gemini-3.7-flash", provenance: "vendor", routing: { policy_name: "gpt-plus-flash" },
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.05, success: true,
}];

function scenario(name, build, measureOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "driver-usage-gen-"));
  const home = join(root, "home");
  const run = join(OUT, name);
  rmSync(run, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  build({ home, run });
  const m = measureDriverUsage({ runDir: run, policy: POLICY, codexHome: home, ...measureOpts });
  if (!m.ok) throw new Error(`${name}: ${m.message}`);
  const report = { ...m.report, collected_at: "2026-10-13T11:00:00.000Z" };
  writeFileSync(join(run, "driver-usage.json"), JSON.stringify(report, null, 2) + "\n");
  writeJsonl(join(run, "telemetry.jsonl"), telemetry(name));
  rmSync(root, { recursive: true, force: true });
  console.log(name, report.source, report.cost_usd_modeled, report.cost_complete, report.cross_check?.verdict ?? null, "|", report.cost_source);
}

const events = (run, threadId, invs) => writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(threadId, invs, { runId: "fixture" }));

scenario("headless-equal", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(40000, 30000, 2000, 500) }] });
  const b = r.turn({ responses: [{ usage: u(60000, 50000, 3000, 800) }] });
  r.write(home);
  events(run, T1, [{ turn: a }, { turn: b }]);
});

scenario("headless-killed-last", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(40000, 30000, 2000, 500) }] });
  const b = r.turn({ responses: [{ usage: u(50000, 40000, 2500) }, { usage: u(52000, 50000, 1500) }], end: "aborted" });
  r.write(home);
  events(run, T1, [{ turn: a }, { turn: b, incomplete: true }]);
});

scenario("headless-mismatch", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(40000, 30000, 2000) }] });
  const b = r.turn({ responses: [{ usage: u(60000, 50000, 3000) }] });
  r.write(home);
  events(run, T1, [{ turn: a }, { turn: b, usage: { ...b.cumulative, output_tokens: 4000 } }]);
});

scenario("headless-compaction", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(40000, 30000, 2000) }] });
  const b = r.turn({ responses: [{ usage: u(30000, 25000, 1000) }, { usage: u(8000, 0, 600), compaction: true }, { usage: u(30000, 25000, 2000) }] });
  r.write(home);
  events(run, T1, [{ turn: a }, { turn: b }]);
});

// The exec stream reports invocation 2's running total 500 input tokens low; invocation 3's total is right again.
scenario("headless-skew-cancels", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
  const b = r.turn({ responses: [{ usage: u(3000, 900, 70) }] });
  const c = r.turn({ responses: [{ usage: u(5000, 2000, 90) }] });
  r.write(home);
  events(run, T1, [{ turn: a }, { turn: b, usage: { ...b.cumulative, input_tokens: b.cumulative.input_tokens - 500 } }, { turn: c }]);
});

// The same 500 missing from invocation 2 on, so invocation 3's own share is right.
scenario("headless-skew-carries", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
  const b = r.turn({ responses: [{ usage: u(3000, 900, 70) }] });
  const c = r.turn({ responses: [{ usage: u(5000, 2000, 90) }] });
  r.write(home);
  const low = (t) => ({ ...t.cumulative, input_tokens: t.cumulative.input_tokens - 500 });
  events(run, T1, [{ turn: a }, { turn: b, usage: low(b) }, { turn: c, usage: low(c) }]);
});

scenario("headless-no-session-resume", ({ run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  r.turn({ responses: [{ usage: u(40000, 30000, 2000) }] });
  const b = r.turn({ responses: [{ usage: u(60000, 50000, 3000) }] });
  const c = r.turn({ responses: [{ usage: u(10000, 5000, 500) }] });
  events(run, T1, [{ turn: b, mode: "resume" }, { turn: c }]);
});

scenario("headless-no-session-killed", ({ run }) => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ responses: [{ usage: u(40000, 30000, 2000) }] });
  const b = r.turn({ responses: [{ usage: u(60000, 50000, 3000) }], end: null });
  events(run, T1, [{ turn: a }, { turn: b, incomplete: true }]);
});

scenario("interactive-lower-bound-unread", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui", source: "vscode" });
  const a = r.turn({ text: "approve", responses: [{ usage: u(50000, 40000, 1500) }] });
  const b = r.turn({ text: "approve", responses: [{ usage: u(50000, 10000, 1500) }] });
  r.write(home);
  writeJsonl(join(run, "driver-session.jsonl"), [marker(T1, inside(a)), marker(T1, inside(b)), marker(T2, inside(b))]);
}, { threadIds: [T2] });

scenario("interactive-unpriced", ({ home, run }) => {
  const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui", source: "vscode" });
  const a = r.turn({ text: "$mmo-codex:brownfield", model: "gpt-6.1-sol", responses: [{ usage: u(5000, 4000, 50) }] });
  const b = r.turn({ text: "approve", responses: [{ usage: u(20000, 10000, 1000) }] });
  r.write(home);
  writeJsonl(join(run, "driver-session.jsonl"), [marker(T1, inside(a)), marker(T1, inside(b))]);
});
