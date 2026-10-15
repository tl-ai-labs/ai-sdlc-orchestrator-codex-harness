import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(ROOT, "plugin", "policy-console", "policy-server.mjs");

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function withConsole(fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, `--port=${port}`], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    await new Promise((ok, fail) => {
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
        if (err.includes("listening on")) ok();
      });
      child.once("exit", (code) => fail(new Error(`policy-server exited ${code}: ${err}`)));
    });
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
  }
}

const preview = (base, models) =>
  fetch(`${base}/api/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "price-check-preview", baseId: "gpt-plus-flash", models }),
  }).then((r) => r.json());

const card = { input: 1, input_cached: 0.1, output: 4 };

test("the policy console refuses a model the price list does not name, as the dispatch server would", async () => {
  await withConsole(async (base) => {
    const out = await preview(base, [{ id: "gw", adapter: "mcp:model-dispatch", model_name: "acme-gateway-1", pricing: card }]);
    assert.equal(out.ok, false);
    assert.ok(
      out.errors.some((e) => /"acme-gateway-1" is not on the price list \(plugin\/mcp\/model-dispatch\/src\/prices\.ts\)/.test(e)),
      JSON.stringify(out.errors),
    );
  });
});

test("the policy console passes a listed model and a pricing_override one the price check", async () => {
  await withConsole(async (base) => {
    const out = await preview(base, [
      { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash", pricing: card },
      { id: "gw", adapter: "mcp:model-dispatch", model_name: "acme-gateway-1", pricing: card, pricing_override: true },
      { id: "bad", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash", pricing: card, pricing_override: "yes" },
    ]);
    const priceErrors = (out.errors ?? []).filter((e) => /price list|pricing_override/.test(e));
    assert.deepEqual(priceErrors, ['Model "bad": pricing_override must be true or false.']);
  });
});

test("the policy console warns that a listed model's differing block is not what a run is billed", async () => {
  await withConsole(async (base) => {
    const out = await preview(base, [
      { id: "gpt", adapter: "openai", model_name: "gpt-5.6-terra", pricing: { input: 3, input_cached: 0.3, output: 15 } },
      { id: "gpt-same", adapter: "openai", model_name: "gpt-5.6-terra", pricing: { input: 2, input_cached: 0.2, output: 12 } },
      { id: "gpt-own", adapter: "openai", model_name: "gpt-5.6-terra", pricing: { input: 3, input_cached: 0.3, output: 15 }, pricing_override: true },
    ]);
    assert.equal(out.warnings.length, 1, JSON.stringify(out.warnings));
    assert.match(out.warnings[0], /^Policy model 'gpt' \(gpt-5\.6-terra\): its pricing block 3\/0\.3\/15 differs .* from the price list 2\/0\.2\/12 .* The list price is billed/);
  });
});
