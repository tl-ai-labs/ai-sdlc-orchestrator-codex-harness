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

import { connectBridge } from "../dist/driverClient.js";

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
