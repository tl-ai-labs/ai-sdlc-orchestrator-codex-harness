/**
 * `intent` as a routing dimension (policy console's per-intent overrides).
 * Pins: an intent-scoped rule only matches a packet carrying that intent,
 * never matches a greenfield packet (no intent at all), and — since
 * pickModel() returns on the first matching rule — rule ORDER is what makes
 * an intent-specific override actually win over the phase's blanket rule.
 *
 * Offline; pure routing only, no policy file needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickModel } from "../dist/routing.js";

const ctx = (phase, intent, task_type = "misc", module = "cross", retry_count = 0) => ({
  phase,
  task_type,
  module,
  retry_count,
  intent,
});

const policy = (rules) => ({ version: 1, name: "test", models: [], rules });

test("an intent-scoped rule wins over the phase's blanket rule when it comes first", () => {
  const p = policy([
    { when: { phase: "tests", intent: "test" }, use: "opus" },
    { when: { phase: "tests" }, use: "flash-completion" },
    { default: "opus" },
  ]);
  const decision = pickModel(ctx("tests", "test"), p);
  assert.equal(decision.modelId, "opus");
  assert.equal(decision.ruleIndex, 0);
});

test("a packet with a different intent falls through to the blanket rule", () => {
  const p = policy([
    { when: { phase: "tests", intent: "test" }, use: "opus" },
    { when: { phase: "tests" }, use: "flash-completion" },
    { default: "opus" },
  ]);
  const decision = pickModel(ctx("tests", "refactor"), p);
  assert.equal(decision.modelId, "flash-completion");
  assert.equal(decision.ruleIndex, 1);
});

test("a greenfield packet (no intent at all) never matches an intent-scoped rule", () => {
  const p = policy([
    { when: { phase: "tests", intent: "test" }, use: "opus" },
    { when: { phase: "tests" }, use: "flash-completion" },
    { default: "opus" },
  ]);
  const decision = pickModel(ctx("tests", undefined), p);
  assert.equal(decision.modelId, "flash-completion");
  assert.equal(decision.ruleIndex, 1);
});

test("intent may be an array — matches any named intent", () => {
  const p = policy([
    { when: { phase: "codegen", intent: ["bugfix", "refactor"] }, use: "opus" },
    { when: { phase: "codegen" }, use: "flash-completion" },
    { default: "opus" },
  ]);
  assert.equal(pickModel(ctx("codegen", "bugfix"), p).modelId, "opus");
  assert.equal(pickModel(ctx("codegen", "refactor"), p).modelId, "opus");
  assert.equal(pickModel(ctx("codegen", "docs"), p).modelId, "flash-completion");
});

test("a blanket rule placed before an intent-scoped one for the same phase shadows it", () => {
  // Ordering is the whole mechanism — pickModel has no notion of
  // "more specific wins" on its own. This pins that the policy console
  // MUST emit intent-scoped rules before the blanket rule (buildCustomPolicy
  // in policy-server.mjs), or an override silently never fires.
  const p = policy([
    { when: { phase: "tests" }, use: "flash-completion" },
    { when: { phase: "tests", intent: "test" }, use: "opus" },
    { default: "opus" },
  ]);
  const decision = pickModel(ctx("tests", "test"), p);
  assert.equal(decision.modelId, "flash-completion", "the blanket rule shadowed the override because it came first");
});

test("route.decide's auto-generated reason names the intent when a rule has no explicit reason", () => {
  const p = policy([
    { when: { phase: "tests", intent: "test" }, use: "opus" },
    { default: "opus" },
  ]);
  const decision = pickModel(ctx("tests", "test"), p);
  assert.match(decision.reason, /intent="test"/);
});
