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
import { appendFileSync, mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The agent-path policies make --check-creds run `gcloud auth application-default
// print-access-token`; the stand-ins put an offline gcloud first on PATH.
import "./lib/stand-ins.mjs";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "setup-policy.mjs");
const CLAUDE_POLICIES = resolve(fileURLToPath(import.meta.url), "..", "fixtures", "policies", "claude");
const RUNNABLE = ["flash-agsdk-only", "gpt-plus-flash", "gpt-plus-flash-38", "gpt-seat-plus-flash"];

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
    const r = run(dir, ["--policy=gpt-seat-plus-flash"]);
    assert.equal(r.code, 0);
    const path = join(dir, ".sdlc", "project.json");
    assert.ok(existsSync(path), "must create .sdlc/project.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.default_policy, "gpt-seat-plus-flash");
    assert.match(r.stderr, /not inside a git repository/i, "must surface the git-fallback note");
  } finally { cleanup(dir); }
});

test("--print-only reads back what --policy just wrote", () => {
  const dir = newTmpDir();
  try {
    run(dir, ["--policy=gpt-plus-flash-38"]);
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "gpt-plus-flash-38", "round-trip must preserve the name");
  } finally { cleanup(dir); }
});

test("--policy rejects an unknown policy name (fail-loud)", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--policy=nonexistent-policy-xyz"]);
    assert.notEqual(r.code, 0, "unknown policy must fail");
    assert.match(r.stderr, /not found/i, "must name the failure");
    assert.match(r.stderr, new RegExp(`Available: ${RUNNABLE.join(", ")}\\n`));
  } finally { cleanup(dir); }
});

test("--policy finds none of the Claude harness policies, and refuses one placed in the policy dir", () => {
  const dir = newTmpDir();
  const policiesDir = newTmpDir();
  try {
    assert.match(run(dir, ["--policy=opus-only"]).stderr, /policy "opus-only" not found/);
    writeFileSync(join(policiesDir, "opus-only.yaml"), readFileSync(join(CLAUDE_POLICIES, "opus-only.yaml"), "utf8"));
    const r = run(dir, ["--policy=opus-only"], { SDLC_POLICIES_DIR_FOR_TESTS: policiesDir });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /policy "opus-only" names an Anthropic adapter \(builtin-anthropic\), and this harness runs no Anthropic model/);
    assert.equal(existsSync(join(dir, ".sdlc", "project.json")), false, "nothing is written");
  } finally { cleanup(policiesDir); cleanup(dir); }
});

const GPT_MODEL = ["  - id: gpt", "    adapter: openai", "    model_name: gpt-5.6-terra", "    auth: { env: OPENAI_API_KEY }"];

function policyFile(name, lines) {
  return ["version: 1", `name: ${name}`, ...lines, ""].join("\n");
}

function seedDriverPolicies() {
  const dir = newTmpDir();
  writeFileSync(join(dir, "gpt-driver.yaml"), policyFile("gpt-driver", [
    "driver:",
    "  model_name: gpt-5.6-terra",
    "  reasoning: { effort: high }",
    "models:",
    ...GPT_MODEL,
  ]));
  writeFileSync(join(dir, "claude-driver.yaml"), policyFile("claude-driver", [
    "driver:",
    "# the conductor",
    "  model_name: claude-opus-5",
    "  reasoning: { effort: high }",
    "models:",
    ...GPT_MODEL,
    "  - id: flash",
    "    adapter: mcp:model-dispatch",
    "    model_name: gemini-3.7-flash",
  ]));
  writeFileSync(join(dir, "inline-driver.yaml"), policyFile("inline-driver", [
    'driver: { model_name: "claude-opus-5", reasoning: { effort: high } }',
    "models:",
    ...GPT_MODEL,
  ]));
  writeFileSync(join(dir, "unpinned-driver.yaml"), policyFile("unpinned-driver", [
    "driver:",
    "  reasoning: { effort: high }",
    "models:",
    ...GPT_MODEL,
  ]));
  return dir;
}

