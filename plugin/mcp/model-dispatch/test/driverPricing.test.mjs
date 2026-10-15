import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  driverPriceRecord,
  driverPricedModel,
  fixedDriverPriceFn,
  listDriverPriceFn,
  priceDriverTokens,
  PRICE_LIST_VERIFIED,
} from "../dist/driverPricing.js";
import { driverTurns, parseDriverRecords, summarizeDriverTurns } from "../dist/driverUsage.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const POLICIES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const POLICY = loadPolicyFromPath(join(POLICIES, "gpt-plus-flash.yaml"));
const PIN = "gpt-5.6-terra";
const DAY = "2026-10-13T10:00:00.000Z";
const tok = (input, cached = 0, output = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
});
const r6 = (n) => Math.round(n * 1e6) / 1e6;

test("the conductor is the driver block, else the legacy gpt entry", () => {
  assert.deepEqual(driverPricedModel(POLICY), { id: "driver", model_name: PIN, pricing: POLICY.driver.pricing, pricing_override: undefined });
  const { driver: _d, ...legacy } = POLICY;
  assert.equal(driverPricedModel(legacy).id, "gpt");
  assert.equal(driverPricedModel({ ...legacy, models: [] }), null);
});

test("a sum under every threshold proves the standard card; above one it is billed standard and labelled unverified", () => {
  const priceFn = listDriverPriceFn(POLICY);
  const under = priceDriverTokens(tok(200_000, 50_000, 1000), PIN, DAY, priceFn);
  assert.deepEqual([under.tier, under.basis, under.verified], ["standard", "list", PRICE_LIST_VERIFIED]);
  assert.equal(r6(under.cost_usd), r6((150_000 * 2 + 50_000 * 0.2 + 1000 * 12) / 1e6));
  const over = priceDriverTokens(tok(400_000, 0, 1000), PIN, DAY, priceFn);
  assert.equal(over.tier, "unverified");
  assert.equal(r6(over.cost_usd), r6((400_000 * 2 + 1000 * 12) / 1e6));
});

test("with per-response sizes, only the response over the threshold bills the long-context card", () => {
  const priceFn = listDriverPriceFn(POLICY);
  const responses = [tok(300_000, 100_000, 500), tok(100_000, 0, 200)];
  const sum = tok(400_000, 100_000, 700);
  const p = priceDriverTokens(sum, PIN, DAY, priceFn, responses);
  assert.deepEqual([p.tier, p.long_context_requests], ["long_context", 1]);
  const long = (200_000 * 4 + 100_000 * 0.4 + 500 * 18) / 1e6;
  const rest = (100_000 * 2 + 200 * 12) / 1e6;
  assert.equal(r6(p.cost_usd), r6(long + rest));
  const allShort = priceDriverTokens(tok(200_000), PIN, DAY, priceFn, [tok(100_000), tok(100_000)]);
  assert.deepEqual([allShort.tier, allShort.long_context_requests], ["standard", 0]);
});

test("a day the list does not cover leaves the tokens unpriced with the reason, never priced from a neighbour", () => {
  const p = priceDriverTokens(tok(1000), PIN, "2026-08-01T00:00:00.000Z", listDriverPriceFn(POLICY));
  assert.equal(p.cost_usd, null);
  assert.equal(p.unpriced_reason, "no price for gpt-5.6-terra on 2026-08-01");
});

test("a driver block under pricing_override bills its own card, labelled custom; a fixed card is custom too", () => {
  const custom = { ...POLICY, driver: { ...POLICY.driver, pricing: { input: 10, input_cached: 1, output: 50 }, pricing_override: true } };
  const p = priceDriverTokens(tok(1_000_000), PIN, DAY, listDriverPriceFn(custom));
  assert.deepEqual([p.basis, p.cost_usd], ["custom", 10]);
  const fixed = fixedDriverPriceFn({ input: 1, input_cached: 0.1, output: 5 })(PIN, null, {});
  assert.deepEqual(fixed, { input: 1, input_cached: 0.1, output: 5, basis: "custom", tier: "standard", verified: null });
});

test("driver turns are summed at each turn's own day, and unpriced and tier-unverified turns are counted apart", () => {
  const lines = [
    { v: 1, kind: "invocation_start", invocation: 1, at: "2026-10-13T00:00:00.000Z", mode: "fresh" },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:01.000Z", event: { type: "turn.started" } },
    { v: 1, kind: "codex", invocation: 1, thread_id: "t1", received_at: "2026-10-13T00:00:02.000Z", event: { type: "turn.completed", usage: tok(400_000) } },
    { v: 1, kind: "invocation_end", invocation: 1, at: "2026-10-13T00:00:03.000Z", ended_by: "exit", exit_status: 0 },
  ];
  const turns = driverTurns(parseDriverRecords(lines.map((l) => JSON.stringify(l)).join("\n")));
  const summary = summarizeDriverTurns(turns, { model: PIN, priceFn: listDriverPriceFn(POLICY) });
  assert.deepEqual([summary.turns_complete, summary.turns_tier_unverified, summary.turns_unpriced, summary.cost_usd], [1, 1, 0, 0.8]);
  const early = summarizeDriverTurns(turns, { model: PIN, priceFn: listDriverPriceFn(POLICY), requestsFor: () => [tok(300_000), tok(100_000)] });
  assert.deepEqual([early.turns_long_context, early.turns_tier_unverified, early.cost_usd], [1, 0, r6((300_000 * 4 + 100_000 * 2) / 1e6)]);
});

test("driver-manifest's price record names the card, its tiers, and the list entry", () => {
  const rec = driverPriceRecord(POLICY, PIN, DAY);
  assert.deepEqual(rec.rates, { input: 2, input_cached: 0.2, output: 12 });
  assert.deepEqual(rec.tiers, [{ above_input_tokens: 272_000, input: 4, input_cached: 0.4, output: 18 }]);
  assert.deepEqual([rec.basis, rec.priced_on, rec.verified, rec.entry_from, rec.entry_to, rec.unpriced_reason], ["list", "2026-10-13", PRICE_LIST_VERIFIED, "2026-08-09", null, null]);
  assert.match(driverPriceRecord(POLICY, "gpt-9", DAY).unpriced_reason, /"gpt-9" is not on the price list/);
});

test("the policy loader refuses a driver model the list does not price, unless the block bills its own card", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-driver-policy-"));
  const load = (text) => {
    const path = join(dir, "p.yaml");
    writeFileSync(path, text);
    return loadPolicyFromPath(path);
  };
  const yaml = (driver) => `version: 1
name: p
driver:
${driver}
models:
  - id: flash
    adapter: mcp:model-dispatch
    model_name: gemini-3.7-flash
rules:
  - default: flash
`;
  try {
    assert.throws(() => load(yaml("  model_name: gpt-9\n  reasoning: { effort: high }")), /Policy driver: 'gpt-9' is not on the price list/);
    assert.throws(
      () => load(yaml("  model_name: gpt-9\n  reasoning: { effort: high }\n  pricing_override: true")),
      /pricing_override: true needs a pricing block/,
    );
    const ok = load(yaml("  model_name: gpt-9\n  reasoning: { effort: high }\n  pricing: { input: 1, input_cached: 0.1, output: 4 }\n  pricing_override: true"));
    assert.equal(ok.driver.pricing_override, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
