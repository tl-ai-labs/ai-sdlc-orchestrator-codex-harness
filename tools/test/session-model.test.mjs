import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkSessionModel,
  defaultEffort,
  findRolloutFile,
  lastTurnContext,
  sessionThreadId,
} from "../../plugin/codex/session-model.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "codex", "session-model.mjs");
const CLAUDE_POLICIES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "policies", "claude");
const PIN = { model: "gpt-5.6-terra", effort: "high" };
const THREAD = "01a134a6-254f-7181-884c-cadba051fc0c";
const NOW = new Date(2026, 9, 13, 15, 0, 0);
const SENTINEL = "SENTINEL-do-not-print-7f3a";

function turnContext({ model, effort, collab } = {}) {
  const payload = { turn_id: `t-${model}`, model, collaboration_mode: { mode: "default", settings: { model, reasoning_effort: collab ?? null } } };
  if (effort) payload.effort = effort;
  return JSON.stringify({ timestamp: "2026-10-13T09:44:26.000Z", type: "turn_context", payload });
}

function message(text) {
  return JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
}

/** A temp CODEX_HOME holding one rollout file for THREAD. */
function home({ lines, day = "13", modelsCache } = {}) {
  const codexHome = mkdtempSync(join(tmpdir(), "session-model-"));
  const dir = join(codexHome, "sessions", "2026", "10", day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-${day}T15-14-26-${THREAD}.jsonl`);
  if (lines) writeFileSync(path, lines.join("\n") + "\n");
  if (modelsCache) writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ models: modelsCache }));
  return { codexHome, path };
}

function check(h, opts = {}) {
  const warnings = [];
  const result = checkSessionModel({ codexHome: h.codexHome, threadId: THREAD, pin: PIN, policyName: "gpt-plus-flash", warn: (m) => warnings.push(m), now: NOW, ...opts });
  return { result, warnings };
}

function withHome(opts, fn) {
  const h = home(opts);
  try {
    return fn(h);
  } finally {
    rmSync(h.codexHome, { recursive: true, force: true });
  }
}

test("a session on the driver pin matches and warns nothing", () => {
  withHome({ lines: [message(SENTINEL), turnContext({ model: "gpt-5.6-terra", effort: "high" })] }, (h) => {
    const { result, warnings } = check(h);
    assert.equal(result.status, "match");
    assert.deepEqual(result.observed, { model: "gpt-5.6-terra", effort: "high", effort_source: "turn" });
    assert.equal(result.rollout_path, h.path);
    assert.equal(result.thread_id, THREAD);
    assert.deepEqual(warnings, []);
  });
});

test("a session on another model is a mismatch, with the /model fix", () => {
  withHome({ lines: [turnContext({ model: "gpt-6.1-sol" })] }, (h) => {
    const { result, warnings } = check(h);
    assert.equal(result.status, "mismatch");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /runs gpt-6\.1-sol/);
    assert.match(warnings[0], /pins the driver to gpt-5\.6-terra at effort high/);
    assert.match(warnings[0], /\/model, choose gpt-5\.6-terra and effort high/);
    assert.match(warnings[0], /codex -s danger-full-access -m gpt-5\.6-terra -c model_reasoning_effort="high"/);
  });
});

test("with no effort set, codex's default from models_cache.json decides", () => {
  const lines = [turnContext({ model: "gpt-5.6-terra" })];
  withHome({ lines, modelsCache: [{ slug: "gpt-5.6-terra", default_reasoning_level: "medium" }] }, (h) => {
    const { result, warnings } = check(h);
    assert.equal(result.status, "mismatch");
    assert.equal(result.observed.effort_source, "codex default");
    assert.match(warnings[0], /effort medium \(codex default\)/);
  });
  withHome({ lines, modelsCache: [{ slug: "gpt-5.6-terra", default_reasoning_level: "high" }] }, (h) => {
    assert.equal(check(h).result.status, "match");
  });
  withHome({ lines }, (h) => {
    const { result, warnings } = check(h);
    assert.equal(result.status, "unverified");
    assert.match(warnings[0], /effort for gpt-5\.6-terra is not recorded/);
  });
});

test("the collaboration mode's effort counts when the turn sets none", () => {
  withHome({ lines: [turnContext({ model: "gpt-5.6-terra", collab: "high" })] }, (h) => {
    const { result } = check(h);
    assert.equal(result.status, "match");
    assert.equal(result.observed.effort_source, "collaboration_mode");
  });
});

test("the last turn_context wins, so a /model change is seen", () => {
  withHome({ lines: [turnContext({ model: "gpt-5.6-terra", effort: "high" }), message("x"), turnContext({ model: "gpt-6.1-sol", effort: "low" })] }, (h) => {
    assert.equal(check(h).result.status, "mismatch");
  });
  withHome({ lines: [turnContext({ model: "gpt-6.1-sol", effort: "low" }), turnContext({ model: "gpt-5.6-terra", effort: "high" })] }, (h) => {
    assert.equal(check(h).result.status, "match");
  });
});

test("what cannot be read is unverified, warned, and never thrown", () => {
  withHome({ lines: [turnContext({ model: "gpt-5.6-terra", effort: "high" })] }, (h) => {
    const noThread = check(h, { threadId: null });
    assert.equal(noThread.result.status, "unverified");
    assert.match(noThread.warnings[0], /CODEX_THREAD_ID is not set/);
    assert.match(noThread.warnings[0], /\/status/);

    const otherThread = check(h, { threadId: "01a0-unknown" });
    assert.equal(otherThread.result.status, "unverified");
    assert.match(otherThread.warnings[0], /no rollout file for thread 01a0-unknown/);

    const noPin = check(h, { pin: null });
    assert.equal(noPin.result.status, "unverified");
  });
  withHome({ lines: [message("hello")] }, (h) => {
    const { result } = check(h);
    assert.equal(result.status, "unverified");
    assert.match(result.reason, /no turn_context yet/);
  });
});

test("a null or empty codexHome means the default CODEX_HOME, never the cwd", () => {
  withHome({ lines: [turnContext({ model: "gpt-5.6-terra", effort: "high" })] }, (h) => {
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = h.codexHome;
    try {
      for (const codexHome of [null, ""]) {
        const { result, warnings } = check(h, { codexHome });
        assert.equal(result.status, "match", String(codexHome));
        assert.equal(result.rollout_path, h.path);
        assert.deepEqual(warnings, []);
      }
      assert.equal(findRolloutFile(THREAD, { codexHome: null, now: NOW }), h.path);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });
});

test("odd arguments and a throwing warn sink still return a status", () => {
  withHome({ lines: [turnContext({ model: "gpt-6.1-sol", effort: "low" })] }, (h) => {
    assert.equal(checkSessionModel(null).status, "unverified");
    const thrower = () => { throw new Error("sink closed"); };
    assert.equal(check(h, { warn: thrower }).result.status, "mismatch");
    assert.equal(check(h, { warn: thrower, threadId: "01a0-unknown" }).result.status, "unverified");
    const { result } = check(h, { now: "not a date" });
    assert.equal(result.status, "mismatch");
    assert.match(result.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("an unreadable rollout file is unverified", { skip: process.getuid?.() === 0 }, () => {
  withHome({ lines: [turnContext({ model: "gpt-5.6-terra", effort: "high" })] }, (h) => {
    chmodSync(h.path, 0o000);
    try {
      const { result } = check(h);
      assert.equal(result.status, "unverified");
      assert.match(result.reason, /cannot read/);
    } finally {
      chmodSync(h.path, 0o644);
    }
  });
});

test("only turn_context records are read: message text never reaches the output", () => {
  withHome({ lines: [message(SENTINEL), turnContext({ model: "gpt-6.1-sol" }), message(SENTINEL)] }, (h) => {
    const { result, warnings } = check(h);
    assert.doesNotMatch(JSON.stringify(result) + warnings.join("\n"), new RegExp(SENTINEL));
    assert.deepEqual(lastTurnContext(h.path), { model: "gpt-6.1-sol", effort: null, effort_source: null, turn_id: "t-gpt-6.1-sol" });
  });
});

test("findRolloutFile looks in today's folder, then anywhere under sessions/", () => {
  withHome({ lines: [turnContext({ model: "m" })] }, (h) => {
    assert.equal(findRolloutFile(THREAD, { codexHome: h.codexHome, now: NOW }), h.path);
  });
  withHome({ lines: [turnContext({ model: "m" })], day: "02" }, (h) => {
    assert.equal(findRolloutFile(THREAD, { codexHome: h.codexHome, now: NOW }), h.path);
    assert.equal(findRolloutFile("nope", { codexHome: h.codexHome, now: NOW }), null);
    assert.equal(findRolloutFile(null, { codexHome: h.codexHome }), null);
  });
});

test("defaultEffort is null when models_cache.json is absent or names no such model", () => {
  withHome({ modelsCache: [{ slug: "gpt-5.6-terra", default_reasoning_level: "medium" }] }, (h) => {
    assert.equal(defaultEffort("gpt-5.6-terra", h.codexHome), "medium");
    assert.equal(defaultEffort("other", h.codexHome), null);
  });
  assert.equal(defaultEffort("gpt-5.6-terra", "/nonexistent"), null);
});

test("sessionThreadId reads CODEX_THREAD_ID, then CODEX_SESSION_ID", () => {
  assert.equal(sessionThreadId({ CODEX_THREAD_ID: "a", CODEX_SESSION_ID: "b" }), "a");
  assert.equal(sessionThreadId({ CODEX_SESSION_ID: "b" }), "b");
  assert.equal(sessionThreadId({}), null);
});

function cli(h, args, env = {}, override = null) {
  const project = mkdtempSync(join(tmpdir(), "session-model-proj-"));
  if (override !== null) writeFileSync(join(project, "routing-policy.yaml"), override);
  try {
    const clean = { ...process.env };
    delete clean.CODEX_THREAD_ID;
    delete clean.CODEX_SESSION_ID;
    return spawnSync(process.execPath, [SCRIPT, `--project-root=${project}`, ...args], {
      encoding: "utf8",
      env: { ...clean, CODEX_HOME: h.codexHome, ...env },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("the CLI checks the project's policy against the session and exits 1 unless it matches", () => {
  withHome({ lines: [turnContext({ model: "gpt-5.6-terra", effort: "high" })] }, (h) => {
    const ok = cli(h, ["--json"], { CODEX_THREAD_ID: THREAD });
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.status, "match");
    assert.equal(out.policy, "gpt-plus-flash");
    assert.equal(out.policy_source, "builtin-default");

    const plain = cli(h, ["--policy=flash-agsdk-only"], { CODEX_THREAD_ID: THREAD });
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /ok\. This session runs gpt-5\.6-terra at effort high, the driver pin of policy 'flash-agsdk-only'/);

    const unverified = cli(h, []);
    assert.equal(unverified.status, 1);
    assert.match(unverified.stderr, /unverified \(CODEX_THREAD_ID is not set/);
    assert.match(unverified.stderr, /codex -s danger-full-access -m gpt-5\.6-terra -c model_reasoning_effort="high"/, "an unreadable session still says how to fix it");

    const claude = cli(h, [], { CODEX_THREAD_ID: THREAD }, readFileSync(join(CLAUDE_POLICIES, "opus-only.yaml"), "utf-8"));
    assert.equal(claude.status, 1);
    assert.match(claude.stderr, /unverified \(the policy could not be resolved: run: policy 'opus-only' .* names an Anthropic adapter/);
  });
});

test("the CLI exits 1 for a session on another model", () => {
  withHome({ lines: [turnContext({ model: "gpt-6.1-sol", effort: "high" })] }, (h) => {
    const r = cli(h, ["--json"], { CODEX_THREAD_ID: THREAD });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).status, "mismatch");
  });
});

test("the CLI refuses an unknown flag with exit code 2", () => {
  withHome({}, (h) => {
    const r = cli(h, ["--nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag --nope/);
  });
});
