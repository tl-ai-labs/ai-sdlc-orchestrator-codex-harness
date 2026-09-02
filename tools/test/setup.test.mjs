/**
 * Guards the clone-route setup wizard (tools/setup.mjs).
 *
 * The wizard is an interactive script, so what is testable without driving a
 * TTY is: that it runs to completion non-interactively without hanging, that
 * its verdict reaches the exit code, and that it never writes state into the
 * repo as a side effect of merely *checking*. Those are exactly the three
 * ways a setup wizard fails badly — hanging a CI job, reporting success while
 * blocked, or silently changing a checkout it was only asked to inspect.
 *
 * The decision logic it shares with verify-setup.mjs (credential state,
 * version pins) is covered in verify-setup.test.mjs against the imported
 * functions directly, not re-derived here through the wizard's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIZARD = join(REPO_ROOT, "tools", "setup.mjs");

/**
 * Runs the wizard with stdin closed — the shape a CI job or a piped shell
 * gives it. A wizard that waits for input here would hang the job forever,
 * so the timeout is the assertion as much as the exit code is.
 */
function runWizard(env = {}) {
  return spawnSync("node", [WIZARD], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

test("the wizard runs to completion with stdin closed instead of hanging", () => {
  const r = runWizard();
  assert.notEqual(r.signal, "SIGTERM", "wizard hung waiting for input that will never come");
  assert.ok(typeof r.status === "number", "wizard must exit with a status");
});

test("every question falls through to a documented default when non-interactive", () => {
  const r = runWizard();
  assert.match(
    r.stdout,
    /non-interactive/,
    "a skipped question must say so, not silently pick an answer",
  );
});

test("a blocked setup reports its verdict through the exit code, not just on screen", () => {
  // This machine has no OPENAI_API_KEY, so the wizard is genuinely blocked —
  // asserting the real state rather than simulating one.
  const r = runWizard({ OPENAI_API_KEY: "" });
  assert.match(r.stdout, /Setup incomplete/);
  assert.equal(r.status, 1, "a caller checking only the exit code must see the block");
});

test("the wizard blames the policy for the key requirement, and names the keyless alternative", () => {
  // This repo has no .sdlc/project.json, so the wizard resolves the default
  // metered policy — which really does bill the key, so the block is correct.
  // What it must not do is present the key as unconditional: a ChatGPT seat
  // plus gpt-seat-plus-flash runs the same models without one.
  const r = runWizard({ OPENAI_API_KEY: "" });
  assert.match(r.stdout, /OPENAI_API_KEY is not set/);
  assert.match(r.stdout, /policy 'gpt-plus-flash' bills it/, "the reason must name the policy");
  assert.match(r.stdout, /gpt-seat-plus-flash/, "the way out must be on screen, not only in the docs");
  assert.ok(
    !/no in-session fallback/i.test(r.stdout),
    "the old claim that nothing covers the judgment tier is false since the seat policy landed",
  );
});

test("the wizard never mentions Anthropic (D9)", () => {
  const r = runWizard();
  assert.ok(!/ANTHROPIC/i.test(r.stdout), "no Anthropic credential belongs in codex setup");
});

test("checking setup does not write state into the repo", () => {
  // A wizard that writes a selection file just for looking would leave a
  // dirty checkout behind every CI run.
  const selectFile = join(REPO_ROOT, ".sdlc", "local", "mmo-select.json");
  const before = existsSync(selectFile) ? readFileSync(selectFile, "utf8") : null;
  runWizard();
  const after = existsSync(selectFile) ? readFileSync(selectFile, "utf8") : null;
  assert.equal(after, before, "the wizard changed project state while only checking");
});

test("the wizard points at verify-setup for a re-check without questions", () => {
  const r = runWizard();
  assert.match(r.stdout, /verify-setup\.mjs/, "the non-interactive re-check path must be discoverable");
});

test("the closing banner shows a runnable driver invocation, not a Claude one", () => {
  const r = runWizard({ OPENAI_API_KEY: "sk-test-not-real" });
  // With a key present this machine still blocks on codex-not-on-PATH, so
  // assert on whichever banner it printed — neither may name `claude`.
  assert.ok(!/\bclaude\b/i.test(r.stdout), "no Claude Code invocation may survive into codex setup");
});
