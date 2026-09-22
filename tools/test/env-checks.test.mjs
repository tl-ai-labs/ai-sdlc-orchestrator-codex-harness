/**
 * Unit tests for plugin/codex/env-checks.mjs.
 *
 * The conflict scan is the interesting one: it was rebuilt on
 * `codex plugin list --json` rather than ported from the source's hand-walk
 * of a plugins directory. Its `spawnSync` is injected here, because the only
 * installed-plugin shape observable on this machine declares no commands at
 * all — so the command-declaring entry shape is exercised against fixtures
 * and is explicitly NOT claimed to be verified against a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSemverLike,
  cmpVer,
  checkNodeVersion,
  checkGitVersion,
  checkSdlcDirWritable,
  checkPluginConflicts,
  commandNamesFrom,
  parseArgs,
  renderText,
  runChecks,
  OUR_COMMAND_NAMES,
} from "../../plugin/codex/env-checks.mjs";

const fakeRun = (result) => () => result;

// ── version helpers ──────────────────────────────────────────────────

test("parseSemverLike pulls a triple out of real tool output", () => {
  assert.deepEqual(parseSemverLike("git version 2.53.0"), [2, 53, 0]);
  assert.deepEqual(parseSemverLike("2.30"), [2, 30, 0]);
  assert.equal(parseSemverLike("no numbers here"), null);
});

test("cmpVer orders versions correctly, including unequal lengths", () => {
  assert.ok(cmpVer([2, 53, 0], [2, 30]) > 0);
  assert.ok(cmpVer([2, 29, 9], [2, 30]) < 0);
  assert.equal(cmpVer([2, 30], [2, 30, 0]), 0);
});

// ── node / git ───────────────────────────────────────────────────────

test("checkNodeVersion passes on this runtime and names the minimum", () => {
  const r = checkNodeVersion();
  assert.equal(r.id, "node-version");
  assert.equal(r.severity, "blocker");
  assert.equal(r.ok, true, "the suite itself runs on Node 20+");
  assert.equal(r.required_min, "20.0.0");
});

test("checkGitVersion blocks when git is absent, with actionable remediation", () => {
  const r = checkGitVersion(fakeRun({ status: 127, stdout: "" }));
  assert.equal(r.ok, false);
  assert.equal(r.severity, "blocker");
  assert.match(r.remediation.join(" "), /not on your PATH/);
});

test("checkGitVersion blocks on a git older than the minimum", () => {
  const r = checkGitVersion(fakeRun({ status: 0, stdout: "git version 2.20.1" }));
  assert.equal(r.ok, false);
  assert.equal(r.detected, "2.20.1");
});

test("checkGitVersion passes on a modern git", () => {
  const r = checkGitVersion(fakeRun({ status: 0, stdout: "git version 2.53.0" }));
  assert.equal(r.ok, true);
});

test("checkGitVersion reports unparseable output rather than crashing", () => {
  const r = checkGitVersion(fakeRun({ status: 0, stdout: "git version banana" }));
  assert.equal(r.ok, false);
  assert.match(r.remediation.join(" "), /Could not parse/);
});

// ── sdlc dir ─────────────────────────────────────────────────────────

test("checkSdlcDirWritable passes inside this repo", () => {
  const r = checkSdlcDirWritable();
  assert.equal(r.id, "sdlc-dir-writable");
  assert.equal(r.ok, true);
});

// ── plugin conflicts ─────────────────────────────────────────────────

test("commandNamesFrom tolerates the shapes a plugin entry might use", () => {
  assert.deepEqual(commandNamesFrom({ commands: ["docs", "/test"] }), ["docs", "test"]);
  assert.deepEqual(commandNamesFrom({ commands: [{ name: "refactor" }] }), ["refactor"]);
  assert.deepEqual(commandNamesFrom({ command: "policy" }), ["policy"]);
  assert.deepEqual(commandNamesFrom({}), [], "an entry declaring no commands yields nothing");
  assert.deepEqual(commandNamesFrom(null), [], "a malformed entry must not throw");
});

test("checkPluginConflicts stays advisory when codex cannot be enumerated", () => {
  const r = checkPluginConflicts(fakeRun({ error: new Error("ENOENT") }));
  assert.equal(r.severity, "advisory");
  assert.equal(r.ok, true, "a check that could not run must not block");
  assert.match(r.note, /conflict scan skipped/);
});

test("checkPluginConflicts stays advisory when the JSON will not parse", () => {
  const r = checkPluginConflicts(fakeRun({ status: 0, stdout: "not json" }));
  assert.equal(r.ok, true);
  assert.match(r.note, /could not parse/);
});

test("checkPluginConflicts reports a clean scan when nothing is installed", () => {
  const r = checkPluginConflicts(fakeRun({ status: 0, stdout: '{"installed":[],"available":[]}' }));
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 0);
});

test("checkPluginConflicts flags a real collision and names both sides", () => {
  const stdout = JSON.stringify({
    installed: [{ name: "someone-elses-plugin", commands: ["docs", "unrelated"] }],
  });
  const r = checkPluginConflicts(fakeRun({ status: 0, stdout }));
  assert.equal(r.ok, false);
  assert.equal(r.severity, "advisory", "a collision is worth saying, but this check cannot see how codex resolves it");
  assert.deepEqual(r.conflicts, [{ plugin: "someone-elses-plugin", command: "docs" }]);
  assert.match(r.remediation.join(" "), /codex plugin remove/);
});

test("checkPluginConflicts does not flag our own plugin declaring our own commands", () => {
  const stdout = JSON.stringify({
    installed: [{ name: "mmo-codex", commands: ["docs", "greenfield"] }],
  });
  const r = checkPluginConflicts(fakeRun({ status: 0, stdout }));
  assert.equal(r.ok, true, "our own commands are not a conflict with ourselves");
});

test("the owned-command list is the current /mmo:* surface, not the pre-rename one", () => {
  assert.ok(OUR_COMMAND_NAMES.has("greenfield"), "the source's copy still said 'run'");
  assert.ok(OUR_COMMAND_NAMES.has("feature-extend"));
  assert.ok(!OUR_COMMAND_NAMES.has("run"));
});

// ── report plumbing ──────────────────────────────────────────────────

test("parseArgs reads --json and --headless", () => {
  assert.deepEqual(parseArgs(["--json"]), { json: true, headless: false });
  assert.deepEqual(parseArgs(["--headless", "--json"]), { json: true, headless: true });
});

test("runChecks turns a thrown check into a blocker instead of crashing the run", () => {
  const exploding = () => { throw new Error("boom"); };
  const report = runChecks([exploding]);
  assert.equal(report.ok, false);
  assert.equal(report.blockers, 1);
  assert.match(report.checks[0].error, /boom/);
});

test("runChecks counts advisories separately and stays ok", () => {
  const advisory = () => ({ id: "x", severity: "advisory", ok: false });
  const report = runChecks([advisory]);
  assert.equal(report.ok, true, "advisories never block");
  assert.equal(report.advisories, 1);
});

test("renderText marks blockers, advisories and passes distinctly", () => {
  const text = renderText({
    blockers: 1,
    advisories: 1,
    checks: [
      { id: "a", ok: true, severity: "blocker" },
      { id: "b", ok: false, severity: "blocker", error: "nope", remediation: ["fix it"] },
      { id: "c", ok: false, severity: "advisory", error: "meh" },
    ],
  });
  assert.match(text, /✓ a/);
  assert.match(text, /✗ b/);
  assert.match(text, /⚠ c/);
  assert.match(text, /fix it/);
  assert.match(text, /FAILED — 1 blocker/);
});
