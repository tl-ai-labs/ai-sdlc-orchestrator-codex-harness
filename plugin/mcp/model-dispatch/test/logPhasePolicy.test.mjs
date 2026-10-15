/**
 * A `dispatch.mjs --log-phase` row names the policy the bridge resolves for
 * it, the one execute_with_model would route by: a policy reaching the
 * bridge only through MMO_POLICY_PATH, or a routing-policy.yaml that wins
 * over --policy, still lands in the row with its own name and version.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectBridge } from "../dist/driverClient.js";
import { buildLogEventArgs } from "../../../codex/dispatch.mjs";

const POLICIES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const custom = (name, version) =>
  readFileSync(join(POLICIES, "gpt-plus-flash.yaml"), "utf-8").replace(/^name: .*$/m, `name: ${name}`).replace(/^version: .*$/m, `version: ${version}`);

async function logged(toolArgs) {
  const bridge = await connectBridge({ env: { MMO_LOG_LEVEL: "error" } });
  try {
    assert.equal(await bridge.callTool("log_telemetry", toolArgs), "ok");
  } finally {
    await bridge.close();
  }
  return JSON.parse(readFileSync(toolArgs.telemetry_path, "utf-8").trim().split("\n").at(-1)).routing;
}

test("the row names the policy file the run passed by path, with that file's version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-phase-policy-"));
  try {
    const path = join(dir, "resolved.yaml");
    writeFileSync(path, custom("my-custom", 3));
    const args = buildLogEventArgs({ phase: "security_review", projectRoot: dir, policyPath: path, telemetryPath: join(dir, "t.jsonl") });
    assert.equal(args.event.routing.policy_name, null, "nothing names it on the command line");
    const routing = await logged(args);
    assert.deepEqual([routing.policy_name, routing.policy_version], ["my-custom", 3]);
    assert.equal(routing.rule_index, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a routing-policy.yaml at the project root wins over --policy, as it does for a dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-phase-policy-"));
  try {
    writeFileSync(join(dir, "routing-policy.yaml"), custom("project-own", 2));
    const args = buildLogEventArgs({ phase: "architecture_design", policyName: "gpt-seat-plus-flash", projectRoot: dir, telemetryPath: join(dir, "t.jsonl") });
    const routing = await logged(args);
    assert.deepEqual([routing.policy_name, routing.policy_version], ["project-own", 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a caller that names no policy keeps the event's own routing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-phase-policy-"));
  try {
    const { event } = buildLogEventArgs({ phase: "tests", telemetryPath: "/unused" });
    const routing = await logged({ telemetry_path: join(dir, "t.jsonl"), event });
    assert.deepEqual([routing.policy_name, routing.policy_version], [null, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
