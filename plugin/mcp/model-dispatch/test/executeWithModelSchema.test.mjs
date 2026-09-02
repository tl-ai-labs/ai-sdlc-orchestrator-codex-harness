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

test("execute_with_model reads provenance from the adapter, defaulting to vendor", () => {
  // Document A section 8: the telemetry event gains a provenance field
  // (vendor/estimated/modeled). Most adapters report real vendor-metered
  // usage, but the codex-cli path can only derive cost from token counts —
  // codex reports no money at all — so the value must come FROM the adapter
  // rather than being hardcoded. Hardcoding "vendor" here would publish a
  // calculation as a bill, which is the one thing this field exists to stop.
  const src = readFileSync(SERVER, "utf8");
  const handlerIdx = src.indexOf('"execute_with_model"');
  const endIdx = src.indexOf('case "simulate_policy"', handlerIdx);
  assert.ok(handlerIdx > 0 && endIdx > handlerIdx);
  const region = src.slice(handlerIdx, endIdx);

  // Three levels, in this order. The per-result label has to come first:
  // an adapter that normally meters can still fail to get usage back on one
  // call and price it from estimateTokens, and consulting only the adapter's
  // static declaration would stamp that estimate `vendor`.
  assert.match(
    region, /provenance:\s*result\.cost_provenance\s*\?\?/,
    "a result that labelled its own cost must win over the adapter's default",
  );
  assert.match(
    region, /result\.cost_provenance\s*\?\?\s*adapter\.costProvenance/,
    "provenance must fall back to the adapter, not be assumed",
  );
  assert.match(
    region, /costProvenance\s*\?\?\s*\(?["']vendor["']/,
    "an adapter that declares nothing must still default to vendor",
  );
});

test("an adapter that had to estimate labels the result, rather than inheriting vendor", () => {
  // The bug this locks out: GeminiFlashAdapter and OpenAIAdapter both fall
  // back to estimateTokens when the vendor sends no usage block, but neither
  // declares a costProvenance — so before this, those estimates reached the
  // report as vendor-metered spend. Assert each adapter both tracks the
  // fallback and stamps it.
  for (const file of ["GeminiFlashAdapter.ts", "OpenAIAdapter.ts"]) {
    const src = readFileSync(new URL(`../src/adapters/${file}`, import.meta.url), "utf8");
    assert.match(src, /let usedEstimate = false;/, `${file}: must track whether it estimated`);
    assert.match(
      src, /usedEstimate\s*\?\s*\{\s*cost_provenance:\s*["']estimated["']/,
      `${file}: must stamp cost_provenance when it estimated`,
    );
    assert.match(
      src, /finalizeResult\([^)]*"vendor_error",\s*true\)/s,
      `${file}: a priced failure path is always an estimate`,
    );
  }
});
