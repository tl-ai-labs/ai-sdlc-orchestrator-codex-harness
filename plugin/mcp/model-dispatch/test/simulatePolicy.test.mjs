import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { simulatePolicyCost } from "../dist/routing.js";
import { loadPolicy } from "../dist/policy.js";
import { connectBridge } from "../dist/driverClient.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml");

// Telemetry stores fresh and cached input as disjoint counts, so cached > fresh is normal.
const JUDGMENT_EVENT = {
  phase: "requirements_analysis",
  task_type: "analysis",
  module: "all",
  retry_count: 0,
  input_tokens: 2_000,
  input_tokens_cached: 8_000,
  output_tokens: 1_000,
};

test("simulatePolicyCost prices fresh and cached input as disjoint, like live dispatch", () => {
  const out = simulatePolicyCost([JUDGMENT_EVENT], loadPolicy({ policyName: "gpt-plus-flash" }));
  // 2,000 × $2.00 + 8,000 × $0.20 + 1,000 × $12.00, per 1M.
  assert.equal(out.total_cost_usd, 0.0176);
  assert.deepEqual(out.per_model, { gpt: 0.0176 });
});

test("simulate_policy prices against a repo-local routing-policy.yaml when project_root is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-sim-"));
  const bridge = await connectBridge();
  try {
    writeFileSync(
      join(dir, "routing-policy.yaml"),
      // The four-space indent picks the models[] entry, not the driver block's
      // card. A block bills only under pricing_override; otherwise the dated list does.
      readFileSync(SHIPPED, "utf-8").replaceAll(
        "    pricing: { input: 2.00, input_cached: 0.20, output: 12.00 }",
        "    pricing: { input: 20.00, input_cached: 2.00, output: 120.00 }\n    pricing_override: true",
      ),
    );
    const shipped = await bridge.callTool("simulate_policy", { events: [JUDGMENT_EVENT], policy_name: "gpt-plus-flash" });
    const local = await bridge.callTool("simulate_policy", {
      events: [JUDGMENT_EVENT],
      policy_name: "gpt-plus-flash",
      project_root: dir,
    });
    assert.equal(shipped.total_cost_usd, 0.0176);
    assert.equal(local.total_cost_usd, 0.176);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dated rates, the tier, unpriced events, the regional surcharge ───────

const FLASH_EVENT = {
  phase: "tests",
  task_type: "test_unit",
  module: "all",
  retry_count: 0,
  input_tokens: 1_000_000,
  input_tokens_cached: 0,
  output_tokens: 1_000_000,
};

test("each event prices on its own UTC day: a 3.7 Flash event on 2027-01-02 bills the 2027 card", () => {
  const policy = loadPolicy({ policyName: "gpt-plus-flash" });
  const intro = simulatePolicyCost([{ ...FLASH_EVENT, ts: "2026-12-31T23:59:59Z" }], policy);
  const y2027 = simulatePolicyCost([{ ...FLASH_EVENT, ts: "2027-01-02T08:00:00Z" }], policy);
  assert.equal(intro.total_cost_usd, 4.5);
  assert.equal(y2027.total_cost_usd, 9);
  assert.equal(y2027.price_warnings.length, 1, "the intro block no longer matches the list");
});

test("an event without ts prices on the replay's day", () => {
  const policy = loadPolicy({ policyName: "gpt-plus-flash" });
  const out = simulatePolicyCost([FLASH_EVENT], policy, {}, { now: new Date("2027-03-01T00:00:00Z") });
  assert.equal(out.total_cost_usd, 9);
});

test("an event on a day the list does not cover is listed as unpriced and left out of the total", () => {
  const policy = loadPolicy({ policyName: "gpt-plus-flash" });
  const out = simulatePolicyCost(
    [{ ...FLASH_EVENT, ts: "2026-08-12T10:00:00Z" }, { ...FLASH_EVENT, ts: "2026-08-12T11:00:00Z" }, { ...FLASH_EVENT, ts: "2026-10-13T00:00:00Z" }],
    policy,
  );
  assert.equal(out.total_cost_usd, 4.5);
  assert.equal(out.unpriced.length, 1);
  assert.equal(out.unpriced[0].model_id, "flash-completion");
  assert.equal(out.unpriced[0].events, 2);
  assert.match(out.unpriced[0].reason, /no price for gemini-3\.7-flash on 2026-08-12/);
});

test("an event whose ts has no zone is unpriced for its timestamp, not for a missing list entry", () => {
  const policy = loadPolicy({ policyName: "gpt-plus-flash" });
  const out = simulatePolicyCost([{ ...FLASH_EVENT, ts: "2026-10-13T10:00:00" }, { ...FLASH_EVENT, ts: 1760000000000 }], policy);
  assert.equal(out.total_cost_usd, 0);
  assert.equal(out.unpriced.length, 2);
  for (const u of out.unpriced) {
    assert.match(u.reason, /^invalid date /);
    assert.doesNotMatch(u.reason, /prices\.ts|pricing_override/);
  }
});

test("a judgment event with prompt_tokens over 272,000 bills the long-context card", () => {
  const policy = loadPolicy({ policyName: "gpt-plus-flash" });
  const ev = { ...JUDGMENT_EVENT, ts: "2026-10-13T00:00:00Z", input_tokens: 200_000, input_tokens_cached: 100_000, output_tokens: 10_000 };
  const long = simulatePolicyCost([{ ...ev, prompt_tokens: 300_000 }], policy);
  assert.equal(long.total_cost_usd, 1.02);
  assert.deepEqual(long.tiers, { long_context: 1, unverified: 0 });
  // Without a per-request count, 300,000 summed tokens prove nothing about the tier.
  const aggregate = simulatePolicyCost([ev], policy);
  assert.equal(aggregate.total_cost_usd, 0.54);
  assert.deepEqual(aggregate.tiers, { long_context: 0, unverified: 1 });
});

test("billedRates applies an endpoint's surcharge on top of the dated card", () => {
  const policy = loadPolicy({ policyName: "gpt-plus-flash" });
  const surcharge = (model, rates) =>
    model.model_name.startsWith("gemini-")
      ? { input: rates.input * 1.1, input_cached: rates.input_cached * 1.1, output: rates.output * 1.1 }
      : rates;
  const out = simulatePolicyCost([{ ...FLASH_EVENT, ts: "2026-10-13T00:00:00Z" }, { ...JUDGMENT_EVENT, ts: "2026-10-13T00:00:00Z" }], policy, {}, { billedRates: surcharge });
  assert.equal(out.per_model["flash-completion"], 4.95);
  assert.equal(out.per_model.gpt, 0.0176);
});

test("simulate_policy bills a regional Vertex endpoint x1.10, as dispatch there would", async () => {
  const home = mkdtempSync(join(tmpdir(), "mmo-sim-home-"));
  const env = { HOME: home, GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "unit-test-project", MMO_SELECT: "" };
  const events = [{ ...FLASH_EVENT, ts: "2026-10-13T00:00:00Z" }];
  const regional = await connectBridge({ env: { ...env, GOOGLE_CLOUD_LOCATION: "us-central1" } });
  const global = await connectBridge({ env: { ...env, GOOGLE_CLOUD_LOCATION: "global" } });
  try {
    const r = await regional.callTool("simulate_policy", { events, policy_name: "gpt-plus-flash" });
    const g = await global.callTool("simulate_policy", { events, policy_name: "gpt-plus-flash" });
    assert.equal(r.total_cost_usd, 4.95);
    assert.equal(g.total_cost_usd, 4.5);
  } finally {
    await regional.close();
    await global.close();
    rmSync(home, { recursive: true, force: true });
  }
});
