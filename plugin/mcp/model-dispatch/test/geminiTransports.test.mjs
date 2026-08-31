/**
 * Guards the credential-detection precedence. One misdetected backend
 * only fails at the first Gemini dispatch, after premium phases are
 * billed — so precedence is tested one fact at a time, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  selectGeminiBackend,
  defaultAdcPath,
  resolveGcpProject,
  resolveGcpLocation,
  isVertexNonGlobal,
  vertexSurchargeApplies,
  applyVertexSurcharge,
  billedOutputTokens,
} from "../dist/adapters/geminiTransports.js";

/** Nothing present. Each test adds exactly the one fact it is about. */
const bare = { env: {}, keyEnvName: "GEMINI_API_KEY", adcFileExists: false };

const tmpJson = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-transport-test-"));
  const path = join(dir, "creds.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
};

// ─── backend precedence ───────────────────────────────────────────────

test("an API key selects the AI Studio door", () => {
  const choice = selectGeminiBackend({ ...bare, env: { GEMINI_API_KEY: "AIza-test" } });
  assert.equal(choice.backend, "api-key");
});

test("the policy's own env var name is honoured, not a hardcoded one", () => {
  // A policy may name a different variable via `auth: { env: ... }`; reading
  // GEMINI_API_KEY regardless would silently ignore the policy.
  const choice = selectGeminiBackend({
    ...bare,
    keyEnvName: "SOME_OTHER_KEY",
    env: { SOME_OTHER_KEY: "AIza-test", GEMINI_API_KEY: "" },
  });
  assert.equal(choice.backend, "api-key");
  assert.match(choice.reason, /SOME_OTHER_KEY/);
});

test("a service-account file selects Vertex", () => {
  const choice = selectGeminiBackend({
    ...bare,
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" },
  });
  assert.equal(choice.backend, "vertex-adc");
});

test("a plain `gcloud auth application-default login` selects Vertex", () => {
  // The important case, and the one the old code got wrong: this login sets
  // no environment variable at all — it only writes a file. Detecting Vertex
  // solely from env vars reported "no credentials" to the majority of
  // enterprise users, whose runs would in fact have worked.
  const choice = selectGeminiBackend({ ...bare, adcFileExists: true });
  assert.equal(choice.backend, "vertex-adc");
});

test("a project env var alone selects Vertex", () => {
  const choice = selectGeminiBackend({ ...bare, env: { GOOGLE_CLOUD_PROJECT: "p" } });
  assert.equal(choice.backend, "vertex-adc");
});

test("with both doors open the API key wins", () => {
  // Exporting a key is a deliberate decision about this shell; ADC on disk is
  // ambient machine state that may predate the plugin by months.
  const choice = selectGeminiBackend({
    ...bare,
    env: { GEMINI_API_KEY: "AIza-test" },
    adcFileExists: true,
  });
  assert.equal(choice.backend, "api-key");
});

test("GEMINI_BACKEND overrides the credentials that are present", () => {
  const forcedVertex = selectGeminiBackend({
    ...bare,
    env: { GEMINI_API_KEY: "AIza-test", GEMINI_BACKEND: "vertex" },
    adcFileExists: true,
  });
  assert.equal(forcedVertex.backend, "vertex-adc");

  const forcedKey = selectGeminiBackend({
    ...bare,
    env: { GEMINI_API_KEY: "AIza-test", GEMINI_BACKEND: "API-Key" },
    adcFileExists: true,
  });
  assert.equal(forcedKey.backend, "api-key", "the override is case-insensitive");
});

test("an unrecognised GEMINI_BACKEND throws instead of guessing", () => {
  // Silently ignoring a typo would route the run through a door the user
  // explicitly tried to close, and bill the wrong account.
  assert.throws(
    () => selectGeminiBackend({ ...bare, env: { GEMINI_BACKEND: "vertexai" }, adcFileExists: true }),
    /not a recognized value/,
  );
});

test("no credentials at all throws, naming both doors", () => {
  assert.throws(() => selectGeminiBackend(bare), (err) => {
    assert.match(err.message, /gcloud auth application-default login/);
    assert.match(err.message, /GEMINI_API_KEY/);
    return true;
  });
});

// ─── project and location resolution ──────────────────────────────────

test("GOOGLE_CLOUD_PROJECT outranks whatever the credentials file says", () => {
  const path = tmpJson({ quota_project_id: "from-file" });
  assert.equal(resolveGcpProject({ GOOGLE_CLOUD_PROJECT: "from-env" }, path), "from-env");
});

test("a user ADC file yields its quota project", () => {
  const path = tmpJson({ type: "authorized_user", quota_project_id: "billed-project" });
  assert.equal(resolveGcpProject({}, path), "billed-project");
});

test("a service-account file yields its project_id", () => {
  // Service-account JSON records project_id and has no quota_project_id.
  const path = tmpJson({ type: "service_account", project_id: "sa-project" });
  assert.equal(
    resolveGcpProject({ GOOGLE_APPLICATION_CREDENTIALS: path }, "/nonexistent/adc.json"),
    "sa-project",
  );
});

test("an unreadable credentials file resolves to undefined, not a throw", () => {
  // Returning undefined lets the SDK run its own resolution (gcloud config,
  // metadata server); only explicit cache creation is given up. Throwing here
  // would break setups that work fine.
  assert.equal(resolveGcpProject({}, "/nonexistent/adc.json"), undefined);
});

