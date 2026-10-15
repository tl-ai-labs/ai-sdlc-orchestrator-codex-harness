import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER = join(TEST_DIR, "..", "..", "plugin", "policy-console", "policy-server.mjs");
const SHIPPED_POLICIES = join(TEST_DIR, "..", "..", "plugin", "config", "policies");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function withConsole(fn, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  });
  try {
    await new Promise((ready, fail) => {
      let err = "";
      const timer = setTimeout(() => fail(new Error(`console did not start: ${err}`)), 10_000);
      child.stderr.on("data", (c) => {
        err += c;
        if (/listening on/.test(err)) {
          clearTimeout(timer);
          ready();
        }
      });
      child.once("exit", (code) => fail(new Error(`console exited ${code}: ${err}`)));
    });
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
  }
}

test("a policy built in the console keeps its base policy's driver pin and cost cap", async () => {
  await withConsole(async (base) => {
    const policies = await (await fetch(`${base}/api/policies`)).json();
    const list = Array.isArray(policies) ? policies : policies.policies;
    const flash = list.find((p) => p.id === "flash-agsdk-only");
    assert.ok(flash, "flash-agsdk-only is offered");
    const res = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseId: "flash-agsdk-only",
        name: "my-flash",
        models: flash.models,
        routing: flash.routing,
        thinking: flash.thinking,
        intentOverrides: flash.intentOverrides,
      }),
    });
    const out = await res.json();
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const saved = parseYaml(out.yaml);
    assert.deepEqual(
      { model_name: saved.driver?.model_name, effort: saved.driver?.reasoning?.effort },
      { model_name: "gpt-5.6-terra", effort: "high" },
    );
    assert.equal(saved.hard_cost_cap_usd, 50);
  });
});

test("the console offers only the shipped runnable policies, and builds a policy on each GPT one", async () => {
  await withConsole(async (base) => {
    const data = await (await fetch(`${base}/api/policies`)).json();
    assert.deepEqual(data.policies.map((p) => p.id), ["gpt-plus-flash", "flash-agsdk-only", "gpt-plus-flash-38", "gpt-seat-plus-flash"]);
    assert.ok(data.policies.every((p) => p.origin === "preset"));
    assert.deepEqual(data.adapters, ["openai", "codex-cli", "mcp:model-dispatch", "antigravity-worker"]);
    assert.doesNotMatch(JSON.stringify(data.adapterLabel), /Anthropic|Claude/);
    for (const id of ["gpt-plus-flash", "gpt-plus-flash-38", "gpt-seat-plus-flash"]) {
      const p = data.policies.find((x) => x.id === id);
      const res = await fetch(`${base}/api/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseId: id, name: `my-${id}`, models: p.models, routing: p.routing, thinking: p.thinking, intentOverrides: p.intentOverrides }),
      });
      const out = await res.json();
      assert.equal(out.ok, true, `${id}: ${JSON.stringify(out.errors)}`);
      const saved = parseYaml(out.yaml);
      assert.equal(saved.driver?.model_name, "gpt-5.6-terra", id);
      assert.ok(saved.models.some((m) => m.adapter === "openai" || m.adapter === "codex-cli"), id);
    }
  });
});

test("the console refuses an Anthropic adapter on a new model", async () => {
  await withConsole(async (base) => {
    const data = await (await fetch(`${base}/api/policies`)).json();
    const p = data.policies.find((x) => x.id === "gpt-plus-flash");
    const models = [...p.models, { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5", pricing: { input: 5, input_cached: 0.5, output: 25 } }];
    const res = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseId: "gpt-plus-flash", name: "with-opus", models, routing: p.routing, thinking: p.thinking, intentOverrides: p.intentOverrides }),
    });
    const out = await res.json();
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /Model "opus" names adapter "builtin-anthropic"/.test(e)), JSON.stringify(out.errors));
  });
});

test("the console offers no base whose driver pins a non-GPT model or that names an Anthropic adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-console-test-"));
  try {
    const gptPlusFlash = readFileSync(join(SHIPPED_POLICIES, "gpt-plus-flash.yaml"), "utf8");
    const claudeDriver = gptPlusFlash
      .replace(/^name: gpt-plus-flash$/m, "name: claude-driver")
      .replace(/^(driver:\n\s+model_name:) gpt-5\.6-terra$/m, "$1 claude-opus-5");
    assert.match(claudeDriver, /^driver:\n\s+model_name: claude-opus-5$/m, "the fixture pins a Claude conductor");
    writeFileSync(join(dir, "gpt-plus-flash.yaml"), gptPlusFlash);
    writeFileSync(join(dir, "claude-driver.yaml"), claudeDriver);
    writeFileSync(join(dir, "opus-only.yaml"), readFileSync(join(TEST_DIR, "fixtures", "policies", "claude", "opus-only.yaml"), "utf8"));
    await withConsole(async (base) => {
      const data = await (await fetch(`${base}/api/policies`)).json();
      assert.deepEqual(data.policies.map((p) => p.id), ["gpt-plus-flash"]);
    }, { SDLC_POLICIES_DIR_FOR_TESTS: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
