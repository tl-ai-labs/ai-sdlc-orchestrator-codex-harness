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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexCliAdapter, parseCodexStream, PLUGIN_HOOKS_OFF_CONFIG } from "../dist/adapters/CodexCliAdapter.js";
import { STRICT_RESULT_ENVELOPE } from "../dist/adapters/strictSchema.js";

// Real `codex exec --json` streams from codex-cli 0.160.1 against a localhost
// mock: `reconnect-only` dropped the first response stream and recovered;
// `drop` also carries the model-metadata warning item codex emits for a model
// it has no metadata for.
const FIXTURES = new URL("./fixtures/codex-0.160.1/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), "utf8");

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
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
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

test("buildArgs switches the installed plugin's write hook off for the nested exec, before the prompt", () => {
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({})) });
  const args = adapter.buildArgs("/s.json", "/o.txt", "prompt");
  const at = args.indexOf(PLUGIN_HOOKS_OFF_CONFIG);
  assert.ok(at > 0, "a trusted plugin hook would otherwise start for every tool call of a read-only worker");
  assert.equal(args[at - 1], "-c");
  assert.ok(at < args.indexOf("--"));
  assert.match(PLUGIN_HOOKS_OFF_CONFIG, /^hooks\.state=\{"[^"]+:hooks\/hooks\.json:pre_tool_use:0:0"=\{enabled=false\}\}$/);
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

test("a hanging codex process is killed at the timeout and booked as an estimated lower bound", async () => {
  const spawnFn = fakeSpawn(() => ({ hang: true }));
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn, timeoutSec: 0.05 });
  const out = await adapter.execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /timeout/);
  assert.ok(out.cost_usd > 0);
  assert.equal(out.cost_provenance, "estimated", "a prompt-length guess is not modeled from real tokens");
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false);
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
  assert.equal(out.cost_usd, 0, "codex never started, so nothing was sent");
  assert.equal(out.attempts[0].cost_provenance, undefined);
});

test("the binary can be overridden for a non-global install", () => {
  const spawnFn = fakeSpawn(() => ({ lastMessage: "{}", stdout: "", code: 0 }));
  const adapter = new CodexCliAdapter(BASE_CONFIG, { spawnFn, codexBin: "/opt/codex" });
  return adapter.execute(PACKET).then(() => {
    assert.equal(spawnFn.calls[0].cmd, "/opt/codex");
  });
});

// ── terminal events decide (codex 0.160 semantics) ───────────────────

test("parseCodexStream collects warnings, reads the thread id, and clears the error once the turn completes", () => {
  const stream = parseCodexStream(fixture("drop.jsonl"));
  assert.equal(stream.completed, true);
  assert.equal(stream.error, null);
  assert.equal(stream.threadId, "01a1340e-168b-7322-a276-d1a40c7d59d8");
  assert.equal(stream.warnings.length, 2);
  assert.match(stream.warnings[0], /Model metadata/);
  assert.match(stream.warnings[1], /Reconnecting\.\.\. 1\/5/);
  assert.equal(stream.usage.cache_write_input_tokens, 0);
});

test("a Reconnecting error followed by turn.completed succeeds and bills the turn", async () => {
  const spawnFn = fakeSpawn(() => ({ stdout: fixture("reconnect-only.jsonl"), lastMessage: JSON.stringify({ ok: true }), code: 0 }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(out.terminal_reason, "success");
  assert.deepEqual(out.result, { ok: true });
  assert.deepEqual(
    { input: out.tokens.input, input_cached: out.tokens.input_cached, output: out.tokens.output },
    { input: 2100, input_cached: 900, output: 70 },
  );
  assert.equal(out.cost_usd, 0.00522);
  assert.equal(out.cost_provenance, undefined, "real turn usage stays modeled, the adapter's own label");
  assert.equal(out.attempts[0].codex_thread_id, "01a1340e-168b-7322-a276-d1a40c7d59d8");
});

test("a model-metadata warning item before the turn does not fail a good turn", async () => {
  const spawnFn = fakeSpawn(() => ({ stdout: fixture("drop.jsonl"), lastMessage: JSON.stringify({ ok: true }), code: 0 }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, true);
  assert.equal(out.cost_usd, 0.00522);
});

test("error events followed by turn.failed fail with the turn.failed message", async () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected)"}',
    '{"type":"turn.failed","error":{"message":"stream disconnected: retries exhausted"}}',
  ].join("\n");
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({ stdout, lastMessage: "", code: 1 })) }).execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /retries exhausted/);
  assert.equal(out.cost_provenance, "estimated");
  assert.equal(out.attempts[0].codex_thread_id, "t-1");
});

test("a lone error line with no turn.completed fails with that message", async () => {
  const stdout = '{"type":"error","message":"unexpected status 401 Unauthorized"}';
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({ stdout, lastMessage: "{}", code: 1 })) }).execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /401/);
});

test("a non-zero exit with no turn at all is a failure, not a success read off a stale file", async () => {
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn: fakeSpawn(() => ({ stdout: "", lastMessage: "{}", code: 2 })) }).execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /exited 2/);
});

