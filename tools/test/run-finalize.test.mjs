/** What run-finalize.mjs writes at every run end: the status mapping and a manifest write that fails open. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeRun, manifestStatus } from "../../plugin/codex/run-finalize.mjs";
import { writeManifest } from "../../plugin/scripts/write-manifest.mjs";

const PIN = { model: "gpt-5.6-terra", effort: "high" };
const DRIVER = {
  pricing: { input: 2.0, input_cached: 0.2, output: 12.0 },
  model: PIN.model,
  policyVersion: 1,
  pin: PIN,
  sandbox: "workspace-write",
  approvalPolicy: "never",
  auth: "unknown",
};

function runFolder() {
  const root = mkdtempSync(join(tmpdir(), "run-finalize-"));
  const runDir = join(root, ".sdlc", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  return {
    root,
    runDir,
    gates: (rows) => writeFileSync(join(runDir, "gates.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    phase9: (status) => writeManifest({ runDir, runId: "r1", policy: "gpt-plus-flash", projectRoot: root, status, summary: true }),
    manifest: () => JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const finalize = (f, outcome) =>
  finalizeRun({ projectRoot: f.root, runDir: f.runDir, runId: "r1", outcome, policyName: "gpt-plus-flash", records: [], driver: DRIVER });

test("an outcome that is not completed maps to the manifest status run.mjs writes", () => {
  const f = runFolder();
  try {
    const table = {
      max_turns: "incomplete",
      codex_failed: "failed",
      aborted: "aborted",
      halted: "halted",
      refused: "refused",
      stopped: "stopped",
      cost_cap: "cost_cap",
      pin_rejected: "pin_rejected",
      interrupted: "interrupted",
    };
    for (const [outcome, status] of Object.entries(table)) assert.equal(manifestStatus(outcome, f.runDir), status, outcome);
  } finally {
    f.cleanup();
  }
});

test("a completed run keeps the status the conductor's Gate 4 re-run wrote, whatever the gate line's wording", () => {
  const f = runFolder();
  try {
    f.gates([{ gate: 4, decision: "approved" }]);
    f.phase9("auto-approved");
    assert.equal(manifestStatus("completed", f.runDir), "auto-approved", "an 'approved' line under auto-approve is not a person's acceptance");
    f.gates([{ gate: 4, decision: "auto-approved" }]);
    f.phase9("accepted");
    assert.equal(manifestStatus("completed", f.runDir), "accepted");
  } finally {
    f.cleanup();
  }
});

test("a completed run with no accepted code-written status falls back to the Gate 4 line", () => {
  const f = runFolder();
  try {
    f.gates([{ gate: 4, decision: "auto-approved" }]);
    assert.equal(manifestStatus("completed", f.runDir), "auto-approved");
    f.phase9("provisional");
    assert.equal(manifestStatus("completed", f.runDir), "auto-approved");
    f.gates([{ gate: 4, status: "approved" }]);
    assert.equal(manifestStatus("completed", f.runDir), "accepted");
  } finally {
    f.cleanup();
  }
});

test("finalizeRun writes the outcome's status into manifest.json, and a manifest it cannot write is a note", async () => {
  const f = runFolder();
  try {
    let r = await finalize(f, "codex_failed");
    assert.equal(f.manifest().status, "failed");
    assert.equal(r.manifest.status, "failed");
    assert.ok(existsSync(join(f.runDir, "driver-manifest.json")));

    rmSync(join(f.runDir, "manifest.json"));
    mkdirSync(join(f.runDir, "manifest.json"));
    r = await finalize(f, "aborted");
    assert.equal(r.manifest, null);
    assert.ok(r.notes.some((n) => /^manifest\.json was not written: /.test(n)), r.notes.join("\n"));
    assert.ok(r.driverManifest, "the driver record is still rebuilt");
  } finally {
    f.cleanup();
  }
});