test("location defaults to the global endpoint, and is overridable", () => {
  // The default is load-bearing for cost, not just latency: the policy YAMLs
  // pin the flat global rates, and a regional default would have made every
  // reported Gemini figure 10% low.
  assert.equal(resolveGcpLocation({}), "global");
  assert.equal(resolveGcpLocation({ GOOGLE_CLOUD_LOCATION: "asia-south1" }), "asia-south1");
});

// ─── the Vertex regional surcharge ────────────────────────────────────

test("only non-global endpoints carry the surcharge", () => {
  assert.equal(isVertexNonGlobal("global"), false);
  assert.equal(isVertexNonGlobal(" GLOBAL "), false, "case and padding must not defeat it");
  assert.equal(isVertexNonGlobal(""), false);
  assert.equal(isVertexNonGlobal("asia-south1"), true);
  assert.equal(isVertexNonGlobal("us-central1"), true);
});

test("the surcharge is Gemini 3-and-later only", () => {
  // Vertex lists the regional differential for the Gemini 3 families only.
  // Applying it to 2.5 would over-report that model — and a policy can pin
  // both generations at once, so a blanket multiplier biases a comparison
  // between them rather than just shifting a total.
  assert.equal(vertexSurchargeApplies("gemini-3.5-flash"), true);
  assert.equal(vertexSurchargeApplies("gemini-3.5-flash-lite"), true);
  assert.equal(vertexSurchargeApplies("gemini-4.0-pro"), true, "later families default to surcharged");
  assert.equal(vertexSurchargeApplies("gemini-2.5-flash"), false);
  assert.equal(vertexSurchargeApplies("claude-opus-4-7"), false);
});

test("default runs report the pinned rates untouched", () => {
  // Both default doors: an AI Studio key, and Vertex on the global endpoint.
  // If either of these started scaling, every headline cost number in the
  // deliverable would drift away from the policy that is published beside it.
  const pinned = { input: 1.5, input_cached: 0.15, output: 9 };
  const viaKey = applyVertexSurcharge(pinned, {
    backend: "api-key",
    location: "",
    modelName: "gemini-3.5-flash",
  });
  const viaGlobal = applyVertexSurcharge(pinned, {
    backend: "vertex-adc",
    location: "global",
    modelName: "gemini-3.5-flash",
  });
  assert.deepEqual(viaKey, pinned);
  assert.deepEqual(viaGlobal, pinned);
});

test("a pinned region bills +10% on every token class", () => {
  // The figures Google prints for asia-south1 on the Vertex pricing page.
  const surcharged = applyVertexSurcharge(
    { input: 1.5, input_cached: 0.15, output: 9 },
    { backend: "vertex-adc", location: "asia-south1", modelName: "gemini-3.5-flash" },
  );
  assert.equal(round2(surcharged.input), 1.65);
  assert.equal(round3(surcharged.input_cached), 0.165);
  assert.equal(round2(surcharged.output), 9.9);
});

test("a pinned region does NOT surcharge an earlier Gemini family", () => {
  const rates = { input: 0.3, input_cached: 0.03, output: 2.5 };
  assert.deepEqual(
    applyVertexSurcharge(rates, {
      backend: "vertex-adc",
      location: "asia-south1",
      modelName: "gemini-2.5-flash",
    }),
    rates,
  );
});

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

// ─── billed output tokens ─────────────────────────────────────────────
//
// These pin the single most costly accounting rule in the plugin. Gemini 3.x
// reports the reasoning it does before answering in `thoughtsTokenCount`, and
// Google bills it at the output rate; it is NOT part of candidatesTokenCount.
// Reading candidates alone under-reports the expensive token class, and does
// so in the direction that flatters the very claim the pass exists to make.

test("thinking tokens are billed as output, not dropped", () => {
  // Verbatim usageMetadata from a live gemini-3.5-flash call on 2026-08-04.
  // Counting candidates alone reports 1 token where Google bills 98.
  const usage = {
    promptTokenCount: 7,
    candidatesTokenCount: 1,
    thoughtsTokenCount: 97,
    totalTokenCount: 105,
  };
  assert.equal(billedOutputTokens(usage), 98);
});

test("a response with no thinking is unaffected", () => {
  assert.equal(billedOutputTokens({ candidatesTokenCount: 40 }), 40);
});

test("an output cap spent entirely on thinking still bills", () => {
  // maxOutputTokens too low to answer: no candidates at all, but the thinking
  // still happened and is still charged. Reporting zero here would make a
  // failed, retried attempt look free — and the doubling loop retries it.
  assert.equal(billedOutputTokens({ promptTokenCount: 7, thoughtsTokenCount: 13 }), 13);
});

test("an empty usage block yields zero rather than NaN", () => {
  // A NaN would propagate silently through every downstream total.
  assert.equal(billedOutputTokens({}), 0);
});

test("the ADC path matches where gcloud actually writes", () => {
  // Three files compute this path independently (this module, verify-setup.mjs
  // and tools/setup.mjs) because none can import the others. Pinning the
  // shape here catches a drift in the one that ships to users.
  assert.equal(
    defaultAdcPath("/home/someone"),
    "/home/someone/.config/gcloud/application_default_credentials.json",
  );
});
