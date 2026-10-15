import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  POLICY_PATH_ENV,
  assertResumePolicy,
  codexEnv,
  policyRecord,
  readRecordedPolicy,
  resolveRunPolicy,
} from "../../plugin/codex/run-policy.mjs";
import { buildCodexArgs, spawnCodex } from "../../plugin/codex/run.mjs";
import { runDispatch } from "../../plugin/codex/dispatch.mjs";
import { argvPin } from "../../plugin/codex/telemetry/fairnessPin.mjs";
import { resolvePolicy } from "../../plugin/mcp/model-dispatch/dist/policy.js";
import "./lib/stand-ins.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = join(REPO, "plugin", "codex", "run.mjs");
const POLICIES = join(REPO, "plugin", "config", "policies");
const CLAUDE_POLICIES = join(REPO, "tools", "test", "fixtures", "policies", "claude");
const PIN = { model: "gpt-5.6-terra", effort: "high" };
const silent = () => {};

function project({ override, defaultPolicy } = {}) {
  const root = mkdtempSync(join(tmpdir(), "run-policy-"));
  writeFileSync(join(root, "brief.md"), "# brief\n");
  if (override !== undefined) writeFileSync(join(root, "routing-policy.yaml"), override);
  if (defaultPolicy !== undefined) {
    mkdirSync(join(root, ".sdlc"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "project.json"), JSON.stringify({ default_policy: defaultPolicy }));
  }
  return root;
}

function shipped(name) {
  return readFileSync(join(POLICIES, `${name}.yaml`), "utf-8");
}

function claudePolicy(name) {
  return readFileSync(join(CLAUDE_POLICIES, `${name}.yaml`), "utf-8");
}

const yamlNames = (dir) => readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();

/** gpt-plus-flash renamed, with its own cap and its own driver rates. */
function customOverride() {
  return shipped("gpt-plus-flash")
    .replace(/^name: .*$/m, "name: my-custom")
    .replace(/^hard_cost_cap_usd: .*$/m, "hard_cost_cap_usd: 5")
    .replace(
      /^(driver:\n(?:  .*\n)*?)  pricing: .*$/m,
      "$1  pricing: { input: 4.00, input_cached: 0.40, output: 24.00 }",
    );
}

