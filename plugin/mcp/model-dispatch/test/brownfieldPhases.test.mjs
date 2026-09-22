/**
 * Routing tests for the two brownfield-mode Phase values ("discovery",
 * "change_plan") added in ticket §7.13. Both must route to the premium tier
 * under either shipped policy — the design intent is that judgment-heavy
 * work stays on Opus regardless of which cost-shape the user picked.
 *
 * If a future policy edit accidentally moves either phase to a cheap tier,
 * npm test fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPolicy, getModel } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";

const ctx = (phase, task_type = "misc", module = "cross", retry_count = 0) => ({
  phase,
  task_type,
  module,
  retry_count,
});

test("discovery phase routes to premium under opus-plus-flash (the mixed-cost default)", () => {
  const policy = loadPolicy({ policyName: "opus-plus-flash" });
  const decision = pickModel(ctx("discovery"), policy);
  const leaf = getModel(policy, decision.modelId);
  assert.equal(leaf.adapter, "builtin-anthropic", "discovery must reach Opus");
  assert.match(leaf.model_name, /opus/i, "discovery must run on Opus family");
});

test("change_plan phase routes to premium under opus-plus-flash", () => {
  const policy = loadPolicy({ policyName: "opus-plus-flash" });
  const decision = pickModel(ctx("change_plan"), policy);
  const leaf = getModel(policy, decision.modelId);
  assert.equal(leaf.adapter, "builtin-anthropic", "change_plan must reach Opus");
});

test("discovery phase routes to Opus under opus-only (single-vendor safety net)", () => {
  const policy = loadPolicy({ policyName: "opus-only" });
  const decision = pickModel(ctx("discovery"), policy);
  const leaf = getModel(policy, decision.modelId);
  assert.equal(leaf.adapter, "builtin-anthropic");
});

test("change_plan phase routes to Opus under opus-only", () => {
  const policy = loadPolicy({ policyName: "opus-only" });
  const decision = pickModel(ctx("change_plan"), policy);
  const leaf = getModel(policy, decision.modelId);
  assert.equal(leaf.adapter, "builtin-anthropic");
});

test("both new phases carry a routing trace naming the matched rule (not defaulting)", () => {
  const policy = loadPolicy({ policyName: "opus-plus-flash" });
  for (const phase of ["discovery", "change_plan"]) {
    const decision = pickModel(ctx(phase), policy);
    assert.notEqual(decision.ruleIndex, -1, `${phase} must match an explicit rule, not fall through to default`);
    assert.ok(decision.reason, `${phase} must carry a rule reason for the telemetry trace`);
  }
});

test("both policies declare a hard_cost_cap_usd (ticket §7.13)", () => {
  for (const name of ["opus-plus-flash", "opus-only"]) {
    const policy = loadPolicy({ policyName: name });
    assert.equal(
      typeof policy.hard_cost_cap_usd, "number",
      `${name} must declare hard_cost_cap_usd (v1 default: 50)`,
    );
    assert.ok(policy.hard_cost_cap_usd > 0, `${name} cap must be positive`);
  }
});
