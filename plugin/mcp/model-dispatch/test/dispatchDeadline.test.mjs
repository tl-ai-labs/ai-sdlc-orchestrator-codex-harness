/**
 * Every dispatch is bounded by its leaf's worker_timeout_sec, below the
 * driver client's per-call timeout, so a slow vendor ends as a recorded
 * failure rather than a client timeout. Offline: injected clients and
 * transports only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import { OpenAIAdapter } from "../dist/adapters/OpenAIAdapter.js";
import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";
import { DEFAULT_DISPATCH_TIMEOUT_SEC, startDeadline } from "../dist/adapters/deadline.js";
import { DEFAULT_WORKER_TIMEOUT_SEC, WORKER_KILL_GRACE_SEC } from "../dist/delegation/workerProcess.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../dist/driverClient.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const PACKET = {
  id: "p1",
  phase: "requirements_analysis",
  task_type: "r",
  module: "m",
  instruction: "Return {ok:true}.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 512 },
  pass_id: "t",
};

/** Resolves only when the request's signal aborts, the way the SDKs reject. */
const hangUntilAborted = (signal) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })), { once: true });
  });

test("an OpenAI dispatch past its deadline fails, recorded as an estimate that names the deadline", async () => {
  const client = { responses: { create: (_req, opts) => hangUntilAborted(opts.signal) } };
  const leaf = { id: "gpt", adapter: "openai", model_name: "gpt-5.6-terra", worker_timeout_sec: 0.2 };
  const out = await new OpenAIAdapter(leaf, { client }).execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /dispatch deadline of 0\.2s reached/);
  assert.ok(out.cost_usd > 0, "the request may have been served, so the prompt stays booked");
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false, "the prompt alone is a floor for a request that may have been served");
});

test("a Gemini dispatch past its deadline fails the same way", async () => {
  const transport = {
    backend: "api-key",
    location: "",
    createCache: async () => undefined,
    generate: (args) => hangUntilAborted(args.abortSignal),
  };
  const leaf = { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash", worker_timeout_sec: 0.2 };
  const out = await new GeminiFlashAdapter(leaf, { transport }).execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /dispatch deadline of 0\.2s reached/);
  assert.equal(out.attempts[0].cost_provenance, "estimated");
  assert.equal(out.attempts[0].usage_complete, false);
});

test("one deadline covers the whole doubling chain, and the caller's abort ends it early", async () => {
  const outer = new AbortController();
  const d = startDeadline(60_000, outer.signal);
  assert.equal(d.signal.aborted, false);
  outer.abort();
  assert.equal(d.signal.aborted, true);
  assert.equal(d.expired, false, "an abort from the caller is not the deadline");
  d.clear();
});

test("every shipped policy leaf's deadline stays below the driver client's call timeout", () => {
  const dir = new URL("../../../config/policies/", import.meta.url);
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const policy = loadPolicyFromPath(new URL(file, dir).pathname);
    for (const m of policy.models) {
      const sec =
        m.adapter === "antigravity-worker"
          ? (m.worker_timeout_sec ?? DEFAULT_WORKER_TIMEOUT_SEC) + WORKER_KILL_GRACE_SEC
          : (m.worker_timeout_sec ?? DEFAULT_DISPATCH_TIMEOUT_SEC);
      assert.ok(sec * 1000 < DEFAULT_TOOL_TIMEOUT_MS, `${file} ${m.id}: ${sec}s is not below ${DEFAULT_TOOL_TIMEOUT_MS / 1000}s`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});

test("the unset-leaf deadline sits just below the client's wait, so it cuts no chain the client would have waited for", () => {
  const ms = DEFAULT_DISPATCH_TIMEOUT_SEC * 1000;
  assert.ok(ms < DEFAULT_TOOL_TIMEOUT_MS, "the client must not give up first");
  assert.ok(ms >= DEFAULT_TOOL_TIMEOUT_MS - 60_000, `${DEFAULT_DISPATCH_TIMEOUT_SEC}s fails a dispatch the client still had time for`);
});

test("a codex-cli leaf with no worker_timeout_sec gets the same default", async () => {
  const { CodexCliAdapter } = await import("../dist/adapters/CodexCliAdapter.js");
  const adapter = new CodexCliAdapter({ id: "gpt", adapter: "codex-cli", model_name: "gpt-5.6-terra" });
  assert.equal(adapter.timeoutMs, DEFAULT_DISPATCH_TIMEOUT_SEC * 1000);
});
