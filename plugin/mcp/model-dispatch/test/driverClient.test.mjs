/**
 * Live reachability test for the driver-side MCP client — spawns the REAL
 * built dist/server.js as a subprocess and calls real tools over the real
 * MCP wire protocol. No injection, no fixture server: this is the concrete
 * proof for docs/verification/p1-codex-runtime.md check 4's fix — a Node
 * process (standing in for the eventual codex driver script) can reach this
 * server's tools even though a model inside `codex exec` cannot.
 *
 * Only load_policy and preflight_dispatch are exercised — both make zero
 * vendor API calls (preflight only constructs adapters; construction is
 * where a missing credential is caught, before any dispatch), so this stays
 * offline and free like every other suite here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { connectBridge, DEFAULT_TOOL_TIMEOUT_MS, canSpawnChildProcess, diagnoseConnectFailure } from "../dist/driverClient.js";

test("load_policy reaches the real server and returns the official codex policy", async () => {
  const bridge = await connectBridge();
  try {
    const policy = await bridge.callTool("load_policy", { policy_name: "gpt-plus-flash" });
    assert.equal(policy.name, "gpt-plus-flash");
    assert.equal(policy.version, 1);
    assert.ok(policy.models.some((m) => m.adapter === "openai"), "policy names the openai adapter");
  } finally {
    await bridge.close();
  }
});

test("preflight_dispatch reaches the real server and classifies a missing OPENAI_API_KEY as blocking", async () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const bridge = await connectBridge();
  try {
    const result = await bridge.callTool("preflight_dispatch", {
      auth_mode: "vendor",
      policy_name: "gpt-plus-flash",
    });
    assert.equal(result.ok, false, "vendor mode with no OPENAI_API_KEY must not pass preflight");
    assert.match(result.halt_reason, /OPENAI_API_KEY|not set/i);
  } finally {
    await bridge.close();
    if (original !== undefined) process.env.OPENAI_API_KEY = original;
  }
});

test("preflight_dispatch passes once a (dummy) OPENAI_API_KEY is present — construction only, no dispatch", async () => {
  const bridge = await connectBridge({ env: { OPENAI_API_KEY: "sk-test-dummy-not-a-real-key" } });
  try {
    const result = await bridge.callTool("preflight_dispatch", {
      auth_mode: "vendor",
      policy_name: "gpt-plus-flash",
    });
    assert.equal(result.ok, true, "adapter construction only checks the key is present, never calls the vendor");
    const gpt = result.models.find((m) => m.id === "gpt");
    assert.equal(gpt.ok, true);
    assert.equal(gpt.adapter, "openai");
  } finally {
    await bridge.close();
  }
});

test("an unreachable server rejects connect() instead of hanging forever", async () => {
  await assert.rejects(
    () => connectBridge({ serverPath: "/nonexistent/path/to/server.js" }),
  );
});

// ── the call timeout ─────────────────────────────────────────────────
//
// The first Workforce Ops reference run died here. `client.callTool` was
// called with no options, so the MCP SDK's 60s default applied while
// gpt-seat-plus-flash allows its adapter 540s. Both requirements dispatches
// returned `MCP error -32001: Request timed out` at 60s with the adapter
// still working, and the conductor — correctly refusing to author substitute
// content — halted the run before Gate 1 having produced nothing.

test("the client's per-call timeout exceeds every shipped policy's worker timeout", () => {
  // The real invariant, checked against the policies rather than a constant:
  // a client that gives up before its own adapter does turns a slow answer
  // into a phantom vendor failure.
  const policyDir = new URL("../../../config/policies/", import.meta.url);
  const files = readdirSync(policyDir).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length > 0, "there should be policies to check");

  let worst = 0;
  for (const file of files) {
    const text = readFileSync(new URL(file, policyDir), "utf8");
    for (const m of text.matchAll(/worker_timeout_sec:\s*(\d+)/g)) {
      worst = Math.max(worst, Number(m[1]));
    }
  }
  assert.ok(worst > 0, "at least one policy should set worker_timeout_sec");
  assert.ok(
    DEFAULT_TOOL_TIMEOUT_MS > worst * 1000,
    `client timeout ${DEFAULT_TOOL_TIMEOUT_MS}ms must exceed the ${worst}s worst-case worker timeout`,
  );
});

test("callTool passes an explicit timeout rather than inheriting the SDK default", () => {
  // Source-level, because the 60s default is invisible at runtime until a
  // call actually runs long — which only happens on a real paid dispatch.
  const src = readFileSync(new URL("../src/driverClient.ts", import.meta.url), "utf8");
  assert.match(
    src, /callTool\(\s*\{[^}]*\}\s*,\s*undefined\s*,\s*\{\s*timeout\s*\}/s,
    "callTool must be given a timeout in its RequestOptions",
  );
});

// ── sandbox diagnosis ────────────────────────────────────────────────────
//
// Codex runs the model's shell commands in a sandbox that permits child
// processes but denies the pipes needed to talk to one. This client reaches
// the bridge over exactly those pipes, so the transport dies at birth and the
// SDK reports `MCP error -32000: Connection closed` — a message that sends
// people hunting for a crashed or unbuilt server, which is the one thing it
// never is. These pin the diagnosis that replaces it.

test("the spawn probe uses piped stdio — an `ignore` probe passes inside the sandbox and proves nothing", () => {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push(opts); return {}; };
  canSpawnChildProcess(run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdio, "pipe", "probing with `ignore` would report a healthy machine under the sandbox");
});

test("a connect failure on a machine that CAN pipe is passed through untouched", () => {
  const msg = diagnoseConnectFailure(new Error("boom"), () => ({ ok: true, code: null }));
  assert.equal(msg, "boom", "never blame the sandbox without evidence — the real error is the honest answer");
});

test("a connect failure on a machine that cannot pipe names the cause and both ways out", () => {
  const msg = diagnoseConnectFailure(
    new Error("MCP error -32000: Connection closed"),
    () => ({ ok: false, code: "EPERM" }),
  );
  assert.match(msg, /MCP error -32000: Connection closed/, "the original error must survive");
  assert.match(msg, /EPERM/);
  assert.match(msg, /not crashed, missing or unbuilt/, "rules out where people actually look first");
  assert.match(msg, /danger-full-access/, "the interactive way out");
  assert.match(msg, /run\.mjs/, "the headless way out");
});

test("the probe reports the real errno rather than collapsing every failure to one code", () => {
  const enoent = canSpawnChildProcess(() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }));
  assert.deepEqual(enoent, { ok: false, code: "ENOENT" });
  const fine = canSpawnChildProcess(() => ({ status: 0 }));
  assert.deepEqual(fine, { ok: true, code: null });
});
