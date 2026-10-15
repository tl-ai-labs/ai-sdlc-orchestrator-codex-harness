import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_LIST,
  PRICE_LIST_VERIFIED,
  OPENAI_PRICING_URL,
  GEMINI_PRICING_URL,
  ANTHROPIC_PRICING_URL,
  effectivePricing,
  requirePricing,
  resolveModel,
  tierLabel,
  utcDay,
  withEffectivePrices,
  UnpricedModelError,
} from "../dist/prices.js";
import { computeCostUsd } from "../dist/pricing.js";

const card = (input, input_cached, output) => ({ input, input_cached, output });
const INTRO_3X = card(0.75, 0.075, 3.75);
const STANDARD_3X = card(1.5, 0.15, 7.5);
const GPT_STANDARD = card(2, 0.2, 12);
const GPT_LONG = card(4, 0.4, 18);

function entries(model) {
  return PRICE_LIST.filter((e) => e.model === model);
}

// ── the entries ─────────────────────────────────────────────────────────

test("gpt-5.6-terra bills 2.00/0.20/12.00 from 2026-08-09, with the >272K tier at 4.00/0.40/18.00", () => {
  const [e, ...rest] = entries("gpt-5.6-terra");
  assert.equal(rest.length, 0);
  assert.deepEqual(card(e.input, e.input_cached, e.output), GPT_STANDARD);
  assert.equal(e.from, "2026-08-09");
  assert.equal(e.to, null);
  assert.equal(e.source, OPENAI_PRICING_URL);
  assert.equal(e.verified, "2026-10-13");
  assert.equal(e.verified, PRICE_LIST_VERIFIED);
  assert.deepEqual(e.tiers, [{ above_input_tokens: 272_000, ...GPT_LONG }]);
});

for (const [model, ga, dayBefore] of [
  ["gemini-3.7-flash", "2026-08-13", "2026-08-12"],
  ["gemini-3.8-flash", "2026-09-02", "2026-09-01"],
]) {
  test(`${model}: the intro card ends 2026-12-31 and the 2027 card starts 2027-01-01`, () => {
    const periods = entries(model).map((e) => ({ from: e.from, to: e.to, rates: card(e.input, e.input_cached, e.output) }));
    assert.deepEqual(periods, [
      { from: ga, to: "2026-12-31", rates: INTRO_3X },
      { from: "2027-01-01", to: null, rates: STANDARD_3X },
    ]);
    assert.deepEqual(requirePricing(model, "2026-12-31T23:59:59Z").pricing, INTRO_3X);
    assert.deepEqual(requirePricing(model, "2027-01-01T00:00:00Z").pricing, STANDARD_3X);
    assert.deepEqual(requirePricing(model, ga).pricing, INTRO_3X);
    const before = effectivePricing(model, dayBefore);
    assert.equal(before.unpriced, true);
    assert.match(before.reason, new RegExp(`no price for ${model.replace(/\./g, "\\.")} on ${dayBefore}`));
  });
}

test("the 2027 Gemini card applies by UTC day, not by local time", () => {
  // 2026-12-31 19:30 in New York is already 2027-01-01 in UTC.
  assert.deepEqual(requirePricing("gemini-3.7-flash", "2026-12-31T19:30:00-05:00").pricing, STANDARD_3X);
  assert.deepEqual(requirePricing("gemini-3.7-flash", new Date("2027-01-01T00:00:00Z")).pricing, STANDARD_3X);
});

test("gemini-3.5-flash and the Claude rows match the Claude harness's list", () => {
  const rows = {
    "gemini-3.5-flash": { from: "2026-05-19", rates: card(1.5, 0.15, 9), source: GEMINI_PRICING_URL },
    "claude-opus-5": { from: "2026-01-01", rates: card(5, 0.5, 25), source: ANTHROPIC_PRICING_URL },
    "claude-opus-4-7": { from: "2026-01-01", rates: card(5, 0.5, 25), source: ANTHROPIC_PRICING_URL },
    "claude-sonnet-5": { from: "2026-01-01", rates: card(2, 0.2, 10), source: ANTHROPIC_PRICING_URL },
  };
  for (const [model, want] of Object.entries(rows)) {
    const [e, ...rest] = entries(model);
    assert.equal(rest.length, 0, model);
    assert.deepEqual(
      { from: e.from, to: e.to, rates: card(e.input, e.input_cached, e.output), source: e.source, tiers: e.tiers },
      { from: want.from, to: null, rates: want.rates, source: want.source, tiers: undefined },
      model,
    );
  }
});

