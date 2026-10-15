/**
 * The agent door end to end through the real AntigravityWorkerAdapter, with
 * GEMINI_WORKER_PYTHON pointed at a stub interpreter (a node script) that
 * writes the usage sidecar the way gemini_worker.py does. No Python, no SDK,
 * no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";

const LEAF = {
  id: "flash-agsdk-worker",
  adapter: "antigravity-worker",
  model_name: "gemini-3.7-flash",
  pricing: { input: 0.75, input_cached: 0.075, output: 3.75 },
  worker_timeout_sec: 30,
};

const PACKET = {
  id: "tp_agent_1",
  phase: "codegen",
  task_type: "implement",
  module: "core",
  instruction: "Write hello.txt.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
  pass_id: "agent-pass",
};

const clock = () => new Date("2026-10-13T12:00:00Z");

/** Behaviour is chosen by STUB_MODE, read from the environment the adapter passes down. */
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const usageFile = a[a.indexOf("--usage-file") + 1];
const mode = process.env.STUB_MODE || "ok";
const usage = JSON.parse(process.env.STUB_USAGE || "null");
const sidecar = (extra) => fs.writeFileSync(usageFile, JSON.stringify({
  sdk: "google-antigravity", sdk_version: process.env.STUB_SDK || "0.1.16", usage, tool_call_count: 0, tool_calls: [], ...extra,
}));
if (mode === "ok") { sidecar({ status: "ok" }); process.stdout.write('{"ok":true}\\n'); }
else if (mode === "timeout-with-usage") { sidecar({ status: "timeout", error_type: "TimeoutError", usage_source: "conversation.total_usage" }); process.stderr.write("gemini_worker failed: timeout\\n"); process.exit(1); }
else if (mode === "timeout-no-usage") { sidecar({ status: "timeout", error_type: "TimeoutError", usage: null }); process.exit(1); }
else if (mode === "pre-session") { process.stderr.write("gemini_worker: no Vertex project\\n"); process.exit(1); }
else if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "hang-tree") {
  // A tool command the agent started: same process group, keeps running unless the group is killed.
  require("child_process").spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.env.STUB_PIDS + '.child', String(process.pid)); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.STUB_PIDS + ".worker", String(process.pid));
  setInterval(() => {}, 1000);
}
`;

function withStub(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-worker-adapter-"));
    const stub = join(dir, "python");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const workdir = join(dir, "work");
    const keys = ["GEMINI_WORKER_PYTHON", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "STUB_MODE", "STUB_USAGE", "STUB_SDK", "STUB_PIDS"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.GEMINI_WORKER_PYTHON = stub;
    process.env.GOOGLE_CLOUD_PROJECT = "unit-test-project";
    delete process.env.GOOGLE_CLOUD_LOCATION;
    try {
      mkdirSync(workdir);
      await fn({ dir, workdir, telemetry: join(dir, "run", "telemetry.jsonl") });
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const SDK_0116_USAGE = {
  prompt_token_count: 39439,
  cached_content_token_count: 128714,
  candidates_token_count: 4240,
  thoughts_token_count: 0,
};

test("a 0.1.16 sidecar bills its fresh input on top of the cached count", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "ok";
  process.env.STUB_USAGE = JSON.stringify(SDK_0116_USAGE);
  const adapter = new AntigravityWorkerAdapter(LEAF, { clock });
  const out = await adapter.execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.equal(out.success, true);
  assert.equal(out.tokens.input, 39439);
  assert.equal(out.tokens.input_cached, 128714);
  assert.equal(out.cost_usd, 0.055133);
  assert.equal(out.attempts[0].cost_provenance, undefined, "a sidecar with usage is the vendor's count");
}));

test("an unchecked SDK version still bills the larger reading", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "ok";
  process.env.STUB_SDK = "0.1.18";
  process.env.STUB_USAGE = JSON.stringify(SDK_0116_USAGE);
  const out = await new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, {
    work_dir: workdir,
    telemetry_path: telemetry,
  });
  assert.equal(out.tokens.input, 39439);
  const record = JSON.parse(readFileSync(join(telemetry, "..", "delegation", "worker-delegation-tp_agent_1.json"), "utf8"));
  assert.ok(record, "the delegation record is still written");
  assert.ok(existsSync(join(telemetry, "..", "delegation", "worker-usage-tp_agent_1.json")));
}));

// ── failed sessions ───────────────────────────────────────────────────

test("a session that timed out but recorded its usage is billed that usage, as the vendor's count", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "timeout-with-usage";
  process.env.STUB_USAGE = JSON.stringify({ prompt_token_count: 20000, cached_content_token_count: 0, candidates_token_count: 300, thoughts_token_count: 0 });
  const out = await new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.equal(out.success, false);
  assert.equal(out.tokens.input, 20000);
  assert.equal(out.cost_usd, (20000 * 0.75 + 300 * 3.75) / 1e6);
  assert.equal(out.attempts[0].cost_provenance, undefined);
  assert.equal(out.attempts[0].usage_complete, undefined);
}));

test("a session that failed with no readable usage is booked as an estimated lower bound", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "timeout-no-usage";
  const out = await new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.equal(out.success, false);
  assert.ok(out.cost_usd > 0, "a session that ran is never a vendor-metered $0");
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false);
  assert.equal(out.cost_provenance, "estimated");
  assert.match(out.error, /usage unknown/);
}));

test("a worker that fails before its session books $0 with no label", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "pre-session";
  const out = await new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.equal(out.success, false);
  assert.equal(out.cost_usd, 0);
  assert.equal(out.attempts[0].cost_provenance, undefined);
  assert.equal(out.attempts[0].usage_complete, undefined);
  assert.match(out.error, /no Vertex project/);
}));

test("a worker killed at the deadline is booked as an estimated lower bound", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "hang";
  const adapter = new AntigravityWorkerAdapter({ ...LEAF, worker_timeout_sec: 1 }, { clock, killGraceSec: 0 });
  const out = await adapter.execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.equal(out.success, false);
  assert.match(out.error, /killed after 1s/);
  assert.ok(out.cost_usd > 0);
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false);
}));

test("a repeat of a packet id that fails before its session is not billed the earlier session's sidecar", withStub(async ({ workdir, telemetry }) => {
  process.env.STUB_MODE = "ok";
  process.env.STUB_USAGE = JSON.stringify(SDK_0116_USAGE);
  const first = await new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.ok(first.cost_usd > 0);
  process.env.STUB_MODE = "pre-session";
  const second = await new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, { work_dir: workdir, telemetry_path: telemetry });
  assert.equal(second.success, false);
  assert.equal(second.cost_usd, 0, "the sidecar on disk belonged to the first dispatch");
  assert.equal(second.attempts[0].cost_provenance, undefined);
  assert.equal(existsSync(join(telemetry, "..", "delegation", "worker-usage-tp_agent_1.json")), false);
}));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return check();
}

test("aborting the dispatch kills the worker's whole process group and books a floor", withStub(async ({ dir, workdir, telemetry }) => {
  process.env.STUB_MODE = "hang-tree";
  process.env.STUB_PIDS = join(dir, "pids");
  const stop = new AbortController();
  const pending = new AntigravityWorkerAdapter(LEAF, { clock }).execute(PACKET, undefined, {
    work_dir: workdir,
    telemetry_path: telemetry,
    signal: stop.signal,
  });
  assert.ok(await waitFor(() => existsSync(`${process.env.STUB_PIDS}.child`) && existsSync(`${process.env.STUB_PIDS}.worker`)));
  const worker = Number(readFileSync(`${process.env.STUB_PIDS}.worker`, "utf8"));
  const child = Number(readFileSync(`${process.env.STUB_PIDS}.child`, "utf8"));
  stop.abort();
  const out = await pending;
  assert.equal(out.success, false);
  assert.match(out.error, /abandoned/);
  assert.ok(out.cost_usd > 0, "a session that was running is never a $0");
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false);
  assert.ok(await waitFor(() => !alive(worker) && !alive(child), 2000), "a process in the worker's group outlived the abort");
}));
