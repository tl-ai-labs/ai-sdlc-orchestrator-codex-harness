import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PLUGIN_POLICY_DIR, loadPolicy, loadPolicyFromPath, resolvePolicy, shippedPresetNames } from "../dist/policy.js";
import { CLAUDE_POLICY_DIR } from "./fixtures/claudePolicies.mjs";

const SHIPPED = join(PLUGIN_POLICY_DIR, "gpt-plus-flash.yaml");

function withOverride(yaml, fn) {
  const root = mkdtempSync(join(tmpdir(), "mmo-driver-pin-"));
  writeFileSync(join(root, "routing-policy.yaml"), yaml);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a driver block is validated when present", () => {
  const bad = [
    ["driver: 7", /'driver' must be an object/],
    ["driver: { reasoning: { effort: high } }", /model_name/],
    ["driver: { model_name: gpt-5.6-terra }", /reasoning\.effort/],
    ["driver: { model_name: gpt-5.6-terra, reasoning: { effort: high }, pricing: { input: 1 } }", /pricing\.input_cached/],
  ];
  for (const [block, re] of bad) {
    const yaml = readFileSync(SHIPPED, "utf-8").replace(/^driver:\n(?:  .*\n)+/m, `${block}\n`);
    withOverride(yaml, (root) => {
      assert.throws(() => resolvePolicy({ projectRoot: root }), re, block);
    });
  }
});

function policiesIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort()
    .map((name) => ({ file: `${name}.yaml`, name, policy: loadPolicyFromPath(join(dir, `${name}.yaml`)) }));
}

test("every shipped policy carries the same driver block", () => {
  const reference = loadPolicy({ policyName: "gpt-plus-flash" }).driver;
  assert.deepEqual(
    { model_name: reference.model_name, effort: reference.reasoning.effort },
    { model_name: "gpt-5.6-terra", effort: "high" },
  );
  const shipped = policiesIn(PLUGIN_POLICY_DIR);
  assert.ok(shipped.length > 1);
  assert.deepEqual(shipped.map((p) => p.name), shippedPresetNames(), "the presets a run is offered are every shipped file");
  for (const { file, name, policy } of shipped) {
    assert.equal(policy.name, name, `${file}: name matches the file name, so --policy=${name} finds it`);
    assert.deepEqual(policy.driver, reference, file);
    const gpt = policy.models.find((m) => m.id === "gpt");
    if (gpt) assert.deepEqual(policy.driver.pricing, gpt.pricing, `${file}: driver rates equal the gpt entry's`);
  }
});

test("the Claude harness policies kept as test fixtures carry no driver block", () => {
  const fixtures = policiesIn(CLAUDE_POLICY_DIR);
  assert.ok(fixtures.length > 0);
  for (const { file, policy } of fixtures) assert.equal(policy.driver, undefined, file);
});
