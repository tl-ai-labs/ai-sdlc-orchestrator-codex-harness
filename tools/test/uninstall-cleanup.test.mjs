/**
 * Unit tests for plugin/scripts/uninstall-cleanup.mjs.
 *
 * Ported from the Claude harness's brownfield-cleanup.mjs, which had no
 * tests. The risk in a cleanup script is asymmetric — a missed artifact is
 * an annoyance, a wrongly-deleted one is data loss — so the survey logic is
 * exported and tested separately from anything that calls rmSync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgs,
  findRepoRoot,
  survey,
  nothingToDo,
  mcpRegistered,
  MCP_SERVER_NAME,
} from "../../plugin/scripts/uninstall-cleanup.mjs";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cleanup-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}
const cleanup = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };
const noMcp = () => false;

// ── argument parsing ─────────────────────────────────────────────────────

test("parseArgs accepts both --repo forms", () => {
  // The source took only the space form; the driver takes only `=`. Accepting
  // both here means neither habit silently produces a scan of the wrong tree.
  assert.equal(parseArgs(["node", "s", "--repo", "/a"]).repo, "/a");
  assert.equal(parseArgs(["node", "s", "--repo=/b"]).repo, "/b");
});

test("parseArgs reads the destructive-action flags", () => {
  const a = parseArgs(["node", "s", "--dry-run", "--yes", "--keep-mcp"]);
  assert.equal(a.dryRun, true);
  assert.equal(a.yes, true);
  assert.equal(a.keepMcp, true);
  assert.equal(parseArgs(["node", "s", "-n"]).dryRun, true, "-n is the documented short form");
});

test("parseArgs defaults to doing nothing destructive without being asked", () => {
  const a = parseArgs(["node", "s"]);
  assert.equal(a.yes, false, "prompts must be on by default");
  assert.equal(a.dryRun, false);
});

// ── locating the repo ────────────────────────────────────────────────────

test("findRepoRoot walks up to the directory holding .git", () => {
  const dir = makeRepo();
  try {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(findRepoRoot(nested), dir);
  } finally { cleanup(dir); }
});

test("findRepoRoot returns null outside a repo rather than guessing", () => {
  // Deleting from a guessed root is the worst outcome this script could have.
  assert.equal(findRepoRoot("/", () => false), null);
});

// ── the survey ───────────────────────────────────────────────────────────

test("survey reports a clean repo as having nothing to do", () => {
  const dir = makeRepo();
  try {
    const found = survey(dir, { mcp: noMcp });
    assert.equal(found.sdlc, false);
    assert.equal(found.agents, false);
    assert.equal(nothingToDo(found), true);
  } finally { cleanup(dir); }
});

test("survey finds .sdlc/ and .agents/ independently", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".sdlc"));
    assert.equal(survey(dir, { mcp: noMcp }).sdlc, true);
    assert.equal(survey(dir, { mcp: noMcp }).agents, false, ".agents must not be inferred from .sdlc");
    mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
    assert.equal(survey(dir, { mcp: noMcp }).agents, true);
  } finally { cleanup(dir); }
});

test("survey still finds .agents/ when every link inside it dangles", () => {
  // This is the state an uninstall actually leaves: the links point into a
  // plugin directory that is already gone. A stat-based probe follows the
  // link, finds nothing, and reports a clean repo — leaving codex scanning
  // a directory of broken skills forever. lstat is why this passes.
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
    symlinkSync(join(dir, "gone", "pipeline"), join(dir, ".agents", "skills", "pipeline"), "dir");
    assert.equal(survey(dir, { mcp: noMcp }).agents, true, "a dangling link is still a footprint");
  } finally { cleanup(dir); }
});

test("survey reports a file named .sdlc as absent, not as a directory to delete", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, ".sdlc"), "not a directory");
    assert.equal(survey(dir, { mcp: noMcp }).sdlc, false);
  } finally { cleanup(dir); }
});

test("an MCP registration alone is enough to have work to do", () => {
  // Setup registers the bridge before any run exists, so a project that never
  // ran still has a footprint in ~/.codex/config.toml.
  const dir = makeRepo();
  try {
    const found = survey(dir, { mcp: () => true });
    assert.equal(found.mcp, true);
    assert.equal(nothingToDo(found), false);
  } finally { cleanup(dir); }
});

// ── the MCP probe ────────────────────────────────────────────────────────

test("mcpRegistered matches the name setup.mjs actually registers", () => {
  const listing = (entries) => () => ({ status: 0, stdout: JSON.stringify(entries) });
  assert.equal(mcpRegistered(listing([{ name: MCP_SERVER_NAME, enabled: true }])), true);
  assert.equal(mcpRegistered(listing([{ name: "some-other-server" }])), false);
  assert.equal(mcpRegistered(listing([])), false);
});

test("mcpRegistered does not match a name that merely contains ours", () => {
  // `\bmodel-dispatch\b` matches inside `model-dispatch-legacy`, because a
  // hyphen is a non-word character. Unregistering that would break somebody
  // else's server, so the comparison is exact.
  assert.equal(
    mcpRegistered(() => ({ status: 0, stdout: JSON.stringify([{ name: `${MCP_SERVER_NAME}-legacy` }]) })),
    false,
  );
});

test("mcpRegistered reports false when codex is absent or its output is unusable", () => {
  assert.equal(mcpRegistered(() => ({ error: new Error("ENOENT") })), false);
  assert.equal(mcpRegistered(() => ({ status: 1, stdout: "" })), false);
  assert.equal(
    mcpRegistered(() => ({ status: 0, stdout: "not json" })), false,
    "malformed output is not evidence of a registration",
  );
});
