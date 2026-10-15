/**
 * A brownfield run.mjs run starts at the root of its git project, where its
 * Gate 0 freeze is written: any other --project-root is refused before codex
 * is started.
 */
import "./lib/stand-ins.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../../plugin/codex/run.mjs";
import { freezeContract } from "../../plugin/scripts/write-contract.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex.mjs");

function repo({ git = true } = {}) {
  const top = mkdtempSync(join(tmpdir(), "run-git-root-"));
  if (git) mkdirSync(join(top, ".git"));
  const app = join(top, "packages", "app");
  mkdirSync(app, { recursive: true });
  for (const dir of [top, app]) writeFileSync(join(dir, "brief.md"), "# Brief\n");
  return { top, app, cleanup: () => rmSync(top, { recursive: true, force: true }) };
}

async function run(root, argv) {
  let out = "";
  let err = "";
  const spawned = [];
  const code = await main(["--project-root", root, "--run-id=r1", "--gates=auto-approve", ...argv], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: join(root, ".codex-home") },
    spawnFn: (bin, args, opts) => {
      spawned.push(args);
      return spawn(process.execPath, [FAKE, ...args], opts);
    },
    stdin: { isTTY: false },
    signals: new EventEmitter(),
    isGitRepo: () => true,
    stdout: { write: (s) => ((out += s), true) },
    stderr: { write: (s) => ((err += s), true) },
  });
  return { code, out, err, spawned };
}

test("a brownfield --project-root below the git root is refused before codex starts, naming the root", async () => {
  const r = repo();
  try {
    assert.throws(() => freezeContract({ projectRoot: r.app, runId: "r0", allowlist: ["src/**"] }), /not the root of a git project/);
    const res = await run(r.app, ["--mode=brownfield"]);
    assert.equal(res.code, 2, res.err);
    assert.match(res.err, /is inside the git project at .*, not its root/);
    assert.ok(res.err.includes(`--project-root='${r.top}'`), res.err);
    assert.match(res.err, /packages\/app\/\*\*/);
    assert.deepEqual(res.spawned, [], "nothing is spawned, not even codex login status");
    assert.equal(existsSync(join(r.app, ".sdlc")), false, "no run folder is made");
  } finally {
    r.cleanup();
  }
});

test("a run with no --mode below the git root is refused too, and told greenfield is the other way", async () => {
  const r = repo();
  try {
    const res = await run(r.app, []);
    assert.equal(res.code, 2, res.err);
    assert.match(res.err, /not its root.*--mode=greenfield/s);
    assert.deepEqual(res.spawned, []);
  } finally {
    r.cleanup();
  }
});

test("a git work tree with no .git folder at or above the root is refused for brownfield", async () => {
  const r = repo({ git: false });
  try {
    const res = await run(r.top, ["--mode=brownfield"]);
    assert.equal(res.code, 2, res.err);
    assert.match(res.err, /has no \.git folder, and none above it/);
    assert.deepEqual(res.spawned, []);
  } finally {
    r.cleanup();
  }
});

test("brownfield at the git root, and greenfield in a subfolder, still start", async () => {
  const r = repo();
  try {
    const brown = await run(r.top, ["--mode=brownfield", "--dry-run"]);
    assert.equal(brown.code, 0, brown.err);
    assert.equal(JSON.parse(brown.out).output_dir, join(r.top, ".sdlc", "runs", "r1"));
    const green = await run(r.app, ["--mode=greenfield", "--dry-run"]);
    assert.equal(green.code, 0, green.err);
  } finally {
    r.cleanup();
  }
});