function within(opts, fn) {
  const root = project(opts);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A dry run as CI would start one: no terminal for gates, and a folder that is not a git repo. */
function dryRun(root, extra = []) {
  const flags = [RUN, "--dry-run", `--project-root=${root}`, "--mode=greenfield", "--gates=auto-approve", ...extra];
  const r = spawnSync(process.execPath, flags, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: join(root, ".codex-home") },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
}

// ── which policy wins ─────────────────────────────────────────────────

test("a routing-policy.yaml gives the run its name, pin, driver rates and cap, and beats --policy", () => {
  within({ override: customOverride(), defaultPolicy: "gpt-seat-plus-flash" }, (root) => {
    const run = resolveRunPolicy({ projectRoot: root, policyArg: "gpt-plus-flash", warn: silent });
    assert.equal(run.name, "my-custom");
    assert.equal(run.source, "project-override");
    assert.equal(run.path, join(root, "routing-policy.yaml"));
    assert.equal(run.requested, "gpt-plus-flash");
    assert.equal(run.policy.hard_cost_cap_usd, 5);
    assert.deepEqual(run.driver.pin, PIN);
    assert.deepEqual(run.driver.pricing, { input: 4, input_cached: 0.4, output: 24 });
    assert.match(run.notice, /routing-policy\.yaml \(policy 'my-custom'\) is used instead of --policy=gpt-plus-flash/);
  });
});

test("without --policy, the project.json default runs", () => {
  within({ defaultPolicy: "gpt-seat-plus-flash" }, (root) => {
    const run = resolveRunPolicy({ projectRoot: root });
    assert.equal(run.name, "gpt-seat-plus-flash");
    assert.equal(run.source, "project-default");
    assert.equal(run.notice, null);
  });
});

test("--policy beats the project.json default when there is no override", () => {
  within({ defaultPolicy: "gpt-seat-plus-flash" }, (root) => {
    const run = resolveRunPolicy({ projectRoot: root, policyArg: "gpt-plus-flash-38" });
    assert.equal(run.name, "gpt-plus-flash-38");
    assert.equal(run.source, "flag");
  });
});

const PRECEDENCE_CASES = [
  { label: "override, flag and default", opts: { override: customOverride(), defaultPolicy: "gpt-seat-plus-flash" }, flag: "gpt-plus-flash-38", source: "project-override" },
  { label: "override only", opts: { override: customOverride() }, flag: null, source: "project-override" },
  { label: "flag and default", opts: { defaultPolicy: "gpt-seat-plus-flash" }, flag: "flash-agsdk-only", source: "flag" },
  { label: "default only", opts: { defaultPolicy: "gpt-seat-plus-flash" }, flag: null, source: "project-default" },
  { label: "nothing", opts: {}, flag: null, source: "builtin-default" },
];

for (const c of PRECEDENCE_CASES) {
  test(`run.mjs and the bridge load the same file (${c.label})`, async () => {
    const root = project(c.opts);
    try {
      const run = resolveRunPolicy({ projectRoot: root, policyArg: c.flag, warn: silent });
      assert.equal(run.source, c.source);

      // What a conductor's dispatch sends, rendered from run.mjs's values,
      // and what the bridge then resolves from it.
      const calls = [];
      const connect = async () => ({
        callTool: async (name, args) => { calls.push(args); return { decision: {}, result: { success: true } }; },
        close: async () => {},
      });
      const packet = join(root, "packet.json");
      writeFileSync(packet, JSON.stringify({ id: "p1", phase: "docs" }));
      const args = { packet, out: join(root, "out.json"), policy: run.name, "project-root": root, telemetry: join(root, "t.jsonl") };
      await runDispatch(args, { connect, env: codexEnv(run, {}) });
      const sent = calls[0];
      assert.equal(sent.policy_path, run.path, "dispatch forwards the run's policy file");
      const bridge = resolvePolicy({ policyName: sent.policy_name, projectRoot: sent.project_root, policyPath: sent.policy_path });
      assert.equal(bridge.path, run.path);
      assert.equal(bridge.sha256, run.sha256);

      // Even where the environment does not reach dispatch.mjs, the rendered
      // name and the project root resolve to the same file.
      await runDispatch(args, { connect, env: {} });
      const bare = calls[1];
      assert.equal(bare.policy_path, undefined);
      assert.equal(resolvePolicy({ policyName: bare.policy_name, projectRoot: bare.project_root }).path, run.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("--policy-path on a dispatch beats the environment", async () => {
  const calls = [];
  const connect = async () => ({ callTool: async (n, a) => { calls.push(a); return { ok: true, models: [] }; }, close: async () => {} });
  const dir = mkdtempSync(join(tmpdir(), "run-policy-pp-"));
  try {
    await runDispatch(
      { preflight: true, "auth-mode": "vendor", out: join(dir, "p.json"), "policy-path": "/a/b.yaml" },
      { connect, env: { [POLICY_PATH_ENV]: "/c/d.yaml" } },
    );
    assert.equal(calls[0].policy_path, "/a/b.yaml");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── driver pin ────────────────────────────────────────────────────────

test("flash-agsdk-only resolves to the GPT driver pin and its rates", () => {
  within({}, (root) => {
    const run = resolveRunPolicy({ projectRoot: root, policyArg: "flash-agsdk-only" });
    assert.deepEqual(run.driver.pin, PIN);
    assert.deepEqual(run.driver.pricing, { input: 2, input_cached: 0.2, output: 12 });
    assert.equal(run.driver.from, "driver");
  });
});

test("flash-agsdk-only starts headless", () => {
  within({}, (root) => {
    const r = dryRun(root, ["--policy=flash-agsdk-only"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.policy, "flash-agsdk-only");
    assert.deepEqual(r.json.pin, PIN);
  });
});

test("an override written before driver blocks existed falls back to its gpt entry, with a warning", () => {
  const legacy = shipped("gpt-plus-flash").replace(/^driver:\n(?:  .*\n)+/m, "");
  within({ override: legacy }, (root) => {
    const warnings = [];
    const run = resolveRunPolicy({ projectRoot: root, warn: (m) => warnings.push(m) });
    assert.deepEqual(run.driver.pin, PIN);
    assert.equal(run.driver.from, "models.gpt");
    assert.equal(warnings.length, 1);
  });
});

test("a policy with no driver block and no gpt entry is refused, showing the block to add", () => {
  const flashOnly = shipped("flash-agsdk-only").replace(/^driver:\n(?:  .*\n)+/m, "");
  within({ override: flashOnly }, (root) => {
    assert.throws(() => resolveRunPolicy({ projectRoot: root }), (err) => {
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /has no driver: block/);
      assert.match(err.message, /model_name: gpt-5\.6-terra/);
      return true;
    });
  });
});

test("the argv run.mjs builds carries the resolved pin", () => {
  within({}, (root) => {
    const run = resolveRunPolicy({ projectRoot: root, policyArg: "gpt-seat-plus-flash" });
    assert.deepEqual(argvPin(buildCodexArgs({ pin: run.driver.pin, promptText: "-m x", hookPath: "/h" })), PIN);
  });
});

// ── policies this harness cannot run ──────────────────────────────────

test("every Claude harness policy, as a project's routing-policy.yaml, is refused before spending", () => {
  const names = yamlNames(CLAUDE_POLICIES);
  assert.ok(names.length > 0);
  for (const name of names) {
    within({ override: claudePolicy(name) }, (root) => {
      assert.throws(() => resolveRunPolicy({ projectRoot: root }), (err) => {
        assert.equal(err.exitCode, 2, name);
        assert.match(err.message, new RegExp(`policy '${name}' .* names an Anthropic adapter \\((builtin-anthropic|claude-cli)`), name);
        assert.match(err.message, /runs no Anthropic model/, name);
        assert.match(err.message, /edit it to route through GPT and Gemini adapters, or move it aside/, name);
        assert.match(err.message, /Runnable presets: flash-agsdk-only, gpt-plus-flash, gpt-plus-flash-38, gpt-seat-plus-flash\./, name);
        return true;
      });
    });
  }
});

test("every shipped policy resolves to the driver pin", () => {
  const names = yamlNames(POLICIES);
  assert.ok(names.length > 1);
  within({}, (root) => {
    for (const name of names) {
      const run = resolveRunPolicy({ projectRoot: root, policyArg: name });
      assert.equal(run.name, name);
      assert.deepEqual(run.driver.pin, PIN, name);
      assert.equal(run.driver.from, "driver", `${name} pins through its driver block, not the legacy gpt entry`);
    }
  });
});

test("run.mjs refuses a routing-policy.yaml that names an Anthropic adapter with exit code 2", () => {
  within({ override: claudePolicy("opus-plus-flash") }, (root) => {
    const r = dryRun(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /'opus-plus-flash'.*names an Anthropic adapter \(builtin-anthropic\).*runs no Anthropic model/);
  });
});

test("--policy naming a Claude harness policy finds no preset, and lists the runnable ones", () => {
  within({}, (root) => {
    const r = dryRun(root, ["--policy=opus-plus-flash"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Policy 'opus-plus-flash' not found at .*Shipped presets: flash-agsdk-only, gpt-plus-flash, gpt-plus-flash-38, gpt-seat-plus-flash\./);
  });
});

test("a policy whose driver is not a GPT model is refused before spending", () => {
  const driver = shipped("gpt-plus-flash").replace(/^(driver:\n  model_name: ).*$/m, "$1claude-opus-5");
  within({ override: driver }, (root) => {
    assert.throws(() => resolveRunPolicy({ projectRoot: root }), (err) => {
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /pins the conductor to 'claude-opus-5', which is not a GPT model/);
      assert.match(err.message, /set its driver: model_name to gpt-5\.6-terra, or move it aside/);
      return true;
    });
  });
});

test("a policy name that cannot go on the dispatch command line is refused", () => {
  within({ override: shipped("gpt-plus-flash").replace(/^name: .*$/m, 'name: "my policy; rm -rf"') }, (root) => {
    assert.throws(() => resolveRunPolicy({ projectRoot: root }), /cannot go on a dispatch command line/);
  });
});

// ── what run.mjs records ──────────────────────────────────────────────

test("--dry-run JSON says which policy file won", () => {
  within({ override: customOverride() }, (root) => {
    const r = dryRun(root, ["--policy=gpt-plus-flash"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.policy, "my-custom");
    assert.equal(r.json.policy_source, "project-override");
    assert.equal(r.json.policy_path, join(root, "routing-policy.yaml"));
    assert.equal(r.json.policy_requested, "gpt-plus-flash");
    assert.match(r.json.policy_sha256, /^[0-9a-f]{64}$/);
    assert.match(r.stderr, /is used instead of --policy=gpt-plus-flash/);
  });
});

test("codex runs with the resolved policy file in its environment", async () => {
  within({}, (root) => {
    const run = resolveRunPolicy({ projectRoot: root });
    assert.equal(codexEnv(run, { PATH: "/bin" })[POLICY_PATH_ENV], run.path);
    assert.equal(codexEnv(run, { PATH: "/bin" }).PATH, "/bin");
  });
  let seen;
  const spawnFn = (bin, args, opts) => {
    seen = opts;
    return { stdout: null, stderr: null, on: (ev, cb) => ev === "close" && setImmediate(() => cb(0)) };
  };
  await spawnCodex(["exec"], { spawnFn, env: { [POLICY_PATH_ENV]: "/p.yaml" } });
  assert.equal(seen.env[POLICY_PATH_ENV], "/p.yaml");
});

// ── --resume keeps the policy the run started on ──────────────────────

test("readRecordedPolicy reads the first invocation_start, then driver-manifest.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-policy-rec-"));
  try {
    assert.equal(readRecordedPolicy(dir), null);
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ policy: "gpt-seat-plus-flash", pin: { ...PIN, sandbox: "x" } }));
    assert.deepEqual(readRecordedPolicy(dir), {
      name: "gpt-seat-plus-flash", path: null, sha256: null, pin: PIN, from: "driver-manifest.json",
    });
    writeFileSync(
      join(dir, "driver-events.jsonl"),
      [
        '{"type":"thread.started","thread_id":"t"}',
        JSON.stringify({ v: 1, kind: "invocation_start", invocation: 1, policy: "gpt-plus-flash", policy_path: "/a.yaml", policy_sha256: "aa", pin: PIN }),
        JSON.stringify({ v: 1, kind: "invocation_start", invocation: 2, policy: "other", policy_path: "/b.yaml", pin: PIN }),
      ].join("\n") + "\n",
    );
    assert.deepEqual(readRecordedPolicy(dir), {
      name: "gpt-plus-flash", path: "/a.yaml", sha256: "aa", pin: PIN, from: "driver-events.jsonl",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runFor(root, flag) {
  return resolveRunPolicy({ projectRoot: root, policyArg: flag, warn: silent });
}

/** An `invocation_start` row with exactly the keys DECISIONS 2.3 defines: no policy_path, no sha256. */
function v1InvocationStart(run, invocation = 1) {
  return {
    v: 1, kind: "invocation_start", run_id: "r1", invocation, at: "2026-10-13T00:00:00.000Z",
    mode: invocation === 1 ? "fresh" : "resume", resume_thread_id: null, resume_after: null,
    policy: run.name, pin: run.driver.pin, gates: "auto-approve", max_turns: 3,
    codex_bin: "codex", cwd: "/p", pid: 1, pgid: 1,
  };
}

test("a v1 invocation_start row takes its file and sha256 from driver-manifest.json", () => {
  within({}, (root) => {
    const first = runFor(root, "gpt-plus-flash");
    const dir = join(root, ".sdlc", "runs", "r1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "driver-events.jsonl"), JSON.stringify(v1InvocationStart(first)) + "\n");
    assert.deepEqual(readRecordedPolicy(dir), {
      name: "gpt-plus-flash", path: null, sha256: null, pin: PIN, from: "driver-events.jsonl",
    });

    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ run_id: "r1", ...policyRecord(first), pin: PIN }));
    assert.deepEqual(readRecordedPolicy(dir), {
      name: "gpt-plus-flash", path: first.path, sha256: first.sha256, pin: PIN,
      from: "driver-events.jsonl+driver-manifest.json",
    });

    // A routing-policy.yaml added after the run started, with the same name: the file differs.
    writeFileSync(
      join(root, "routing-policy.yaml"),
      shipped("gpt-plus-flash").replace(/^hard_cost_cap_usd: .*$/m, "hard_cost_cap_usd: 1000"),
    );
    const resumed = runFor(root, "gpt-plus-flash");
    assert.equal(resumed.name, "gpt-plus-flash");
    assert.equal(resumed.source, "project-override");
    assert.throws(
      () => assertResumePolicy({ recorded: readRecordedPolicy(dir), run: resumed, runDir: dir, warn: silent }),
      (err) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /--resume refused: the policy file differs/);
        return true;
      },
    );
  });
});

test("a manifest naming another policy does not lend its file to the first invocation", () => {
  within({}, (root) => {
    const first = runFor(root, "gpt-plus-flash");
    const other = runFor(root, "gpt-seat-plus-flash");
    const dir = mkdtempSync(join(tmpdir(), "run-policy-mix-"));
    try {
      writeFileSync(join(dir, "driver-events.jsonl"), JSON.stringify(v1InvocationStart(first)) + "\n");
      writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify(policyRecord(other)));
      assert.deepEqual(readRecordedPolicy(dir), {
        name: "gpt-plus-flash", path: null, sha256: null, pin: PIN, from: "driver-events.jsonl",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("assertResumePolicy accepts the same policy and refuses a different name, file or pin", () => {
  within({}, (root) => {
    const run = runFor(root, "gpt-plus-flash");
    const same = { name: run.name, path: run.path, sha256: run.sha256, pin: PIN };
    assert.doesNotThrow(() => assertResumePolicy({ recorded: same, run, warn: silent }));

    const refused = (recorded, re) =>
      assert.throws(() => assertResumePolicy({ recorded, run, warn: silent }), (err) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, re);
        return true;
      });
    refused({ ...same, name: "gpt-seat-plus-flash" }, /--resume refused: the policy name differs/);
    refused({ ...same, path: "/elsewhere/gpt-plus-flash.yaml", sha256: "0".repeat(64) }, /the policy file differs/);
    refused({ ...same, path: "/elsewhere/gpt-plus-flash.yaml", sha256: null }, /the policy file differs/);
    refused({ ...same, pin: { model: "gpt-6", effort: "high" } }, /the driver pin differs/);
  });
});

test("assertResumePolicy accepts the same bytes at a new path, as after a plugin update, with a warning", () => {
  within({}, (root) => {
    const run = runFor(root, "gpt-plus-flash");
    const warnings = [];
    const recorded = { name: run.name, path: "/old/cache/0.2.0/config/policies/gpt-plus-flash.yaml", sha256: run.sha256, pin: PIN };
    assert.doesNotThrow(() => assertResumePolicy({ recorded, run, warn: (m) => warnings.push(m) }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /the policy file moved .* with the same contents/);
  });
});

test("assertResumePolicy warns when the same file changed, or when nothing was recorded", () => {
  within({}, (root) => {
    const run = runFor(root, "gpt-plus-flash");
    const warnings = [];
    assertResumePolicy({ recorded: { name: run.name, path: run.path, sha256: "0".repeat(64), pin: PIN }, run, warn: (m) => warnings.push(m) });
    assertResumePolicy({ recorded: null, run, runDir: "/r", warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /changed since the run started/);
    assert.match(warnings[1], /records no policy/);
  });
});

/** The record run.mjs leaves in a run folder whose first invocation started on `dry`'s policy and stopped at --max-turns. */
function recordRun(root, runId, dry) {
  const dir = join(root, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const { argv, output_dir, code_dir, gates, run_id, ...policy } = dry;
  const thread = "01a10f3e-4db6-7a70-8d73-a94d86244d4d";
  const rows = [
    { v: 1, kind: "invocation_start", run_id: runId, invocation: 1, at: "2026-10-13T00:00:00.000Z", mode: "fresh", ...policy, gates, run_mode: "greenfield", code_dir },
    { v: 1, kind: "codex", invocation: 1, thread_id: thread, received_at: "2026-10-13T00:00:01.000Z", event: { type: "thread.started", thread_id: thread } },
    { v: 1, kind: "invocation_end", invocation: 1, at: "2026-10-13T00:00:02.000Z", thread_id: thread, exit_status: 0, signal: null, ended_by: "exit", turns: { started: 0, completed: 0, failed: 0 }, incomplete: false, stderr_tail: "" },
    { v: 1, kind: "run_end", invocation: 1, at: "2026-10-13T00:00:03.000Z", outcome: "max_turns", deliberate: false, reason: "test", exit_code: 3, run_id: runId, ...policy, gates },
  ];
  writeFileSync(join(dir, "driver-events.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

test("run.mjs --resume keeps the run's policy, and refuses a different one before spending", () => {
  within({}, (root) => {
    recordRun(root, "r1", dryRun(root, ["--policy=gpt-seat-plus-flash", "--run-id=r1"]).json);

    const other = dryRun(root, ["--policy=gpt-plus-flash", "--resume=r1"]);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /--policy=gpt-plus-flash differs from run r1's policy \(gpt-seat-plus-flash\); a resumed run keeps its policy/);

    const same = dryRun(root, ["--resume=r1"]);
    assert.equal(same.status, 0, same.stderr);
    assert.equal(same.json.policy, "gpt-seat-plus-flash", "a resume without --policy keeps the policy the run started on");

    writeFileSync(join(root, "routing-policy.yaml"), shipped("gpt-plus-flash"));
    const overridden = dryRun(root, ["--resume=r1"]);
    assert.equal(overridden.status, 2);
    assert.match(overridden.stderr, /--resume refused: the policy name differs/);
  });
});

test("with --run-id, a driver-manifest.json another run wrote is ignored, with a warning", () => {
  within({}, (root) => {
    const dir = join(root, ".sdlc");
    mkdirSync(dir, { recursive: true });
    const earlier = runFor(root, "gpt-plus-flash");
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ run_id: "run-a", ...policyRecord(earlier), pin: PIN }));

    const warnings = [];
    assert.equal(readRecordedPolicy(dir, { runId: "run-b", warn: (m) => warnings.push(m) }), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /written by run 'run-a', not 'run-b'; its policy record is ignored/);

    assert.equal(readRecordedPolicy(dir, { runId: "run-a", warn: silent }).name, "gpt-plus-flash");
    assert.equal(readRecordedPolicy(dir, { warn: silent }).name, "gpt-plus-flash");
  });
});

test("with --run-id, invocation_start rows of another run are skipped", () => {
  within({}, (root) => {
    const a = runFor(root, "gpt-plus-flash");
    const b = runFor(root, "gpt-seat-plus-flash");
    const dir = join(root, ".sdlc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "driver-events.jsonl"),
      [{ ...v1InvocationStart(a), run_id: "run-a" }, { ...v1InvocationStart(b), run_id: "run-b" }].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    assert.equal(readRecordedPolicy(dir, { runId: "run-b", warn: silent }).name, "gpt-seat-plus-flash");
    assert.equal(readRecordedPolicy(dir, { runId: "run-a", warn: silent }).name, "gpt-plus-flash");
    assert.equal(readRecordedPolicy(dir, { runId: "run-c", warn: silent }), null);
  });
});

test("run.mjs --resume reads the run's own first invocation, not a driver-manifest.json another run left", () => {
  within({}, (root) => {
    const dir = recordRun(root, "run-b", dryRun(root, ["--policy=gpt-plus-flash-38", "--run-id=run-b"]).json);
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify(dryRun(root, ["--policy=gpt-plus-flash", "--run-id=run-a"]).json));

    const resumed = dryRun(root, ["--resume=run-b"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.json.policy, "gpt-plus-flash-38");
    assert.doesNotMatch(resumed.stderr, /records no policy/);

    const other = dryRun(root, ["--policy=gpt-plus-flash", "--resume=run-b"]);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /a resumed run keeps its policy/);
  });
});

test("run.mjs --resume accepts the --policy a routing-policy.yaml overrode when the run started", () => {
  within({ override: customOverride() }, (root) => {
    recordRun(root, "r1", dryRun(root, ["--policy=gpt-plus-flash", "--run-id=r1"]).json);
    const again = dryRun(root, ["--policy=gpt-plus-flash", "--resume=r1"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.policy, "my-custom");
    const bare = dryRun(root, ["--resume=r1"]);
    assert.equal(bare.status, 0, bare.stderr);
    assert.doesNotMatch(bare.stderr, /is used instead of --policy/, "no notice for a flag the person did not pass");
  });
});

test("policyRecord names every key a run records", () => {
  within({}, (root) => {
    const run = runFor(root, null);
    assert.deepEqual(Object.keys(policyRecord(run)), [
      "policy", "policy_version", "policy_source", "policy_path", "policy_sha256", "policy_requested",
    ]);
  });
});