test("the Anthropic source is the single-docs path, not the doubled docs/en/docs one", () => {
  assert.equal(ANTHROPIC_PRICING_URL, "https://platform.claude.com/docs/en/about-claude/pricing");
  for (const e of PRICE_LIST) assert.doesNotMatch(e.source, /docs\/en\/docs/, e.model);
});

test("every entry is well formed: dated, ordered, non-overlapping, sourced, with finite rates", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const byModel = new Map();
  for (const e of PRICE_LIST) {
    if (!byModel.has(e.model)) byModel.set(e.model, []);
    byModel.get(e.model).push(e);
  }
  for (const [model, list] of byModel) {
    list.forEach((e, i) => {
      assert.match(e.from, ISO, model);
      if (e.to !== null) {
        assert.match(e.to, ISO, model);
        assert.ok(e.from <= e.to, model);
      }
      if (i > 0) assert.ok(list[i - 1].to !== null && list[i - 1].to < e.from, `${model}: entries overlap or are out of order`);
      assert.match(e.source, /^https:\/\//, model);
      assert.match(e.verified, ISO, model);
      assert.ok(e.verified <= PRICE_LIST_VERIFIED, `${model}: verified after the list's own date`);
      for (const k of ["input", "input_cached", "output"]) assert.ok(Number.isFinite(e[k]) && e[k] >= 0, `${model}.${k}`);
      for (const t of e.tiers ?? []) {
        assert.ok(Number.isInteger(t.above_input_tokens) && t.above_input_tokens > 0, `${model} tier`);
        for (const k of ["input", "input_cached", "output"]) assert.ok(t[k] >= e[k], `${model} tier ${k} below standard`);
      }
    });
  }
});

test("the list is frozen and a lookup hands back a copy", () => {
  assert.throws(() => { PRICE_LIST[0].input = 1; }, TypeError);
  assert.throws(() => { PRICE_LIST.push({}); }, TypeError);
  assert.throws(() => { PRICE_LIST[0].tiers[0].input = 1; }, TypeError);
  const a = requirePricing("gpt-5.6-terra", "2026-10-13");
  a.pricing.input = 999;
  assert.equal(requirePricing("gpt-5.6-terra", "2026-10-13").pricing.input, 2);
});

// ── the >272K tier ──────────────────────────────────────────────────────

test("a request of exactly 272,000 input tokens bills standard; 272,001 bills the whole request at the tier", () => {
  const at = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 272_000 });
  assert.equal(at.tier, "standard");
  assert.equal(at.tier_unverified, false);
  assert.deepEqual(at.pricing, GPT_STANDARD);

  const over = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 272_001 });
  assert.equal(over.tier, "long_context");
  assert.equal(over.tier_unverified, false);
  assert.deepEqual(over.pricing, GPT_LONG);
});

test("the tier is decided on the whole prompt, cached tokens included, and bills every token class", () => {
  // OpenAI usage: input_tokens 300,000 (100,000 of them cached), output 10,000.
  const p = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 300_000 });
  const usd = computeCostUsd({ input: 200_000, input_cached: 100_000, output: 10_000 }, p.pricing);
  assert.equal(usd, 1.02);
  // The same tokens at the standard card, the figure the policy block alone gave.
  assert.equal(computeCostUsd({ input: 200_000, input_cached: 100_000, output: 10_000 }, GPT_STANDARD), 0.54);
});

test("aggregate usage proves standard at or below 272,000 and is flagged tier_unverified above it", () => {
  const under = requirePricing("gpt-5.6-terra", "2026-10-13", { aggregateInputTokens: 272_000 });
  assert.equal(under.tier, "standard");
  assert.equal(under.tier_unverified, false);

  const over = requirePricing("gpt-5.6-terra", "2026-10-13", { aggregateInputTokens: 2_900_000 });
  assert.equal(over.tier, "standard", "an aggregate never proves one request crossed the tier");
  assert.equal(over.tier_unverified, true);
  assert.deepEqual(over.pricing, GPT_STANDARD);

  const unknown = requirePricing("gpt-5.6-terra", "2026-10-13");
  assert.equal(unknown.tier_unverified, true, "no size at all proves nothing");
});

