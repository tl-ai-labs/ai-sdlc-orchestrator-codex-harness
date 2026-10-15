/**
 * The recorder writes each attempt once, as it returns, and books the attempt
 * still in flight when the client gives up. Runs against dist/dispatchRecorder.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DispatchRecorder, packetPromptTokens } from "../dist/dispatchRecorder.js";

const PACKET = {
  id: "tp_rec_1",
  phase: "codegen",
  task_type: "implement",
  module: "core",
  instruction: "i".repeat(380),
  inputs: [{ path: "a.ts", content: "c".repeat(380), reason: "r" }],
  outputSchema: {},
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 512 },
  pass_id: "rec",
};
const ID = {
  packet: PACKET,
  decision: { modelId: "flash-completion", reason: "r", ruleIndex: 0 },
  policy: { name: "p", version: 1 },
  modelName: "gemini-3.7-flash",
};
const att = (n) => ({
  attempt_number: n,
  ceiling_used: 512 * n,
  hit_output_cap: n < 2,
  tokens: { input: 100, input_cached: 0, output: 10 },
  cost_usd: 0.001,
  latency_ms: 5,
  success: n >= 2,
});
const price = (n) => ({ cost_usd: n / 1e6, price_basis: "list", price_tier: "standard", price_verified: "2026-10-13" });

function withFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-recorder-"));
  try {
    const path = join(dir, "telemetry.jsonl");
    fn(path, () => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an attempt recorded live is not written again when the result returns", () => {
  withFile((path, read) => {
    const r = new DispatchRecorder(ID, path, Date.now(), price);
    r.record(att(1));
    assert.equal(read().length, 1, "written the moment it returned");
    r.finish({ result: {}, tokens: att(2).tokens, cost_usd: 0.002, latency_ms: 10, cache_hit: false, success: true, attempts: [att(1), att(2)] });
    assert.deepEqual(read().map((e) => e.attempt_number), [1, 2]);
    assert.equal(r.events.length, 2);
  });
});

test("the attempt in flight is booked once as an estimate, and nothing after it", () => {
  withFile((path, read) => {
    const r = new DispatchRecorder(ID, path, Date.now(), price);
    r.record(att(1));
    const ev = r.abandon("the client cancelled the call");
    assert.equal(ev.attempt_number, 2);
    assert.equal(ev.ceiling_used, 512);
    assert.equal(ev.provenance, "estimated");
    assert.equal(ev.usage_complete, false);
    assert.equal(ev.input_tokens, packetPromptTokens(PACKET));
    assert.equal(ev.cost_usd, packetPromptTokens(PACKET) / 1e6);
    assert.equal(r.abandon("again"), null);
    r.record(att(2));
    r.finish({ result: {}, tokens: att(2).tokens, cost_usd: 0, latency_ms: 0, cache_hit: false, success: false, attempts: [att(1), att(2)] });
    assert.deepEqual(read().map((e) => e.attempt_number), [1, 2]);
    assert.equal(read()[1].usage_complete, false);
  });
});

test("with no telemetry path the events are still built for the reply", () => {
  const r = new DispatchRecorder(ID, undefined, Date.now(), price);
  r.record(att(1));
  assert.equal(r.events.length, 1);
});

test("the placeholder estimate covers the instruction and every input", () => {
  assert.equal(packetPromptTokens(PACKET), Math.ceil(761 / 3.8));
});
