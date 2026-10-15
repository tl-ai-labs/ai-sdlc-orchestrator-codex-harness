/**
 * The bridge copies each attempt's price_basis, price_tier, price_verified
 * and prompt_tokens into the telemetry line it writes. Offline: codex is a
 * stub script, and the OpenAI SDK talks to a server on 127.0.0.1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectBridge } from "../dist/driverClient.js";

const packet = (id) => ({
  id,
  phase: "requirements_analysis",
  task_type: "analysis",
  module: "all",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
  pass_id: "price-fields",
});

function telemetryLines(path, taskId) {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.task_id === taskId);
}

const CODEX_STUB = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ ok: true }));
for (const e of [
  { type: "thread.started", thread_id: "stub-thread" },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 300000, cached_input_tokens: 100000, output_tokens: 1000 } },
]) console.log(JSON.stringify(e));
`;

test("a codex-cli dispatch writes list basis, the unverified tier and the entry's date to telemetry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-price-fields-"));
  const stub = join(dir, "codex-stub.cjs");
  writeFileSync(stub, CODEX_STUB);
  chmodSync(stub, 0o755);
  const telemetry = join(dir, "telemetry.jsonl");
  const bridge = await connectBridge({ env: { CODEX_BIN: stub, MMO_SELECT: "" } });
  try {
    await bridge.callTool("execute_with_model", {
      policy_name: "gpt-seat-plus-flash",
      telemetry_path: telemetry,
      packet: packet("tp_price_codex"),
    });
    const [ev, ...rest] = telemetryLines(telemetry, "tp_price_codex");
    assert.equal(rest.length, 0);
    assert.equal(ev.model, "gpt-5.6-terra");
    assert.equal(ev.success, true);
    assert.equal(ev.price_basis, "list");
    // One turn's usage sums its requests, so 300,000 cannot prove the >272K tier either way.
    assert.equal(ev.price_tier, "unverified");
    assert.equal(ev.price_verified, "2026-10-13");
    assert.equal(ev.prompt_tokens, undefined);
    assert.equal(ev.cost_usd, 0.432);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an openai dispatch writes the long-context tier and the request's prompt_tokens to telemetry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-price-fields-"));
  const telemetry = join(dir, "telemetry.jsonl");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_price_fields",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5.6-terra",
          output: [
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 300000,
            input_tokens_details: { cached_tokens: 100000 },
            output_tokens: 10000,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 310000,
          },
        }),
      );
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  const bridge = await connectBridge({
    env: { OPENAI_API_KEY: "test-key-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, MMO_SELECT: "" },
  });
  try {
    await bridge.callTool("execute_with_model", {
      policy_name: "gpt-plus-flash",
      telemetry_path: telemetry,
      packet: packet("tp_price_openai"),
    });
    assert.deepEqual(requests, ["POST /v1/responses"]);
    const [ev, ...rest] = telemetryLines(telemetry, "tp_price_openai");
    assert.equal(rest.length, 0);
    assert.equal(ev.success, true);
    assert.equal(ev.price_basis, "list");
    assert.equal(ev.price_tier, "long_context");
    assert.equal(ev.price_verified, "2026-10-13");
    assert.equal(ev.prompt_tokens, 300000);
    assert.equal(ev.input_tokens, 200000);
    assert.equal(ev.input_tokens_cached, 100000);
    assert.equal(ev.cost_usd, 1.02);
  } finally {
    await bridge.close();
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
});
