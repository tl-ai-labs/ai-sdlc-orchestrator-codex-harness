/**
 * The agent-worker probe's `rates` lines: what a delegation today bills,
 * compared with the unsurcharged price card, never with the leaf's block.
 * Offline: the adapter is constructed but never executed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { WORKER_PYTHON_ENV } from "../dist/delegation/workerProcess.js";
import { GEMINI_PRICING_URL } from "../dist/prices.js";
import { pricingNote, priceLines } from "../../../scripts/probe-agent-worker.mjs";

const INTRO = { input: 0.75, input_cached: 0.075, output: 3.75 };

function adapterFor(leaf, iso) {
  const saved = { p: process.env.GOOGLE_CLOUD_PROJECT, py: process.env[WORKER_PYTHON_ENV] };
  process.env.GOOGLE_CLOUD_PROJECT = "unit-test-project";
  process.env[WORKER_PYTHON_ENV] = process.execPath;
  try {
    return new AntigravityWorkerAdapter(leaf, { clock: () => new Date(iso) });
  } finally {
    if (saved.p === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = saved.p;
    if (saved.py === undefined) delete process.env[WORKER_PYTHON_ENV];
    else process.env[WORKER_PYTHON_ENV] = saved.py;
  }
}

const leaf = (extra = {}) => ({
  id: "flash-agsdk-worker",
  adapter: "antigravity-worker",
  model_name: "gemini-3.7-flash",
  pricing: INTRO,
  pricing_source: "https://example.invalid/block-source",
  pricing_last_verified: "2026-01-01",
  ...extra,
});

test("a global leaf whose intro block no longer matches the list says no surcharge, not a regional one", () => {
  const l = leaf({ region: "global" });
  const lines = priceLines(adapterFor(l, "2027-01-02T12:00:00Z").pricingOn(), l, "global");
  assert.equal(lines[0], "  rates       billed at the price list's rates, $1.5/$0.15/$7.5 per million (region 'global' carries no surcharge)");
  assert.deepEqual(lines.slice(1, 3), [`  listed from ${GEMINI_PRICING_URL}`, "  verified    2026-10-12"]);
  assert.match(lines[3], /^ {2}note {8}Policy model 'flash-agsdk-worker' .* differs .* from the price list 1\.5\/0\.15\/7\.5/);
  assert.ok(!lines.some((x) => x.includes("example.invalid") || x.includes("2026-01-01")), "the block's metadata is not the list's");
});

test("a regional leaf compares the billed card with the list card it surcharges", () => {
  const l = leaf({ region: "asia-south1" });
  const lines = priceLines(adapterFor(l, "2026-10-13T12:00:00Z").pricingOn(), l, "asia-south1");
  assert.equal(
    lines[0],
    "  rates       billed at the price list's rates plus Google's regional surcharge, because this leaf runs in " +
      "'asia-south1' rather than the global endpoint: in $0.75/$0.075/$3.75 → $0.825/$0.0825/$4.125 per million (input/cached/output)",
  );
  assert.equal(lines.length, 3, "a block equal to the list adds no note");
});

test("a pricing_override leaf names its own rates and the block's source", () => {
  const l = leaf({ region: "global", pricing: { input: 1, input_cached: 0.1, output: 4 }, pricing_override: true });
  const lines = priceLines(adapterFor(l, "2026-10-13T12:00:00Z").pricingOn(), l, "global");
  assert.equal(lines[0], "  rates       billed at the policy's pricing_override rates, $1/$0.1/$4 per million (region 'global' carries no surcharge)");
  assert.deepEqual(lines.slice(1), ["  pinned from https://example.invalid/block-source", "  verified    2026-01-01"]);
});

test("a leaf nothing prices today says the delegation will be refused, and why", () => {
  const l = leaf({ region: "global" });
  const [line, ...rest] = priceLines(adapterFor(l, "2026-08-12T12:00:00Z").pricingOn(), l, "global");
  assert.match(line, /not priced today by the price list .* refused: no price for gemini-3\.7-flash on 2026-08-12/);
  assert.deepEqual(rest, []);
  assert.match(pricingNote(undefined, undefined, "global"), /will be refused/);
});
