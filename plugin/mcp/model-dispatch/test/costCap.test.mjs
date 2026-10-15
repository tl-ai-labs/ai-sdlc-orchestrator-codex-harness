import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertUnderCostCap, recordedCostUsd, CostCapExceededError, COST_CAP_EXCEEDED } from "../dist/costCap.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { connectBridge } from "../dist/driverClient.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml");

function tmp() {
  return mkdtempSync(join(tmpdir(), "mmo-costcap-"));
}

function writeTelemetry(dir, costs) {
  const path = join(dir, "telemetry.jsonl");
  writeFileSync(path, costs.map((c, i) => JSON.stringify({ task_id: `t${i}`, cost_usd: c })).join("\n") + "\n");
  return path;
}

function policyWithCap(dir, cap) {
  const yaml = readFileSync(SHIPPED, "utf-8").replace(/^hard_cost_cap_usd: .*$/m, `hard_cost_cap_usd: ${cap}`);
  const path = join(dir, "capped.yaml");
  writeFileSync(path, yaml);
  return path;
}

const policy = (cap) => ({ name: "p", version: 1, models: [], rules: [], hard_cost_cap_usd: cap });

test("recordedCostUsd sums every event regardless of provenance, and skips torn lines", () => {
  const dir = tmp();
  try {
    const path = writeTelemetry(dir, [0.1, 0.25]);
    writeFileSync(path, readFileSync(path, "utf-8") + '{"cost_usd": 0.05, "provenance": "modeled"}\n{"torn');
    assert.equal(Math.round(recordedCostUsd(path) * 1e6) / 1e6, 0.4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("under the cap, dispatch is allowed", () => {
  const dir = tmp();
  try {
    assert.doesNotThrow(() => assertUnderCostCap(policy(1), writeTelemetry(dir, [0.4, 0.5])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("at or over the cap, dispatch is refused with a coded error", () => {
  const dir = tmp();
  try {
    const path = writeTelemetry(dir, [0.6, 0.4]);
    assert.throws(
      () => assertUnderCostCap(policy(1), path),
      (err) => err instanceof CostCapExceededError && err.code === COST_CAP_EXCEEDED && /hard_cost_cap_usd \$1/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no cap, or no telemetry path, means no check", () => {
  const dir = tmp();
  try {
    const path = writeTelemetry(dir, [999]);
    assert.doesNotThrow(() => assertUnderCostCap(policy(undefined), path));
    assert.doesNotThrow(() => assertUnderCostCap(policy(1), undefined));
    assert.doesNotThrow(() => assertUnderCostCap(policy(1), join(dir, "absent.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cap that is not a positive number fails at policy load, not silently at dispatch", () => {
  const dir = tmp();
  try {
    for (const bad of ['"50"', "0", "-5"]) {
      assert.throws(() => loadPolicyFromPath(policyWithCap(dir, bad)), /hard_cost_cap_usd/, bad);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// No OPENAI_API_KEY is set, so a dispatch that got past the cap check would
// fail on adapter construction instead — the error text tells the two apart.
test("the real bridge refuses execute_with_model once a $0.01 cap is spent, and appends nothing", async () => {
  const dir = tmp();
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const bridge = await connectBridge();
  try {
    const telemetry = writeTelemetry(dir, [0.02]);
    const before = readFileSync(telemetry, "utf-8");
    await assert.rejects(
      bridge.callTool("execute_with_model", {
        policy_path: policyWithCap(dir, "0.01"),
        telemetry_path: telemetry,
        packet: {
          id: "tp_cap_001",
          phase: "requirements_analysis",
          task_type: "analysis",
          module: "all",
          instruction: "unused",
          inputs: [],
          outputSchema: {},
          acceptance: [],
          budget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
          pass_id: "cap-test",
        },
      }),
      new RegExp(COST_CAP_EXCEEDED),
    );
    assert.equal(readFileSync(telemetry, "utf-8"), before);
  } finally {
    await bridge.close();
    if (original !== undefined) process.env.OPENAI_API_KEY = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
