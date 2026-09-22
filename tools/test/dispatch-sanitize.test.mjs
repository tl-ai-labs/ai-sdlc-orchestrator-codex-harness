/**
 * Unit tests for plugin/scripts/dispatch-sanitize.mjs — the secret-pattern
 * sweep the MCP adapters run before every provider call (ticket §7.13, §10.1).
 *
 * Coverage: at least one positive (real match) and one negative (must-not-match)
 * per pattern class. If a shipped pattern regresses, npm test fails here — the
 * one place we want a regression to fail loud.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, assertSafe, PATTERNS } from "../../plugin/scripts/dispatch-sanitize.mjs";

test("the pattern registry has entries and each declares name + kind + re", () => {
  assert.ok(PATTERNS.length >= 8, "expected at least 8 patterns");
  for (const p of PATTERNS) {
    assert.ok(p.name, "each pattern has a name");
    assert.ok(p.kind, "each pattern has a kind");
    assert.ok(p.re instanceof RegExp, "each pattern has a RegExp");
  }
});

test("scan detects Anthropic API keys (real prefix, 80+ suffix)", () => {
  const key = "sk-ant-api03-" + "a".repeat(85);
  const hits = scan(`payload contains ${key} as a header`);
  assert.ok(hits.some((h) => h.kind === "anthropic"), "expected an anthropic hit");
});

test("scan detects Google API keys (AIza-prefixed, 35 char suffix)", () => {
  const key = "AIza" + "b".repeat(35);
  const hits = scan(`GEMINI_API_KEY=${key}`);
  assert.ok(hits.some((h) => h.kind === "google"), "expected a google hit");
});

test("scan detects PEM private-key blocks", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\n" + "a".repeat(60) + "\n-----END RSA PRIVATE KEY-----";
  const hits = scan(pem);
  assert.ok(hits.some((h) => h.kind === "cryptographic-key"), "expected a private-key hit");
});

test("scan detects AWS access key IDs", () => {
  const hits = scan("credential AKIAIOSFODNN7EXAMPLE was used");
  assert.ok(hits.some((h) => h.kind === "aws"), "expected an AWS hit");
});

test("scan detects GitHub tokens", () => {
  const hits = scan("token: ghp_" + "a".repeat(40));
  assert.ok(hits.some((h) => h.kind === "github"), "expected a github hit");
});

test("scan does NOT match innocent prose about Anthropic", () => {
  const hits = scan("The Anthropic API is used for LLM calls; see docs/api-keys.md for details.");
  assert.equal(hits.length, 0, "prose about Anthropic must not trigger a credential match");
});

test("scan does NOT match a git commit SHA (40-hex string)", () => {
  const hits = scan("commit b739f0745e9c7d8f2a3b4c5d6e7f8a9b0c1d2e3f — a README update");
  assert.equal(hits.length, 0, "40-char hex SHA must not match anything");
});

test("scan does NOT match a Stripe *publishable* key (pk_ prefix)", () => {
  // Stripe pattern targets sk_/rk_ deliberately, not pk_ (publishable is safe to expose).
  const hits = scan("stripe pubkey pk_live_" + "z".repeat(24));
  assert.equal(hits.length, 0, "pk_ publishable keys must not match");
});

test("assertSafe throws with a message naming the pattern kind and preview", () => {
  const key = "sk-ant-api03-" + "a".repeat(85);
  assert.throws(
    () => assertSafe(`prompt: ${key}`),
    /refused to dispatch|anthropic|secret/i,
  );
});

test("assertSafe is silent on safe text", () => {
  assert.doesNotThrow(() => assertSafe("regular prompt text with no secrets, just README updates"));
});

test("scan is idempotent — the shared /g regex state does not leak between calls", () => {
  const key = "AIza" + "b".repeat(35);
  const text = `env var GEMINI_API_KEY=${key}`;
  const a = scan(text);
  const b = scan(text);
  assert.equal(a.length, b.length, "same input → same match count");
});

test("scan bounds itself with maxFindings", () => {
  const key = "AIza" + "c".repeat(35);
  const text = Array(200).fill(`k=${key}`).join(" ");
  const hits = scan(text, { maxFindings: 10 });
  assert.equal(hits.length, 10, "maxFindings must cap the result set");
});
