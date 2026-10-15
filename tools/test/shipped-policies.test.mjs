/** Every policy the plugin ships runs on this harness: a GPT conductor, Codex-side adapters only, no Anthropic model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { resolveRunPolicy } from "../../plugin/codex/run-policy.mjs";
import { ANTHROPIC_ADAPTER_IDS, KNOWN_ADAPTER_IDS, shippedPresetNames } from "../../plugin/mcp/model-dispatch/dist/policy.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICIES = join(REPO, "plugin", "config", "policies");
const RUNNABLE = ["flash-agsdk-only", "gpt-plus-flash", "gpt-plus-flash-38", "gpt-seat-plus-flash"];
const CODEX_ADAPTERS = ["openai", "codex-cli", "mcp:model-dispatch", "antigravity-worker"];
const ANTHROPIC_MODEL = /\bclaude-[\w.-]+|\bopus\b|\bsonnet\b|\bhaiku\b/i;

const shipped = readdirSync(POLICIES)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((file) => {
    const text = readFileSync(join(POLICIES, file), "utf-8");
    return { file, name: file.replace(/\.ya?ml$/, ""), text, raw: parseYaml(text) };
  });

test("the plugin ships exactly the four runnable policies, and offers each one", () => {
  assert.deepEqual(shipped.map((p) => p.name).sort(), RUNNABLE);
  assert.deepEqual(shippedPresetNames(), RUNNABLE);
});

test("every Codex adapter is one the bridge builds, and none is an Anthropic one", () => {
  for (const id of CODEX_ADAPTERS) {
    assert.ok(KNOWN_ADAPTER_IDS.has(id), `${id} is a bridge adapter`);
    assert.equal(ANTHROPIC_ADAPTER_IDS.has(id), false, id);
  }
});

test("every shipped policy pins a GPT conductor in its driver block, and a run accepts it", () => {
  const root = mkdtempSync(join(tmpdir(), "shipped-policies-"));
  try {
    for (const { file, name, raw } of shipped) {
      assert.match(String(raw.driver?.model_name), /^gpt-/, `${file}: driver.model_name`);
      assert.equal(typeof raw.driver?.reasoning?.effort, "string", `${file}: driver.reasoning.effort`);
      const run = resolveRunPolicy({ projectRoot: root, policyArg: name, warn: () => {} });
      assert.equal(run.driver.from, "driver", file);
      assert.deepEqual(run.driver.pin, { model: raw.driver.model_name, effort: raw.driver.reasoning.effort }, file);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every shipped policy routes only through adapters the bridge ships for Codex", () => {
  for (const { file, raw } of shipped) {
    assert.ok(Array.isArray(raw.models) && raw.models.length > 0, file);
    for (const m of raw.models) assert.ok(CODEX_ADAPTERS.includes(m.adapter), `${file}: model '${m.id}' uses adapter '${m.adapter}'`);
  }
});

test("no shipped policy names an Anthropic model, in a field or a comment", () => {
  for (const { file, text, raw } of shipped) {
    const named = [raw.driver, ...raw.models].flatMap((m) => [m?.model_name, m?.display_name]).filter(Boolean);
    for (const n of named) assert.doesNotMatch(String(n), ANTHROPIC_MODEL, `${file}: ${n}`);
    assert.doesNotMatch(text, ANTHROPIC_MODEL, file);
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY|builtin-anthropic|claude-cli/, file);
  }
});
