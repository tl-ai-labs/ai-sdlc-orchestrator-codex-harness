import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { loadPolicy, loadPolicyFromPath } from "../dist/policy.js";
import { effectivePricing, lookupEntry } from "../dist/prices.js";
import { assessPricing } from "../dist/preflight.js";
import { connectBridge } from "../dist/driverClient.js";
import { CLAUDE_POLICY_DIR } from "./fixtures/claudePolicies.mjs";

const POLICIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const FILES = readdirSync(POLICIES_DIR).filter((f) => f.endsWith(".yaml"));
const SHIPPED = FILES.map((f) => f.replace(/\.yaml$/, ""));
// Compared with today, as the Claude harness does: on 2027-01-01 the Gemini
// 3.7/3.8 blocks stop matching and this fails until they are re-pinned.
const TODAY = new Date().toISOString().slice(0, 10);

function leavesIn(dir, files) {
  return files.flatMap((file) => {
    const parsed = parseYaml(readFileSync(join(dir, file), "utf-8"));
    const leaves = (parsed.models ?? []).map((m) => ({ where: `${file} models[${m.id}] (${m.model_name})`, m }));
    // The driver block carries a card too, and it must not drift from the list either.
    if (parsed.driver) leaves.push({ where: `${file} driver (${parsed.driver.model_name})`, m: parsed.driver });
    return leaves;
  });
}

const shippedLeaves = () => leavesIn(POLICIES_DIR, FILES);

// ── shipped policy blocks equal the list ────────────────────────────────

test("every shipped policy model is priced by the list today", () => {
  const leaves = shippedLeaves();
  assert.ok(leaves.length >= 14, `expected every shipped leaf, found ${leaves.length}`);
  const problems = [];
  for (const { where, m } of leaves) {
    const r = effectivePricing(m, TODAY);
    if (r.unpriced) problems.push(`${where}: ${r.reason}`);
    else if (r.basis !== "list") problems.push(`${where}: billed as ${r.basis}; a shipped policy bills the list`);
  }
  assert.deepEqual(problems, []);
});

