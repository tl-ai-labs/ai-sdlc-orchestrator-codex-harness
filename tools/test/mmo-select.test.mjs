/**
 * Unit tests for plugin/codex/mmoSelect.mjs — the project-local
 * MMO_SELECT persistence that replaces the source's
 * .claude/settings.json + .mcp.json round-trip (see the module's own
 * docstring for why).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMmoSelectFile, writeMmoSelectFile } from "../../plugin/codex/mmoSelect.mjs";

function makeProject() {
  return mkdtempSync(join(tmpdir(), "mmo-select-test-"));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("readMmoSelectFile returns undefined when no file exists", () => {
  const dir = makeProject();
  try {
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { cleanup(dir); }
});

test("writeMmoSelectFile then readMmoSelectFile round-trips the spec", () => {
  const dir = makeProject();
  try {
    const path = writeMmoSelectFile(dir, "gemini-flash=flash-agsdk-worker");
    assert.ok(existsSync(path));
    assert.equal(readMmoSelectFile(dir), "gemini-flash=flash-agsdk-worker");
  } finally { cleanup(dir); }
});

test("writeMmoSelectFile creates .sdlc/local/ if it doesn't exist yet", () => {
  const dir = makeProject();
  try {
    writeMmoSelectFile(dir, "a=b");
    assert.ok(existsSync(join(dir, ".sdlc", "local", "mmo-select.json")));
  } finally { cleanup(dir); }
});

test("writeMmoSelectFile with a falsy spec deletes the file — empty and absent are identical", () => {
  const dir = makeProject();
  try {
    writeMmoSelectFile(dir, "a=b");
    assert.ok(existsSync(join(dir, ".sdlc", "local", "mmo-select.json")));
    writeMmoSelectFile(dir, undefined);
    assert.equal(existsSync(join(dir, ".sdlc", "local", "mmo-select.json")), false);
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { cleanup(dir); }
});

test("writeMmoSelectFile with an empty string also deletes the file", () => {
  const dir = makeProject();
  try {
    writeMmoSelectFile(dir, "a=b");
    writeMmoSelectFile(dir, "");
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { cleanup(dir); }
});

test("readMmoSelectFile fails open on a corrupt file rather than throwing", () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "mmo-select.json"), "not json {[}");
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { cleanup(dir); }
});

test("readMmoSelectFile fails open when mmo_select is missing or the wrong type", () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "mmo-select.json"), JSON.stringify({ mmo_select: 42 }));
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { cleanup(dir); }
});

test("the file format is plain, readable JSON with one field", () => {
  const dir = makeProject();
  try {
    writeMmoSelectFile(dir, "gemini-flash=flash-agsdk-worker");
    const raw = readFileSync(join(dir, ".sdlc", "local", "mmo-select.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), { mmo_select: "gemini-flash=flash-agsdk-worker" });
  } finally { cleanup(dir); }
});
