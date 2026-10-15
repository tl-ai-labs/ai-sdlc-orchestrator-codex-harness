import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POLICY_PATH_ENV, runDispatch } from "../../plugin/codex/dispatch.mjs";
import { appendSessionMarker, SESSION_MARKERS_FILE } from "../../plugin/codex/session-marker.mjs";

const THREAD = "01a2000a-0000-7000-8000-0000000000aa";

function tmp() {
  return mkdtempSync(join(tmpdir(), "mmo-marker-"));
}

function fakeBridge(result = { result: { success: true } }) {
  const calls = [];
  return {
    calls,
    connect: async () => ({
      callTool: async (name, args) => {
        calls.push({ name, args });
        return result;
      },
      close: async () => {},
    }),
  };
}

const markers = (dir) =>
  readFileSync(join(dir, SESSION_MARKERS_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));

test("a dispatch from a codex shell leaves one marker beside its telemetry", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "runs", "r1");
    mkdirSync(run, { recursive: true });
    const packet = join(dir, "p.json");
    writeFileSync(packet, JSON.stringify({ id: "p" }));
    const { connect } = fakeBridge();
    await runDispatch(
      { packet, out: join(dir, "o.json"), policy: "gpt-plus-flash", telemetry: join(run, "telemetry.jsonl") },
      { connect, env: { CODEX_THREAD_ID: THREAD } },
    );
    const [m] = markers(run);
    assert.deepEqual(Object.keys(m).sort(), ["pid", "policy", "thread_id", "tool", "ts"]);
    assert.equal(m.thread_id, THREAD);
    assert.equal(m.tool, "execute_with_model");
    assert.equal(m.policy, "gpt-plus-flash");
    assert.equal(m.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(m.ts)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the marker names the policy file the bridge is handed, which outranks a --policy name", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "runs", "r1");
    mkdirSync(run, { recursive: true });
    const packet = join(dir, "p.json");
    writeFileSync(packet, JSON.stringify({ id: "p" }));
    const policyFile = join(dir, "routing-policy.yaml");
    const { connect, calls } = fakeBridge();
    await runDispatch(
      { packet, out: join(dir, "o.json"), policy: "gpt-plus-flash", telemetry: join(run, "telemetry.jsonl") },
      { connect, env: { CODEX_THREAD_ID: THREAD, [POLICY_PATH_ENV]: policyFile } },
    );
    assert.equal(calls[0].args.policy_path, policyFile);
    assert.equal(markers(run)[0].policy, policyFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the marker is written before the bridge is reached, so the cap check can see it", async () => {
  const dir = tmp();
  try {
    let seen = null;
    const connect = async () => {
      seen = existsSync(join(dir, SESSION_MARKERS_FILE));
      return { callTool: async () => ({ ok: true }), close: async () => {} };
    };
    await runDispatch({ preflight: true, "auth-mode": "vendor", out: join(dir, "preflight.json") }, { connect, env: { CODEX_THREAD_ID: THREAD } });
    assert.equal(seen, true);
    assert.equal(markers(dir)[0].tool, "preflight_dispatch", "--preflight writes it beside --out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a logged phase leaves a marker too", async () => {
  const dir = tmp();
  try {
    const { connect } = fakeBridge("ok");
    await runDispatch(
      { "log-phase": "docs", "task-type": "skipped", telemetry: join(dir, "telemetry.jsonl"), out: join(dir, "r.json") },
      { connect, env: { CODEX_THREAD_ID: THREAD } },
    );
    assert.equal(markers(dir)[0].tool, "log_telemetry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outside codex, or with no run folder to write to, no marker is written", async () => {
  const dir = tmp();
  try {
    const packet = join(dir, "p.json");
    writeFileSync(packet, JSON.stringify({ id: "p" }));
    const { connect } = fakeBridge();
    await runDispatch({ packet, out: join(dir, "o.json"), telemetry: join(dir, "telemetry.jsonl") }, { connect, env: {} });
    assert.equal(existsSync(join(dir, SESSION_MARKERS_FILE)), false);
    await assert.rejects(
      () => runDispatch({ packet, out: join(dir, "o.json") }, { connect, env: { CODEX_THREAD_ID: THREAD } }),
      /--telemetry=<path> is required/,
    );
    assert.equal(existsSync(join(dir, SESSION_MARKERS_FILE)), false, "no --telemetry: refused before any marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare --telemetry flag with no value does not trip the marker", async () => {
  const dir = tmp();
  try {
    const packet = join(dir, "p.json");
    writeFileSync(packet, JSON.stringify({ id: "p" }));
    const { connect, calls } = fakeBridge({ ok: true });
    await assert.rejects(
      () => runDispatch({ packet, out: join(dir, "o.json"), telemetry: true }, { connect, env: { CODEX_THREAD_ID: THREAD } }),
      /--telemetry=<path> is required/,
    );
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(dir, SESSION_MARKERS_FILE)), false);

    await runDispatch(
      { preflight: true, "auth-mode": "vendor", out: join(dir, "preflight.json"), telemetry: true },
      { connect, env: { CODEX_THREAD_ID: THREAD } },
    );
    assert.equal(calls.length, 1);
    assert.equal(markers(dir)[0].tool, "preflight_dispatch", "a preflight falls back to --out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable run folder warns and the dispatch still goes ahead", async () => {
  const dir = tmp();
  try {
    const run = join(dir, "locked");
    mkdirSync(run);
    chmodSync(run, 0o500);
    const warnings = [];
    const marker = appendSessionMarker(run, { tool: "execute_with_model" }, { env: { CODEX_THREAD_ID: THREAD }, warn: (m) => warnings.push(m) });
    if (process.getuid?.() === 0) return;
    assert.equal(marker, null);
    assert.match(warnings[0], /could not append/);

    const packet = join(dir, "p.json");
    writeFileSync(packet, JSON.stringify({ id: "p" }));
    const { connect, calls } = fakeBridge();
    const original = console.error;
    console.error = () => {};
    try {
      const out = await runDispatch(
        { packet, out: join(dir, "o.json"), telemetry: join(run, "telemetry.jsonl") },
        { connect, env: { CODEX_THREAD_ID: THREAD } },
      );
      assert.equal(out.ok, true);
    } finally {
      console.error = original;
    }
    assert.equal(calls.length, 1);
  } finally {
    chmodSync(join(dir, "locked"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the marker file name matches the one the session reader looks for", async () => {
  const { SESSION_MARKERS_FILE: readerName } = await import("../../plugin/mcp/model-dispatch/dist/sessionUsage.js");
  assert.equal(SESSION_MARKERS_FILE, readerName);
});
