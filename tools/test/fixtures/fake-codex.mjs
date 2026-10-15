/**
 * A stand-in for `codex` in the driver tests. Each `codex exec` call plays
 * the next step of the scenario named by FAKE_CODEX_SCENARIO and logs its
 * argv to FAKE_CODEX_LOG. `codex login status` prints FAKE_CODEX_AUTH.
 *
 * Step keys: fixture (a codex-0.160.1 capture to replay), events (raw lines
 * after thread.started), usage, message, failTurn, noThread, thread, stderr,
 * gates, summary (Phase 9's write-manifest.mjs; summaryStatus is its
 * --status, by default the one an accepting Gate 4 line in the same step
 * calls for, null for none), handSummary (a SUMMARY.md written by hand),
 * preflight, stop, question, guardDeny, telemetry, blockManifest (a
 * directory where manifest.json goes), freeze (Gate 0's write-contract.mjs
 * --freeze, given {allowlist}), close (close-out's --close, after this
 * step's gates), sleepMs (after turn.started, or after turn.completed with
 * sleepAfterTurn), ignoreTerm, exit, rollout (the turn's per-response usages,
 * written to the thread's session file under CODEX_HOME as codex 0.160.1
 * writes it; turn.completed then reports the thread's running total).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeManifest } from "../../../plugin/scripts/write-manifest.mjs";
import { closeContract, freezeContract } from "../../../plugin/scripts/write-contract.mjs";

const argv = process.argv.slice(2);
const env = process.env;

if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write(`${env.FAKE_CODEX_AUTH ?? "Logged in using ChatGPT"}\n`);
  process.exit(0);
}

const scenario = JSON.parse(readFileSync(env.FAKE_CODEX_SCENARIO, "utf-8"));
const statePath = `${env.FAKE_CODEX_SCENARIO}.state`;
const n = (existsSync(statePath) ? Number(readFileSync(statePath, "utf-8")) : 0) + 1;
writeFileSync(statePath, String(n));
const step = scenario.steps?.[n - 1] ?? scenario.default ?? {};
const log = (entry) => appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify({ n, pid: process.pid, ...entry }) + "\n");
log({ argv, cwd: process.cwd() });

process.on("SIGTERM", () => {
  log({ signal: "SIGTERM" });
  if (!step.ignoreTerm) process.exit(143);
});
process.on("SIGHUP", () => {
  log({ signal: "SIGHUP" });
  process.exit(129);
});

const out = (ev) => process.stdout.write((typeof ev === "string" ? ev : JSON.stringify(ev)) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runDir = scenario.runDir;
const append = (path, line) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + "\n");
};

/** What a conductor that follows the playbook passes to Phase 9's re-run after Gate 4. */
function gate4Status(gates = []) {
  const g4 = gates.filter((g) => /4/.test(String(g.gate)) && /^(accept|accepted|approved|auto-approved)$/i.test(g.decision ?? g.status ?? "")).at(-1);
  if (!g4) return undefined;
  return /^auto-approved$/i.test(g4.decision ?? g4.status) ? "auto-approved" : "accepted";
}

