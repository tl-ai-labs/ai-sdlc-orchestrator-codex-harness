import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertUnderCostCap, CostCapExceededError } from "../dist/costCap.js";

function telemetry(rows) {
  const root = mkdtempSync(join(tmpdir(), "mmo-capseat-"));
  mkdirSync(join(root, "home"));
  const path = join(root, "telemetry.jsonl");
  writeFileSync(path, rows.map((r, i) => JSON.stringify({ task_id: `t${i}`, ...r })).join("\n") + "\n");
  return { path, home: join(root, "home"), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("the cap counts a codex-cli seat floor in full and names it as modeled", () => {
  const t = telemetry([
    { provenance: "estimated", adapter_provenance: "modeled", usage_complete: false, cost_usd: 0.6 },
    { provenance: "vendor", cost_usd: 0.5 },
  ]);
  try {
    assert.throws(
      () => assertUnderCostCap({ name: "gpt-seat-plus-flash", hard_cost_cap_usd: 1 }, t.path, { codexHome: t.home, env: {} }),
      (err) => {
        assert.ok(err instanceof CostCapExceededError);
        assert.equal(err.spend.dispatched_usd, 1.1);
        assert.equal(err.spend.dispatched_modeled_usd, 0.6);
        assert.match(err.message, /\$1\.1000 dispatched \([^;]+; \$0\.6000 of it modeled\)/);
        return true;
      },
    );
  } finally {
    t.done();
  }
});

test("a metered estimate is not counted as modeled", () => {
  const t = telemetry([{ provenance: "estimated", usage_complete: false, cost_usd: 0.3 }]);
  try {
    const spend = assertUnderCostCap({ name: "gpt-plus-flash", hard_cost_cap_usd: 1 }, t.path, { codexHome: t.home, env: {} });
    assert.equal(spend.dispatched_usd, 0.3);
    assert.equal(spend.dispatched_modeled_usd, 0);
  } finally {
    t.done();
  }
});
