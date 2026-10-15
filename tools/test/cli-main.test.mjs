/**
 * Every plugin CLI runs when started through a symlinked path (a linked
 * plugin folder, /tmp on macOS): import.meta.url is the real path while
 * argv[1] keeps the link, so a plain string compare exits 0 doing nothing.
 */
import "./lib/stand-ins.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CLIS = [
  "codex/dispatch.mjs",
  "codex/env-checks.mjs",
  "codex/run.mjs",
  "codex/session-model.mjs",
  "codex/verify-setup.mjs",
  "codex/start-run.mjs",
  "codex/end-run.mjs",
  "scripts/collect-driver-usage.mjs",
  "scripts/credential-discovery.mjs",
  "scripts/dispatch-sanitize.mjs",
  "scripts/plan-packets.mjs",
  "scripts/probe-agent-worker.mjs",
  "scripts/uninstall-cleanup.mjs",
];

test("each plugin CLI guards its main with the realpath check", () => {
  for (const rel of CLIS) {
    const src = readFileSync(join(REPO, "plugin", rel), "utf-8");
    assert.match(src, /^if \(isMain\(import\.meta\.url(, process\.argv\[1\])?\)\) \{$/m, rel);
    assert.doesNotMatch(src, /fileURLToPath\(import\.meta\.url\) === (resolve\()?process\.argv\[1\]|`file:\/\/\$\{process\.argv\[1\]\}`/, rel);
  }
});

test("credential discovery looks for the Antigravity distribution the worker pins", () => {
  const pinned = /^(google-antigravity)==/m.exec(readFileSync(join(REPO, "plugin/mcp/model-dispatch/worker/requirements.txt"), "utf-8"))?.[1];
  assert.equal(pinned, "google-antigravity");
  const src = readFileSync(join(REPO, "plugin/scripts/credential-discovery.mjs"), "utf-8");
  assert.ok(src.includes(`const ANTIGRAVITY_DIST = "${pinned}";`));
  assert.doesNotMatch(src, /google-antigravity-sdk/);
});

test("a CLI started through a symlinked plugin folder runs its main", () => {
  const base = mkdtempSync(join(tmpdir(), "cli-main-"));
  try {
    const link = join(base, "plugin");
    symlinkSync(join(REPO, "plugin"), link);
    const cases = [
      ["codex/session-model.mjs", ["--bogus"], 2, /session-model: unknown flag --bogus/],
      ["codex/run.mjs", ["--bogus", "--codex-bin=/nonexistent"], 2, /run: unknown flag --bogus/],
      ["codex/dispatch.mjs", [], null, /--out=<path> is required/],
      ["scripts/collect-driver-usage.mjs", ["--bogus"], null, /unknown flag --bogus/],
      ["scripts/plan-packets.mjs", ["--bogus"], 2, /plan-packets: unknown flag --bogus/],
    ];
    for (const [rel, args, code, re] of cases) {
      const r = spawnSync(process.execPath, [join(link, rel), ...args], { cwd: base, encoding: "utf-8" });
      assert.match(r.stdout + r.stderr, re, rel);
      if (code !== null) assert.equal(r.status, code, rel);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
