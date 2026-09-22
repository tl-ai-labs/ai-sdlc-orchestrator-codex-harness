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
