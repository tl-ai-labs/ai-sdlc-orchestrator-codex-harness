/**
 * `dispatch.mjs --preflight` on a day the price list does not cover a model:
 * the bridge reports ok:false with the pricing halt reason, and dispatch.mjs
 * exits 1. The clock is moved by a module preloaded into both processes.
 * Offline: preflight only constructs adapters, with dummy keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DISPATCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "codex", "dispatch.mjs");

const FAKE_CLOCK = `
const offset = Date.parse(process.env.FAKE_NOW) - Date.now();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = FakeDate;
`;

function preflight(dir, name, extraEnv) {
  const out = join(dir, `${name}.json`);
  const run = spawnSync(
    process.execPath,
    [DISPATCH, "--preflight", "--auth-mode=vendor", "--policy=gpt-plus-flash", `--project-root=${dir}`, `--out=${out}`],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-dummy-not-a-real-key",
        GEMINI_API_KEY: "AIza-test-dummy-not-a-real-key",
        MMO_SELECT: "",
        ...extraEnv,
      },
      timeout: 60_000,
    },
  );
  return { status: run.status, stderr: run.stderr, result: JSON.parse(readFileSync(out, "utf-8")) };
}

test("preflight halts and dispatch.mjs exits 1 on a day the list does not price gemini-3.7-flash", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-preflight-unpriced-"));
  try {
    const clock = join(dir, "fake-clock.mjs");
    writeFileSync(clock, FAKE_CLOCK);

    const today = preflight(dir, "today", {});
    assert.equal(today.status, 0, today.stderr);
    assert.equal(today.result.ok, true);
    assert.deepEqual(today.result.unpriced, []);

    // gpt-5.6-terra is listed from 2026-08-09, gemini-3.7-flash from 2026-08-13.
    const early = preflight(dir, "early", {
      NODE_OPTIONS: `--import=${pathToFileURL(clock).href}`,
      FAKE_NOW: "2026-08-12T12:00:00Z",
    });
    assert.equal(early.status, 1, early.stderr);
    assert.equal(early.result.ok, false);
    assert.equal(early.result.priced_on, "2026-08-12");
    assert.deepEqual(early.result.unpriced.map((u) => u.id), ["flash-completion"]);
    assert.match(early.result.halt_reason, /Cannot price 1 of 2 models/);
    assert.ok(early.result.models.every((m) => m.ok), "every adapter constructs; the price alone halts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
