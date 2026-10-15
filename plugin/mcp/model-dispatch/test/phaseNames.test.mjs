/**
 * A packet or a logged phase whose name is not one the bridge routes is
 * refused before any policy or vendor work: such a name matches no rule,
 * routes to the default tier, and gets no row of its own in the report.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectBridge } from "../dist/driverClient.js";
import { isPhase, PHASES } from "../dist/types.js";

const packet = (phase) => ({
  id: "tp_1",
  phase,
  task_type: "controller_handler",
  module: "auth",
  instruction: "x",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: ["x"],
  budget: { maxInputTokens: 100, maxOutputTokens: 100 },
  pass_id: "r1",
});

const skipEvent = (phase) => ({
  pass: null, phase, task_type: "skipped", task_id: `${phase}-skipped`, module: null, model: null,
  provenance: "none", routed_by: "manual",
  routing: { policy_name: "gpt-plus-flash", policy_version: 1, rule_index: -1, rule_reason: "skipped" },
  input_tokens: 0, input_tokens_cached: 0, output_tokens: 0, cost_usd: 0, success: true, retry_count: 0,
});

test("the phase list holds the brownfield phases and nothing the state machine calls a step", () => {
  assert.ok(PHASES.includes("discovery") && PHASES.includes("change_plan"));
  for (const step of ["execute_packets", "test_run", "preflight", "read_brief", "generate_final_report", "driver_loop"]) {
    assert.equal(isPhase(step), false, step);
  }
  assert.equal(isPhase(undefined), false);
});

test("execute_with_model refuses a state-machine step name as a phase, before any routing", async () => {
  const bridge = await connectBridge({ env: { MMO_LOG_LEVEL: "error" } });
  try {
    for (const phase of ["test_run", "execute_packets", ""]) {
      await assert.rejects(
        bridge.callTool("execute_with_model", { packet: packet(phase), policy_name: "no-such-policy" }),
        /TaskPacket\.phase '.*' is not a phase the bridge routes\. Use one of: requirements_analysis, .*change_plan/,
        phase,
      );
    }
  } finally {
    await bridge.close();
  }
});

test("log_telemetry refuses an unknown phase and writes nothing; a known one is recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-names-"));
  const path = join(dir, "telemetry.jsonl");
  const bridge = await connectBridge({ env: { MMO_LOG_LEVEL: "error" } });
  try {
    await assert.rejects(
      bridge.callTool("log_telemetry", { telemetry_path: path, event: skipEvent("test_run") }),
      /event\.phase 'test_run' is not a phase the bridge routes/,
    );
    assert.equal(existsSync(path), false);
    assert.equal(await bridge.callTool("log_telemetry", { telemetry_path: path, event: skipEvent("tests") }), "ok");
    assert.equal(JSON.parse(readFileSync(path, "utf-8").trim()).phase, "tests");
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