function runIdOfThisRun() {
  const start = readFileSync(join(runDir, "driver-events.jsonl"), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((r) => r.kind === "invocation_start");
  return start?.run_id ?? basename(runDir);
}

function writeFiles() {
  if (step.freeze) freezeContract({ projectRoot: scenario.projectRoot, runId: runIdOfThisRun(), allowlist: step.freeze.allowlist ?? ["src/**"] });
  for (const g of step.gates ?? []) append(join(runDir, "gates.jsonl"), g);
  if (step.close) closeContract({ projectRoot: scenario.projectRoot, runId: runIdOfThisRun() });
  for (const t of step.telemetry ?? []) append(join(runDir, "telemetry.jsonl"), t);
  if (step.preflight) writeFileSync(join(runDir, "preflight.json"), JSON.stringify(step.preflight));
  if (step.stop) writeFileSync(join(runDir, "stop.json"), JSON.stringify(step.stop));
  if (step.question) writeFileSync(join(runDir, "question.json"), JSON.stringify({ question: step.question }));
  if (step.summary) {
    const start = readFileSync(join(runDir, "driver-events.jsonl"), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((r) => r.kind === "invocation_start");
    writeManifest({
      runDir,
      runId: start?.run_id ?? basename(runDir),
      policy: start?.policy ?? "gpt-plus-flash",
      projectRoot: scenario.projectRoot,
      codeDir: start?.code_dir,
      status: step.summaryStatus === undefined ? gate4Status(step.gates) : (step.summaryStatus ?? undefined),
      summary: true,
    });
  }
  if (step.handSummary) writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
  if (step.blockManifest) mkdirSync(join(runDir, "manifest.json"), { recursive: true });
  if (step.guardDeny) {
    append(join(scenario.projectRoot, ".sdlc", "local", "guard-decisions.jsonl"), {
      ts: new Date().toISOString(),
      decision: "deny",
      ...step.guardDeny,
    });
  }
}

const thread = step.thread ?? scenario.thread ?? "01a1340d-41da-7e31-84cd-b0907e9bc31f";

const BUCKETS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const usageOf = (u = {}) => Object.fromEntries(BUCKETS.map((k) => [k, u[k] ?? 0]));

/** Appends this turn to the thread's session file and returns the thread's running total after it. */
function writeRollout(responses) {
  const dir = join(env.CODEX_HOME, "sessions", "2026", "10", "13");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-13T10-00-00-${thread}.jsonl`);
  const earlier = existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
  let total = usageOf(earlier.filter((l) => l.payload?.type === "token_count").at(-1)?.payload.info.total_token_usage);
  const model = argv[argv.indexOf("-m") + 1];
  const effort = /^model_reasoning_effort="(.*)"$/.exec(argv.find((a) => a.startsWith("model_reasoning_effort=")) ?? "")?.[1] ?? null;
  const lines = [];
  const push = (type, payload) => lines.push({ timestamp: new Date().toISOString(), type, payload });
  if (earlier.length === 0) push("session_meta", { id: thread, originator: "codex_exec", source: "exec", cli_version: "0.160.1", model_provider: "openai" });
  const turnId = `turn-${n}-${thread.slice(0, 8)}`;
  push("event_msg", { type: "task_started", turn_id: turnId });
  push("turn_context", { turn_id: turnId, model, effort });
  responses.forEach((r, i) => {
    const usage = usageOf(r);
    push("token_usage_record", { thread_id: thread, turn_id: turnId, response_id: `resp-${n}-${i}`, usage });
    total = Object.fromEntries(BUCKETS.map((k) => [k, total[k] + usage[k]]));
    push("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: usage } });
  });
  push("event_msg", { type: "task_complete", turn_id: turnId });
  appendFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return total;
}

if (step.fixture) {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "codex-0.160.1");
  writeFiles();
  for (const line of readFileSync(join(fixtures, `${step.fixture}.jsonl`), "utf-8").split("\n")) {
    if (line.trim()) out(line);
  }
} else {
  if (!step.noThread) out({ type: "thread.started", thread_id: thread });
  for (const ev of step.events ?? []) out(ev);
  out({ type: "turn.started" });
  if (step.sleepMs && !step.sleepAfterTurn) await sleep(step.sleepMs);
  if (step.stderr) process.stderr.write(step.stderr);
  writeFiles();
  if (step.failTurn) {
    out({ type: "turn.failed", error: { message: step.failTurn } });
  } else {
    out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: step.message ?? "ok" } });
    const total = step.rollout ? writeRollout(step.rollout) : null;
    out({ type: "turn.completed", usage: step.usage ?? total ?? { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 } });
  }
  if (step.sleepMs && step.sleepAfterTurn) await sleep(step.sleepMs);
}
if (step.fixture && step.stderr) process.stderr.write(step.stderr);
process.exitCode = step.exit ?? 0;