test("--policy refuses a policy whose driver pins a non-GPT model, and no list offers it", () => {
  const dir = newTmpDir();
  const policiesDir = seedDriverPolicies();
  const env = { SDLC_POLICIES_DIR_FOR_TESTS: policiesDir };
  try {
    for (const [name, pin] of [
      ["claude-driver", "pins the conductor to 'claude-opus-5', which is not a GPT model"],
      ["inline-driver", "pins the conductor to 'claude-opus-5', which is not a GPT model"],
      ["unpinned-driver", "has a driver: block with no model_name"],
    ]) {
      const r = run(dir, [`--policy=${name}`], env);
      assert.notEqual(r.code, 0, name);
      assert.ok(
        r.stderr.includes(`policy "${name}" ${pin}: this harness runs its conductor in codex on a GPT model only. Runnable policies: gpt-driver.`),
        r.stderr,
      );
    }
    assert.equal(existsSync(join(dir, ".sdlc", "project.json")), false, "nothing is written");
    assert.match(run(dir, ["--policy=nonexistent"], env).stderr, /Available: gpt-driver\n/);

    const list = JSON.parse(run(dir, ["--list-json"], env).stdout);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    assert.deepEqual(
      Object.fromEntries(list.map((p) => [p.name, [p.driver_model, p.non_gpt_driver]])),
      {
        "claude-driver": ["claude-opus-5", true],
        "gpt-driver": ["gpt-5.6-terra", false],
        "inline-driver": ["claude-opus-5", true],
        "unpinned-driver": [null, true],
      },
    );
    assert.deepEqual(byName["claude-driver"].adapters, ["mcp:model-dispatch", "openai"]);

    const home = homeWithoutAdc();
    try {
      const parsed = checkCreds("claude-driver", { home, policiesDir, env: { OPENAI_API_KEY: "sk-test-dummy-not-a-real-key" } });
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.missing.map((m) => m.kind), ["policy"], JSON.stringify(parsed));
      assert.match(parsed.missing[0].fix, /pins the conductor to 'claude-opus-5', which is not a GPT model/);
    } finally { cleanup(home); }

    assert.equal(run(dir, ["--policy=gpt-driver"], env).code, 0, "a GPT driver is accepted");
  } finally { cleanup(policiesDir); cleanup(dir); }
});

test("--policy sees an Anthropic adapter written as an item's first key, quoted, or in a flow mapping", () => {
  const dir = newTmpDir();
  const policiesDir = newTmpDir();
  const env = { SDLC_POLICIES_DIR_FOR_TESTS: policiesDir };
  try {
    writeFileSync(join(policiesDir, "first-key.yaml"), policyFile("first-key", [
      "models:",
      "  - adapter: builtin-anthropic",
      "    id: opus",
      "    model_name: claude-opus-5",
      '  - { id: sonnet, adapter: "claude-cli", model_name: claude-sonnet-5 }',
      "  - id: gpt",
      "    adapter: 'openai' # judgment",
      "    model_name: gpt-5.6-terra",
    ]));
    writeFileSync(join(policiesDir, "gpt-only.yaml"), policyFile("gpt-only", ["models:", ...GPT_MODEL]));

    const list = JSON.parse(run(dir, ["--list-json"], env).stdout);
    const firstKey = list.find((p) => p.name === "first-key");
    assert.ok(!firstKey.error, JSON.stringify(firstKey));
    assert.deepEqual(firstKey.adapters, ["builtin-anthropic", "claude-cli", "openai"]);
    assert.deepEqual(firstKey.anthropic_adapters, ["builtin-anthropic", "claude-cli"]);

    const r = run(dir, ["--policy=first-key"], env);
    assert.notEqual(r.code, 0);
    assert.ok(
      r.stderr.includes(`policy "first-key" names an Anthropic adapter (builtin-anthropic, claude-cli), and this harness runs no Anthropic model. Runnable policies: gpt-only.`),
      r.stderr,
    );
    assert.equal(existsSync(join(dir, ".sdlc", "project.json")), false, "nothing is written");
  } finally { cleanup(policiesDir); cleanup(dir); }
});

test("--policy is idempotent — running twice with the same name is safe", () => {
  const dir = newTmpDir();
  try {
    run(dir, ["--policy=gpt-plus-flash"]);
    const r = run(dir, ["--policy=gpt-plus-flash"]);
    assert.equal(r.code, 0, "second run must succeed");
    const parsed = JSON.parse(readFileSync(join(dir, ".sdlc", "project.json"), "utf8"));
    assert.equal(parsed.default_policy, "gpt-plus-flash");
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
    run(dir, ["--policy=gpt-plus-flash"]);
    const parsed = JSON.parse(readFileSync(join(sdlcDir, "project.json"), "utf8"));
    assert.deepEqual(parsed.stacks, ["nest"], "must preserve pre-existing stacks");
    assert.equal(parsed.test_command, "npm test", "must preserve pre-existing test_command");
    assert.equal(parsed.default_policy, "gpt-plus-flash", "must add the new field");
  } finally { cleanup(dir); }
});