test("a per-request count outranks an aggregate", () => {
  const p = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 300_000, aggregateInputTokens: 100 });
  assert.equal(p.tier, "long_context");
});

test("an estimated count picks the card but proves no tier, on either side of 272,000", () => {
  const over = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 315_852, estimated: true });
  assert.deepEqual(over.pricing, GPT_LONG, "the estimate still picks the card");
  assert.equal(over.tier_unverified, true);
  assert.equal(tierLabel(over), "unverified", "never long_context from an estimate");

  const under = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 1_000, estimated: true });
  assert.deepEqual(under.pricing, GPT_STANDARD);
  assert.equal(tierLabel(under), "unverified", "never a proven standard from an estimate");

  const aggregate = requirePricing("gpt-5.6-terra", "2026-10-13", { aggregateInputTokens: 1_000, estimated: true });
  assert.deepEqual(aggregate.pricing, GPT_STANDARD);
  assert.equal(tierLabel(aggregate), "unverified");

  const reported = requirePricing("gpt-5.6-terra", "2026-10-13", { requestInputTokens: 315_852, estimated: false });
  assert.equal(tierLabel(reported), "long_context");
});

test("a model with no tier ignores request size", () => {
  for (const size of [{ requestInputTokens: 5_000_000 }, { aggregateInputTokens: 5_000_000 }, { requestInputTokens: 5_000_000, estimated: true }, {}]) {
    const p = requirePricing("gemini-3.7-flash", "2026-10-13", size);
    assert.equal(p.tier, "standard");
    assert.equal(p.tier_unverified, false);
    assert.deepEqual(p.pricing, INTRO_3X);
  }
});

// ── names, dates, refusal ───────────────────────────────────────────────

test("resolveModel accepts the id and its dated snapshots, and nothing else", () => {
  assert.equal(resolveModel("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(resolveModel("gpt-5.6-terra-2026-08-01"), "gpt-5.6-terra");
  assert.equal(resolveModel("claude-opus-4-7-20260101"), "claude-opus-4-7");
  assert.equal(resolveModel("claude-opus-5"), "claude-opus-5");
  for (const name of ["gpt-5.6-terra-mini", "gpt-5.6", "gpt-5.6-terra-2026-02-30", "gemini-3.7-flash-lite", "GPT-5.6-TERRA", "", null, 42]) {
    assert.equal(resolveModel(name), null, String(name));
  }
});

test("utcDay refuses a timestamp with no zone, whose day would depend on this machine", () => {
  assert.equal(utcDay("2026-10-13"), "2026-10-13");
  assert.equal(utcDay("2026-10-13T23:30:00Z"), "2026-10-13");
  assert.equal(utcDay("2026-10-13T23:30:00-02:00"), "2026-10-14");
  for (const bad of ["2026-10-13T23:30:00", "2026-02-30", "yesterday", "", 20261013, null, new Date("x")]) {
    assert.equal(utcDay(bad), null, String(bad));
  }
  const r = effectivePricing("gpt-5.6-terra", "2026-10-13T12:00:00");
  assert.equal(r.unpriced, true);
  assert.match(r.reason, /invalid date/);
});

test("an unlisted model is unpriced with a reason, and requirePricing throws UNPRICED_MODEL", () => {
  const r = effectivePricing("gpt-unknown-9", "2026-10-13");
  assert.equal(r.unpriced, true);
  assert.match(r.reason, /"gpt-unknown-9" is not on the price list \(plugin\/mcp\/model-dispatch\/src\/prices\.ts\)/);

  assert.throws(
    () => requirePricing("gpt-unknown-9", "2026-10-13"),
    (err) => err instanceof UnpricedModelError && err.code === "UNPRICED_MODEL" && /^unpriced: /.test(err.message),
  );
  const policyModel = { id: "judge", model_name: "gpt-unknown-9", pricing: card(0, 0, 0) };
  assert.match(effectivePricing(policyModel, "2026-10-13").reason, /pricing_override: true/);
});

test("the list-or-override hint follows an unlisted model or a dated gap, never an unreadable date", () => {
  const hint = /add its verified price entry .* or give policy model 'flash' a pricing block with pricing_override: true/;
  const flash = { id: "flash", model_name: "gemini-3.7-flash" };
  assert.match(effectivePricing(flash, "2026-08-12").reason, hint);
  assert.match(effectivePricing({ ...flash, model_name: "gemini-9-flash" }, "2026-10-13").reason, hint);
  for (const bad of ["2026-10-13T10:00:00", 1760000000000]) {
    const r = effectivePricing(flash, bad);
    assert.equal(r.unpriced, true);
    assert.match(r.reason, /^invalid date /);
    assert.doesNotMatch(r.reason, /pricing_override/);
  }
});

// ── the policy block ────────────────────────────────────────────────────

test("a policy model with no block is priced from the list", () => {
  const p = requirePricing({ id: "flash", model_name: "gemini-3.7-flash" }, "2026-10-13");
  assert.equal(p.basis, "list");
  assert.deepEqual(p.pricing, INTRO_3X);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.entry.verified, "2026-10-12");
});

test("a block equal to the list is silent, including on a long-context request", () => {
  const m = { id: "gpt", model_name: "gpt-5.6-terra", pricing: GPT_STANDARD };
  assert.deepEqual(requirePricing(m, "2026-10-13").warnings, []);
  const long = requirePricing(m, "2026-10-13", { requestInputTokens: 400_000 });
  assert.deepEqual(long.warnings, []);
  assert.deepEqual(long.pricing, GPT_LONG);
});

test("a block more than 0.5% off the list is ignored, and the warning names both cards", () => {
  const m = { id: "sonnet", model_name: "claude-sonnet-5", pricing: card(3, 0.3, 15) };
  const p = requirePricing(m, "2026-10-13");
  assert.equal(p.basis, "list");
  assert.deepEqual(p.pricing, card(2, 0.2, 10));
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /'sonnet'.*3\/0\.3\/15.*2\/0\.2\/10/);

  const close = { ...m, pricing: card(2.01, 0.2, 10) };
  assert.deepEqual(requirePricing(close, "2026-10-13").warnings, [], "within 0.5% is not a mismatch");
});

