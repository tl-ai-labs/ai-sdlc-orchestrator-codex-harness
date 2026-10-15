/**
 * A dispatch the client stops waiting for still leaves its spend on record.
 * The real bridge (dist/server.js) is driven through driverClient with a short
 * call timeout; codex is a stub script and OpenAI a server on 127.0.0.1, so
 * nothing leaves this machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { connectBridge } from "../dist/driverClient.js";

const FIXTURE = new URL("./fixtures/codex-0.160.1/drop.jsonl", import.meta.url).pathname;

const packet = (id, maxOutputTokens = 1000) => ({
  id,
  phase: "requirements_analysis",
  task_type: "analysis",
  module: "all",
  instruction: "Return {ok:true} as JSON.",
  inputs: [{ path: "brief.md", content: "x".repeat(3800), reason: "the brief" }],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 10000, maxOutputTokens },
  pass_id: "abandoned",
});

const lines = (path) =>
  existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function codexPolicy(dir) {
  const path = join(dir, "policy.yaml");
  writeFileSync(
    path,
    [
      "version: 1",
      "name: abandoned-test",
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

/** A codex stand-in: replays the real 0.160.1 capture after SLOW_MS, then leaves a marker. */
function codexStub(dir) {
  const path = join(dir, "codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
setTimeout(() => {
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], '{"ok":true}');
  process.stdout.write(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
  if (process.env.STUB_MARKER) fs.writeFileSync(process.env.STUB_MARKER, "finished");
}, Number(process.env.SLOW_MS || 0));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("a codex-cli dispatch the client gave up on is booked once, as an estimate, and its child is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-abandoned-"));
  const telemetry = join(dir, "telemetry.jsonl");
  const marker = join(dir, "finished.txt");
  const bridge = await connectBridge({
    toolTimeoutMs: 500,
    env: { CODEX_BIN: codexStub(dir), SLOW_MS: "2500", STUB_MARKER: marker, MMO_LOG_LEVEL: "error" },
  });
  try {
    await assert.rejects(
      bridge.callTool("execute_with_model", {
        policy_path: codexPolicy(dir),
        telemetry_path: telemetry,
        project_root: dir,
        packet: packet("tp_abandoned_codex"),
      }),
      /timed out/i,
    );
  } finally {
    await bridge.close();
  }
  try {
    const [ev, ...rest] = lines(telemetry);
    assert.ok(ev, "the abandoned dispatch left no telemetry line");
    assert.equal(rest.length, 0, "the abandoned attempt is recorded once");
    assert.equal(ev.task_id, "tp_abandoned_codex");
    assert.equal(ev.success, false);
    assert.equal(ev.usage_complete, false);
    assert.equal(ev.provenance, "estimated");
    assert.equal(ev.adapter_provenance, "modeled", "a seat floor, kept out of the vendor-metered total");
    assert.ok(ev.cost_usd > 0, "a lower bound, never a vendor-looking $0");
    assert.match(ev.error, /abandoned/);
    await sleep(3000);
    assert.equal(existsSync(marker), false, "the nested codex outlived the bridge and kept spending");
    assert.equal(lines(telemetry).length, 1, "nothing more is appended after the dispatch was abandoned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a codex-cli dispatch that finishes writes exactly one line, billed from the turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-abandoned-"));
  const telemetry = join(dir, "telemetry.jsonl");
  const bridge = await connectBridge({ env: { CODEX_BIN: codexStub(dir), MMO_LOG_LEVEL: "error" } });
  try {
    const out = await bridge.callTool("execute_with_model", {
      policy_path: codexPolicy(dir),
      telemetry_path: telemetry,
      project_root: dir,
      packet: packet("tp_finished_codex"),
    });
    assert.equal(out.result.success, true, "a reconnect and a metadata warning must not fail the call");
    const all = lines(telemetry);
    assert.equal(all.length, 1, "the live record and the post-return pass must not both write");
    assert.equal(all[0].provenance, "modeled");
    assert.equal(all[0].adapter_provenance, "modeled");
    assert.equal(all[0].cost_usd, 0.00522);
    assert.equal(all[0].codex_thread_id, "01a1340e-168b-7322-a276-d1a40c7d59d8");
    assert.deepEqual(out.events, all, "the reply carries the same events the file got");
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an OpenAI attempt that returned before the client gave up keeps its vendor-metered line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-abandoned-"));
  const telemetry = join(dir, "telemetry.jsonl");
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    if (requests > 1) return; // the doubled attempt never answers
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          created_at: 0,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          model: "gpt-5.6-terra",
          output: [],
          usage: {
            input_tokens: 50000,
            input_tokens_details: { cached_tokens: 40000 },
            output_tokens: 1000,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 51000,
          },
        }),
      );
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const bridge = await connectBridge({
    toolTimeoutMs: 1500,
    env: {
      OPENAI_API_KEY: "test-key-not-real",
      OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      MMO_SELECT: "",
      MMO_LOG_LEVEL: "error",
    },
  });
  try {
    await assert.rejects(
      bridge.callTool("execute_with_model", {
        policy_name: "gpt-plus-flash",
        telemetry_path: telemetry,
        packet: packet("tp_abandoned_openai"),
      }),
      /timed out/i,
    );
  } finally {
    await bridge.close();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
  try {
    const all = lines(telemetry);
    assert.equal(all.length, 2);
    assert.equal(all[0].attempt_number, 1);
    assert.equal(all[0].provenance, "vendor");
    assert.equal(all[0].cost_usd, (10000 * 2.0 + 40000 * 0.2 + 1000 * 12.0) / 1e6);
    assert.equal(all[1].attempt_number, 2);
    assert.equal(all[1].provenance, "estimated");
    assert.equal(all[1].adapter_provenance, undefined, "an API-key OpenAI floor is metered spend");
    assert.equal(all[1].usage_complete, false);
    assert.equal(all[1].ceiling_used, 1000, "the placeholder carries the last ceiling it knew");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
