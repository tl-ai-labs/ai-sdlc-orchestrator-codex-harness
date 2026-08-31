/**
 * Runs against dist/preflight.js — server.ts opens a stdio transport at
 * import and would hang the test runner. Adapter factory is injected so
 * "this model cannot be constructed" is expressed by a throwing stub, not
 * by an unset env var.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  IN_SESSION_ADAPTER,
  assessModels,
  parseAuthMode,
  requiresServerDispatch,
} from "../dist/preflight.js";

/** The two models of the shipped opus-plus-flash policy, in policy-file order. */
const MODELS = [
  { id: "opus", model_name: "claude-opus-4-7", adapter: "builtin-anthropic" },
  { id: "gemini-flash", model_name: "gemini-3.5-flash", adapter: "mcp:model-dispatch" },
];

/** An adapter factory where the named model ids throw and every other id succeeds. */
function factoryFailing(...failingIds) {
  return (modelId) => {
    if (failingIds.includes(modelId)) {
      throw new Error(`ANTHROPIC_API_KEY not set for BuiltinAnthropicAdapter (model ${modelId})`);
    }
    return { id: modelId };
  };
}

test("parseAuthMode accepts exactly the two documented modes", () => {
  assert.equal(parseAuthMode("vendor"), "vendor");
  assert.equal(parseAuthMode("estimated"), "estimated");
});

test("parseAuthMode throws on anything else, using the message operating rule 6 specifies", () => {
  for (const bad of [undefined, null, "", "VENDOR", "estimate", "subscription", 1, {}]) {
    assert.throws(
      () => parseAuthMode(bad),
      /this run requires auth_mode=vendor\|estimated/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("vendor mode dispatches every model through this server", () => {
  assert.equal(requiresServerDispatch(IN_SESSION_ADAPTER, "vendor"), true);
  assert.equal(requiresServerDispatch("mcp:model-dispatch", "vendor"), true);
});

test("estimated mode dispatches everything except the in-session adapter", () => {
  assert.equal(requiresServerDispatch(IN_SESSION_ADAPTER, "estimated"), false);
  assert.equal(requiresServerDispatch("mcp:model-dispatch", "estimated"), true);
  // An unknown adapter is dispatched, and so must work. Defaulting the other way
  // would let a typo'd adapter name skip the check entirely.
  assert.equal(requiresServerDispatch("mcp:some-future-server", "estimated"), true);
});

test("a healthy setup passes in both modes with no warnings", () => {
  for (const mode of ["vendor", "estimated"]) {
    const out = assessModels(MODELS, mode, factoryFailing());
    assert.equal(out.ok, true, mode);
    assert.equal(out.halt_reason, null, mode);
    assert.deepEqual(out.warnings, [], mode);
    assert.ok(out.models.every((m) => m.ok), mode);
  }
});

/**
 * The regression. This is the exact shape of the 2026-08-04 false positive: an
 * estimated-mode run with no ANTHROPIC_API_KEY, halted on an adapter it was never
 * going to construct.
 */
test("a missing Anthropic key does not halt an estimated run", () => {
  const out = assessModels(MODELS, "estimated", factoryFailing("opus"));

  assert.equal(out.ok, true, "the run must be allowed to start");
  assert.equal(out.halt_reason, null);

  const opus = out.models.find((m) => m.id === "opus");
  assert.equal(opus.ok, false, "the failure is still recorded truthfully");
  assert.equal(opus.required, false);
  assert.equal(opus.severity, "warning");

  assert.equal(out.warnings.length, 1, "and it is still surfaced to the operator");
  assert.match(out.warnings[0], /does not dispatch to it/);
  assert.match(out.warnings[0], /would block a vendor-mode run/);
});

test("the same missing key does halt a vendor run", () => {
  const out = assessModels(MODELS, "vendor", factoryFailing("opus"));

  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /Cannot dispatch to 1 of 2 models/);
  assert.match(out.halt_reason, /opus \(ANTHROPIC_API_KEY not set/);
  assert.deepEqual(out.warnings, [], "a blocking failure is not also a warning");

  const opus = out.models.find((m) => m.id === "opus");
  assert.equal(opus.required, true);
  assert.equal(opus.severity, "blocking");
});

test("an unreachable mechanical tier halts an estimated run", () => {
  // The failure this gate was built for: without Gemini every mechanical packet
  // falls back to the premium tier and the run costs more than the baseline.
  const out = assessModels(MODELS, "estimated", factoryFailing("gemini-flash"));

  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /gemini-flash/);
  assert.match(out.halt_reason, /costs more than a single-model baseline/);
  assert.deepEqual(out.warnings, []);
});

test("an all-in-session policy needs nothing from this server under estimated", () => {
  // opus-only in estimated mode: every phase runs in the Claude Code session, so
  // there is nothing for pre-flight to block on even with every adapter broken.
  const opusOnly = [MODELS[0]];
  const out = assessModels(opusOnly, "estimated", factoryFailing("opus"));

  assert.equal(out.ok, true);
  assert.equal(out.halt_reason, null);
  assert.equal(out.warnings.length, 1);
});

test("both models failing in vendor mode are named in one halt_reason", () => {
  const out = assessModels(MODELS, "vendor", factoryFailing("opus", "gemini-flash"));

  assert.equal(out.ok, false);
  assert.match(out.halt_reason, /Cannot dispatch to 2 of 2 models/);
  assert.match(out.halt_reason, /opus \(/);
  assert.match(out.halt_reason, /gemini-flash \(/);
});

test("results preserve policy order and carry the fields the orchestrator prints", () => {
  const out = assessModels(MODELS, "estimated", factoryFailing());
  assert.deepEqual(
    out.models.map((m) => m.id),
    ["opus", "gemini-flash"],
  );
  for (const m of out.models) {
    assert.equal(typeof m.model_name, "string");
    assert.equal(typeof m.adapter, "string");
    assert.equal(typeof m.required, "boolean");
    assert.equal(m.error, undefined, "a passing model carries no error");
    assert.equal(m.severity, undefined, "and no severity");
  }
});

test("every model is constructed, so the cache is warm and non-required failures are seen", () => {
  const built = [];
  assessModels(MODELS, "estimated", (id) => {
    built.push(id);
    return {};
  });
  assert.deepEqual(built, ["opus", "gemini-flash"]);
});

test("the claude-cli adapter dispatches through the server in both auth modes", () => {
  // It IS Anthropic, but it goes through a subprocess — the in-session
  // shortcut does not apply. Both modes must construct and probe it.
  assert.equal(requiresServerDispatch("claude-cli", "vendor"), true);
  assert.equal(requiresServerDispatch("claude-cli", "estimated"), true);
});

test("a missing claude binary halts an estimated run that names the claude-cli adapter", () => {
  const MIXED = [
    { id: "opus", model_name: "claude-opus-5", adapter: "builtin-anthropic" },
    { id: "sonnet-cli", model_name: "claude-sonnet-5", adapter: "claude-cli" },
  ];
  const factory = (modelId) => {
    if (modelId === "sonnet-cli") {
      throw new Error("ClaudeCliAdapter needs the `claude` binary on PATH");
    }
    return { id: modelId };
  };
  const out = assessModels(MIXED, "estimated", factory);
  assert.equal(out.ok, false, "an unreachable claude-cli leaf must halt even under estimated");
  assert.match(out.halt_reason, /sonnet-cli/);
  const sonnet = out.models.find((m) => m.id === "sonnet-cli");
  assert.equal(sonnet.required, true);
  assert.equal(sonnet.severity, "blocking");
});