// ── terminal picker helpers (--list-json / --check-creds / --guard-active-run) ─────

test("--list-json on the shipped policies dir lists the four runnable policies, correctly shaped", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--list-json"]);
    assert.equal(r.code, 0);
    const list = JSON.parse(r.stdout);
    assert.ok(Array.isArray(list), "must be an array");
    assert.deepEqual(list.map((p) => p.name).sort(), RUNNABLE);
    for (const p of list) {
      assert.deepEqual(p.anthropic_adapters, [], p.name);
      assert.deepEqual([p.driver_model, p.non_gpt_driver], ["gpt-5.6-terra", false], p.name);
    }
    const gptPlusFlash = list.find((p) => p.name === "gpt-plus-flash");
    assert.deepEqual(gptPlusFlash.adapters, ["antigravity-worker", "mcp:model-dispatch", "openai"]);
    assert.deepEqual(gptPlusFlash.required_env, ["GEMINI_API_KEY", "OPENAI_API_KEY"]);
    assert.equal(gptPlusFlash.requires_vertex_adc, true, "antigravity-worker → vertex ADC");
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
      "  - id: gpt",
      "    adapter: openai",
      "    model_name: gpt-5.6-terra",
      "    auth: { env: OPENAI_API_KEY }",
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
    assert.deepEqual(good.adapters, ["openai"]);
    assert.deepEqual(good.required_env, ["OPENAI_API_KEY"]);
  } finally { cleanup(policiesDir); cleanup(dir); }
});

// GEMINI_API_KEY is one of two doors to the mechanical tier, so these tests
// have to control BOTH. `HOME` decides where adcPath() looks, so pointing it
// at an empty directory shuts the Vertex door; writing an ADC-shaped file
// there opens it. Without that, the result would depend on whether whoever
// runs the suite happens to have run `gcloud auth` on their machine.
function homeWithoutAdc() {
  return newTmpDir();
}

function homeWithAdc() {
  const home = newTmpDir();
  const dir = join(home, ".config", "gcloud");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "application_default_credentials.json"),
    JSON.stringify({
      type: "authorized_user",
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      refresh_token: "test-refresh-token",
    }),
  );
  return home;
}

// Fixture policies rather than shipped ones, so these exercise the two-door
// rule alone. Every shipped Gemini policy also carries the antigravity-worker
// leaf, whose `requires_vertex_adc` check shells out to `gcloud` for a LIVE
// token — which a planted credential file cannot satisfy, and which would be
// testing a different rule anyway.
function seedPolicies() {
  const dir = newTmpDir();
  writeFileSync(join(dir, "gemini-only.yaml"), [
    "version: 1",
    "name: gemini-only",
    "models:",
    "  - id: flash",
    "    adapter: mcp:model-dispatch",
    "    model_name: gemini-3.7-flash",
    "    auth: { env: GEMINI_API_KEY }",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "gemini-plus-openai.yaml"), [
    "version: 1",
    "name: gemini-plus-openai",
    "models:",
    "  - id: gpt",
    "    adapter: openai",
    "    model_name: gpt-5.6-terra",
    "    auth: { env: OPENAI_API_KEY }",
    "  - id: flash",
    "    adapter: mcp:model-dispatch",
    "    model_name: gemini-3.7-flash",
    "    auth: { env: GEMINI_API_KEY }",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "with-agent.yaml"), [
    "version: 1",
    "name: with-agent",
    "models:",
    "  - id: flash-agent",
    "    adapter: antigravity-worker",
    "    model_name: gemini-3.7-flash",
    "",
  ].join("\n"));
  return dir;
}

