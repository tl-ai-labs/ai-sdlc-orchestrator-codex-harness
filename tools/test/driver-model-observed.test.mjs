/** A headless run records the model and effort codex's session file says each conductor thread ran on. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { regenerateDriverFiles } from "../../plugin/codex/run-finalize.mjs";
import { observedSessionModels } from "../../plugin/codex/session-model.mjs";
import { parseDriverRecords } from "../../plugin/mcp/model-dispatch/dist/driverUsage.js";
import { sessionHome } from "./fixtures/session-home.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-0.160.1");
const THREAD = "01a1340d-41da-7e31-84cd-b0907e9bc31f";
const PIN = { model: "gpt-5.6-terra", effort: "high" };
const NOW = new Date("2026-10-13T10:15:00Z");
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function home(threads, opts) {
  const h = sessionHome(threads, opts);
  temps.push(h);
  return h;
}

function records() {
  const lines = [{ v: 1, kind: "invocation_start", run_id: "r1", invocation: 1, at: "2026-10-13T10:00:00.000Z", mode: "fresh" }];
  for (const raw of readFileSync(join(FIXTURES, "exec1.jsonl"), "utf-8").split("\n").filter((l) => l.trim())) {
    lines.push({ v: 1, kind: "codex", invocation: 1, thread_id: THREAD, received_at: "2026-10-13T10:00:01.000Z", event: JSON.parse(raw) });
  }
  lines.push({ v: 1, kind: "invocation_end", invocation: 1, at: "2026-10-13T10:00:59.000Z", thread_id: THREAD, exit_status: 0, ended_by: "exit", signal: null });
  return parseDriverRecords(lines.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function regenerate(codexHome) {
  const runDir = mkdtempSync(join(tmpdir(), "driver-model-"));
  temps.push(runDir);
  mkdirSync(runDir, { recursive: true });
  const driver = {
    pricing: { input: 2.0, input_cached: 0.2, output: 12.0 },
    model: PIN.model,
    policyName: "gpt-plus-flash",
    pin: PIN,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    auth: "unknown",
    codexHome,
  };
  const { manifest } = regenerateDriverFiles({ runDir, runId: "r1", records: records(), driver });
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, "driver-manifest.json"), "utf-8")).driver_model_observed, manifest.driver_model_observed);
  return manifest.driver_model_observed;
}

test("the session file confirms the pin for each conductor thread", () => {
  const observed = regenerate(home([THREAD]));
  assert.equal(observed.status, "match");
  assert.deepEqual(observed.pin, PIN);
  assert.equal(observed.threads.length, 1);
  assert.equal(observed.threads[0].thread_id, THREAD);
  assert.deepEqual(observed.threads[0].observed, { model: "gpt-5.6-terra", effort: "high", effort_source: "turn" });
  assert.match(observed.threads[0].rollout_path, new RegExp(`rollout-.*-${THREAD}\\.jsonl$`));
});

test("a thread the session file shows on another model is recorded as a mismatch", () => {
  const observed = regenerate(home([THREAD], { model: "gpt-6.1-sol" }));
  assert.equal(observed.status, "mismatch");
  assert.equal(observed.threads[0].observed.model, "gpt-6.1-sol");
});

test("no session file leaves the model unverified, and no codex home reads nothing", () => {
  const missing = regenerate(home([]));
  assert.equal(missing.status, "unverified");
  assert.match(missing.threads[0].reason, /no rollout file for thread/);
  assert.equal(regenerate(null), null);
});

test("several threads: any mismatch wins, and a run with no thread is unverified", () => {
  const h = home(["t-a", "t-b"]);
  assert.equal(observedSessionModels(["t-a", "t-b", "t-a"], { codexHome: h, pin: PIN, now: NOW }).threads.length, 2);
  assert.equal(observedSessionModels(["t-a", "t-c"], { codexHome: h, pin: PIN, now: NOW }).status, "unverified");
  assert.equal(observedSessionModels([], { codexHome: h, pin: PIN, now: NOW }).status, "unverified");
  const other = home(["t-x"], { model: "gpt-6.1-sol" });
  assert.equal(observedSessionModels(["t-x"], { codexHome: other, pin: PIN, now: NOW }).status, "mismatch");
});
