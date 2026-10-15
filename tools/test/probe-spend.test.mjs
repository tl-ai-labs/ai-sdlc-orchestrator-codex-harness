/**
 * The agent-worker probe spends about two cents, so it records that spend in
 * the bridge's event shape and says how the SDK's usage was read. Pure
 * helpers only; the probe itself makes a real call and is never run here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyFailure, probePacket, probeSpendEvents, probeTelemetryPath, sdkLines } from "../../plugin/scripts/probe-agent-worker.mjs";
import { pinnedSdkVersion } from "../../plugin/codex/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "plugin", "mcp", "model-dispatch", "dist");
const BUILT = existsSync(join(DIST, "dispatchEvents.js"));

test("the probe records to --telemetry, else the project's pre-check file, else its evidence folder", () => {
  assert.equal(probeTelemetryPath({ flag: "t.jsonl", cwd: "/proj", evidenceDir: "/tmp/e" }), "/proj/t.jsonl");
  assert.equal(
    probeTelemetryPath({ cwd: "/proj", evidenceDir: "/tmp/e", exists: (p) => p === "/proj/.sdlc" }),
    "/proj/.sdlc/pre-check/telemetry.jsonl",
  );
  assert.equal(
    probeTelemetryPath({ cwd: "/proj", evidenceDir: "/tmp/e", exists: () => false }),
    "/tmp/e/telemetry.jsonl",
    "a project with no .sdlc/ does not get one",
  );
});

test("the probe's spend line has the bridge's event shape, marked manual", { skip: !BUILT && "server not built" }, async () => {
  const { attemptEvents } = await import(join(DIST, "dispatchEvents.js"));
  const packet = probePacket();
  const [ev, ...rest] = probeSpendEvents({
    attemptEvents,
    policy: { name: "gpt-plus-flash", version: 1 },
    leaf: { id: "flash-agsdk-worker", model_name: "gemini-3.7-flash" },
    packet,
    ts: "2026-10-13T00:00:00.000Z",
    result: {
      result: { ok: true },
      tokens: { input: 12245, input_cached: 0, output: 154 },
      cost_usd: 0.0198,
      latency_ms: 9000,
      cache_hit: false,
      success: true,
      attempts: [
        { attempt_number: 1, ceiling_used: 256, hit_output_cap: false, tokens: { input: 12245, input_cached: 0, output: 154 }, cost_usd: 0.0198, latency_ms: 9000, success: true },
      ],
    },
  });
  assert.equal(rest.length, 0);
  assert.equal(ev.routed_by, "manual");
  assert.equal(ev.task_id, packet.id);
  assert.equal(ev.model_id, "flash-agsdk-worker");
  assert.equal(ev.cost_usd, 0.0198);
  assert.equal(ev.provenance, "vendor");
  assert.equal(ev.routing.policy_name, "gpt-plus-flash");
});

test("the probe says how the SDK's input was read, and warns on an unchecked version", { skip: !BUILT && "server not built" }, async () => {
  const { sidecarUsageSemantics } = await import(join(DIST, "delegation", "workerProcess.js"));
  const [ok, ...noWarning] = sdkLines({ sdk: "google-antigravity", sdk_version: "0.1.16", usage: {} }, sidecarUsageSemantics);
  assert.match(ok, /google-antigravity 0\.1\.16 \(input read as disjoint\)/);
  assert.equal(noWarning.length, 0);
  const [line, warning] = sdkLines({ sdk_version: "0.1.18", usage: {} }, sidecarUsageSemantics);
  assert.match(line, /unverified/);
  assert.match(warning, /AGY_USAGE_SEMANTICS/);
  assert.match(sdkLines(null, sidecarUsageSemantics)[0], /no usage sidecar/);
});

test("with GEMINI_WORKER_PYTHON set, the probe's version warning names that interpreter, not --fix alone", { skip: !BUILT && "server not built" }, async () => {
  const { sidecarUsageSemantics } = await import(join(DIST, "delegation", "workerProcess.js"));
  const [, warning] = sdkLines({ sdk_version: "0.1.18", usage: {} }, sidecarUsageSemantics, { pythonOverride: "/opt/py/bin/python3", pin: "0.1.16" });
  assert.match(warning, /\/opt\/py\/bin\/python3 -m pip install google-antigravity==0\.1\.16/);
  assert.match(warning, /unset GEMINI_WORKER_PYTHON/, "--fix rebuilds the plugin's .venv, which this interpreter is not");
});

test("the documented pin in troubleshooting.md is the one requirements.txt holds", () => {
  const pin = pinnedSdkVersion(readFileSync(join(ROOT, "plugin", "mcp", "model-dispatch", "worker", "requirements.txt"), "utf8"));
  const doc = readFileSync(join(ROOT, "docs", "troubleshooting.md"), "utf8");
  const named = [...doc.matchAll(/google-antigravity==(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(named.length > 0);
  for (const v of named) assert.equal(v, pin, "raise the pin in the docs with requirements.txt");
});

/** Runs the real probe in `dir` against a stand-in worker interpreter that reports fixed usage. */
function runProbe(dir) {
  const stub = join(dir, "python");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("--usage-file") + 1], JSON.stringify({ sdk: "google-antigravity", sdk_version: "0.1.16", status: "ok",
  usage: { prompt_token_count: 39439, cached_content_token_count: 128714, candidates_token_count: 4240, thoughts_token_count: 0 } }));
process.stdout.write('{"ok":true}\\n');
`,
  );
  chmodSync(stub, 0o755);
  return spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "probe-agent-worker.mjs"), "--policy=gpt-plus-flash"], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, TMPDIR: dir, GEMINI_WORKER_PYTHON: stub, GOOGLE_CLOUD_PROJECT: "unit-test-project", MMO_LOG_LEVEL: "error" },
  });
}

test("a probe run records its delegation's spend where it says it did", { skip: !BUILT && "server not built" }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "probe-spend-")));
  try {
    mkdirSync(join(dir, ".sdlc"));
    const r = runProbe(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /no report or cost cap reads it/);
    assert.match(r.stdout, /google-antigravity 0\.1\.16 \(input read as disjoint\)/);
    const spend = join(dir, ".sdlc", "pre-check", "telemetry.jsonl");
    assert.match(r.stdout, new RegExp(`recorded +${spend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const [ev, ...rest] = readFileSync(spend, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rest.length, 0);
    assert.equal(ev.cost_usd, 0.055133);
    assert.equal(ev.input_tokens, 39439);
    assert.equal(ev.routed_by, "manual");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a probe run outside a project says its spend is kept where nothing reads it", { skip: !BUILT && "server not built" }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "probe-spend-")));
  try {
    const r = runProbe(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /recorded +\S+\/evidence\/telemetry\.jsonl/);
    assert.match(r.stdout, /no report or cost cap reads it here: run from the project root, or pass --telemetry=<path>/);
    assert.equal(existsSync(join(dir, ".sdlc")), false, "the probe does not create a .sdlc/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the probe's fix lines name verify-setup where it ships", () => {
  const src = readFileSync(join(ROOT, "plugin", "scripts", "probe-agent-worker.mjs"), "utf8");
  assert.doesNotMatch(src, /scripts["/, ]+verify-setup\.mjs/, "verify-setup.mjs lives under codex/, not scripts/");
  assert.ok(existsSync(join(ROOT, "plugin", "codex", "verify-setup.mjs")));
  assert.match(classifyFailure("No module named 'google.antigravity'").fix, /<plugin>\/codex\/verify-setup\.mjs --fix/);
});