// `node` is spawned by absolute path so a test can empty PATH — which is how
// the "gcloud cannot be executed" case is reproduced without a sandbox.
function checkCreds(policy, { home, policiesDir, env = {}, emptyPath = false } = {}) {
  const dir = newTmpDir();
  try {
    const scrubbed = { ...process.env, HOME: home, ...env };
    delete scrubbed.ANTHROPIC_API_KEY;
    delete scrubbed.GEMINI_API_KEY;
    delete scrubbed.GOOGLE_APPLICATION_CREDENTIALS;
    if (policiesDir) scrubbed.SDLC_POLICIES_DIR_FOR_TESTS = policiesDir;
    if (emptyPath) scrubbed.PATH = "";
    const r = spawnSync(process.execPath, [SCRIPT, "--check-creds", `--policy=${policy}`], {
      cwd: dir,
      encoding: "utf8",
      env: scrubbed,
    });
    assert.equal(r.status, 0, `exit 0 expected, got ${r.status}. stderr: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally { cleanup(dir); }
}

test("--check-creds reports missing env vars with fix strings", () => {
  const home = homeWithoutAdc();
  try {
    const parsed = checkCreds("gpt-plus-flash", { home, env: { OPENAI_API_KEY: "" } });
    assert.equal(parsed.ok, false, "missing creds → ok:false");
    const missingNames = parsed.missing.filter((m) => m.kind === "env").map((m) => m.name);
    assert.ok(missingNames.includes("OPENAI_API_KEY"), "must flag OPENAI_API_KEY");
    assert.ok(missingNames.includes("GEMINI_API_KEY"), "must flag GEMINI_API_KEY");
    for (const m of parsed.missing) {
      assert.ok(m.fix, `missing entry must carry a fix string: ${JSON.stringify(m)}`);
    }
  } finally { cleanup(home); }
});

test("--check-creds refuses a policy that names an Anthropic adapter, and asks for no Anthropic credential", () => {
  const home = homeWithoutAdc();
  const policiesDir = newTmpDir();
  try {
    for (const name of ["opus-plus-flash", "opus-plus-sonnet-max"]) {
      writeFileSync(join(policiesDir, `${name}.yaml`), readFileSync(join(CLAUDE_POLICIES, `${name}.yaml`), "utf8"));
    }
    for (const [name, adapters] of [["opus-plus-flash", "builtin-anthropic"], ["opus-plus-sonnet-max", "builtin-anthropic, claude-cli"]]) {
      const parsed = checkCreds(name, { home, policiesDir });
      assert.equal(parsed.ok, false, name);
      assert.equal(parsed.missing.length, 1, JSON.stringify(parsed));
      assert.equal(parsed.missing[0].kind, "policy");
      assert.ok(parsed.missing[0].fix.includes(`names an Anthropic adapter (${adapters}), and this harness runs no Anthropic model`), parsed.missing[0].fix);
      assert.doesNotMatch(JSON.stringify(parsed), /ANTHROPIC_API_KEY|Claude Code CLI/);
    }
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("--check-creds accepts Vertex ADC in place of GEMINI_API_KEY — two doors, not one", () => {
  // The regression that sent a user to buy an API key for a tier that was
  // already working, and that made $mmo-codex:policy refuse to revalidate a
  // policy already persisted and running. The policy files say it on the line
  // above the auth block: "AI Studio door. Unset → falls through to Vertex ADC."
  const home = homeWithAdc();
  const policiesDir = seedPolicies();
  try {
    const parsed = checkCreds("gemini-only", { home, policiesDir });
    assert.equal(parsed.ok, true, `ADC must satisfy the mechanical tier, got ${JSON.stringify(parsed)}`);
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("--check-creds still flags GEMINI_API_KEY when BOTH doors are shut, and names the other one", () => {
  const home = homeWithoutAdc();
  const policiesDir = seedPolicies();
  try {
    const parsed = checkCreds("gemini-only", { home, policiesDir });
    assert.equal(parsed.ok, false);
    const gemini = parsed.missing.find((m) => m.name === "GEMINI_API_KEY");
    assert.ok(gemini, "GEMINI_API_KEY must be reported when nothing else covers the tier");
    assert.match(gemini.fix, /application-default login/, "the fix must name the second door too");
    assert.equal(gemini.alternative.kind, "vertex_adc");
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("--check-creds keeps OPENAI_API_KEY a hard requirement — a seat is a different policy, not a second door", () => {
  const home = homeWithAdc();
  const policiesDir = seedPolicies();
  try {
    const parsed = checkCreds("gemini-plus-openai", { home, policiesDir, env: { OPENAI_API_KEY: "" } });
    assert.equal(parsed.ok, false);
    assert.deepEqual(
      parsed.missing.map((m) => m.name),
      ["OPENAI_API_KEY"],
      "ADC covers Gemini; nothing covers the judgment key",
    );
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("a Vertex probe that could not RUN falls back to the credential file, not to 'missing'", () => {
  // codex executes its own tool calls in a sandbox that denies process spawn,
  // so `gcloud` returns EPERM there; an empty PATH reproduces the same shape
  // as ENOENT. Either way the probe never ran, which is not evidence that the
  // credential is absent — and the file it would have read is right there.
  const home = homeWithAdc();
  const policiesDir = seedPolicies();
  try {
    const parsed = checkCreds("with-agent", { home, policiesDir, emptyPath: true });
    assert.equal(parsed.ok, true, `unrunnable probe + valid ADC must pass, got ${JSON.stringify(parsed)}`);
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("an unrunnable Vertex probe with no credential file behind it is still reported", () => {
  // The other half: the fallback must not turn into a blanket pass.
  const home = homeWithoutAdc();
  const policiesDir = seedPolicies();
  try {
    const parsed = checkCreds("with-agent", { home, policiesDir, emptyPath: true });
    assert.equal(parsed.ok, false);
    assert.ok(
      parsed.missing.some((m) => m.kind === "vertex_adc"),
      `must still report the agent tier as unauthenticated: ${JSON.stringify(parsed)}`,
    );
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("--check-creds asks the offline gcloud stand-in, never a real gcloud", () => {
  // with-agent carries an antigravity-worker leaf, so --check-creds probes
  // gcloud for a live token. A real gcloud would contact Google from a test.
  const home = homeWithoutAdc();
  const policiesDir = seedPolicies();
  try {
    const parsed = checkCreds("with-agent", { home, policiesDir });
    const adc = parsed.missing.find((m) => m.kind === "vertex_adc");
    assert.ok(adc, `the agent tier must be reported: ${JSON.stringify(parsed)}`);
    assert.match(adc.reason, /stand-in for tests: no network/);
  } finally { cleanup(policiesDir); cleanup(home); }
});

test("--check-creds returns ok:true when required env vars are present", () => {
  const home = homeWithAdc();
  const policiesDir = seedPolicies();
  try {
    // gemini-plus-openai has no agent leaf: the key and the ADC door satisfy it.
    const parsed = checkCreds("gemini-plus-openai", { home, policiesDir, env: { OPENAI_API_KEY: "sk-test-dummy-not-a-real-key" } });
    assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed)}`);
  } finally { cleanup(policiesDir); cleanup(home); }
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

test("--guard-active-run reports active:true for a run stopped at a gate, from its run folder's state.json", () => {
  const dir = newTmpDir();
  try {
    const stateDir = join(dir, ".sdlc", "runs", "run-abc");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({
      run_id: "run-abc",
      phase: "codegen",
      status: "gate_pending",
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
    const stateDir = join(dir, ".sdlc", "runs", "run-x");
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
    const stateDir = join(dir, ".sdlc", "runs", "run-x");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), "not valid json {");
    const r = run(dir, ["--guard-active-run"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.active, false, "malformed state.json → inactive, not a crash");
  } finally { cleanup(dir); }
});

test("--guard-active-run ignores a gate state whose run recorded its end, and the old shared state.json", () => {
  const dir = newTmpDir();
  try {
    const pending = JSON.stringify({ run_id: "x", phase: "codegen", status: "gate_pending" });
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "state.json"), pending);
    const session = join(dir, ".sdlc", "runs", "s1");
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "state.json"), pending);
    writeFileSync(join(session, "run.json"), JSON.stringify({ run_id: "s1", route: "interactive", outcome: "completed" }));
    const headless = join(dir, ".sdlc", "runs", "h1");
    mkdirSync(headless, { recursive: true });
    writeFileSync(join(headless, "state.json"), pending);
    writeFileSync(join(headless, "driver-events.jsonl"), [
      { v: 1, kind: "invocation_start", run_id: "h1", invocation: 1 },
      { v: 1, kind: "run_end", invocation: 1, outcome: "max_turns" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.equal(JSON.parse(run(dir, ["--guard-active-run"]).stdout).active, false);

    appendFileSync(join(headless, "driver-events.jsonl"), JSON.stringify({ v: 1, kind: "invocation_start", run_id: "h1", invocation: 2 }) + "\n");
    const resumed = JSON.parse(run(dir, ["--guard-active-run"]).stdout);
    assert.equal(resumed.active, true, "a resumed run.mjs run that never wrote its run_end is still at its gate");
    assert.equal(resumed.run_id, "h1");
  } finally { cleanup(dir); }
});
