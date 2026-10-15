import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { costCapStop } from "../../plugin/codex/run.mjs";
import { loadPolicyFromPath } from "../../plugin/mcp/model-dispatch/dist/policy.js";
import { SyntheticRollout, driverEventLines, u, writeJsonl } from "../../plugin/mcp/model-dispatch/test/fixtures/syntheticRollout.mjs";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "config", "policies", "gpt-plus-flash.yaml");

test("run.mjs stops resuming once the conductor's modeled spend alone reaches the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cap-driver-"));
  try {
    const policy = { ...loadPolicyFromPath(SHIPPED), hard_cost_cap_usd: 0.5 };
    const telemetry = join(dir, "telemetry.jsonl");
    writeFileSync(telemetry, JSON.stringify({ cost_usd: 0.1 }) + "\n");
    const rows = (costs) =>
      writeFileSync(
        join(dir, "driver-cost-modeled.jsonl"),
        costs.map((c, i) => JSON.stringify({ invocation: i + 1, status: "complete", cost_usd: c })).join("\n") + "\n",
      );
    rows([0.2]);
    assert.equal(costCapStop(policy, telemetry), null);
    rows([0.2, 0.2]);
    const stop = costCapStop(policy, telemetry);
    assert.match(stop, /COST_CAP_EXCEEDED: \$0\.5000/);
    assert.match(stop, /\$0\.1000 dispatched .* \+ \$0\.4000 conductor \(modeled from driver-cost-modeled\.jsonl\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("before the first driver row, run.mjs's cap reads the running turn from the session file in the codex home it is given", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cap-driver-"));
  try {
    const home = join(dir, "home");
    const run = join(dir, "run");
    mkdirSync(home, { recursive: true });
    mkdirSync(run, { recursive: true });
    const thread = "01a2000c-0000-7000-8000-0000000000e1";
    const rollout = new SyntheticRollout({ threadId: thread });
    const turn = rollout.turn({ responses: [{ usage: u(1_000_000) }], end: null });
    rollout.write(home);
    writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(thread, [{ turn, incomplete: true, open: true }]));
    const telemetry = join(run, "telemetry.jsonl");
    const policy = { ...loadPolicyFromPath(SHIPPED), hard_cost_cap_usd: 1.5 };

    const stop = costCapStop(policy, telemetry, { codexHome: home });
    // One request of 1,000,000 input tokens is over the 272,000 threshold, so the list bills 4.00 per 1M.
    assert.match(stop, /\+ \$4\.0000 conductor \(modeled from the codex session file\)/);
    assert.equal(costCapStop(policy, telemetry, { codexHome: join(dir, "empty-home") }), null, "no session file there: the conductor is unmeasured and adds $0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
