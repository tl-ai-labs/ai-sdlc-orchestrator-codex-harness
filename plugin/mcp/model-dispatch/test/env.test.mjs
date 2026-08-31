/**
 * Regression tests for env sanitation. Pins: what counts as unusable
 * (`${NAME}` verbatim, empty, undefined), that only declared vars are
 * touched, and that legitimate `$`-containing values survive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isUnusableEnvValue,
  sanitizePluginEnv,
  PLUGIN_DECLARED_ENV,
  UNEXPANDED_PLACEHOLDER,
} from "../dist/env.js";

test("an unexpanded placeholder is unusable", () => {
  assert.equal(isUnusableEnvValue("${GOOGLE_CLOUD_PROJECT}"), true);
  assert.equal(isUnusableEnvValue("${GEMINI_BACKEND}"), true);
  assert.equal(isUnusableEnvValue("${_PRIVATE_VAR9}"), true);
  // Surrounding whitespace must not hide it.
  assert.equal(isUnusableEnvValue("  ${GEMINI_API_KEY}  "), true);
});

test("absent and empty values are unusable", () => {
  assert.equal(isUnusableEnvValue(undefined), true);
  assert.equal(isUnusableEnvValue(""), true);
  assert.equal(isUnusableEnvValue("   "), true);
});

test("a real value containing a dollar sign is left alone", () => {
  // The regex is anchored at both ends precisely so these survive. A passphrase or a
  // path that happens to contain `${...}` is a legitimate value, not a placeholder.
  assert.equal(isUnusableEnvValue("ai-studies-console"), false);
  assert.equal(isUnusableEnvValue("/Users/x/creds.json"), false);
  assert.equal(isUnusableEnvValue("p$${weird}word"), false);
  assert.equal(isUnusableEnvValue("prefix-${VAR}"), false);
  assert.equal(isUnusableEnvValue("${VAR}-suffix"), false);
  assert.equal(isUnusableEnvValue("${not a var name}"), false);
  assert.equal(isUnusableEnvValue("$VAR"), false);
});

test("sanitize deletes the placeholders and reports their names", () => {
  const env = {
    GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}",
    GEMINI_BACKEND: "${GEMINI_BACKEND}",
    GOOGLE_CLOUD_LOCATION: "asia-south1",
  };
  const removed = sanitizePluginEnv(env);

  assert.deepEqual(removed, ["GOOGLE_CLOUD_PROJECT", "GEMINI_BACKEND"]);
  assert.equal("GOOGLE_CLOUD_PROJECT" in env, false, "must be absent, not empty-string");
  assert.equal("GEMINI_BACKEND" in env, false);
  assert.equal(env.GOOGLE_CLOUD_LOCATION, "asia-south1", "a real value must survive");
});

test("after sanitation an unset variable is genuinely absent", () => {
  // This is the property the whole fix rests on: `key in env` is false, so every
  // consumer's existing "not set" branch runs — the backend selector falls through to
  // the ADC file, and the project resolver reads the quota project out of it.
  const env = { GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}" };
  sanitizePluginEnv(env);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(Object.keys(env).length, 0);
});

test("variables outside the declared set are never touched", () => {
  // Deleting arbitrary empty variables would be overreach — plenty are legitimately
  // empty, and tools we shell out to may depend on them.
  const env = {
    PATH: "/usr/bin",
    SOME_OTHER_VAR: "${SOME_OTHER_VAR}",
    LEGITIMATELY_EMPTY: "",
    GEMINI_API_KEY: "${GEMINI_API_KEY}",
  };
  const removed = sanitizePluginEnv(env);

  assert.deepEqual(removed, ["GEMINI_API_KEY"]);
  assert.equal(env.SOME_OTHER_VAR, "${SOME_OTHER_VAR}");
  assert.equal(env.LEGITIMATELY_EMPTY, "");
  assert.equal(env.PATH, "/usr/bin");
});

test("a clean environment is returned unchanged", () => {
  const env = { GOOGLE_CLOUD_PROJECT: "ai-studies-console", GOOGLE_CLOUD_LOCATION: "global" };
  assert.deepEqual(sanitizePluginEnv(env), []);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, "ai-studies-console");
});

test("every variable plugin.json declares is covered", async () => {
  // If a pass-through is added to plugin.json without being added to the
  // sanitize list, it keeps the old broken behaviour silently: the literal
  // "${VAR}" reaches the consumer, truthy and wrong.
  //
  // Read from the shipped files rather than compared against a list copied
  // into this test. A copy asserts only that someone updated the copy — which
  // is the very mistake it exists to catch. There are three hand-maintained
  // copies of this list (plugin.json, env.ts, verify-setup.mjs), each in a
  // package that cannot import the others, so all three are pinned here.
  const pluginJson = JSON.parse(
    readFileSync(
      new URL("../../../.claude-plugin/plugin.json", import.meta.url),
      "utf-8",
    ),
  );
  const declaredInManifest = Object.keys(
    pluginJson.mcpServers["model-dispatch"].env,
  ).sort();

  assert.deepEqual([...PLUGIN_DECLARED_ENV].sort(), declaredInManifest);

  const { DECLARED_ENV } = await import("../../../scripts/verify-setup.mjs");
  assert.deepEqual([...DECLARED_ENV].sort(), declaredInManifest);
});

test("the placeholder pattern is anchored", () => {
  assert.equal(UNEXPANDED_PLACEHOLDER.test("${A}"), true);
  assert.equal(UNEXPANDED_PLACEHOLDER.test("x${A}"), false);
  assert.equal(UNEXPANDED_PLACEHOLDER.test("${A}x"), false);
  // A leading digit is not a valid shell identifier, so it is not a placeholder we emit.
  assert.equal(UNEXPANDED_PLACEHOLDER.test("${9A}"), false);
});
