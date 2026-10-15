/**
 * Unit tests for plugin/scripts/session-hydrate.mjs — reads project state
 * for the orchestrator + commands to hand off (ticket §7.14, §10.1).
 *
 * Verifies: null-safe when no .sdlc/ present; reads project.json fields
 * (including default_policy); detects mid-setup resume from setup-status.json;
 * emits the one-line marker via --marker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "session-hydrate.mjs");

function run(cwd, args = []) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeRepo({ project, setupStatus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  const sdlc = join(dir, ".sdlc");
  if (project !== undefined) {
    mkdirSync(sdlc, { recursive: true });
    writeFileSync(join(sdlc, "project.json"), JSON.stringify(project));
  }
  if (setupStatus !== undefined) {
    mkdirSync(join(sdlc, "local"), { recursive: true });
    writeFileSync(join(sdlc, "local", "setup-status.json"), JSON.stringify(setupStatus));
  }
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("returns a well-formed empty payload when no .sdlc/ exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  try {
    const r = run(dir);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project, null, "project must be null when no .sdlc/");
    assert.equal(payload.baseline, null);
    assert.deepEqual(payload.recent_runs, []);
    assert.equal(payload.resume, null);
  } finally { cleanup(dir); }
});

test("exposes default_policy from project.json in the payload", async () => {
  const dir = makeRepo({ project: { schema_version: 1, default_policy: "my-custom" } });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project.default_policy, "my-custom", "default_policy must round-trip");
  } finally { cleanup(dir); }
});

test("exposes stacks and test_command when project.json has them", async () => {
  const dir = makeRepo({
    project: { schema_version: 1, stacks: ["nest"], test_command: "npm test" },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(payload.project.stacks, ["nest"]);
    assert.equal(payload.project.test_command, "npm test");
    assert.equal(payload.project.default_policy, null, "unset default_policy → null, not undefined");
  } finally { cleanup(dir); }
});

test("detects a pending setup from setup-status.json and returns a resume hint", async () => {
  const dir = makeRepo({
    setupStatus: {
      schema_version: 1,
      sections_done: ["install"],
      sections_pending: [{ number: 2, name: "environment" }, { number: 3, name: "credentials" }],
      timestamp: "2026-08-13T00:00:00Z",
    },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.ok(payload.resume, "resume hint must be present when sections_pending non-empty");
    assert.equal(payload.resume.pending, true);
    assert.equal(payload.resume.kind, "setup");
  } finally { cleanup(dir); }
});

test("no resume hint when setup-status.json shows all sections done", async () => {
  const dir = makeRepo({
    setupStatus: {
      schema_version: 1,
      sections_done: ["install", "environment"],
      sections_pending: [],
      status: "complete",
      timestamp: "2026-08-13T00:00:00Z",
    },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.resume, null, "no pending sections → no resume");
  } finally { cleanup(dir); }
});

test("--marker prints a single-line human summary", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    const r = run(dir, ["--marker"]);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "--marker must produce a single line");
    assert.match(lines[0], /SDLC/, "marker must be recognisable");
  } finally { cleanup(dir); }
});

test("tolerates corrupt project.json — treats it as absent, does not crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  try {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), "this is not json {[}");
    const r = run(dir);
    assert.equal(r.code, 0, "must not crash on corrupt project.json");
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project, null, "corrupt project.json → project null");
  } finally { cleanup(dir); }
});

// ── a run to resume, read from its own folder ────────────────────────

function runFolder(dir, id, files) {
  const runDir = join(dir, ".sdlc", "runs", id);
  mkdirSync(runDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(runDir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return runDir;
}
const sessionRun = (id, extra = {}) => ({ run_id: id, route: "interactive", mode: "brownfield", outcome: null, started_at: "2026-10-13T09:00:00.000Z", ...extra });

test("a session run that never recorded its end is offered for resume, with its phase from its own state.json", () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    runFolder(dir, "b1", {
      "run.json": sessionRun("b1"),
      "state.json": { run_id: "b1", phase: "architecture", gate: 2, status: "gate_pending", at: "2026-10-13T09:30:00.000Z" },
    });
    const { resume, marker } = JSON.parse(run(dir).stdout);
    assert.deepEqual(resume, {
      pending: true, kind: "run", run_id: "b1", route: "interactive", phase: "architecture", checkpoint: null,
      status: "gate_pending", at: "2026-10-13T09:30:00.000Z",
    });
    assert.match(marker, /resume: run b1 at architecture/);
  } finally { cleanup(dir); }
});

test("the run asking (--run-id) is never its own resume, and an ended or greenfield run is not offered", () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    runFolder(dir, "now", { "run.json": sessionRun("now", { started_at: "2026-10-13T10:00:00.000Z" }) });
    runFolder(dir, "done", { "run.json": sessionRun("done", { outcome: "stopped" }), "state.json": { status: "gate_pending" } });
    runFolder(dir, "green", { "run.json": sessionRun("green", { mode: "greenfield" }) });
    assert.equal(JSON.parse(run(dir, ["--run-id=now"]).stdout).resume, null);
    assert.equal(JSON.parse(run(dir, ["--run-id", "other"]).stdout).resume.run_id, "now", "without its own id, the asking run looks interrupted");
  } finally { cleanup(dir); }
});

test("the old shared .sdlc/local/state.json is no longer read", () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "state.json"), JSON.stringify({ run_id: "old", phase: "codegen", status: "gate_pending" }));
    assert.equal(JSON.parse(run(dir).stdout).resume, null);
  } finally { cleanup(dir); }
});

test("a run.mjs run stopped at a gate with no run end is offered, and says it is headless", () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    const events = (...kinds) => kinds.map((kind) => JSON.stringify({ v: 1, kind })).join("\n") + "\n";
    runFolder(dir, "h1", { "driver-events.jsonl": events("invocation_start", "codex"), "state.json": { phase: "requirements", status: "gate_pending" } });
    runFolder(dir, "h2", { "driver-events.jsonl": events("invocation_start", "run_end"), "state.json": { status: "gate_pending" } });
    const { resume } = JSON.parse(run(dir, ["--sdlc", join(dir, ".sdlc")]).stdout);
    assert.equal(resume.run_id, "h1");
    assert.equal(resume.route, "headless");
    assert.equal(resume.phase, "requirements");
  } finally { cleanup(dir); }
});

test("a run whose write-contract lock is live outranks a newer run, and --sdlc= names the folder", () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    runFolder(dir, "held", {
      "write-contract.lock.json": { schema_version: 1, run_id: "held", sha256: "0".repeat(64), frozen_at: "2026-10-01T00:00:00.000Z", ended_at: null },
    });
    runFolder(dir, "newer", { "run.json": sessionRun("newer", { started_at: "2026-10-13T00:00:00.000Z" }) });
    const { resume } = JSON.parse(run(tmpdir(), [`--sdlc=${join(dir, ".sdlc")}`, "--run-id=newer"]).stdout);
    assert.equal(resume.run_id, "held");
    assert.equal(resume.write_contract, "live");
    assert.equal(resume.status, "live");
  } finally { cleanup(dir); }
});
