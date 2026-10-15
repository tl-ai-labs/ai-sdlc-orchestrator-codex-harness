/**
 * dispatch.mjs refuses a paid call it cannot record, and its exit code says
 * whether the model call succeeded. The bridge is injected; nothing connects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLogEventArgs, requireTelemetryPath, runDispatch } from "../../plugin/codex/dispatch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function withPacket(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-telemetry-"));
  try {
    const packet = join(dir, "packet.json");
    writeFileSync(packet, JSON.stringify({ id: "p1", phase: "docs" }));
    return await fn(dir, packet);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bridgeReturning = (result, calls = []) => {
  const connect = async () => {
    calls.push("connect");
    return { callTool: async (name, args) => (calls.push({ name, args }), result), close: async () => {} };
  };
  return connect;
};

test("a packet dispatch without --telemetry is refused before the bridge starts", () =>
  withPacket(async (dir, packet) => {
    const calls = [];
    await assert.rejects(
      runDispatch({ packet, out: join(dir, "o.json") }, { connect: bridgeReturning({}, calls) }),
      /--telemetry=<path> is required for --packet/,
    );
    assert.deepEqual(calls, [], "the bridge must not be started for a call nobody would record");
  }));

test("a bare --telemetry with no value is refused too", () =>
  withPacket(async (dir, packet) => {
    await assert.rejects(
      runDispatch({ packet, out: join(dir, "o.json"), telemetry: true }, { connect: bridgeReturning({}) }),
      /--telemetry=<path> is required/,
    );
    assert.throws(() => requireTelemetryPath({ telemetry: "  " }, "--packet"), /required/);
    assert.throws(
      () => buildLogEventArgs({ phase: "docs", telemetryPath: true }),
      /--telemetry=<path> is required for --log-phase/,
    );
  }));

test("the telemetry path reaches execute_with_model", () =>
  withPacket(async (dir, packet) => {
    const calls = [];
    const telemetry = join(dir, "telemetry.jsonl");
    await runDispatch({ packet, out: join(dir, "o.json"), telemetry }, { connect: bridgeReturning({ result: { success: true } }, calls) });
    assert.equal(calls[1].args.telemetry_path, telemetry);
  }));

test("preflight, which spends nothing, still needs no telemetry", () =>
  withPacket(async (dir) => {
    const calls = [];
    await runDispatch({ preflight: true, "auth-mode": "vendor", out: join(dir, "p.json") }, { connect: bridgeReturning({ ok: true, models: [] }, calls) });
    assert.equal(calls[1].name, "preflight_dispatch");
  }));

test("a model call that returned success:false is ok:false, and its result file is still written", () =>
  withPacket(async (dir, packet) => {
    const out = join(dir, "o.json");
    const failed = { decision: { modelId: "gpt" }, result: { success: false, error: "vendor", terminal_reason: "vendor_error", cost_usd: 0.01 } };
    const r = await runDispatch({ packet, out, telemetry: join(dir, "t.jsonl") }, { connect: bridgeReturning(failed) });
    assert.equal(r.ok, false);
    assert.match(r.summary, /success=false/);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), failed);
  }));

test("a reply with no result at all is ok:false", () =>
  withPacket(async (dir, packet) => {
    const r = await runDispatch({ packet, out: join(dir, "o.json"), telemetry: join(dir, "t.jsonl") }, { connect: bridgeReturning({}) });
    assert.equal(r.ok, false);
  }));

test("the CLI exits 1 without --telemetry and says why on stderr", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "plugin", "codex", "dispatch.mjs"), "--packet=/nonexistent.json", "--out=/tmp/never.json"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--telemetry=<path> is required/);
  assert.equal(r.stdout, "");
});

const BRIDGE_BUILT = existsSync(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "server.js"));

test("the CLI exits 1 when the model call returned success:false, says why, and still writes --out", { skip: !BRIDGE_BUILT && "server not built" }, () =>
  withPacket(async (dir) => {
    writeFileSync(
      join(dir, "routing-policy.yaml"),
      [
        "version: 1",
        "name: failing-codex",
        "models:",
        "  - id: gpt",
        "    adapter: codex-cli",
        "    model_name: gpt-5.6-terra",
        "    reasoning: { effort: high }",
        "    pricing: { input: 2.00, input_cached: 0.20, output: 12.00 }",
        "rules:",
        "  - default: gpt",
        "",
      ].join("\n"),
    );
    const codex = join(dir, "codex");
    writeFileSync(
      codex,
      `#!/usr/bin/env node
process.stdout.write([
  '{"type":"thread.started","thread_id":"t-failed"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 1/5"}',
  '{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}',
].join("\\n") + "\\n");
process.exit(1);
`,
    );
    chmodSync(codex, 0o755);
    const packet = join(dir, "full-packet.json");
    writeFileSync(
      packet,
      JSON.stringify({
        id: "tp_cli_failed",
        phase: "requirements_analysis",
        task_type: "analysis",
        module: "all",
        instruction: "Return {ok:true} as JSON.",
        inputs: [{ path: "brief.md", content: "x".repeat(400), reason: "the brief" }],
        outputSchema: { type: "object" },
        acceptance: [],
        budget: { maxInputTokens: 10000, maxOutputTokens: 1000 },
        pass_id: "cli",
      }),
    );
    const out = join(dir, "result.json");
    const telemetry = join(dir, "telemetry.jsonl");
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "plugin", "codex", "dispatch.mjs"), `--packet=${packet}`, `--out=${out}`, `--telemetry=${telemetry}`, `--project-root=${dir}`],
      { encoding: "utf8", env: { ...process.env, CODEX_BIN: codex, MMO_SELECT: "", MMO_LOG_LEVEL: "error" } },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /dispatch: the model call failed \(terminal_reason=vendor_error\): stream disconnected before completion/);
    assert.match(r.stdout, /success=false/);
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.result.success, false, "the result file is written for a failed call too");
    const [ev] = readFileSync(telemetry, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(ev.task_id, "tp_cli_failed");
    assert.equal(ev.success, false);
    assert.equal(ev.provenance, "estimated");
  }));

test("the brownfield Gate-0 smoke dispatch passes --telemetry", () => {
  const skill = readFileSync(join(ROOT, "plugin", "skills", "brownfield-guide", "SKILL.md"), "utf8");
  const commands = skill.split("node '{{PLUGIN_ROOT}}/codex/dispatch.mjs'").slice(1).map((c) => c.split("```")[0]);
  assert.ok(commands.length > 0);
  for (const c of commands) {
    if (/--packet=/.test(c)) assert.match(c, /--telemetry=/, c);
  }
});

test("the brownfield pre-check smoke records to the pre-check's own file and gives the real reason: the run folder exists by then", () => {
  const skill = readFileSync(join(ROOT, "plugin", "skills", "brownfield-guide", "SKILL.md"), "utf8");
  assert.match(skill, /--telemetry='\{\{PROJECT_ROOT\}\}\/\.sdlc\/pre-check\/telemetry\.jsonl'/);
  assert.doesNotMatch(skill, /no run exists yet/);
  assert.match(skill, /cached in `\.sdlc\/pre-check-status\.json` for later runs/);
  const troubleshooting = readFileSync(join(ROOT, "docs", "troubleshooting.md"), "utf8");
  assert.doesNotMatch(troubleshooting, /Outside a run, the brownfield/);
});