test("every shipped pricing block equals the list's standard card today", () => {
  const problems = [];
  for (const { where, m } of shippedLeaves()) {
    if (!m.pricing) {
      problems.push(`${where}: no pricing block (the policy console and the skills read it)`);
      continue;
    }
    const found = lookupEntry(m.model_name, TODAY);
    if ("reason" in found) continue; // reported above
    for (const k of Object.keys(m.pricing)) {
      if (!["input", "input_cached", "output"].includes(k)) problems.push(`${where}: unknown pricing field ${k}`);
    }
    for (const k of ["input", "input_cached", "output"]) {
      if (m.pricing[k] !== found.entry[k]) {
        problems.push(`${where}: ${k} is ${m.pricing[k]}, the list says ${found.entry[k]} (${found.entry.source}, verified ${found.entry.verified})`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every shipped block cites its list entry's source and carries that entry's verified date", () => {
  const problems = [];
  let checked = 0;
  for (const { where, m } of shippedLeaves()) {
    const found = lookupEntry(m.model_name, TODAY);
    if ("reason" in found) continue;
    checked++;
    const source = String(m.pricing_source ?? "");
    if (source !== found.entry.source && !source.startsWith(`${found.entry.source} `)) {
      problems.push(`${where}: pricing_source ${JSON.stringify(source)} does not start with the list's ${found.entry.source}`);
    }
    if (String(m.pricing_last_verified) !== found.entry.verified) {
      problems.push(`${where}: pricing_last_verified is ${m.pricing_last_verified}, the list entry was verified ${found.entry.verified}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 14, `checked ${checked}`);
});

test("no shipped policy cites the doubled docs/en/docs Anthropic path", () => {
  for (const file of FILES) {
    assert.doesNotMatch(readFileSync(join(POLICIES_DIR, file), "utf-8"), /docs\/en\/docs/, file);
  }
});

test("both Sonnet 5 leaves in the Claude harness fixtures carry Anthropic's 2.00/0.20/10.00 card", () => {
  const fixtures = readdirSync(CLAUDE_POLICY_DIR).filter((f) => f.endsWith(".yaml"));
  const sonnet = leavesIn(CLAUDE_POLICY_DIR, fixtures).filter(({ m }) => m.model_name === "claude-sonnet-5");
  assert.equal(sonnet.length, 2);
  for (const { where, m } of sonnet) assert.deepEqual(m.pricing, { input: 2, input_cached: 0.2, output: 10 }, where);
});

test("gpt-plus-flash-38 differs from gpt-plus-flash only in the Gemini model", () => {
  const base = loadPolicy({ policyName: "gpt-plus-flash" });
  const v38 = loadPolicy({ policyName: "gpt-plus-flash-38" });
  assert.deepEqual(v38.rules, base.rules);
  assert.deepEqual(v38.select, base.select && {
    ...base.select,
    "gemini-flash": {
      ...base.select["gemini-flash"],
      reason: base.select["gemini-flash"].reason.replace("Gemini 3.7", "Gemini 3.8"),
    },
  });
  assert.equal(v38.hard_cost_cap_usd, base.hard_cost_cap_usd);
  assert.deepEqual(
    v38.models.map((m) => ({ ...m, model_name: m.model_name.replace("3.8", "3.7"), display_name: undefined })),
    base.models.map((m) => ({ ...m, display_name: undefined })),
  );
});

test("every shipped policy still loads", () => {
  for (const name of SHIPPED) assert.ok(loadPolicy({ policyName: name }).models.length > 0, name);
});

// ── the loader ──────────────────────────────────────────────────────────

function withPolicy(models, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-pricing-"));
  const path = join(dir, "routing-policy.yaml");
  writeFileSync(
    path,
    JSON.stringify({ version: 1, name: "t", models, rules: [{ when: {}, use: models[0].id }] }),
  );
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const leaf = (extra) => ({ id: "m", adapter: "openai", model_name: "gpt-5.6-terra", ...extra });

test("a listed model with no pricing block loads", () => {
  withPolicy([leaf({})], (path) => assert.equal(loadPolicyFromPath(path).models[0].pricing, undefined));
});

test("a model the list does not name is refused at load unless it carries pricing_override", () => {
  withPolicy([leaf({ model_name: "gpt-unknown-9", pricing: { input: 0, input_cached: 0, output: 0 } })], (path) => {
    assert.throws(
      () => loadPolicyFromPath(path),
      /Policy model 'm': 'gpt-unknown-9' is not on the price list \(plugin\/mcp\/model-dispatch\/src\/prices\.ts\).*pricing_override: true/,
    );
  });
  withPolicy(
    [leaf({ model_name: "gpt-unknown-9", pricing: { input: 1, input_cached: 0.1, output: 4 }, pricing_override: true })],
    (path) => assert.equal(loadPolicyFromPath(path).models[0].pricing_override, true),
  );
});

test("pricing_override must be a boolean and needs a block to bill", () => {
  withPolicy([leaf({ pricing_override: "yes" })], (path) => {
    assert.throws(() => loadPolicyFromPath(path), /pricing_override must be true or false/);
  });
  withPolicy([leaf({ pricing_override: true })], (path) => {
    assert.throws(() => loadPolicyFromPath(path), /pricing_override: true needs a pricing block/);
  });
});

test("a pricing block, when present, needs three non-negative numbers", () => {
  withPolicy([leaf({ pricing: { input: 2, input_cached: 0.2 } })], (path) => {
    assert.throws(() => loadPolicyFromPath(path), /pricing\.output must be a number >= 0/);
  });
  withPolicy([leaf({ pricing: { input: -1, input_cached: 0.2, output: 12 } })], (path) => {
    assert.throws(() => loadPolicyFromPath(path), /pricing\.input must be a number >= 0/);
  });
  withPolicy([leaf({ pricing: "2/0.2/12" })], (path) => {
    assert.throws(() => loadPolicyFromPath(path), /pricing must be/);
  });
});

// ── pre-flight ──────────────────────────────────────────────────────────

test("pre-flight halts on a model with no price that day and passes a priced one", () => {
  const flash = { id: "flash", model_name: "gemini-3.7-flash" };
  const gpt = { id: "gpt", model_name: "gpt-5.6-terra", pricing: { input: 2, input_cached: 0.2, output: 12 } };

  const ok = assessPricing([gpt, flash], new Date("2026-10-13T09:00:00Z"));
  assert.equal(ok.ok, true);
  assert.equal(ok.halt_reason, null);
  assert.equal(ok.priced_on, "2026-10-13");

  const beforeGa = assessPricing([gpt, flash], new Date("2026-08-12T09:00:00Z"));
  assert.equal(beforeGa.ok, false);
  assert.deepEqual(beforeGa.unpriced.map((u) => u.id), ["flash"]);
  assert.match(beforeGa.halt_reason, /Cannot price 1 of 2 models.*flash \(gemini-3\.7-flash: no price for gemini-3\.7-flash on 2026-08-12/);
});

test("pre-flight reports a block that differs from the list as a price warning, not a halt", () => {
  const sonnet = { id: "sonnet", model_name: "claude-sonnet-5", pricing: { input: 3, input_cached: 0.3, output: 15 } };
  const r = assessPricing([sonnet], new Date("2026-10-13T09:00:00Z"));
  assert.equal(r.ok, true);
  assert.equal(r.price_warnings.length, 1);
  assert.match(r.price_warnings[0], /'sonnet'/);
});

test("the bridge's load_policy and preflight_dispatch carry each model's dated price", async () => {
  const bridge = await connectBridge({
    env: { OPENAI_API_KEY: "sk-test-dummy-not-a-real-key", GEMINI_API_KEY: "AIza-test-dummy-not-a-real-key", MMO_SELECT: "" },
  });
  try {
    const loaded = await bridge.callTool("load_policy", { policy_name: "gpt-plus-flash" });
    assert.equal(loaded.effective_prices_on, TODAY);
    const gpt = loaded.models.find((m) => m.id === "gpt");
    assert.equal(gpt.effective_price.basis, "list");
    assert.deepEqual(gpt.effective_price.tiers.map((t) => t.above_input_tokens), [272_000]);
    assert.equal(gpt.effective_price.pricing_block, "equals_list");

    const pre = await bridge.callTool("preflight_dispatch", { auth_mode: "vendor", policy_name: "gpt-plus-flash" });
    assert.equal(pre.priced_on, TODAY);
    assert.deepEqual(pre.unpriced, []);
    assert.deepEqual(pre.price_warnings, []);
  } finally {
    await bridge.close();
  }
});
