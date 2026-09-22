/**
 * Runs against dist/adapters/ClaudeCliAdapter.js — the adapter takes its
 * spawn function and its binary probe by injection so these tests never
 * actually invoke `claude`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { ClaudeCliAdapter } from "../dist/adapters/ClaudeCliAdapter.js";

const BASE_CONFIG = {
  id: "sonnet-cli",
  adapter: "claude-cli",
  model_name: "claude-sonnet-5",
  pricing: { input: 3, input_cached: 0.3, output: 15 },
};

const PACKET = {
  id: "pkt-1",
  phase: "codegen",
  task_type: "controller_handler",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  acceptance: ["Responds with valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "test-pass",
};

/**
 * Build a fake `spawn` that returns a child-like object whose stdio can be
 * driven from the test. `behavior` returns what to emit on stdout/stderr and
 * an exit code (or leaves it running forever if `hang: true`).
 */
function fakeSpawn(behavior) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (_signal) => {
      child.killed = true;
      // No 'close' emitted for a hanging process — the adapter's timeout
      // fulfils the promise directly.
    };

    // Let the caller write to stdin, then react asynchronously.
    setImmediate(() => {
      const result = behavior();
      if (result.hang) return;
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", result.code ?? 0));
    });

    return child;
  };
}

const SUCCESS_RESPONSE = {
  is_error: false,
  result: '{"ok":true}',
  total_cost_usd: 0.1219536,
  duration_ms: 3943,
  duration_api_ms: 2518,
  stop_reason: "end_turn",
  terminal_reason: "completed",
  session_id: "sess-1",
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 18765,
    cache_read_input_tokens: 30992,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    service_tier: "standard",
  },
};

test("returns a successful ExecutionResult and preserves vendor cost verbatim", async () => {
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    spawnFn: fakeSpawn(() => ({ stdout: JSON.stringify(SUCCESS_RESPONSE), code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.equal(out.terminal_reason, "success");
  assert.deepEqual(out.result, { ok: true });
  // input = input_tokens + cache_creation_input_tokens
  assert.equal(out.tokens.input, 18767);
  assert.equal(out.tokens.input_cached, 30992);
  assert.equal(out.tokens.output, 4);
  assert.equal(out.cost_usd, 0.1219536, "cost passes through untouched from total_cost_usd");
  assert.equal(out.latency_ms, 2518, "latency comes from duration_api_ms, not duration_ms");
  assert.equal(out.cache_hit, true, "any cache_read_input_tokens > 0 flips cache_hit");
  assert.equal(out.attempts.length, 1, "no doubling loop — always one attempt");
});

test("classifies is_error responses as a vendor_error ExecutionResult", async () => {
  const errorResponse = {
    is_error: true,
    result: "quota exhausted",
    total_cost_usd: 0,
    stop_reason: "error",
    terminal_reason: "error",
    usage: { input_tokens: 1, output_tokens: 0 },
  };
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    spawnFn: fakeSpawn(() => ({ stdout: JSON.stringify(errorResponse), code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /quota exhausted/);
  assert.equal(out.result, null);
});

test("garbage stdout is reported as a vendor_error, not thrown", async () => {
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    spawnFn: fakeSpawn(() => ({ stdout: "not JSON at all", code: 0 })),
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /JSON parse failed/);
});

test("a hanging subprocess is killed after the configured timeout", async () => {
  const adapter = new ClaudeCliAdapter(BASE_CONFIG, {
    probeBinary: () => {},
    spawnFn: fakeSpawn(() => ({ hang: true })),
    timeoutSec: 0.05,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /claude-cli timeout/);
});

test("constructor throws when the claude binary is missing (ENOENT)", () => {
  assert.throws(
    () =>
      new ClaudeCliAdapter(BASE_CONFIG, {
        probeBinary: () => {
          const err = new Error("spawn claude ENOENT");
          err.code = "ENOENT";
          throw err;
        },
        spawnFn: fakeSpawn(() => ({ stdout: "{}", code: 0 })),
      }),
    /needs the `claude` binary on PATH/,
  );
});
