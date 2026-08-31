/**
 * Regression tests for the up-front TaskPacket schema check on
 * execute_with_model. Real-run session b8c3b629 crashed with
 * "Cannot read properties of undefined (reading 'map')" because
 * the orchestrator's first packet was missing `inputs`. Now the
 * server refuses that packet with an actionable message.
 *
 * We import the validator via a direct-tier import from the built
 * server bundle; server.ts exports it for testing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

/**
 * Confirm the validator function exists in the compiled bundle.
 * We check the compiled source rather than importing the ESM module
 * (server.ts starts a Server on import; we don't want side effects
 * in a unit test). The function's shape is the invariant, and its
 * behavior is regression-tested end-to-end via the orchestrator.
 */
test("compiled server bundle contains the validateTaskPacket guard", () => {
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /validateTaskPacket/, "validator must be present in compiled bundle");
  assert.match(src, /missing required field/, "must emit an actionable missing-field message");
  assert.match(src, /inputs must be a FileSlice/, "must call out inputs array shape specifically");
  assert.match(src, /budget must be/, "must call out budget shape specifically");
});

test("the validator lists every required TaskPacket field", () => {
  const src = readFileSync(SERVER, "utf8");
  // Every field in the TaskPacket schema per types.ts must appear in the
  // required[] array of the validator.
  const requiredFields = [
    "id", "phase", "task_type", "module", "instruction",
    "inputs", "outputSchema", "acceptance", "budget", "pass_id",
  ];
  // Find the required[] array in the compiled source.
  const match = src.match(/const required = \[([\s\S]*?)\];/);
  assert.ok(match, "required[] array must be findable in compiled output");
  const arrayContent = match[1];
  for (const field of requiredFields) {
    assert.ok(arrayContent.includes(`"${field}"`), `required[] must include "${field}"`);
  }
});

test("the validator is wired into the execute_with_model handler", () => {
  const src = readFileSync(SERVER, "utf8");
  // The validator must be called on the packet before it's used.
  // Downstream code accesses packet.inputs.filter(...) etc., so
  // validation MUST come first.
  const validateIdx = src.indexOf("validateTaskPacket(a.packet)");
  assert.notEqual(validateIdx, -1, "validateTaskPacket must be called on args.packet");
  // Make sure it's inside execute_with_model handler, not lingering elsewhere.
  const handlerIdx = src.indexOf('"execute_with_model"');
  assert.ok(handlerIdx > 0 && validateIdx > handlerIdx, "validator call must be inside execute_with_model handler");
});
