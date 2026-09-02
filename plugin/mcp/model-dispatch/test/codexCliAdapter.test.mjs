/**
 * Runs against dist/adapters/CodexCliAdapter.js — the adapter takes its
 * spawn function by injection so these tests never actually invoke codex.
 *
 * The property that matters most here is the cost label. This adapter can
 * only DERIVE cost (codex reports tokens but no money), so an event it
 * produces must never claim to be vendor-metered. A regression there would
 * publish a calculation as a bill.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";

import { CodexCliAdapter, parseCodexStream } from "../dist/adapters/CodexCliAdapter.js";

const BASE_CONFIG = {
  id: "gpt",
  adapter: "codex-cli",
  model_name: "gpt-5.6-terra",
  reasoning: { effort: "high" },
  pricing: { input: 2.0, input_cached: 0.2, output: 12.0 },
};

const PACKET = {
  id: "pkt-1",
  phase: "requirements_analysis",
  task_type: "requirements",
  module: "cross",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "test-pass",
};

/**
 * Fake spawn. `behavior` returns the JSONL to emit, the content to write to
 * the --output-last-message path, and an exit code — or `hang: true` to
 * never settle, so the timeout path can be exercised.
 */
function fakeSpawn(behavior) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};

    setImmediate(() => {
      const r = behavior(args);
      if (r.hang) return;
      // The adapter reads its result from the file codex was told to write.
      const outIdx = args.indexOf("--output-last-message");
      if (outIdx !== -1 && r.lastMessage !== undefined) {
        writeFileSync(args[outIdx + 1], r.lastMessage);
      }
      if (r.stdout) child.stdout.write(r.stdout);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", r.code ?? 0));
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const usageLine = (u) => JSON.stringify({ type: "turn.completed", usage: u });

// ── stream parsing ───────────────────────────────────────────────────

test("parseCodexStream pulls usage off turn.completed", () => {
  const { usage, error } = parseCodexStream(
    usageLine({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 2 }),
  );
  assert.equal(error, null);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cached_input_tokens, 20);
});

test("parseCodexStream surfaces each of the three real error shapes", () => {
  assert.match(parseCodexStream('{"type":"error","message":"boom"}').error, /boom/);
  assert.match(parseCodexStream('{"type":"turn.failed","error":{"message":"nested"}}').error, /nested/);
  assert.match(
    parseCodexStream('{"type":"item.completed","item":{"type":"error","message":"item-level"}}').error,
    /item-level/,
  );
});

test("parseCodexStream skips a truncated line rather than throwing", () => {
  const { usage } = parseCodexStream(`${usageLine({ input_tokens: 7 })}\n{"type":"turn.comp`);
  assert.equal(usage.input_tokens, 7);
});

// ── the cost label ───────────────────────────────────────────────────

test("the adapter declares its cost as modeled, never vendor", () => {
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({})) });
  assert.equal(
    adapter.costProvenance, "modeled",
    "codex reports no money — an event from here must not claim to be metered",
  );
});

// ── the invocation ───────────────────────────────────────────────────

test("buildArgs carries the model, the effort pin, and a read-only sandbox", () => {
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({})) });
  const args = adapter.buildArgs("/s.json", "/o.txt", "prompt");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.6-terra");
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only", "a judgment call has no business writing files");
  assert.ok(args.includes("--skip-git-repo-check"), "dispatch may run outside a repo");
});

test("buildArgs puts the prompt behind a bare -- separator", () => {
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({})) });
  const args = adapter.buildArgs("/s.json", "/o.txt", "---\nfrontmatter\n---");
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], "---\nfrontmatter\n---");
});

test("buildArgs wires the packet's own schema and an output file", () => {
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({})) });
  const args = adapter.buildArgs("/schema.json", "/last.txt", "p");
  assert.equal(args[args.indexOf("--output-schema") + 1], "/schema.json");
  assert.equal(args[args.indexOf("--output-last-message") + 1], "/last.txt");
});

// ── execution ────────────────────────────────────────────────────────

test("a successful call returns the parsed result priced from real token counts", async () => {
  const spawnFn = fakeSpawn(() => ({
    lastMessage: JSON.stringify({ ok: true }),
    stdout: usageLine({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 8 }),
    code: 0,
  }));
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.equal(out.terminal_reason, "success");
  assert.deepEqual(out.result, { ok: true });
  assert.equal(out.tokens.input, 600, "input is the FRESH count: 1000 total minus 400 cached");
  assert.equal(out.tokens.input_cached, 400);
  assert.equal(out.tokens.output, 50);
  // fresh input is total MINUS cached (1000 - 400): codex/OpenAI report
  // input_tokens inclusive of the cached subset.
  const expected = (600 / 1e6) * 2.0 + (400 / 1e6) * 0.2 + (50 / 1e6) * 12.0;
  assert.ok(Math.abs(out.cost_usd - expected) < 1e-9, `cost ${out.cost_usd} != ${expected}`);
});

test("the result is read from the output file, not scraped from stdout", async () => {
  // stdout carries only usage; the answer lives in the file. A change that
  // started parsing stdout would break on any run codex adds chatter to.
  const spawnFn = fakeSpawn(() => ({
    lastMessage: JSON.stringify({ fromFile: true }),
    stdout: usageLine({ input_tokens: 10, output_tokens: 2 }),
    code: 0,
  }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.deepEqual(out.result, { fromFile: true });
});

test("non-JSON output degrades to a raw wrapper rather than failing", async () => {
  const spawnFn = fakeSpawn(() => ({
    lastMessage: "not json at all",
    stdout: usageLine({ input_tokens: 10, output_tokens: 4 }),
    code: 0,
  }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, true);
  assert.deepEqual(out.result, { raw: "not json at all" });
});

test("an error in the stream becomes a vendor_error result, not a throw", async () => {
  const spawnFn = fakeSpawn(() => ({
    stdout: '{"type":"turn.failed","error":{"message":"quota exhausted"}}',
    lastMessage: "",
    code: 1,
  }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /quota exhausted/);
});

test("an empty final message is reported rather than passed off as a result", async () => {
  const spawnFn = fakeSpawn(() => ({ lastMessage: "", stdout: usageLine({ input_tokens: 5 }), code: 0 }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /empty final message/);
});

test("a hanging codex process is killed at the timeout", async () => {
  const spawnFn = fakeSpawn(() => ({ hang: true }));
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn, timeoutSec: 0.05 });
  const out = await adapter.execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /timeout/);
});

test("a missing codex binary is reported, not thrown", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })));
    return child;
  };
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, false);
});

test("the binary can be overridden for a non-global install", () => {
  const spawnFn = fakeSpawn(() => ({ lastMessage: "{}", stdout: "", code: 0 }));
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn, codexBin: "/opt/codex" });
  return adapter.execute(PACKET).then(() => {
    assert.equal(spawnFn.calls[0].cmd, "/opt/codex");
  });
});
