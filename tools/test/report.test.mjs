/**
 * Guards the post-run cost report.
 *
 * The load-bearing property is arithmetic honesty. Two failure modes matter
 * more than formatting:
 *
 *   1. The phase rows not summing to the stated total. A reader who checks
 *      the addition and finds it wrong stops trusting every other number.
 *   2. The modeled driver cost leaking into the vendor total. Codex reports
 *      no wallet figures, so the driver leg's cost is derived, not measured —
 *      and on a seat-backed driver it may correspond to no money at all.
 *      Merging the two produces a figure that is neither the API bill nor
 *      the seat usage, which is the specific dishonesty D4 exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(REPO_ROOT, "tools", "report.mjs");

function runReport(dir, extra = []) {
  return spawnSync("node", [REPORT, dir, ...extra], { encoding: "utf8", timeout: 30_000 });
}

function event(overrides = {}) {
  return JSON.stringify({
    ts: "2026-09-01T10:00:00Z", pass: "r1", phase: "codegen", task_type: "x",
    task_id: "tp_1", module: "m", model: "gemini-3.7-flash", provenance: "vendor",
    routed_by: "orchestrator",
    routing: { policy_name: "gpt-plus-flash", policy_version: 1, rule_index: 0, rule_reason: "r" },
    input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100,
    cost_usd: 0.01, latency_ms: 100, success: true, retry_count: 0,
    ...overrides,
  });
}

function makeRun({ telemetry = [], modeled = [], driverManifest = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "report-test-"));
  if (telemetry.length) writeFileSync(join(dir, "telemetry.jsonl"), telemetry.join("\n") + "\n");
  if (modeled.length) writeFileSync(join(dir, "driver-cost-modeled.jsonl"), modeled.join("\n") + "\n");
  if (driverManifest) writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify(driverManifest));
  return dir;
}
const cleanup = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } };

// ── the arithmetic ───────────────────────────────────────────────────

test("phase costs sum to the stated vendor total", () => {
  const dir = makeRun({
    telemetry: [
      event({ phase: "requirements_analysis", task_id: "a", cost_usd: 0.0344 }),
      event({ phase: "codegen", task_id: "b", cost_usd: 0.02 }),
      event({ phase: "security_review", task_id: "c", cost_usd: 0.0364 }),
    ],
  });
  try {
    const out = runReport(dir).stdout;
    // 0.0344 + 0.02 + 0.0364 = 0.0908
    assert.match(out, /Vendor-metered total\s+\$0\.0908/);
  } finally { cleanup(dir); }
});

test("the modeled driver cost is NOT added into the vendor total", () => {
  const dir = makeRun({
    telemetry: [event({ cost_usd: 0.05 })],
    modeled: [event({ phase: "driver_loop", provenance: "modeled", task_id: "d1", cost_usd: 0.99 })],
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /Vendor-metered total\s+\$0\.0500/, "vendor total must exclude the modeled figure");
    assert.match(out, /Modeled cost\s+\$0\.9900/, "the modeled figure still has to be reported");
    assert.ok(!/Vendor-metered total\s+\$1\.04/.test(out), "the two must never be summed together");
  } finally { cleanup(dir); }
});

test("the modeled section says plainly that it is not measured spend", () => {
  const dir = makeRun({
    telemetry: [event()],
    modeled: [event({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.1 })],
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /modeled, not measured/i);
    assert.match(out, /NOT an amount anyone was billed/i);
  } finally { cleanup(dir); }
});

test("SDLC work and runner overhead are counted separately", () => {
  const dir = makeRun({
    telemetry: [
      event({ phase: "codegen", task_id: "a", cost_usd: 0.03 }),
      event({ phase: "driver_loop", task_id: "b", cost_usd: 0.07 }),
    ],
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /SDLC total\s+1\s+\$0\.0300/);
    assert.match(out, /Runner overhead\s+1\s+\$0\.0700/);
    assert.match(out, /Vendor-metered total\s+\$0\.1000/, "the two still sum to the vendor total");
  } finally { cleanup(dir); }
});

// ── doubling attempts ────────────────────────────────────────────────

test("retry attempts collapse into one packet row carrying the summed cost", () => {
  const dir = makeRun({
    telemetry: [
      event({ task_id: "tp_cg_1", cost_usd: 0.01, attempt_number: 1, ceiling_used: 2000 }),
      event({ task_id: "tp_cg_1", cost_usd: 0.02, attempt_number: 2, ceiling_used: 4000 }),
    ],
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /output cap/i, "a retried packet must be surfaced");
    assert.match(out, /tp_cg_1.*2 attempts.*\$0\.0300/s, "cost must cover all attempts, not the last one");
  } finally { cleanup(dir); }
});

// ── provenance ───────────────────────────────────────────────────────

test("a phase with mixed provenance is tagged as mixed, not silently as one", () => {
  const dir = makeRun({
    telemetry: [
      event({ phase: "codegen", task_id: "a", provenance: "vendor" }),
      event({ phase: "codegen", task_id: "b", provenance: "estimated" }),
    ],
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /codegen\s+~/, "a phase mixing provenances must not claim a single one");
  } finally { cleanup(dir); }
});

test("unlabelled events are reported as unknown rather than assumed vendor", () => {
  const dir = makeRun({ telemetry: [event({ provenance: undefined })] });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /1 unknown/, "an event with no provenance must not be counted as vendor");
  } finally { cleanup(dir); }
});

// ── pins and failure surfacing ───────────────────────────────────────

test("the report prints the pins the run actually used", () => {
  const dir = makeRun({
    telemetry: [event()],
    driverManifest: {
      run_id: "r9", policy: "gpt-plus-flash",
      pin: { model: "gpt-5.6-terra", effort: "high", sandbox: "workspace-write", approval_policy: "never" },
    },
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /gpt-5\.6-terra/);
    assert.match(out, /effort high/);
    assert.match(out, /workspace-write/);
  } finally { cleanup(dir); }
});

test("a pin rejection recorded by the driver is surfaced, not buried", () => {
  const dir = makeRun({
    telemetry: [event()],
    driverManifest: { run_id: "r", pin_rejection: "[ReasoningEffortParam] invalid_enum_value" },
  });
  try {
    const out = runReport(dir).stdout;
    assert.match(out, /Pin rejected during this run/);
    assert.match(out, /invalid_enum_value/);
  } finally { cleanup(dir); }
});

// ── robustness ───────────────────────────────────────────────────────

test("a run with only driver turns still reports, rather than erroring", () => {
  const dir = makeRun({
    modeled: [event({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.11 })],
  });
  try {
    const r = runReport(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No dispatched calls recorded/);
    assert.match(r.stdout, /Modeled cost\s+\$0\.1100/);
  } finally { cleanup(dir); }
});

test("a run directory with no telemetry at all exits non-zero with an explanation", () => {
  const dir = makeRun({});
  try {
    const r = runReport(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /No telemetry found/);
    assert.match(r.stderr, /halted at preflight produces neither/, "the commonest cause should be named");
  } finally { cleanup(dir); }
});

test("a malformed telemetry line is skipped rather than crashing the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-test-"));
  try {
    writeFileSync(join(dir, "telemetry.jsonl"), event({ cost_usd: 0.02 }) + "\nnot json at all\n");
    const r = runReport(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\$0\.0200/);
  } finally { cleanup(dir); }
});

test("a missing run directory is a usage error, not a stack trace", () => {
  const r = runReport("/nonexistent/run/dir");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

test("--markdown renders tables instead of the box drawing", () => {
  const dir = makeRun({ telemetry: [event()] });
  try {
    const out = runReport(dir, ["--markdown"]).stdout;
    assert.match(out, /^# Run report/m);
    assert.match(out, /\|---\|/);
    assert.ok(!/┌/.test(out), "markdown output must not carry terminal box characters");
  } finally { cleanup(dir); }
});
