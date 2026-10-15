/**
 * `dispatch.mjs --load-policy`: how a skill reads what each model bills
 * today. load_policy makes no vendor call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLoadPolicyArgs, runDispatch, summarize } from "../../../codex/dispatch.mjs";
import { connectBridge } from "../dist/driverClient.js";
import { utcDay } from "../dist/prices.js";

test("buildLoadPolicyArgs passes the policy name and project root in the bridge's snake_case", () => {
  assert.deepEqual(buildLoadPolicyArgs({ policy: "gpt-plus-flash", projectRoot: "/p" }), {
    policy_name: "gpt-plus-flash",
    project_root: "/p",
  });
  assert.deepEqual(buildLoadPolicyArgs({}), {});
});

test("summarize names each model's price basis, and UNPRICED for one nothing prices", () => {
  const line = summarize("load_policy", {
    name: "p",
    effective_prices_on: "2026-10-13",
    models: [{ id: "gpt", effective_price: { basis: "list" } }, { id: "x", effective_price: { basis: null } }],
  });
  assert.equal(line, "policy name=p priced_on=2026-10-13 gpt:list x:UNPRICED");
});

test("--load-policy writes the policy with each model's effective price to --out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-load-policy-"));
  const out = join(dir, "policy.json");
  try {
    const r = await runDispatch(
      { "load-policy": true, policy: "gpt-plus-flash", "project-root": dir, out },
      { connect: connectBridge, env: { MMO_SELECT: "" } },
    );
    assert.equal(r.ok, true);
    assert.equal(r.toolName, "load_policy");
    const written = JSON.parse(readFileSync(out, "utf-8"));
    assert.equal(written.name, "gpt-plus-flash");
    assert.equal(written.effective_prices_on, utcDay(new Date()));
    const gpt = written.models.find((m) => m.id === "gpt");
    assert.equal(gpt.effective_price.basis, "list");
    assert.deepEqual(gpt.effective_price.rates, { input: 2, input_cached: 0.2, output: 12 });
    assert.equal(gpt.effective_price.tiers[0].above_input_tokens, 272_000);
    assert.match(r.summary, /^policy name=gpt-plus-flash priced_on=\d{4}-\d{2}-\d{2} gpt:list /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