test("a completed turn with an empty final message bills the turn's real usage, modeled", async () => {
  const spawnFn = fakeSpawn(() => ({ stdout: usageLine({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 }), lastMessage: "", code: 0 }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.tokens.input, 5);
  assert.equal(out.tokens.output, 3);
  assert.equal(out.cost_provenance, undefined);
  assert.equal(out.attempts[0].usage_complete, undefined);
});

test("a completed turn that reported no usage is labelled estimated", async () => {
  const spawnFn = fakeSpawn(() => ({ stdout: '{"type":"turn.completed"}', lastMessage: JSON.stringify({ ok: true }), code: 0 }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute(PACKET);
  assert.equal(out.success, true);
  assert.ok(out.cost_usd > 0);
  assert.equal(out.cost_provenance, "estimated");
  assert.equal(out.attempts[0].cost_provenance, "estimated");
});

test("a real child process replaying the reconnect capture succeeds through the spawn path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-cli-stub-"));
  try {
    const stub = join(dir, "codex");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], '{"ok":true}');
process.stdout.write(fs.readFileSync(${JSON.stringify(new URL("reconnect-only.jsonl", FIXTURES).pathname)}, "utf8"));
`,
    );
    chmodSync(stub, 0o755);
    const out = await new CodexCliAdapter(BASE_CONFIG, { codexBin: stub }).execute(PACKET);
    assert.equal(out.success, true);
    assert.equal(out.cost_usd, 0.00522);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── strict-mode schemas ──────────────────────────────────────────────

// The brownfield plan packet's schema that OpenAI strict mode refused: its array items are an object with no properties.
const LOOSE_PLAN_SCHEMA = {
  type: "object",
  properties: { packets: { type: "array", items: { type: "object" } } },
  required: ["packets"],
  additionalProperties: false,
};

/**
 * A real child process standing in for codex: it records the schema file and the prompt it was handed, and answers
 * with `answer`, inside `result_json` when the schema it got is the envelope.
 */
async function withCodexStub(answer, fn) {
  const dir = mkdtempSync(join(tmpdir(), "codex-cli-stub-"));
  try {
    const capture = join(dir, "capture.json");
    const stub = join(dir, "codex");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ schema, prompt: args[args.length - 1] }));
const answer = ${JSON.stringify(answer)};
const message = schema.properties && schema.properties.result_json ? { result_json: JSON.stringify(answer) } : answer;
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(message));
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }) + "\\n");
`,
    );
    chmodSync(stub, 0o755);
    const captured = () => JSON.parse(readFileSync(capture, "utf8"));
    return await fn(stub, captured);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MODELED_COST = (600 / 1e6) * 2.0 + (400 / 1e6) * 0.2 + (50 / 1e6) * 12.0;

test("a schema strict mode accepts reaches --output-schema unchanged, with no envelope in the prompt", async () => {
  await withCodexStub({ ok: true }, async (codexBin, captured) => {
    const out = await new CodexCliAdapter(BASE_CONFIG, { codexBin }).execute(PACKET);
    assert.deepEqual(captured().schema, PACKET.outputSchema);
    assert.doesNotMatch(captured().prompt, /result_json/);
    assert.equal(out.success, true);
    assert.deepEqual(out.result, { ok: true });
  });
});

test("a schema strict mode would refuse is replaced by the envelope, and the value inside result_json comes back", async () => {
  const plan = { packets: [{ id: "p1", files: ["src/a.ts"] }, { id: "p2" }] };
  await withCodexStub(plan, async (codexBin, captured) => {
    const out = await new CodexCliAdapter(BASE_CONFIG, { codexBin }).execute({ ...PACKET, outputSchema: LOOSE_PLAN_SCHEMA });
    assert.deepEqual(captured().schema, STRICT_RESULT_ENVELOPE);
    assert.match(captured().prompt, /`result_json`/);
    assert.ok(
      captured().prompt.includes(JSON.stringify(LOOSE_PLAN_SCHEMA, null, 2)),
      "the model is told which schema the value inside result_json must match",
    );
    assert.equal(out.success, true);
    assert.equal(out.terminal_reason, "success");
    assert.deepEqual(out.result, plan);
    assert.ok(Math.abs(out.cost_usd - MODELED_COST) < 1e-9, "the envelope changes no cost accounting");
    assert.equal(out.cost_provenance, undefined);
  });
});

test("the shipped plan schemas take the enforced path: sent to --output-schema as they are, never enveloped", async () => {
  const plan = { packets: [] };
  for (const mode of ["greenfield", "brownfield"]) {
    const schema = JSON.parse(readFileSync(new URL(`../../../config/schemas/plan-packets.${mode}.json`, import.meta.url), "utf8"));
    await withCodexStub(plan, async (codexBin, captured) => {
      const out = await new CodexCliAdapter(BASE_CONFIG, { codexBin }).execute({ ...PACKET, phase: "plan_task_packets", outputSchema: schema });
      assert.deepEqual(captured().schema, schema, mode);
      assert.doesNotMatch(captured().prompt, /result_json/, mode);
      assert.equal(out.success, true);
      assert.deepEqual(out.result, plan);
    });
  }
});

test("result_json that is not JSON degrades to a raw wrapper, as a non-JSON final message does", async () => {
  const spawnFn = fakeSpawn(() => ({
    lastMessage: JSON.stringify({ result_json: "not json at all" }),
    stdout: usageLine({ input_tokens: 10, output_tokens: 4 }),
    code: 0,
  }));
  const out = await new CodexCliAdapter(BASE_CONFIG, { spawnFn }).execute({ ...PACKET, outputSchema: LOOSE_PLAN_SCHEMA });
  assert.equal(out.success, true);
  assert.deepEqual(out.result, { raw: "not json at all" });
});