test("on 2027-01-01 a 3.7 Flash leaf still carrying the intro block bills the 2027 card and warns", () => {
  const m = { id: "flash", model_name: "gemini-3.7-flash", pricing: INTRO_3X };
  const p = requirePricing(m, "2027-01-01");
  assert.deepEqual(p.pricing, STANDARD_3X);
  assert.equal(p.warnings.length, 1);
});

test("pricing_override bills the block as a custom price, including for an unlisted model", () => {
  const listed = requirePricing({ id: "flash", model_name: "gemini-3.5-flash", pricing: card(0.3, 0.03, 2.5), pricing_override: true }, "2026-10-13");
  assert.equal(listed.basis, "custom");
  assert.deepEqual(listed.pricing, card(0.3, 0.03, 2.5));
  assert.equal(listed.entry, null);
  assert.deepEqual(listed.warnings, []);

  const gateway = requirePricing({ id: "gw", model_name: "acme-gateway-1", pricing: card(1, 0.1, 4), pricing_override: true }, "2020-01-01");
  assert.equal(gateway.basis, "custom");
  assert.deepEqual(gateway.pricing, card(1, 0.1, 4));
});

test("withEffectivePrices reports, per model, what a dispatch on that day bills", () => {
  const policy = {
    name: "p",
    models: [
      { id: "gpt", model_name: "gpt-5.6-terra", pricing: GPT_STANDARD },
      { id: "flash", model_name: "gemini-3.7-flash", pricing: INTRO_3X },
      { id: "gw", model_name: "acme-gateway-1", pricing: card(1, 0.1, 4), pricing_override: true },
    ],
  };
  const out = withEffectivePrices(policy, new Date("2027-01-02T08:00:00Z"));
  assert.equal(out.effective_prices_on, "2027-01-02");
  const [gpt, flash, gw] = out.models.map((m) => m.effective_price);
  assert.deepEqual(gpt.rates, GPT_STANDARD);
  assert.deepEqual(gpt.tiers, [{ above_input_tokens: 272_000, ...GPT_LONG }]);
  assert.equal(gpt.pricing_block, "equals_list");
  assert.deepEqual(flash.rates, STANDARD_3X);
  assert.equal(flash.pricing_block, "ignored_differs_from_list");
  assert.equal(gw.basis, "custom");
  assert.equal(gw.pricing_block, "billed_pricing_override");
  assert.deepEqual(out.models[0].pricing, GPT_STANDARD, "the policy's own block is passed through unchanged");
});
