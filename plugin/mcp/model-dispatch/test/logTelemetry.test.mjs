/**
 * Regression tests for direct-tier telemetry normalization. Pins:
 * timestamp always server-stamped; latency always null (not zero) for
 * events this server did not itself measure. A model has no clock;
 * placeholder timestamps would corrupt manifest.duration_sec.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDirectTierEvent, appendEvent, readEvents, buildManifest } from "../dist/telemetry.js";
import { mkdtempSync, rmSync } from "node:fs";
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
