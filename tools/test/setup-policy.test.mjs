/**
 * Unit tests for plugin/scripts/setup-policy.mjs — the shepherd helper that
 * writes per-project default_policy and reads it back for the commands.
 *
 * Interactive-flow paths (dev-server spawn, browser open, stdin prompt) are
 * not tested here — they need a live Next.js dev server. Scripted and
 * --print-only paths are the ones the commands depend on at runtime, and
 * both must work with and without git.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "setup-policy.mjs");

function run(cwd, args, extraEnv = {}) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function newTmpDir() {
  return mkdtempSync(join(tmpdir(), "setup-policy-test-"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("--print-only in a folder without .sdlc/ prints an empty line and exits 0", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "", "no default_policy → empty stdout");
  } finally { cleanup(dir); }
});

test("--print-only tolerates a folder without git — does not fail", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0, "must never fail --print-only, even without git");
  } finally { cleanup(dir); }
});

test("--policy=<name> writes to .sdlc/project.json in a non-git folder (with a git-fallback note)", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--policy=opus-only"]);
    assert.equal(r.code, 0);
    const path = join(dir, ".sdlc", "project.json");
    assert.ok(existsSync(path), "must create .sdlc/project.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.default_policy, "opus-only");
    assert.match(r.stderr, /not inside a git repository/i, "must surface the git-fallback note");
  } finally { cleanup(dir); }
});

test("--print-only reads back what --policy just wrote", () => {
  const dir = newTmpDir();
  try {
    run(dir, ["--policy=opus-plus-flash"]);
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "opus-plus-flash", "round-trip must preserve the name");
  } finally { cleanup(dir); }
});

test("--policy rejects an unknown policy name (fail-loud)", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--policy=nonexistent-policy-xyz"]);
    assert.notEqual(r.code, 0, "unknown policy must fail");
    assert.match(r.stderr, /not found/i, "must name the failure");
  } finally { cleanup(dir); }
});

test("--policy is idempotent — running twice with the same name is safe", () => {
  const dir = newTmpDir();
  try {
    run(dir, ["--policy=opus-only"]);
    const r = run(dir, ["--policy=opus-only"]);
    assert.equal(r.code, 0, "second run must succeed");
    const parsed = JSON.parse(readFileSync(join(dir, ".sdlc", "project.json"), "utf8"));
    assert.equal(parsed.default_policy, "opus-only");
  } finally { cleanup(dir); }
});

test("--policy preserves other fields in an existing project.json", () => {
  const dir = newTmpDir();
  try {
    // Simulate an existing project.json written earlier by discovery.
    const sdlcDir = join(dir, ".sdlc");
    mkdirSync(sdlcDir, { recursive: true });
    writeFileSync(
      join(sdlcDir, "project.json"),
      JSON.stringify({ schema_version: 1, stacks: ["nest"], test_command: "npm test" }),
    );
    run(dir, ["--policy=opus-only"]);
    const parsed = JSON.parse(readFileSync(join(sdlcDir, "project.json"), "utf8"));
    assert.deepEqual(parsed.stacks, ["nest"], "must preserve pre-existing stacks");
    assert.equal(parsed.test_command, "npm test", "must preserve pre-existing test_command");
    assert.equal(parsed.default_policy, "opus-only", "must add the new field");
  } finally { cleanup(dir); }
});

// ── terminal picker helpers (--list-json / --check-creds / --guard-active-run) ─────

test("--list-json on the shipped policies dir returns correctly-shaped JSON entries", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--list-json"]);
    assert.equal(r.code, 0);
    const list = JSON.parse(r.stdout);
    assert.ok(Array.isArray(list), "must be an array");
    assert.ok(list.length >= 2, "must include the shipped presets");
    const opusPlusFlash = list.find((p) => p.name === "opus-plus-flash");
    assert.ok(opusPlusFlash, "must include opus-plus-flash");
    assert.ok(Array.isArray(opusPlusFlash.adapters), "adapters array");
    assert.ok(Array.isArray(opusPlusFlash.required_env), "required_env array");
    assert.equal(typeof opusPlusFlash.requires_vertex_adc, "boolean");
    assert.equal(typeof opusPlusFlash.requires_claude_cli, "boolean");
    // opus-plus-flash uses builtin-anthropic + mcp:model-dispatch + antigravity-worker
    assert.ok(opusPlusFlash.required_env.includes("ANTHROPIC_API_KEY"));
    assert.ok(opusPlusFlash.required_env.includes("GEMINI_API_KEY"));
    assert.equal(opusPlusFlash.requires_vertex_adc, true, "antigravity-worker → vertex ADC");
  } finally { cleanup(dir); }
});

test("--list-json includes malformed YAML as { name, error } entry", () => {
  const dir = newTmpDir();
  const policiesDir = newTmpDir();
  try {
    // Seed the fixture with one good-shape file and one malformed file.
    writeFileSync(join(policiesDir, "good.yaml"), [
      "version: 1",
      "name: good",
      "models:",
      "  - id: opus",
      "    adapter: builtin-anthropic",
      "    model_name: claude-opus-4-7",
      "    auth: { env: ANTHROPIC_API_KEY }",
      "",
    ].join("\n"));
    writeFileSync(join(policiesDir, "malformed.yaml"), "this is not a policy at all\n");

    const r = run(dir, ["--list-json"], { SDLC_POLICIES_DIR_FOR_TESTS: policiesDir });
    assert.equal(r.code, 0);
    const list = JSON.parse(r.stdout);
    const bad = list.find((p) => p.name === "malformed");
    assert.ok(bad, "malformed entry must be present");
    assert.ok(bad.error, "malformed entry must carry an `error` field");
    const good = list.find((p) => p.name === "good");
    assert.ok(good, "good entry must be present");
    assert.ok(!good.error, "good entry must not carry an error");
    assert.deepEqual(good.adapters, ["builtin-anthropic"]);
    assert.deepEqual(good.required_env, ["ANTHROPIC_API_KEY"]);
  } finally { cleanup(policiesDir); cleanup(dir); }
});

test("--check-creds reports missing env vars with fix strings", () => {
  const dir = newTmpDir();
  try {
    // Wipe ANTHROPIC_API_KEY + GEMINI_API_KEY from the subprocess env by
    // spawning without them. Node's spawn env replaces the whole env when set.
    const scrubbed = { ...process.env };
    delete scrubbed.ANTHROPIC_API_KEY;
    delete scrubbed.GEMINI_API_KEY;
    const r = spawnSync("node", [SCRIPT, "--check-creds", "--policy=opus-plus-flash"], {
      cwd: dir,
      encoding: "utf8",
      env: scrubbed,
    });
    assert.equal(r.status, 0, `exit 0 expected, got ${r.status}. stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false, "missing creds → ok:false");
    const missingNames = parsed.missing.filter((m) => m.kind === "env").map((m) => m.name);
    assert.ok(missingNames.includes("ANTHROPIC_API_KEY"), "must flag ANTHROPIC_API_KEY");
    assert.ok(missingNames.includes("GEMINI_API_KEY"), "must flag GEMINI_API_KEY");
    for (const m of parsed.missing) {
      assert.ok(m.fix, `missing entry must carry a fix string: ${JSON.stringify(m)}`);
    }
  } finally { cleanup(dir); }
});

test("--check-creds returns ok:true when required env vars are present", () => {
  const dir = newTmpDir();
  try {
    // Use a policy that only needs ANTHROPIC_API_KEY (opus-only).
    const scrubbed = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-value" };
    const r = spawnSync("node", [SCRIPT, "--check-creds", "--policy=opus-only"], {
      cwd: dir,
      encoding: "utf8",
      env: scrubbed,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    // opus-only doesn't need vertex/claude-cli, so ok should be true.
    assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed)}`);
  } finally { cleanup(dir); }
});

test("--check-creds refuses when --policy is missing", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--check-creds"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--policy/);
  } finally { cleanup(dir); }
});

test("--guard-active-run reports active:false when there is no state.json", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--guard-active-run"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.active, false);
  } finally { cleanup(dir); }
});

test("--guard-active-run reports active:true for an in-flight run", () => {
  const dir = newTmpDir();
  try {
    const stateDir = join(dir, ".sdlc", "local");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({
      run_id: "run-abc",
      phase: "codegen",
      status: "in_progress",
    }));
    const r = run(dir, ["--guard-active-run"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.active, true);
    assert.equal(parsed.run_id, "run-abc");
    assert.equal(parsed.phase, "codegen");
  } finally { cleanup(dir); }
});

test("--guard-active-run treats terminal statuses as inactive", () => {
  const dir = newTmpDir();
  try {
    const stateDir = join(dir, ".sdlc", "local");
    mkdirSync(stateDir, { recursive: true });
    for (const status of ["complete", "completed", "aborted", "failed"]) {
      writeFileSync(join(stateDir, "state.json"), JSON.stringify({
        run_id: "run-x", phase: "docs", status,
      }));
      const r = run(dir, ["--guard-active-run"]);
      assert.equal(r.code, 0, `status=${status}: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.active, false, `status=${status} must be inactive`);
    }
  } finally { cleanup(dir); }
});

test("--guard-active-run tolerates malformed state.json (treats as inactive)", () => {
  const dir = newTmpDir();
  try {
    const stateDir = join(dir, ".sdlc", "local");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), "not valid json {");
    const r = run(dir, ["--guard-active-run"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.active, false, "malformed state.json → inactive, not a crash");
  } finally { cleanup(dir); }
});
