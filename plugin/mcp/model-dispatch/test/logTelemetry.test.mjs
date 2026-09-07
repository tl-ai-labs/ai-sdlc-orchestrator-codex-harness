/**
 * Regression tests for direct-tier telemetry normalization. Pins:
 * timestamp always server-stamped; latency always null (not zero) for
 * events this server did not itself measure. A model has no clock;
 * placeholder timestamps would corrupt manifest.duration_sec.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDirectTierEvent, appendEvent, readEvents, buildManifest } from "../dist/telemetry.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A direct-tier event shaped exactly like the one the 2026-08-04 run produced. */
function modelSuppliedEvent(overrides = {}) {
  return {
    ts: "2026-08-04T00:00:00.000Z", // the placeholder midnight a model invents
    pass: "pass1",
    phase: "requirements_analysis",
    task_type: "analysis",
    task_id: "tp_req_001",
    module: "all",
    model: "claude-opus-4-7",
    routed_by: "orchestrator",
    routing: { policy_name: "opus-plus-flash", policy_version: 1, rule_index: 0, rule_reason: "Judgment-heavy, low volume" },
    input_tokens: 9560,
    input_tokens_cached: 6100,
    output_tokens: 4650,
    cost_usd: 0.136575,
    latency_ms: 0, // the false "instant" a model invents
    success: true,
    retry_count: 0,
    provenance: "estimated",
    artifact_path: ".sdlc/requirements.md",
    ...overrides,
  };
}

test("overwrites the model's placeholder timestamp with the server's clock", () => {
  const now = new Date("2026-08-04T19:45:23.000Z");
  const out = normalizeDirectTierEvent(modelSuppliedEvent(), now);
  assert.equal(out.ts, "2026-08-04T19:45:23.000Z");
});

test("records latency as null, never the model's zero", () => {
  const out = normalizeDirectTierEvent(modelSuppliedEvent(), new Date());
  assert.equal(out.latency_ms, null);
  // Explicitly not 0 — a zero reads downstream as "returned instantly".
  assert.notEqual(out.latency_ms, 0);
});

test("a latency the model claims to have measured is still discarded", () => {
  // Even a plausible number is a guess: this server never saw the call.
  const out = normalizeDirectTierEvent(modelSuppliedEvent({ latency_ms: 8241 }), new Date());
  assert.equal(out.latency_ms, null);
});

test("every other field is carried through untouched", () => {
  const src = modelSuppliedEvent();
  const out = normalizeDirectTierEvent(src, new Date());
  for (const k of Object.keys(src)) {
    if (k === "ts" || k === "latency_ms") continue;
    assert.deepEqual(out[k], src[k], `field ${k} was altered`);
  }
  // Costs and tokens are the deliverable — they must survive verbatim.
  assert.equal(out.cost_usd, 0.136575);
  assert.equal(out.input_tokens, 9560);
});

test("does not mutate the caller's event object", () => {
  const src = modelSuppliedEvent();
  normalizeDirectTierEvent(src, new Date());
  assert.equal(src.ts, "2026-08-04T00:00:00.000Z");
  assert.equal(src.latency_ms, 0);
});

test("manifest run duration is real once events are normalized", () => {
  // The actual reason this bug mattered: buildManifest sorts on `ts`, so placeholder
  // midnights made started_at === ended_at and the run looked instantaneous.
  const dir = mkdtempSync(join(tmpdir(), "tele-"));
  const path = join(dir, "telemetry.jsonl");
  try {
    appendEvent(path, normalizeDirectTierEvent(modelSuppliedEvent(), new Date("2026-08-04T19:45:23.000Z")));
    appendEvent(path, normalizeDirectTierEvent(modelSuppliedEvent({ phase: "architecture_design" }), new Date("2026-08-04T19:56:45.000Z")));

    const events = readEvents(path);
    assert.equal(events.length, 2);
    const manifest = buildManifest(events, { pass: "pass1", policy_name: "opus-plus-flash" });
    assert.equal(manifest.started_at, "2026-08-04T19:45:23.000Z");
    assert.equal(manifest.ended_at, "2026-08-04T19:56:45.000Z");
    assert.notEqual(manifest.started_at, manifest.ended_at, "run must not look instantaneous");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── readEvents: an interrupted run must keep its complete events ─────────
//
// telemetry.jsonl is append-only and written incrementally precisely so a
// run killed mid-write leaves usable partial data (docs/running.md says so).
// readEvents used to throw on the truncated final line, discarding every
// complete event before it and making manifest.json unbuildable — the
// opposite of the promise. Both sibling readers already skip: report.mjs's
// readJsonl filters nulls, event-reader.mjs's parseEventStream continues.

test("readEvents keeps complete events when a killed run left a truncated last line", () => {
  const dir = mkdtempSync(join(tmpdir(), "tel-trunc-"));
  const path = join(dir, "telemetry.jsonl");
  try {
    const good = JSON.stringify({
      ts: "2026-09-01T10:00:00Z", pass: "p", phase: "codegen", task_type: "t",
      task_id: "1", module: "m", model: "gemini", input_tokens: 10,
      input_tokens_cached: 0, output_tokens: 5, cost_usd: 0.01,
      latency_ms: 100, success: true, retry_count: 0,
    });
    // Two complete events, then a line the process died halfway through.
    writeFileSync(path, `${good}\n${good}\n{"ts":"2026-09-01T10:01:00Z","cost_usd":0.02,"input_`);

    const events = readEvents(path);
    assert.equal(events.length, 2, "the two complete events must survive the partial third");
    assert.equal(buildManifest(events, { pass: "p", policy_name: "x" }).total_cost_usd, 0.02);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readEvents skips a garbage line mid-file without losing the events after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tel-mid-"));
  const path = join(dir, "telemetry.jsonl");
  try {
    const ev = (id) => JSON.stringify({
      ts: `2026-09-01T10:0${id}:00Z`, pass: "p", phase: "codegen", task_type: "t",
      task_id: String(id), module: "m", model: "gemini", input_tokens: 1,
      input_tokens_cached: 0, output_tokens: 1, cost_usd: 0.01,
      latency_ms: 1, success: true, retry_count: 0,
    });
    writeFileSync(path, `${ev(1)}\nnot json at all\n${ev(2)}\n`);
    assert.deepEqual(readEvents(path).map((e) => e.task_id), ["1", "2"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
