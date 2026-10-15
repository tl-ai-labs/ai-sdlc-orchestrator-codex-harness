/**
 * The npm `codex` is a Node wrapper (@openai/codex bin/codex.js) that spawns
 * the native binary with inherited stdio and forwards only SIGINT, SIGTERM and
 * SIGHUP. These tests use a stub of that shape: a wrapper plus a "native"
 * grandchild that replays the real 0.160.1 capture after SLOW_MS. A dispatch
 * that is abandoned or hits its deadline must leave neither process running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CodexCliAdapter } from "../dist/adapters/CodexCliAdapter.js";

const SERVER = new URL("../dist/server.js", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/codex-0.160.1/drop.jsonl", import.meta.url).pathname;
const SLOW_MS = 2500;
/** Under SLOW_MS, so the native stand-in can never answer before the deadline fires. */
const DEADLINE_SEC = 2;

const LEAF = {
  id: "gpt",
  adapter: "codex-cli",
  model_name: "gpt-5.6-terra",
  reasoning: { effort: "high" },
  pricing: { input: 2.0, input_cached: 0.2, output: 12.0 },
};

const PACKET = {
  id: "tp_group",
  phase: "requirements_analysis",
  task_type: "analysis",
  module: "all",
  instruction: "Return {ok:true} as JSON.",
  inputs: [{ path: "brief.md", content: "x".repeat(3800), reason: "the brief" }],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 10000, maxOutputTokens: 1000 },
  pass_id: "group",
};

function wrapperStub(dir) {
  const native = join(dir, "native-codex.js");
  writeFileSync(
    native,
    `const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.STUB_MARKER + ".pid", String(process.pid));
setTimeout(() => {
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], '{"ok":true}');
  process.stdout.write(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
  fs.writeFileSync(process.env.STUB_MARKER, "finished ppid=" + process.ppid);
}, ${SLOW_MS});
`,
  );
  const wrapper = join(dir, "codex");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
if (process.argv[2] === "--warm") process.exit(0);
const { spawn } = require("child_process");
const child = spawn(process.execPath, [${JSON.stringify(native)}, ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
`,
  );
  chmodSync(wrapper, 0o755);
  // macOS checks a freshly written executable on its first exec, which takes seconds when other
  // suites run at once. Paying that here keeps it out of every dispatch's deadline.
  spawnSync(wrapper, ["--warm"]);
  return wrapper;
}

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
    await sleep(25);
  }
  return check();
}

function withStub(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-group-"));
    const marker = join(dir, "finished.txt");
    const saved = process.env.STUB_MARKER;
    process.env.STUB_MARKER = marker;
    try {
      await fn({ dir, marker, codexBin: wrapperStub(dir) });
    } finally {
      if (saved === undefined) delete process.env.STUB_MARKER;
      else process.env.STUB_MARKER = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** The native stand-in is gone, and it never reached the point where it would have answered. */
async function assertNativeKilled(marker, startedAt) {
  const pid = Number(readFileSync(`${marker}.pid`, "utf8"));
  assert.ok(await waitFor(() => !alive(pid), 2000), "the native codex outlived the kill and kept spending");
  await sleep(Math.max(0, startedAt + SLOW_MS + 300 - Date.now()));
  assert.equal(existsSync(marker), false, "the native codex finished its turn after the kill");
}

test("an abandoned dispatch kills the native codex behind the npm wrapper, and returns at once", withStub(async ({ marker, codexBin }) => {
  const stop = new AbortController();
  const started = Date.now();
  const pending = new CodexCliAdapter(LEAF, { codexBin }).execute(PACKET, undefined, { signal: stop.signal });
  assert.ok(await waitFor(() => existsSync(`${marker}.pid`)), "the native stand-in never started");
  const abortedAt = Date.now();
  stop.abort();
  const out = await pending;
  assert.ok(Date.now() - abortedAt < 1500, "execute() waited on a pipe an orphan still held");
  assert.equal(out.success, false);
  assert.match(out.error, /abandoned/);
  await assertNativeKilled(marker, started);
}));

test("a dispatch at its deadline kills the native codex behind the npm wrapper", withStub(async ({ marker, codexBin }) => {
  const started = Date.now();
  const out = await new CodexCliAdapter(LEAF, { codexBin, timeoutSec: DEADLINE_SEC }).execute(PACKET);
  assert.ok(existsSync(`${marker}.pid`), "the native stand-in had not started by the deadline");
  assert.equal(out.success, false);
  assert.match(out.error, new RegExp(`timeout after ${DEADLINE_SEC}s`));
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false);
  await assertNativeKilled(marker, started);
}));

// ── through the real bridge, with no MCP cancel ───────────────────────

function codexPolicy(dir) {
  const path = join(dir, "policy.yaml");
  writeFileSync(
    path,
    [
      "version: 1",
      "name: group-test",
      "models:",
      "  - id: gpt",
      "    adapter: codex-cli",
      "    model_name: gpt-5.6-terra",
      "    reasoning: { effort: high }",
      "    pricing: { input: 2.00, input_cached: 0.20, output: 12.00 }",
      "rules:",
      "  - default: gpt",
      "",
    ].join("\n"),
  );
  return path;
}

/** The bridge over raw stdio, so the test controls exactly how the connection ends. */
function startBridge(dir, codexBin, marker) {
  const server = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_BIN: codexBin, STUB_MARKER: marker, MMO_LOG_LEVEL: "error", MMO_SELECT: "" },
  });
  server.stdout.resume();
  server.stderr.resume();
  const exited = new Promise((ok) => server.once("exit", (code, signal) => ok({ code, signal })));
  const send = (m) => server.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "execute_with_model",
      arguments: { policy_path: codexPolicy(dir), telemetry_path: join(dir, "telemetry.jsonl"), project_root: dir, packet: PACKET },
    },
  });
  return { server, exited };
}

const telemetryLines = (dir) => {
  const path = join(dir, "telemetry.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("a client that closes the bridge's stdin without cancelling still gets the attempt booked and codex killed", withStub(async ({ dir, marker, codexBin }) => {
  const started = Date.now();
  const { server, exited } = startBridge(dir, codexBin, marker);
  try {
    assert.ok(await waitFor(() => existsSync(`${marker}.pid`)), "the native stand-in never started");
    server.stdin.end();
    assert.ok(await waitFor(() => telemetryLines(dir).length > 0, 3000), "closing stdin left no telemetry line");
    const [ev, ...rest] = telemetryLines(dir);
    assert.equal(rest.length, 0);
    assert.match(ev.error, /^abandoned \(the client closed the connection\)/);
    assert.equal(ev.provenance, "estimated");
    assert.equal(ev.usage_complete, false);
    await assertNativeKilled(marker, started);
    assert.equal(telemetryLines(dir).length, 1, "nothing more is appended after the dispatch was abandoned");
  } finally {
    server.kill("SIGKILL");
    await exited;
  }
}));

test("SIGTERM to the bridge books the attempt in flight and kills the native codex", withStub(async ({ dir, marker, codexBin }) => {
  const started = Date.now();
  const { server, exited } = startBridge(dir, codexBin, marker);
  try {
    assert.ok(await waitFor(() => existsSync(`${marker}.pid`)), "the native stand-in never started");
    server.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 143);
    const lines = telemetryLines(dir);
    assert.equal(lines.length, 1);
    assert.match(lines[0].error, /^abandoned \(the server received SIGTERM\)/);
    await assertNativeKilled(marker, started);
  } finally {
    server.kill("SIGKILL");
  }
}));
