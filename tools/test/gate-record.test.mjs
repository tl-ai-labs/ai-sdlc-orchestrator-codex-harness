/** Every reader of gates.jsonl reads a line the same way, and every prompt asks for the same line. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gateDecision, gateLine, gateNumber, gatesOutcome, parseGateLines } from "../../plugin/scripts/lib/gate-record.mjs";
import { gate4Acceptance, stopCheck } from "../../plugin/codex/run-record.mjs";
import { checkCompleted, GATE_RECORD } from "../../plugin/codex/interactive-run.mjs";
import { GATE_MODES } from "../../plugin/codex/run.mjs";
import { closeContract, ContractRefusal, freezeContract } from "../../plugin/scripts/write-contract.mjs";
import { writeManifest } from "../../plugin/scripts/write-manifest.mjs";
import "./lib/stand-ins.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function repo(lines) {
  const root = mkdtempSync(join(tmpdir(), "gate-record-"));
  mkdirSync(join(root, ".git"));
  freezeContract({ projectRoot: root, runId: "r1", allowlist: ["src/**"] });
  const runDir = join(root, ".sdlc", "runs", "r1");
  for (const l of lines) appendFileSync(join(runDir, "gates.jsonl"), JSON.stringify(l) + "\n");
  return { root, runDir, done: () => rmSync(root, { recursive: true, force: true }) };
}

function closeOutcome(root) {
  try {
    return closeContract({ projectRoot: root, runId: "r1" }).outcome;
  } catch (err) {
    if (err instanceof ContractRefusal) return null;
    throw err;
  }
}

test("an answer under decision or status reads the same, in any case, with the reply words mapped", () => {
  assert.equal(gateDecision({ decision: "approved" }), "approved");
  assert.equal(gateDecision({ status: "Pending " }), "pending");
  assert.equal(gateDecision({ decision: "Accept" }), "accepted");
  assert.equal(gateDecision({ status: "abort" }), "aborted");
  assert.equal(gateDecision({ decision: "accepted", status: "pending" }), "accepted", "decision wins over status");
  assert.equal(gateDecision({}), "");
  assert.equal(gateNumber({ gate: 4 }), 4);
  assert.equal(gateNumber({ gate: "gate-4" }), 4);
  assert.equal(gateNumber({ gate: "G4" }), 4);
  assert.equal(gateNumber({ gate: 4.5 }), null);
  assert.deepEqual(parseGateLines('{"gate":1}\nnot json\n[1]\n\n{"gate":2}\n'), [{ gate: 1 }, { gate: 2 }]);
});

test("the run's completion check, the session's end check and the brownfield close-out agree on every gate log", () => {
  const cases = [
    [[{ gate: 4, decision: "accepted" }], "completed"],
    [[{ gate: "gate-4", status: "accepted" }], "completed"],
    [[{ gate: 4, decision: "Accept" }], "completed"],
    [[{ gate: 4, decision: "auto-approved" }], "completed"],
    [[{ gate: 4, status: "pending" }], null],
    [[{ gate: 4, decision: "accepted" }, { gate: 4, decision: "rejected", note: "tests fail" }], null],
    [[{ gate: 4, decision: "rejected" }, { gate: 4, status: "approved" }], "completed"],
    [[{ gate: 3, decision: "accepted" }], null],
    [[{ gate: 2, status: "abort" }], "aborted"],
  ];
  for (const [lines, expected] of cases) {
    const r = repo(lines);
    const label = JSON.stringify(lines);
    try {
      const completed = expected === "completed";
      assert.equal(gatesOutcome(lines), expected, label);
      assert.equal(gate4Acceptance(r.runDir) !== null, completed, `run.mjs: ${label}`);
      const session = checkCompleted(r.runDir);
      assert.equal(session.missing.some((m) => /Gate 4/.test(m)), !completed, `end-run: ${label}`);
      assert.equal(closeOutcome(r.root), expected, `write-contract --close: ${label}`);
    } finally { r.done(); }
  }
});

test("an abort recorded under status stops a headless run", () => {
  const r = repo([{ gate: 2, artifact: "design.md", status: "Aborted", note: "wrong stack" }]);
  try {
    const stop = stopCheck({ runDir: r.runDir, projectRoot: r.root, runId: "r1", gateMode: "auto-approve", startedAtMs: Date.now() - 1000 });
    assert.equal(stop.outcome, "aborted");
    assert.match(stop.reason, /gate 2 aborted: wrong stack/);
  } finally { r.done(); }
});

test("manifest.json lists each gate with its answer under decision", () => {
  const r = repo([
    { gate: 1, artifact: "requirements.md", status: "approved", run_id: "r1" },
    { gate: 2, artifact: "design.md", decision: "revise", note: "split the module" },
  ]);
  try {
    const { manifest } = writeManifest({ runDir: r.runDir, runId: "r1", policy: "gpt-plus-flash", projectRoot: r.root });
    assert.deepEqual(manifest.gates.map((g) => [g.gate, g.decision]), [[1, "approved"], [2, "revise"]]);
    assert.equal(manifest.gates[0].status, "approved", "the line as written is kept");
  } finally { r.done(); }
});

test("a line run.mjs writes itself has the prompts' shape", () => {
  const line = gateLine({ gate: 3, decision: "aborted", note: "no answer", recorded_by: "run.mjs" }, new Date("2026-10-14T08:00:00Z"));
  assert.deepEqual(line, { gate: 3, artifact: null, decision: "aborted", note: "no answer", ts: "2026-10-14T08:00:00.000Z", recorded_by: "run.mjs" });
});

const SHAPE = ["gate", "artifact", "decision", "note", "ts"];

function gateExamples(text) {
  return [...String(text).matchAll(/\{"gate": [^}\n]*\}/g)].map((m) => m[0]);
}

test("the conductor prompt, the playbooks and the start scripts all ask for {gate, artifact, decision, note, ts}", () => {
  const sources = {
    "plugin/codex/prompts/conductor.md": readFileSync(join(REPO, "plugin/codex/prompts/conductor.md"), "utf-8"),
    "plugin/skills/pipeline/SKILL.md": readFileSync(join(REPO, "plugin/skills/pipeline/SKILL.md"), "utf-8"),
    "plugin/skills/brownfield-guide/SKILL.md": readFileSync(join(REPO, "plugin/skills/brownfield-guide/SKILL.md"), "utf-8"),
    "interactive-run.mjs GATE_RECORD": GATE_RECORD,
    "run.mjs GATE_MODES.prompt": GATE_MODES.prompt,
  };
  for (const [name, text] of Object.entries(sources)) {
    const examples = gateExamples(text).filter((e) => !e.includes('"phase"'));
    assert.ok(examples.length > 0, `${name} shows a gate line`);
    for (const example of examples) {
      const keys = [...example.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
      assert.ok(keys.includes("decision") && keys.includes("ts"), `${name}: ${example}`);
      assert.ok(!keys.includes("status"), `${name} never asks for status: ${example}`);
      assert.deepEqual(keys.filter((k) => !SHAPE.includes(k)), [], `${name}: ${example}`);
    }
  }
});
