/**
 * Unit tests for the driver entry (plugin/codex/run.mjs) and the
 * conductor's dispatch tool (plugin/codex/dispatch.mjs).
 *
 * Everything here is offline and free: the bridge connection is injected,
 * and codex itself is never spawned (driver-lifecycle.test.mjs drives the
 * whole loop against a stand-in codex). What these tests actually protect is
 * the argv the fairness argument rests on — every pin in
 * docs/verification/p1-codex-runtime.md's "Pins chosen" table has to
 * survive into the real invocation, and two of them (the sandbox network
 * flag and the `--` separator) are load-bearing in ways a code reading
 * would not catch if they silently disappeared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCodexArgs,
  buildRunArtifacts,
  renderPrompt,
  renderSkills,
  GATE_MODES,
  renderHandover,
  validIntents,
  costCapStop,
  threadIdFrom,
  RESUME_PROMPT,
  resumePrompt,
  gateAnswerPrompt,
  questionAnswerPrompt,
  createLineReader,
  DEFAULT_MAX_TURNS,
  parseArgs as parseRunArgs,
  main as runMain,
  SANDBOX_MODE,
  APPROVAL_POLICY,
} from "../../plugin/codex/run.mjs";
import {
  parseArgs as parseDispatchArgs,
  buildExecuteArgs,
  buildPreflightArgs,
  bridgeEnv,
  summarize,
  runDispatch,
} from "../../plugin/codex/dispatch.mjs";
import { resolveRunPolicy } from "../../plugin/codex/run-policy.mjs";
import { pluginHooks, pluginHooksOffConfig, sessionHookConfig } from "../../plugin/codex/hook-wiring.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "driver-test-"));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const PIN = { model: "gpt-5.6-terra", effort: "high" };
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin");
const HOOKS_OFF = pluginHooksOffConfig();

// ── run.mjs: the pinned invocation ───────────────────────────────────────

test("buildCodexArgs carries every pin from the verification doc", () => {
  const argv = buildCodexArgs({ pin: PIN, promptText: "do the thing" });
  assert.ok(argv.includes("--json"), "telemetry capture depends on --json");
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.6-terra");
  assert.ok(argv.includes('model_reasoning_effort="high"'));
  assert.ok(argv.includes(`sandbox_mode="${SANDBOX_MODE}"`));
  assert.ok(argv.includes(`approval_policy="${APPROVAL_POLICY}"`));
});

test("buildCodexArgs sets the sandbox network flag — without it the bridge subprocess is silently killed", () => {
  const argv = buildCodexArgs({ pin: PIN, promptText: "x" });
  assert.ok(
    argv.includes("sandbox_workspace_write.network_access=true"),
    "the sandbox finding in the verification doc makes this load-bearing, not optional",
  );
});

test("buildCodexArgs puts the prompt last, behind a bare -- separator", () => {
  const argv = buildCodexArgs({ pin: PIN, promptText: "---\nname: x\n---\nbody" });
  assert.equal(argv[argv.length - 2], "--", "the separator must immediately precede the prompt");
  assert.equal(argv[argv.length - 1], "---\nname: x\n---\nbody");
});

test("buildCodexArgs wires the plugin's own hook entry for apply_patch and Bash, marked as run.mjs's", () => {
  const argv = buildCodexArgs({ pin: PIN, promptText: "x" });
  const hookArg = argv.find((a) => typeof a === "string" && a.startsWith("hooks.PreToolUse="));
  assert.ok(hookArg, "a PreToolUse hook config must be present");
  assert.match(hookArg, /matcher="apply_patch\|Bash"/, "apply_patch is the model's default edit tool; Bash covers shell writes");
  assert.match(hookArg, /write-contract-check\.mjs\\" --wired-by=run"/);
  assert.ok(argv.includes("features.hooks=true"), "a person's [features] hooks=false would silence the guard");
  assert.ok(argv.includes(HOOKS_OFF), "the installed plugin's copy is off, so each call is judged once");
  assert.ok(argv.includes("--dangerously-bypass-hook-trust"), "session hooks are untrusted, and skipped silently without it");
  assert.ok(!argv.some((a) => String(a).includes('hooks.state."')), "a dotted quoted key does nothing");
  for (const flag of ["features.hooks=true", HOOKS_OFF]) assert.equal(argv[argv.indexOf(flag) - 1], "-c", flag);
  assert.ok(argv.indexOf(HOOKS_OFF) < argv.indexOf("--"));
});

test("buildCodexArgs quotes a plugin root containing spaces — an unquoted one fails OPEN", () => {
  const argv = buildCodexArgs({ pin: PIN, promptText: "x", pluginRoot: PLUGIN_DIR });
  const hookArg = argv.find((a) => typeof a === "string" && a.startsWith("hooks.PreToolUse="));
  assert.equal(hookArg, sessionHookConfig(pluginHooks(PLUGIN_DIR), PLUGIN_DIR));
  const dir = tmp();
  try {
    const root = join(dir, "TL ai labs", "plugin");
    mkdirSync(join(root, "hooks"), { recursive: true });
    copyFileSync(join(PLUGIN_DIR, "hooks", "hooks.json"), join(root, "hooks", "hooks.json"));
    const spaced = buildCodexArgs({ pin: PIN, promptText: "x", pluginRoot: root });
    const command = `node \\"${root}/codex/hooks/write-contract-check.mjs\\" --wired-by=run`;
    assert.ok(spaced.some((a) => a.includes(`command="${command}"`)), spaced.join("\n"));
  } finally { cleanup(dir); }
});

test("buildCodexArgs grants CODEX_HOME as writable, so a nested codex exec can start", () => {
  // Regression from the first quick-demo run: without this, the seat-backed
  // dispatch path's inner `codex exec` dies in ~330ms with
  // "failed to initialize in-process app-server client: Read-only file
  // system", and every judgment dispatch fails.
  // Expressed as a config key rather than --add-dir: `codex exec resume`
  // rejects the flag, and both invocations must grant the same root.
  const argv = buildCodexArgs({ pin: PIN, promptText: "x", codexHome: "/home/u/.codex" });
  assert.ok(
    argv.some((a) => typeof a === "string" && a.includes("writable_roots") && a.includes("/home/u/.codex")),
  );
});

test("buildCodexArgs grants npm's cache as writable, so Phase 7's npm install can run in the sandbox", () => {
  const argv = buildCodexArgs({ pin: PIN, promptText: "x", codexHome: "/home/u/.codex", npmCache: "/home/u/.npm" });
  const roots = argv.filter((a) => typeof a === "string" && a.startsWith("sandbox_workspace_write.writable_roots="));
  assert.deepEqual(roots, ['sandbox_workspace_write.writable_roots=["/home/u/.codex","/home/u/.npm"]']);
  const resumed = buildCodexArgs({ pin: PIN, promptText: "x", codexHome: "/home/u/.codex", npmCache: "/home/u/.npm", resumeThreadId: "t-1" });
  assert.ok(resumed.includes(roots[0]), "a resumed turn keeps the same writable roots");
  const prev = process.env.npm_config_cache;
  process.env.npm_config_cache = "/srv/npm-cache";
  try {
    assert.ok(buildCodexArgs({ pin: PIN, promptText: "x", codexHome: "/home/u/.codex" }).some((a) => a.includes('"/srv/npm-cache"')));
  } finally {
    if (prev === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = prev;
  }
});

test("buildCodexArgs passes -C only when a cwd is given", () => {
  assert.ok(!buildCodexArgs({ pin: PIN, promptText: "x" }).includes("-C"));
  const withCwd = buildCodexArgs({ pin: PIN, promptText: "x", cwd: "/proj" });
  assert.equal(withCwd[withCwd.indexOf("-C") + 1], "/proj");
});

test("an unconfigured project runs the shipped default, and it carries the driver pin", () => {
  const dir = tmp();
  try {
    const run = resolveRunPolicy({ projectRoot: dir });
    assert.equal(run.name, "gpt-plus-flash");
    assert.equal(run.source, "builtin-default");
    assert.deepEqual(run.driver.pin, PIN);
  } finally { cleanup(dir); }
});

test("a policy that doesn't exist is refused before spending, with exit code 2", () => {
  const dir = tmp();
  try {
    assert.throws(() => resolveRunPolicy({ projectRoot: dir, policyArg: "no-such-policy" }), (err) => {
      assert.match(err.message, /not found at/);
      assert.equal(err.exitCode, 2);
      return true;
    });
  } finally { cleanup(dir); }
});

test("parseArgs handles --key=value and bare flags", () => {
  const args = parseRunArgs(["--policy=x", "--dry-run", "--output-dir=/o"]);
  assert.deepEqual(args, { policy: "x", "dry-run": true, "output-dir": "/o" });
});

test("parseArgs takes the space form too: --max-turns 5 is 5, not one turn", () => {
  assert.deepEqual(parseRunArgs(["--max-turns", "5"]), { "max-turns": "5" });
  assert.deepEqual(parseRunArgs(["--output-dir", ".sdlc/runs/x"]), { "output-dir": ".sdlc/runs/x" });
  assert.deepEqual(parseRunArgs(["--dry-run"]), { "dry-run": true });
  assert.deepEqual(parseRunArgs(["--dry-run=false"]), { "dry-run": false });
});

test("parseArgs refuses a missing value, an unknown flag, a stray word and a repeat", () => {
  assert.throws(() => parseRunArgs(["--resume"]), /--resume needs a value/);
  assert.throws(() => parseRunArgs(["--resume", "--dry-run"]), /--resume needs a value/);
  assert.throws(() => parseRunArgs(["--policy="]), /needs a value/);
  assert.throws(() => parseRunArgs(["--bogus"]), /unknown flag --bogus/);
  assert.throws(() => parseRunArgs(["stray"]), /unexpected argument 'stray'/);
  assert.throws(() => parseRunArgs(["--gates=auto-approve", "--gates=prompt"]), /more than once/);
  assert.throws(() => parseRunArgs(["--dry-run=yes"]), /takes no value/);
});

test("a usage error exits 2 before anything is spent", async () => {
  for (const argv of [["--max-turns=0"], ["--max-turns=1.5"], ["--max-turns=abc"], ["--bogus"], ["--resume"]]) {
    assert.equal(await runMain(argv, { cwd: tmpdir() }), 2, argv.join(" "));
  }
});

// ── run.mjs: conductor prompt rendering ──────────────────────────────────

test("renderPrompt substitutes every placeholder it is given", () => {
  const out = renderPrompt("root={{PLUGIN_ROOT}} policy={{POLICY}}", {
    PLUGIN_ROOT: "/p", POLICY: "gpt-plus-flash",
  });
  assert.equal(out, "root=/p policy=gpt-plus-flash");
});

test("renderPrompt throws on an unrendered placeholder rather than shipping it to the model", () => {
  assert.throws(
    () => renderPrompt("out={{OUTPUT_DIR}} missing={{NOPE}}", { OUTPUT_DIR: "/o" }),
    /unrendered placeholder\(s\): \{\{NOPE\}\}/,
  );
});

test("the shipped conductor prompt renders with no placeholder left behind", () => {
  const promptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "plugin", "codex", "prompts", "conductor.md",
  );
  const rendered = renderPrompt(readFileSync(promptPath, "utf-8"), {
    PLUGIN_ROOT: "/plug", PROJECT_ROOT: "/proj", OUTPUT_DIR: "/out",
    CODE_DIR: "/code", BRIEF_PATH: "/proj/brief.md", POLICY: "gpt-plus-flash", RUN_ID: "r1",
    GATE_INSTRUCTION: "gate text",
    HANDOVER: "",
  });
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(rendered));
  assert.match(rendered, /dispatch\.mjs/, "the prompt must tell the conductor how to dispatch");
  assert.match(rendered, /--preflight --auth-mode=vendor/, "rule 0 must survive rendering");
});

test("the shipped conductor prompt quotes paths that may contain spaces", () => {
  const promptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "plugin", "codex", "prompts", "conductor.md",
  );
  const rendered = renderPrompt(readFileSync(promptPath, "utf-8"), {
    PLUGIN_ROOT: "/a b/plug", PROJECT_ROOT: "/a b/proj", OUTPUT_DIR: "/a b/out",
    CODE_DIR: "/a b/code", BRIEF_PATH: "/a b/brief.md", POLICY: "p", RUN_ID: "r", GATE_INSTRUCTION: "gate text",
    HANDOVER: "",
  });
  assert.match(rendered, /node '\/a b\/plug\/codex\/dispatch\.mjs'/);
  assert.ok(
    !/node \/a b\/plug/.test(rendered),
    "an unquoted path with spaces would split into separate shell arguments",
  );
});

test("the conductor prompt names the run id and folder, the stop record and where tests run", () => {
  const promptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "plugin", "codex", "prompts", "conductor.md",
  );
  const rendered = renderPrompt(readFileSync(promptPath, "utf-8"), {
    PLUGIN_ROOT: "/plug", PROJECT_ROOT: "/proj", OUTPUT_DIR: "/proj/.sdlc/runs/r9",
    CODE_DIR: "/proj/src", BRIEF_PATH: "/proj/brief.md", POLICY: "gpt-plus-flash", RUN_ID: "r9",
    GATE_INSTRUCTION: "gate text", HANDOVER: "",
  });
  assert.match(rendered, /Your run id is `r9` and your run folder is `\/proj\/\.sdlc\/runs\/r9`/);
  assert.match(rendered, /Do not\s+generate another run id/);
  assert.match(rendered, /`\/proj\/\.sdlc\/runs\/r9\/stop\.json`/);
  assert.match(rendered, /7\. test_run +→ in \/proj\/src:/);
  assert.match(rendered, /"decision": "pending\|/);
});

test("the shipped conductor prompt states the authors-no-content rule", () => {
  const promptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "plugin", "codex", "prompts", "conductor.md",
  );
  const text = readFileSync(promptPath, "utf-8");
  assert.match(text, /author no shipped content/i, "D1's conductor rule must be stated explicitly");
  assert.match(text, /search/i, "the web-search disclosure mandate must be present");
});

// ── run.mjs: gate modes ──────────────────────────────────────────────────

test("the default gate mode records the gate as pending and ends the turn, so run.mjs can relay it", () => {
  assert.match(GATE_MODES.prompt, /"decision": "pending"/);
  assert.match(GATE_MODES.prompt, /end your turn/i);
  assert.match(GATE_MODES.prompt, /next message/i);
  assert.match(GATE_MODES.prompt, /Never record a decision they did not give/);
  assert.ok(!/\{\{/.test(GATE_MODES.prompt), "it is rendered into the prompt, so it may not carry a placeholder");
});

test("under prompt, a question that is not a gate is relayed through question.json; unattended, it stops the run", () => {
  assert.match(GATE_MODES.prompt, /brownfield job type or interview, the Phase 7 environment check/);
  assert.match(GATE_MODES.prompt, /\{"question": "<the question, one line>"\} to question\.json/);
  for (const mode of ["auto-approve", "auto-abort"]) {
    assert.match(GATE_MODES[mode], /Do not ask a question you cannot receive an answer to/);
    assert.match(GATE_MODES[mode], /stop\.json/);
  }
});

test("auto-approve tells the conductor not to ask a question it cannot receive an answer to", () => {
  // `codex exec` runs with stdin closed. A conductor told to "wait for the
  // user" in that mode waits forever.
  assert.match(GATE_MODES["auto-approve"], /UNATTENDED/);
  assert.match(GATE_MODES["auto-approve"], /stdin is closed/i);
  assert.match(GATE_MODES["auto-approve"], /without waiting/i);
});

test("auto-approve still requires the conductor to flag an artifact a reviewer would reject", () => {
  // Auto-approving must not become "pass everything silently" — the whole
  // reason to record the mode is that nobody read the output.
  assert.match(GATE_MODES["auto-approve"], /would have rejected/i);
});

test("auto-abort stops rather than proceeding", () => {
  assert.match(GATE_MODES["auto-abort"], /stop the run/i);
});

test("every documented gate mode has instruction text", () => {
  for (const mode of ["prompt", "auto-approve", "auto-abort"]) {
    assert.ok(GATE_MODES[mode]?.length > 40, `${mode} needs real instruction text`);
  }
});

// ── run.mjs: skill rendering ─────────────────────────────────────────────

test("renderSkills writes both skills with every placeholder resolved", () => {
  const dir = tmp();
  try {
    const written = renderSkills(dir, {
      PLUGIN_ROOT: "/plug", PROJECT_ROOT: "/proj", OUTPUT_DIR: "/out",
      CODE_DIR: "/code", BRIEF_PATH: "/proj/brief.md", POLICY: "gpt-plus-flash", RUN_ID: "r1", GATE_INSTRUCTION: "g", GATE_INSTRUCTION: "gate text",
    });
    for (const name of ["pipeline.md", "brownfield-guide.md", "discovery.md"]) {
      assert.ok(written.includes(join(dir, "skills", name)), `${name} must render`);
    }
    for (const path of written) {
      const text = readFileSync(path, "utf-8");
      assert.ok(
        !/\{\{[A-Z_]+\}\}/.test(text),
        `${path} still carries a placeholder — the conductor would be handed an unrunnable command`,
      );
    }
  } finally { cleanup(dir); }
});

test("a rendered skill's dispatch command carries real paths, not markers", () => {
  const dir = tmp();
  try {
    renderSkills(dir, {
      PLUGIN_ROOT: "/plug", PROJECT_ROOT: "/proj", OUTPUT_DIR: "/out",
      CODE_DIR: "/code", BRIEF_PATH: "/b.md", POLICY: "gpt-plus-flash", RUN_ID: "r1", GATE_INSTRUCTION: "g", GATE_INSTRUCTION: "g", GATE_INSTRUCTION: "gate text",
    });
    const text = readFileSync(join(dir, "skills", "pipeline.md"), "utf-8");
    assert.match(text, /node '\/plug\/codex\/dispatch\.mjs'/);
    assert.match(text, /--policy=gpt-plus-flash/);
  } finally { cleanup(dir); }
});

// ── run.mjs: turning a finished stream into artifacts ────────────────────

const REAL_STREAM = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50,"reasoning_output_tokens":10}}',
].join("\n");

const PRICING = { input: 2.0, input_cached: 0.2, output: 12.0 };

const POLICY_REF = { name: "gpt-seat-plus-flash", version: 1 };

test("buildRunArtifacts models the driver's own cost from real turn usage", () => {
  const { modeled, rejection } = buildRunArtifacts({
    jsonl: REAL_STREAM, pin: PIN, pricing: PRICING, passId: "run-1", policy: POLICY_REF,
    now: () => "2026-08-31T00:00:00.000Z",
  });
  assert.equal(rejection, null);
  assert.equal(modeled.length, 1);
  assert.equal(modeled[0].provenance, "modeled", "driver cost is never presented as vendor-metered");
  assert.equal(modeled[0].pass, "run-1");
  // fresh input is total MINUS cached (1000 - 400): codex/OpenAI report
  // input_tokens inclusive of the cached subset.
  const expected = (600 / 1e6) * 2.0 + (400 / 1e6) * 0.2 + (50 / 1e6) * 12.0;
  assert.ok(Math.abs(modeled[0].cost_usd - expected) < 1e-9);
});

test("buildRunArtifacts surfaces a pin rejection from the stream", () => {
  const rejected = '{"type":"turn.failed","error":{"message":"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] bad"}}';
  const { rejection } = buildRunArtifacts({ jsonl: rejected, pin: PIN, pricing: PRICING, passId: "r", policy: POLICY_REF });
  assert.ok(rejection, "a rejected pin must be detected, not silently reported as a clean run");
  assert.match(rejection, /invalid_enum_value/);
});

test("buildRunArtifacts names the policy the run used, not a hard-coded one", () => {
  const { modeled } = buildRunArtifacts({
    jsonl: REAL_STREAM, pin: PIN, pricing: PRICING, passId: "r", policy: resolveRunPolicy({ projectRoot: join(dirname(fileURLToPath(import.meta.url)), "fixtures"), policyArg: "gpt-seat-plus-flash" }).policy,
  });
  assert.equal(modeled[0].routing.policy_name, "gpt-seat-plus-flash");
});

test("buildRunArtifacts prices a resumed thread once, from its running total", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-0.160.1");
  const jsonl = ["exec1", "exec2", "exec3"].map((f) => readFileSync(join(fixtures, `${f}.jsonl`), "utf-8")).join("");
  const { modeled } = buildRunArtifacts({ jsonl, pin: PIN, pricing: PRICING, passId: "r", policy: POLICY_REF });
  assert.deepEqual(modeled.map((r) => r.input_tokens + r.input_tokens_cached), [1000, 3000, 5000]);
  const total = modeled.reduce((s, r) => s + r.cost_usd, 0);
  assert.ok(Math.abs(total - 0.01494) < 1e-9, `three invocations price at the last running total, got ${total}`);
});

// ── dispatch.mjs: the conductor's bridge tool ────────────────────────────

test("buildExecuteArgs includes only the fields actually supplied", () => {
  const packet = { id: "p1" };
  assert.deepEqual(buildExecuteArgs({ packet }), { packet });
  assert.deepEqual(
    buildExecuteArgs({ packet, policy: "gpt-plus-flash", projectRoot: "/p", telemetryPath: "/t.jsonl", workDir: "/w" }),
    { packet, policy_name: "gpt-plus-flash", project_root: "/p", telemetry_path: "/t.jsonl", work_dir: "/w" },
  );
});

test("buildPreflightArgs always carries auth_mode — the bridge refuses to guess it", () => {
  assert.deepEqual(buildPreflightArgs({ authMode: "vendor" }), { auth_mode: "vendor" });
});

test("bridgeEnv folds in the stored MMO_SELECT, but an explicit export wins", () => {
  assert.deepEqual(bridgeEnv("/p", {}, () => "gemini-flash=flash-agsdk-worker"), {
    MMO_SELECT: "gemini-flash=flash-agsdk-worker",
  });
  assert.equal(bridgeEnv("/p", { MMO_SELECT: "already=set" }, () => "stored=value"), undefined);
  assert.equal(bridgeEnv("/p", {}, () => undefined), undefined);
});

test("summarize prints a compact line for a dispatch, with no result body", () => {
  const line = summarize("execute_with_model", {
    decision: { modelId: "gpt" },
    result: { success: true, cost_usd: 0.0123 },
  });
  assert.match(line, /model=gpt/);
  assert.match(line, /success=true/);
  assert.match(line, /cost_usd=0\.0123/);
});

test("summarize reports preflight per-model status", () => {
  const line = summarize("preflight_dispatch", {
    ok: false,
    models: [{ id: "gpt", ok: false }, { id: "flash-completion", ok: true }],
  });
  assert.match(line, /preflight ok=false/);
  assert.match(line, /gpt:FAILED/);
  assert.match(line, /flash-completion:ok/);
});

test("runDispatch writes the full result to --out and returns only a summary", async () => {
  const dir = tmp();
  try {
    const packetPath = join(dir, "packet.json");
    const outPath = join(dir, "result.json");
    writeFileSync(packetPath, JSON.stringify({ id: "p1", phase: "docs" }));

    const fakeResult = { decision: { modelId: "gpt" }, result: { success: true, cost_usd: 0.5 } };
    const calls = [];
    const connect = async () => ({
      callTool: async (name, args) => { calls.push({ name, args }); return fakeResult; },
      close: async () => {},
    });

    const out = await runDispatch(
      { packet: packetPath, out: outPath, policy: "gpt-plus-flash", telemetry: join(dir, "telemetry.jsonl") },
      { connect },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "execute_with_model");
    assert.deepEqual(calls[0].args.packet, { id: "p1", phase: "docs" });
    assert.equal(calls[0].args.policy_name, "gpt-plus-flash");
    assert.deepEqual(JSON.parse(readFileSync(outPath, "utf8")), fakeResult);
    assert.match(out.summary, /success=true/);
  } finally { cleanup(dir); }
});

test("runDispatch routes --preflight to preflight_dispatch with the auth mode", async () => {
  const dir = tmp();
  try {
    const outPath = join(dir, "pre.json");
    const calls = [];
    const connect = async () => ({
      callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, models: [] }; },
      close: async () => {},
    });
    await runDispatch({ preflight: true, "auth-mode": "vendor", out: outPath }, { connect });
    assert.equal(calls[0].name, "preflight_dispatch");
    assert.equal(calls[0].args.auth_mode, "vendor");
    assert.ok(existsSync(outPath));
  } finally { cleanup(dir); }
});

test("runDispatch reports ok:false when preflight itself fails — the exit code carries the verdict", async () => {
  const dir = tmp();
  try {
    const connect = async () => ({
      callTool: async () => ({ ok: false, halt_reason: "no credential", models: [] }),
      close: async () => {},
    });
    const out = await runDispatch(
      { preflight: true, "auth-mode": "vendor", out: join(dir, "p.json") },
      { connect },
    );
    assert.equal(out.ok, false, "a caller checking only the exit code must not read this as a pass");
  } finally { cleanup(dir); }
});

test("runDispatch reports ok:true for a successful execute_with_model regardless of payload shape", async () => {
  const dir = tmp();
  try {
    const packetPath = join(dir, "p.json");
    writeFileSync(packetPath, JSON.stringify({ id: "p" }));
    const connect = async () => ({
      callTool: async () => ({ result: { success: true } }),
      close: async () => {},
    });
    const out = await runDispatch({ packet: packetPath, out: join(dir, "o.json"), telemetry: join(dir, "t.jsonl") }, { connect });
    assert.equal(out.ok, true);
  } finally { cleanup(dir); }
});

test("runDispatch refuses --preflight without an auth mode", async () => {
  await assert.rejects(
    () => runDispatch({ preflight: true, out: "/tmp/x.json" }, { connect: async () => ({}) }),
    /--auth-mode=vendor\|estimated is required/,
  );
});

test("runDispatch requires --out — results never go to stdout", async () => {
  await assert.rejects(
    () => runDispatch({ packet: "/tmp/p.json" }, { connect: async () => ({}) }),
    /--out=<path> is required/,
  );
});

test("runDispatch gives a readable error for an unreadable packet file", async () => {
  await assert.rejects(
    () => runDispatch({ packet: "/nonexistent/packet.json", out: "/tmp/o.json", telemetry: "/tmp/t.jsonl" }, { connect: async () => ({}) }),
    /could not read the packet/,
  );
});

test("runDispatch always closes the bridge, even when the tool call throws", async () => {
  const dir = tmp();
  try {
    const packetPath = join(dir, "p.json");
    writeFileSync(packetPath, JSON.stringify({ id: "p" }));
    let closed = false;
    const connect = async () => ({
      callTool: async () => { throw new Error("vendor exploded"); },
      close: async () => { closed = true; },
    });
    await assert.rejects(
      () => runDispatch({ packet: packetPath, out: join(dir, "o.json"), telemetry: join(dir, "t.jsonl") }, { connect }),
      /vendor exploded/,
    );
    assert.equal(closed, true, "a leaked bridge subprocess would outlive the run");
  } finally { cleanup(dir); }
});

test("parseDispatchArgs handles --key=value and bare flags", () => {
  assert.deepEqual(parseDispatchArgs(["--packet=/p.json", "--preflight", "--out=/o.json"]), {
    packet: "/p.json", preflight: true, out: "/o.json",
  });
});

// ── the brownfield handover ──────────────────────────────────────────────
//
// The brownfield guide's step 4 branches on a block naming `intent:` and
// `seed_description:`, supplied by whichever entry point invoked it.
// Interactively that comes from the job-alias skill the user picked.
// Headlessly there was no way to supply one — so an unattended brownfield run
// reached step 4a, which asks the user to choose a job type, with stdin
// closed and nobody to answer. `--mode` / `--intent` / `--seed` fix that.

test("validIntents reads the ids from intents.json rather than duplicating them", () => {
  // Duplicating the list would let a new intent be valid to the guide and
  // rejected by the driver, or the reverse.
  const ids = validIntents();
  for (const expected of ["docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"]) {
    assert.ok(ids.includes(expected), `intents.json should define '${expected}'`);
  }
});

test("renderHandover emits nothing when no job was supplied", () => {
  // The guide's documented third case — ask which job type — must survive
  // untouched, so an empty handover has to be genuinely empty.
  assert.equal(renderHandover({}), "");
  assert.equal(renderHandover(), "");
});

test("renderHandover writes the keys the brownfield guide actually reads", () => {
  const block = renderHandover({ mode: "brownfield", intent: "bugfix", seed: "login 500s" });
  assert.match(block, /^mode: brownfield$/m);
  assert.match(block, /^intent: bugfix$/m);
  assert.match(block, /^seed_description: login 500s$/m);
  assert.match(block, /do not ask the questions it already answers/i);
});

test("renderHandover flattens a multi-line seed onto one line", () => {
  // The block is one key per line; a seed carrying a newline would otherwise
  // produce a line the guide reads as an unknown key.
  const block = renderHandover({ intent: "docs", seed: "document\nthe   auth\tmodule" });
  assert.match(block, /^seed_description: document the auth module$/m);
});

test("renderHandover omits keys it was not given", () => {
  const block = renderHandover({ intent: "test" });
  assert.match(block, /^intent: test$/m);
  assert.doesNotMatch(block, /seed_description:/);
  assert.doesNotMatch(block, /^mode:/m);
});

test("the conductor prompt has a HANDOVER slot for it to land in", () => {
  // renderPrompt throws on any unrendered placeholder, so a slot that exists
  // in one file and not the other fails every run rather than silently
  // dropping the handover.
  const prompt = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "codex", "prompts", "conductor.md"),
    "utf-8",
  );
  assert.match(prompt, /\{\{HANDOVER\}\}/, "conductor prompt must carry the slot");
});

test("an empty handover leaves no stray placeholder in the rendered prompt", () => {
  const rendered = renderPrompt("before\n{{HANDOVER}}after", { HANDOVER: renderHandover({}) });
  assert.equal(rendered, "before\nafter");
});

// ── multi-turn continuation ──────────────────────────────────────────────
//
// One `codex exec` turn does not finish a real project. The Workforce Ops
// reference run got through requirements, design and into codegen, then the
// turn ended: 2.9M input tokens (2.8M cached), context ceiling reached, six
// phases to go — and it reported `exit=0` with no error. An unfinished run
// that looks successful is the worst shape this failure could take, so the
// driver now resumes the session until the pipeline signals completion.

test("costCapStop lets the run resume under the cap and stops it once the cap is spent", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cap-"));
  try {
    const policy = { ...resolveRunPolicy({ projectRoot: dir, policyArg: "gpt-plus-flash" }).policy, hard_cost_cap_usd: 0.5 };
    const telemetry = join(dir, "telemetry.jsonl");
    assert.equal(costCapStop(policy, telemetry), null, "no telemetry yet is under any cap");
    writeFileSync(telemetry, JSON.stringify({ cost_usd: 0.3 }) + "\n");
    assert.equal(costCapStop(policy, telemetry), null);
    writeFileSync(telemetry, JSON.stringify({ cost_usd: 0.3 }) + "\n" + JSON.stringify({ cost_usd: 0.2 }) + "\n");
    assert.match(costCapStop(policy, telemetry), /COST_CAP_EXCEEDED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("threadIdFrom reads the session id out of the event stream", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"01a0560d-55c0-7141-b85d-9509e3dd5226"}',
    '{"type":"turn.started"}',
  ].join("\n");
  assert.equal(threadIdFrom(stream), "01a0560d-55c0-7141-b85d-9509e3dd5226");
});

test("threadIdFrom returns null rather than throwing on a stream without one", () => {
  // No id means no resume is possible; the driver must stop, not crash.
  assert.equal(threadIdFrom('{"type":"turn.started"}\nnot json at all'), null);
  assert.equal(threadIdFrom(""), null);
  assert.equal(threadIdFrom(undefined), null);
});

test("buildCodexArgs puts `resume <id>` directly after `exec`", () => {
  // codex requires the subcommand in that position; anywhere else it is
  // parsed as a prompt argument and a fresh session starts silently.
  const args = buildCodexArgs({
    pin: PIN, promptText: "continue", cwd: "/proj", resumeThreadId: "abc-123",
  });
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume");
  assert.equal(args[2], "abc-123");
});

test("a fresh invocation carries no resume subcommand", () => {
  const args = buildCodexArgs({ pin: PIN, promptText: "start", cwd: "/proj" });
  assert.ok(!args.includes("resume"));
  assert.equal(args[1], "--json");
});

test("a resumed turn keeps the pin, the sandbox and the write-contract hook", () => {
  // A resumed turn that dropped the hook would write unguarded, and one that
  // dropped the pin would silently answer on a different model.
  const args = buildCodexArgs({
    pin: PIN, promptText: RESUME_PROMPT, cwd: "/proj", resumeThreadId: "abc-123",
  });
  assert.equal(args[args.indexOf("-m") + 1], PIN.model);
  assert.ok(args.includes(`model_reasoning_effort="${PIN.effort}"`));
  assert.ok(args.includes(`sandbox_mode="${SANDBOX_MODE}"`), "sandbox must survive a resume");
  assert.ok(args.some((a) => a.includes("write-contract-check.mjs")), "hook must survive a resume");
  assert.ok(args.includes("features.hooks=true") && args.includes(HOOKS_OFF), "and so must its switches");
  assert.ok(args.some((a) => a.includes("network_access=true")), "bridge needs the network grant");
});

test("a resumed invocation is told its gate mode and never to answer a pending gate", () => {
  for (const mode of Object.keys(GATE_MODES)) {
    const text = resumePrompt(mode);
    assert.ok(text.startsWith(RESUME_PROMPT));
    assert.ok(text.includes(`Gate mode for this invocation: ${GATE_MODES[mode]}`), mode);
  }
  assert.match(RESUME_PROMPT, /do not answer it yourself/i);
  assert.match(RESUME_PROMPT, /record why before you end your turn/i);
  assert.doesNotMatch(RESUME_PROMPT, /say why again/i, "a stop with no new record reads as a context-ceiling stop");
});

test("a resume after a deliberate stop says the person chose to continue past it", () => {
  const after = { outcome: "aborted", reason: "gate 1 aborted: auto-abort" };
  const text = resumePrompt("auto-approve", after);
  assert.match(text, /last stopped on purpose \(aborted: gate 1 aborted: auto-abort\)/);
  assert.match(text, /resumed it with --gates=auto-approve: they chose to continue past that stop/);
  assert.match(text, /write a new record first/);
  assert.ok(text.endsWith(`Gate mode for this invocation: ${GATE_MODES["auto-approve"]}`));
  for (const outcome of ["max_turns", "interrupted", "codex_failed", "killed"]) {
    assert.equal(resumePrompt("prompt", { outcome }), resumePrompt("prompt"), outcome);
  }
});

test("a question's answer is passed through as the person's words, with the gate mode", () => {
  const text = questionAnswerPrompt("bugfix\n", "prompt");
  assert.match(text, /^Answer from the person to your question: bugfix\n/);
  assert.ok(text.includes(GATE_MODES.prompt));
});

test("the terminal reader drops input typed before the question and reads the line after it", async () => {
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  const reader = createLineReader(stdin);
  reader.attach();
  stdin.write("stale\n\n");
  let dropped = null;
  const answer = reader.ask((n) => {
    dropped = n;
    setImmediate(() => stdin.write("approved\n"));
  });
  assert.equal(await answer, "approved");
  assert.equal(dropped, 2);

  const next = reader.ask(() => setImmediate(() => reader.cancel()));
  assert.equal(await next, null, "cancel ends the wait");
  assert.equal(await reader.ask(), null, "and every later one");
  reader.close();
});

test("the terminal reader answers null at end of input", async () => {
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  const reader = createLineReader(stdin);
  stdin.end("typed before the question\n");
  assert.equal(await reader.ask(), null);
  reader.close();
});

test("a gate answer is passed through as the person's words, with the gate mode", () => {
  const text = gateAnswerPrompt(2, "revise: add rate limits\n", "prompt");
  assert.match(text, /^Gate 2 answer from the person: revise: add rate limits\n/);
  assert.ok(text.includes(GATE_MODES.prompt));
});

test("buildCodexArgs passes --skip-git-repo-check only when asked, right after --json", () => {
  for (const resumeThreadId of [null, "abc-123"]) {
    const argv = buildCodexArgs({ pin: PIN, promptText: "x", skipGitRepoCheck: true, resumeThreadId });
    assert.equal(argv[argv.indexOf("--json") + 1], "--skip-git-repo-check");
    assert.ok(argv.indexOf("--skip-git-repo-check") < argv.indexOf("--"));
    assert.ok(!buildCodexArgs({ pin: PIN, promptText: "x", resumeThreadId }).includes("--skip-git-repo-check"));
  }
});

test("the resume prompt tells the model not to redo finished work", () => {
  // Restating the pipeline would burn the context that just ran out, and
  // re-dispatching completed packets would double-bill the run.
  assert.match(RESUME_PROMPT, /do not redo completed phases/i);
  assert.match(RESUME_PROMPT, /result file already exists/i);
  assert.match(RESUME_PROMPT, /SUMMARY\.md/, "it must know what finishing looks like");
  assert.match(RESUME_PROMPT, /author no shipped content/i, "the D1 rule must survive the resume");
});

test("the turn cap is a positive integer with room for a real project", () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_TURNS) && DEFAULT_MAX_TURNS > 1);
});

test("a resumed turn passes no flag that `codex exec resume` rejects", () => {
  // `codex exec resume` accepts a strict subset of `codex exec`'s flags.
  // --sandbox, --add-dir and -C/--cd are exec-only: passing any of them makes
  // codex exit 2 on argument parsing, before doing any work. That is exactly
  // how the Workforce Ops run died — 57 dispatches of real work completed,
  // then the resume failed instantly and the run ended incomplete.
  const args = buildCodexArgs({
    pin: PIN, promptText: RESUME_PROMPT, cwd: "/proj",
    codexHome: "/home/u/.codex", resumeThreadId: "abc-123",
  });
  for (const rejected of ["--sandbox", "--add-dir", "-C", "--cd"]) {
    assert.ok(
      !args.includes(rejected),
      `${rejected} is exec-only; codex exec resume exits 2 when given it`,
    );
  }
});

test("the resumed turn keeps sandbox and writable roots via config keys instead", () => {
  // The settings are load-bearing, so they have to survive the switch away
  // from the exec-only flags: a resumed turn that lost workspace-write could
  // not write, and one that lost the CODEX_HOME writable root could not start
  // a nested codex exec for the seat dispatch path.
  const args = buildCodexArgs({
    pin: PIN, promptText: RESUME_PROMPT, cwd: "/proj",
    codexHome: "/home/u/.codex", resumeThreadId: "abc-123",
  });
  assert.ok(args.includes(`sandbox_mode="${SANDBOX_MODE}"`), "sandbox must survive as a config key");
  assert.ok(
    args.some((a) => typeof a === "string" && a.includes("writable_roots") && a.includes("/home/u/.codex")),
    "CODEX_HOME must stay writable for the nested codex exec",
  );
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"), "the bridge still needs network");
});

test("a fresh turn still uses the exec-only flags, which it may", () => {
  const args = buildCodexArgs({
    pin: PIN, promptText: "start", cwd: "/proj", codexHome: "/home/u/.codex",
  });
  assert.equal(args[args.indexOf("-C") + 1], "/proj");
  assert.ok(args.includes(`sandbox_mode="${SANDBOX_MODE}"`));
});
