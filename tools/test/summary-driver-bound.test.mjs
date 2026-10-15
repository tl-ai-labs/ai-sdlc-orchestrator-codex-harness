/** SUMMARY.md's conductor cell and manifest.json's incomplete-turn count against the cost report, over the report's driver-usage fixtures. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRun, summarize } from "../../plugin/scripts/report.mjs";
import { writeManifest } from "../../plugin/scripts/write-manifest.mjs";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "report", "driver-usage");
const WORD = { floor: "at least ", ceiling: "at most ", mixed: "about ", exact: "" };
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function runFrom(name) {
  const root = mkdtempSync(join(tmpdir(), "summary-bound-"));
  roots.push(root);
  const runDir = join(root, ".sdlc", "runs", name);
  mkdirSync(dirname(runDir), { recursive: true });
  cpSync(join(FIXTURES, name), runDir, { recursive: true });
  return { root, runDir };
}

function write(root, runDir, name) {
  const { manifest } = writeManifest({ runDir, runId: name, policy: "gpt-plus-flash", projectRoot: root, summary: true });
  const cell = /^\| Conductor \(driver\) loop — modeled \| (.*) \|$/m.exec(readFileSync(join(runDir, "SUMMARY.md"), "utf-8"))?.[1];
  return { manifest, cell };
}

test("the summary's conductor cell carries the same bound word as the cost report, on every fixture", () => {
  const names = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(names.length >= 7);
  for (const name of names) {
    const { root, runDir } = runFrom(name);
    const driver = summarize(readRun(runDir)).driver;
    const { cell } = write(root, runDir, name);
    const usage = JSON.parse(readFileSync(join(runDir, "driver-usage.json"), "utf-8"));
    assert.equal(cell, `${WORD[driver.bound]}$${usage.cost_usd_modeled.toFixed(4)}`, name);
  }
});

test("a figure booked from the exec stream counts the turns it leaves out; a session-file booking counts none", () => {
  const cases = { "headless-no-session-killed": 1, "headless-killed-last": 0, "headless-equal": 0, "interactive-lower-bound-unread": 0 };
  for (const [name, n] of Object.entries(cases)) {
    const { root, runDir } = runFrom(name);
    const { manifest, cell } = write(root, runDir, name);
    assert.equal(manifest.totals.driver_cost_source, "driver-usage.json", name);
    assert.equal(manifest.totals.driver_turns_incomplete, n, name);
    if (name === "headless-no-session-killed") assert.equal(cell, "at least $0.0500");
  }
});

test("a provisional interactive figure reads as a floor in the summary", () => {
  const { root, runDir } = runFrom("headless-equal");
  const path = join(runDir, "driver-usage.json");
  const usage = JSON.parse(readFileSync(path, "utf-8"));
  const cost_source = "session file (interactive; no exec stream to cross-check; unverified); PROVISIONAL: the closing turn was still running";
  writeFileSync(path, JSON.stringify({ ...usage, cost_source, cost_complete: false, cross_check: null, window: { provisional: true } }));
  assert.equal(write(root, runDir, "headless-equal").cell, "at least $0.1160");
});
