/**
 * Unit tests for plugin/codex/hooks/write-contract-check.mjs — the PreToolUse
 * hook that refuses off-limits or not-in-manifest writes during brownfield
 * runs, rebuilt for codex's payload shapes and reply protocol.
 *
 * Testing shape: subprocess-based, piping the codex hook payload shape on
 * stdin and reading the reply on stdout: a JSON deny, or nothing for an
 * allow. Codex ignores a bare exit code and reports a bare
 * `permissionDecision: "allow"` as a failed hook run
 * (docs/verification/p1-codex-runtime.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync, symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { endRun, freezeContract, abandonRun } from "../../plugin/scripts/write-contract.mjs";
import {
  extractBashFolders, extractBashRemovals, extractBashTargets, extractNarrowTargets, wordForms,
} from "../../plugin/scripts/lib/write-guard.mjs";

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "codex", "hooks", "write-contract-check.mjs");
const WRITE_CONTRACT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "write-contract.mjs");

/** Run the hook with the given tool call payload. Returns { decision, reason, stderr }; an empty reply is an allow. */
function runHook(cwd, payload, args = []) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn("node", [HOOK, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}\nstderr: ${stderr}`));
      if (stdout === "") return resolvePromise({ decision: "allow", reason: undefined, stderr });
      try {
        const parsed = JSON.parse(stdout);
        const decision = parsed.hookSpecificOutput?.permissionDecision;
        if (decision !== "deny") throw new Error(`a non-empty reply must be a deny, got ${JSON.stringify(decision)}`);
        resolvePromise({ decision, reason: parsed.hookSpecificOutput?.permissionDecisionReason, stderr });
      } catch (e) {
        reject(new Error(`hook did not reply with a JSON deny: ${stdout}\nstderr: ${stderr}\n${e}`));
      }
    });
    p.stdin.end(JSON.stringify({ cwd, ...payload }));
  });
}

/** A git project, with a hand-written contract (no lock) when one is given. */
function makeRepo(contract) {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  mkdirSync(join(dir, ".git"));
  if (contract !== undefined) {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return dir;
}

/** A git project whose contract write-contract.mjs froze for run `runId`. */
function makeFrozenRepo(allowlist = ["src/**"], { runId = "r1", offLimits, strict = true, projectDefaults } = {}) {
  const dir = makeRepo(undefined);
  if (projectDefaults !== undefined) {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ off_limits_default: projectDefaults }));
  }
  freezeContract({ projectRoot: dir, runId, allowlist, offLimits: offLimits ?? [], strict });
  return dir;
}

const contractFile = (dir) => join(dir, ".sdlc", "local", "write-contract.json");
const lockFile = (dir, id) => join(dir, ".sdlc", "runs", id, "write-contract.lock.json");
const decisionsFile = (dir) => join(dir, ".sdlc", "local", "guard-decisions.jsonl");
const decisions = (dir) => existsSync(decisionsFile(dir))
  ? readFileSync(decisionsFile(dir), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

async function expectAll(dir, cases, decision, label = "") {
  for (const path of cases) {
    const r = await runHook(dir, typeof path === "string" ? applyPatchAdd(path) : path);
    assert.equal(r.decision, decision, `${label}${typeof path === "string" ? path : path.tool_input.command} → ${r.reason ?? ""}${r.stderr}`);
  }
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function applyPatchAdd(path, contents = "hello") {
  return {
    tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+${contents}\n*** End Patch` },
  };
}

function bashRedirect(command) {
  return { tool_name: "Bash", tool_input: { command } };
}

// ── apply_patch extraction path ─────────────────────────────────────────

test("allows any write when no contract file exists (greenfield case)", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, applyPatchAdd("src/anything.ts"));
    assert.equal(r.decision, "allow");
  } finally { cleanup(dir); }
});

test("allows any write when contract.active is false", async () => {
  const dir = makeRepo({ schema_version: 1, active: false, allowlist: [], off_limits: [] });
  try {
    const r = await runHook(dir, applyPatchAdd("src/anything.ts"));
    assert.equal(r.decision, "allow");
  } finally { cleanup(dir); }
});

test("allows a path that matches the allowlist", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: ["src/**"], off_limits: [".env*"],
  });
  try {
    const r = await runHook(dir, applyPatchAdd("src/lib/foo.ts"));
    assert.equal(r.decision, "allow", `stderr=${r.stderr}`);
  } finally { cleanup(dir); }
});

test("denies a path that hits off_limits — even if it also matches allowlist", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "test-1",
    allowlist: ["**/*"], off_limits: [".env", ".env.*"],
  });
  try {
    const r = await runHook(dir, applyPatchAdd(".env.production"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /off-limits/);
  } finally { cleanup(dir); }
});

test("denies a path that is not in the allowlist (allowlist-default-deny)", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "test-2",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, applyPatchAdd("docs/README.md"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /not in the confirmed allowlist/i);
  } finally { cleanup(dir); }
});

test("strict=false downgrades an off_limits hit to allow, with a warning", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: false,
    allowlist: [], off_limits: ["docs/private/**"],
  });
  try {
    const r = await runHook(dir, applyPatchAdd("docs/private/notes.md"));
    assert.equal(r.decision, "allow");
    assert.match(r.stderr, /WARN: .*off-limits pattern "docs\/private\/\*\*"/);
  } finally { cleanup(dir); }
});

test("strict=false never opens the always-off-limits list", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: false, run_id: "loose",
    allowlist: ["**"], off_limits: [],
  });
  try {
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    await expectAll(dir, [".env", "src/.env.local", "pkg/.git/config", ".codex/auth.json", ".agents/skills/x.md"], "deny");
  } finally { cleanup(dir); }
});

test("fails open when the contract file is not valid JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), "this is not json {[}");
    const r = await runHook(dir, applyPatchAdd("anything"));
    assert.equal(r.decision, "allow");
  } finally { cleanup(dir); }
});

test("fails open when the tool call has no extractable target", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, { tool_name: "apply_patch", tool_input: {} });
    assert.equal(r.decision, "allow");
  } finally { cleanup(dir); }
});

test("fails open on an unrelated tool name with no structured path field", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, { tool_name: "view_image", tool_input: { url: "https://example.com/x.png" } });
    assert.equal(r.decision, "allow", "a tool this hook isn't wired for must not accidentally deny");
  } finally { cleanup(dir); }
});

test("an allow is an empty reply on every path, a refusal the one JSON reply", () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    const ask = (input) => spawnSync(process.execPath, [HOOK], { cwd: dir, input, encoding: "utf8" });
    const allowed = [
      JSON.stringify({ cwd: dir, tool_name: "Bash", tool_input: { command: "ls" } }),
      JSON.stringify({ cwd: dir, ...applyPatchAdd("src/a.ts") }),
      "not json",
      "",
    ];
    for (const input of allowed) {
      const r = ask(input);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "", `nothing on stdout for an allow: ${input.slice(0, 60)}`);
    }
    const r = ask(JSON.stringify({ cwd: dir, ...applyPatchAdd("lib/a.ts") }));
    assert.equal(r.status, 0);
    const reply = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(reply.hookEventName, "PreToolUse");
    assert.equal(reply.permissionDecision, "deny");
    assert.match(reply.permissionDecisionReason, /not in the confirmed allowlist for run r1/);
    assert.equal(decisions(dir).filter((row) => row.decision === "allow").length, 2, "an allow is still recorded");
  } finally { cleanup(dir); }
});

// ── multi-file apply_patch: one off-limits target blocks the whole call ──

test("a multi-file patch is denied whole if ANY target is off-limits", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "multi-1",
    allowlist: ["src/**"], off_limits: [".env"],
  });
  try {
    const command =
      "*** Begin Patch\n" +
      "*** Add File: src/ok.ts\n+ok\n" +
      "*** Update File: .env\n+SECRET=1\n" +
      "*** End Patch";
    const r = await runHook(dir, { tool_name: "apply_patch", tool_input: { command } });
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /off-limits/);
  } finally { cleanup(dir); }
});

test("a Move to: destination is checked as its own target", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "move-1",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const command =
      "*** Begin Patch\n" +
      "*** Update File: src/old.ts\n" +
      "*** Move to: docs/new.ts\n" +
      "-old\n+new\n" +
      "*** End Patch";
    const r = await runHook(dir, { tool_name: "apply_patch", tool_input: { command } });
    assert.equal(r.decision, "deny", "the rename destination (docs/new.ts) is outside the allowlist");
    assert.match(r.reason, /not in the confirmed allowlist/i);
  } finally { cleanup(dir); }
});

// ── Bash extraction path ─────────────────────────────────────────────────

test("Bash: a redirect write is extracted and checked against the contract", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "bash-1",
    allowlist: [], off_limits: [".env"],
  });
  try {
    const r = await runHook(dir, bashRedirect("printf 'x' > .env"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /off-limits/);
  } finally { cleanup(dir); }
});

test("Bash: a read-only command with no redirect is allowed (nothing to check)", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, bashRedirect("cat .env"));
    assert.equal(r.decision, "allow", "no redirect target means nothing was extracted");
  } finally { cleanup(dir); }
});

test("Bash: tee is recognized as a write target", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "bash-tee",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, bashRedirect("echo hi | tee docs/out.md"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /not in the confirmed allowlist/i);
  } finally { cleanup(dir); }
});

test("Bash: an allowlisted redirect target is allowed", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, bashRedirect("printf 'x' > src/generated.ts"));
    assert.equal(r.decision, "allow", `stderr=${r.stderr}`);
  } finally { cleanup(dir); }
});

test("Bash: a bare touch (no redirect) is still extracted and checked", async () => {
  // Live-verified gap this closes: an unhandled `touch` slips an empty file
  // past the contract even while a subsequent content-write to the same
  // path is correctly blocked (docs/verification/p1-codex-runtime.md).
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "touch-1",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, bashRedirect("mkdir -p docs && touch docs/notes.txt"));
    assert.equal(r.decision, "deny", `stderr=${r.stderr}`);
    assert.match(r.reason, /not in the confirmed allowlist/i);
  } finally { cleanup(dir); }
});

test("Bash: touch on an allowlisted path is allowed", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, bashRedirect("touch src/new-empty-file.ts"));
    assert.equal(r.decision, "allow", `stderr=${r.stderr}`);
  } finally { cleanup(dir); }
});

test("Bash: cp's destination is checked, not its source", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "cp-1",
    allowlist: ["src/**"], off_limits: [".env"],
  });
  try {
    // Source is off-limits but is only READ; destination is what gets
    // written and is outside the allowlist.
    const r = await runHook(dir, bashRedirect("cp .env docs/leaked.txt"));
    assert.equal(r.decision, "deny", `stderr=${r.stderr}`);
    assert.match(r.reason, /not in the confirmed allowlist/i, "must deny on the destination, not the off-limits source");
  } finally { cleanup(dir); }
});

test("Bash: mv into the allowlist is allowed", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, bashRedirect("mv /tmp/staged.ts src/final.ts"));
    assert.equal(r.decision, "allow", `stderr=${r.stderr}`);
  } finally { cleanup(dir); }
});

test("Bash: cp into a directory (trailing slash) is judged as the file it lands on", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, bashRedirect("cp file.txt some-dir/"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /^some-dir\/file\.txt matches off-limits pattern "\*\*\/\*"/);
  } finally { cleanup(dir); }
});

/** A folder outside the repo holding `files` (path → text), for a cp/mv source. */
function sourceFolder(files) {
  const dir = mkdtempSync(join(tmpdir(), "cp-source-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("scan: cp and mv into a folder land on <folder>/<source name>; a folder source is listed file by file", () => {
  assert.deepEqual(extractBashTargets("cp src/a.js lib/"), ["lib/a.js"]);
  assert.deepEqual(extractBashTargets("mv -f src/a.js src/b.js lib/"), ["lib/a.js", "lib/b.js"]);
  assert.deepEqual(extractBashTargets("cp a b dir"), ["dir/a", "dir/b"], "several sources need a folder");
  assert.deepEqual(extractBashTargets("cp /tmp/x/.env ./"), ["./.env"]);
  assert.deepEqual(extractBashTargets("cp src/a.ts src/b.ts"), ["src/b.ts"], "one source to a file path is that file");
  const src = sourceFolder({ "a.ts": "a", "sub/b.ts": "b" });
  const repo = makeRepo(undefined);
  try {
    mkdirSync(join(repo, "lib"));
    assert.deepEqual(extractBashTargets("cp src/a.js lib", repo), ["lib/a.js"], "an existing folder takes the file");
    assert.deepEqual(extractBashTargets(`cp -R ${src}/. out/`, repo).sort(), ["out/a.ts", "out/sub/b.ts"]);
    assert.deepEqual(extractBashTargets(`cp -r ${src}/ out/`, repo).sort(),
      [`out/${src.split("/").pop()}/a.ts`, `out/${src.split("/").pop()}/sub/b.ts`, "out/a.ts", "out/sub/b.ts"].sort(),
      "BSD and GNU cp put a trailing-slash folder in different places, so both are judged");
    assert.deepEqual(extractBashTargets(`cp -r ${src} lib`, repo).sort(), [`lib/${src.split("/").pop()}/a.ts`, `lib/${src.split("/").pop()}/sub/b.ts`]);
    assert.deepEqual(extractBashFolders(`cp -r ${src} lib`, repo), []);
    assert.deepEqual(extractBashFolders("cp -R /no/such/folder/. out/", repo), ["out/"], "a folder the hook cannot list");
    assert.deepEqual(extractBashFolders('cp -r "$SRC" out/', repo), ["out/$SRC"]);
  } finally { cleanup(repo); cleanup(src); }
});

test("live contract: a cp or mv into a folder is judged on what lands there, as the todo's repro gives it", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  const src = sourceFolder({ "a.ts": "a", ".env": "SECRET=1", "skills/pipeline.md": "x" });
  try {
    mkdirSync(join(dir, "lib"));
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    writeFileSync(join(dir, "src", "a.js"), "x");
    await expectAll(dir, [
      bashRedirect("cp src/a.js lib/"), bashRedirect("mv src/a.js lib/"), bashRedirect("cp src/a.js lib"),
      bashRedirect("cp -r src/ lib/"), bashRedirect("cp src/a.js .git/"), bashRedirect("cp src/a.js ./"),
      bashRedirect(`cp ${src}/.env ./`), bashRedirect(`cp ${src}/.env .`),
      bashRedirect("cp /tmp/write-contract.lock.json .sdlc/runs/r1/"),
      bashRedirect("cp /tmp/write-contract.json .sdlc/local/"),
      bashRedirect(`cp -R ${src}/skills/. .sdlc/runs/r1/skills/`),
      bashRedirect("cp -R /no/such/skills/. .sdlc/runs/r1/skills/"),
      bashRedirect(`cp -R ${src}/. .sdlc/runs/r1/`),
      bashRedirect(`cp -R ${src}/. src/`),
      bashRedirect('cp -R "$SRC"/. lib/'),
    ], "deny");
    await expectAll(dir, [
      bashRedirect("cp src/a.js src/sub/"), bashRedirect("cp lib/x.js src/"), bashRedirect("mv src/a.js src/sub"),
      bashRedirect(`cp ${src}/a.ts src/`), bashRedirect(`cp -R ${src}/skills/. src/docs/`),
      bashRedirect('cp -R "$SRC"/. src/'), bashRedirect(`cp ${src}/a.ts .sdlc/runs/r1/notes/`),
    ], "allow");
    const r = await runHook(dir, bashRedirect(`cp -R ${src}/. src/`));
    assert.match(r.reason, /^src\/\.env matches always-off-limits pattern "\.env"/, "a listed folder names the file that is refused");
    const f = await runHook(dir, bashRedirect('cp -R "$SRC"/. lib/'));
    assert.match(f.reason, /^lib\/ \(a folder copied in whole\) is not in the confirmed allowlist for run r1/);
  } finally { cleanup(dir); cleanup(src); }
});

test("no contract: a copy into a folder meets the always-off-limits list like any other write", async () => {
  const dir = makeRepo(undefined);
  const src = sourceFolder({ "app.js": "x", ".git/config": "[core]" });
  try {
    mkdirSync(join(dir, "pkg"));
    await expectAll(dir, [
      bashRedirect(`cp -r ${src}/.git ./`), bashRedirect(`cp ${src}/app.js .GIT/`), bashRedirect(`cp -r ${src} pkg`),
      bashRedirect('cp -R "$X"/. .codex/'), bashRedirect('cp -R "$X"/. .agents/'),
    ], "deny");
    await expectAll(dir, [
      bashRedirect(`cp ${src}/app.js pkg/`), bashRedirect(`cp -R ${src}/app.js pkg/`),
      bashRedirect('cp -R "$X"/. pkg/'),
    ], "allow");
    assert.ok(!existsSync(join(dir, ".sdlc")));
  } finally { cleanup(dir); cleanup(src); }
});

// ── SiteNotes regression: cross-repo writes and pre-contract safety net ────

test("cross-repo write: denies an absolute path that resolves outside cwd's contract", async () => {
  const repoA = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "repo-a-run",
    allowlist: ["src/**"], off_limits: [],
  });
  const repoB = mkdtempSync(join(tmpdir(), "write-contract-repo-b-"));
  try {
    const absTargetInB = join(repoB, "plugin", "scripts", "verify-setup.mjs");
    mkdirSync(join(repoB, "plugin", "scripts"), { recursive: true });
    const r = await runHook(repoA, applyPatchAdd(absTargetInB));
    assert.equal(r.decision, "deny", `stderr=${r.stderr}`);
    assert.match(r.reason, /OUTSIDE the calling session's contracted repo|Cross-project writes/);
  } finally { cleanup(repoA); cleanup(repoB); }
});

test("pre-contract safety net: never overwrites an EXISTING .env", async () => {
  // The reason the .env rule exists: a real .env holds the user's secrets.
  // This is the case that must stay refused, and the narrowed rule keys on
  // exactly it.
  const dir = makeRepo(undefined);
  try {
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://real:secret@host/db\n");
    const r = await runHook(dir, applyPatchAdd(".env"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /always-off-limits/);
    assert.match(
      readFileSync(join(dir, ".env"), "utf8"), /real:secret/,
      "the existing file must be untouched",
    );
  } finally { cleanup(dir); }
});

test("pre-contract safety net: allows CREATING a .env that does not exist", async () => {
  // The greenfield test fixture. The pipeline's test phase copies the run's
  // own .env.test to .env before `npm test`, for an app whose codegen emitted
  // a validating config module. The blanket rule refused it, so the Workforce
  // Ops reference run silently skipped build, E2E and startup verification —
  // the harness was forbidding a write it also instructs.
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, applyPatchAdd(".env"));
    assert.equal(r.decision, "allow");
  } finally { cleanup(dir); }
});

test("pre-contract safety net: still refuses .env.* variants whether or not they exist", async () => {
  // The narrowing is for the bare fixture name only. `.env.production` is
  // never something a greenfield test bootstrap needs.
  const dir = makeRepo(undefined);
  try {
    for (const name of [".env.production", ".env.local"]) {
      const r = await runHook(dir, applyPatchAdd(name));
      assert.equal(r.decision, "deny", `${name} must stay off-limits`);
    }
  } finally { cleanup(dir); }
});

test("pre-contract safety net: allows the harness to write its OWN run record", async () => {
  // Regression from the first real end-to-end run: `.sdlc/**` was off-limits,
  // which blocked the conductor writing requirements.md / packets.json — the
  // artifacts the run exists to produce. The run halted at the first packet.
  const dir = makeRepo(undefined);
  try {
    for (const path of [".sdlc/requirements.md", ".sdlc/packets.json", ".sdlc/telemetry.jsonl"]) {
      const r = await runHook(dir, applyPatchAdd(path));
      assert.equal(r.decision, "allow", `${path} is the harness's own output and must be writable`);
    }
  } finally { cleanup(dir); }
});

test("pre-contract: .sdlc/local/ is writable before a contract exists, and refused while one is live", async () => {
  const dir = makeRepo(undefined);
  try {
    await expectAll(dir, [".sdlc/local/state.json", ".sdlc/local/write-contract.json"], "allow", "no contract: ");
  } finally { cleanup(dir); }
  const frozen = makeFrozenRepo();
  try {
    await expectAll(frozen, [".sdlc/local/state.json", ".sdlc/local/write-contract.json", ".sdlc/local/guard-decisions.jsonl"], "deny", "live: ");
  } finally { cleanup(frozen); }
});

test("pre-contract safety net: refuses writes to .agents/, the conductor's own instructions", async () => {
  // `verify-setup.mjs --fix` links the shipped skills into .agents/skills, so
  // those files are the pipeline state machine, the brownfield guide and the
  // reviewer roles. A run able to write there could rewrite the rules it is
  // being judged by — the same hazard the .sdlc/local/ entry guards against.
  const dir = makeRepo(undefined);
  try {
    for (const path of [".agents/skills/pipeline/SKILL.md", ".agents/skills/security-review.md"]) {
      const r = await runHook(dir, applyPatchAdd(path));
      assert.equal(r.decision, "deny", `${path} is conductor instruction state and must stay protected`);
    }
  } finally { cleanup(dir); }
});

test("pre-contract safety net: allows an ordinary src/ write when no contract exists", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, applyPatchAdd("src/lib/foo.ts"));
    assert.equal(r.decision, "allow");
  } finally { cleanup(dir); }
});

test("target-anchored contract resolution: absolute target inside a contracted repo hits its contract", async () => {
  const neutralCwd = mkdtempSync(join(tmpdir(), "write-contract-neutral-"));
  const contracted = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "target-anchored",
    allowlist: ["docs/**"], off_limits: [],
  });
  try {
    const absTarget = join(contracted, "src", "should-not-be-written.ts");
    mkdirSync(join(contracted, "src"), { recursive: true });
    const r = await runHook(neutralCwd, applyPatchAdd(absTarget));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /not in the confirmed allowlist/i);
  } finally { cleanup(neutralCwd); cleanup(contracted); }
});

// ── D3: guard-decisions.jsonl sidecar ────────────────────────────────────

test("a denied call is recorded in .sdlc/local/guard-decisions.jsonl", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "sidecar-1",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    await runHook(dir, applyPatchAdd("docs/README.md"));
    const sidecarPath = join(dir, ".sdlc", "local", "guard-decisions.jsonl");
    assert.ok(existsSync(sidecarPath), "guard-decisions.jsonl must exist after a denial");
    const lines = readFileSync(sidecarPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.decision, "deny");
    assert.equal(last.run_id, "sidecar-1");
    assert.ok(last.ts, "sidecar record carries its own timestamp — codex events don't");
  } finally { cleanup(dir); }
});

test("an allowed call is also recorded, not just denials", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "sidecar-2",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    await runHook(dir, applyPatchAdd("src/ok.ts"));
    const sidecarPath = join(dir, ".sdlc", "local", "guard-decisions.jsonl");
    assert.ok(existsSync(sidecarPath));
    const lines = readFileSync(sidecarPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.decision, "allow");
  } finally { cleanup(dir); }
});

// ── item 2: before a contract, only secrets, Codex config, git and the skills are refused ──

test("no contract: build output, .sdlc/local and other tools' folders are writable", async () => {
  const dir = makeRepo(undefined);
  try {
    await expectAll(dir, [
      ".sdlc/local/state.json", ".sdlc/local/write-contract.json", "dist/x.js", "packages/a/build/x",
      "node_modules/a/i.js", ".next/x", ".cursor/rules/a.mdc", ".sdlc/runs/r1/requirements.md",
    ], "allow");
  } finally { cleanup(dir); }
});

test("no contract: secrets, Codex config, git's store and .agents are refused at any depth and in any case", async () => {
  const dir = makeRepo(undefined);
  try {
    await expectAll(dir, [
      ".env.local", ".mcp.json", ".codex/config.toml", ".codex/auth.json", ".git/config", ".agents/skills/x.md",
      "pkg/.env.production", ".MCP.json", ".AGENTS/x.md", ".ENV.production", ".GIT/hooks/pre-commit", "a/.Codex/Config.toml",
    ], "deny");
    const r = await runHook(dir, applyPatchAdd(".mcp.json"));
    assert.match(r.reason, /always-off-limits pattern "\.mcp\.json"/);
    assert.match(r.reason, /Stop and tell the person/);
  } finally { cleanup(dir); }
});

test("no contract: a missing .env, .env.example or .env.test may be created, at any depth", async () => {
  const dir = makeRepo(undefined);
  try {
    await expectAll(dir, [".env", ".env.example", ".env.test", "app/.env.test", "app/.env.example", ".ENV"], "allow");
    await expectAll(dir, [
      bashRedirect(`cp .env.test ${join(dir, ".env")}`), bashRedirect(`cp app/.env.test ${join(dir, "app", ".env")}`),
      bashRedirect(`bash -lc "cp .env.test ${join(dir, ".env.test")}"`),
    ], "allow", "a literal absolute shell target: ");
  } finally { cleanup(dir); }
});

test("no contract: an existing .env-family file, or a link in its place, is refused", async () => {
  const dir = makeRepo(undefined);
  try {
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    writeFileSync(join(dir, ".env.example"), "KEY=\n");
    symlinkSync(join(dir, "nowhere", ".env"), join(dir, "app-env"));
    mkdirSync(join(dir, "app"));
    symlinkSync(join(dir, "elsewhere-secret"), join(dir, "app", ".env"));
    await expectAll(dir, [
      bashRedirect("cp .env.test .ENV"), ".env.example", "app/.env", bashRedirect("printf x > app/.env"),
    ], "deny");
  } finally { cleanup(dir); }
});

test("no contract: the .env allowance holds only for a target the shell writes as it stands", async () => {
  const home = mkdtempSync(join(tmpdir(), "write-contract-home-"));
  try {
    writeFileSync(join(home, ".env"), "SECRET=1\n");
    const dir = join(home, "proj");
    mkdirSync(join(dir, ".git"), { recursive: true });
    await expectAll(dir, [
      bashRedirect("cp .env.test ../.env"),
      bashRedirect("cp .env.test ~/.env"), bashRedirect('cp .env.test "$HOME/.env"'), bashRedirect("echo X=2 > ~/.env"),
      bashRedirect("echo X=2 > $HOME/.env"), bashRedirect("cp .env.test `pwd`/.env"), "~/.env",
    ], "deny");
    await expectAll(dir, [bashRedirect(`cp .env.test ${join(dir, ".env")}`)], "allow", "the literal path, with nothing there: ");
  } finally { cleanup(home); }
});

test("no contract: a relative shell target gets no .env allowance, since the shell may run it in another folder", async () => {
  // Codex's shell tool takes a `workdir` the hook payload does not carry, and a `cd` can sit inside a quoted string.
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", ".env"), "SECRET=1\n");
    await expectAll(dir, [
      bashRedirect("cp .env.test .env"), bashRedirect("echo X=1 > .env.test"), bashRedirect("touch .env.example"),
      bashRedirect("cd out && cp .env.test .env"), bashRedirect("sh -c 'cd out && cp .env.test .env'"),
      bashRedirect('bash -lc "cd out && cp .env.test .env"'), bashRedirect("env -C out cp .env.test .env"),
      bashRedirect("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: .env\n+X=1\n*** End Patch\nEOF\n"),
    ], "deny");
  } finally { cleanup(dir); }
});

test("no contract: the greenfield bootstrap with an absolute target creates a missing .env, and never overwrites one", async () => {
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, "out"));
    const bootstrap = `cd ${join(dir, "out")} && if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test ${join(dir, "out", ".env")}; fi`;
    const shellPatch = `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${join(dir, "out", ".env")}\n+X=1\n*** End Patch\nEOF\n`;
    await expectAll(dir, [bashRedirect(bootstrap), bashRedirect(shellPatch)], "allow");
    writeFileSync(join(dir, "out", ".env"), "SECRET=1\n");
    await expectAll(dir, [bashRedirect(bootstrap), bashRedirect(shellPatch), "out/.env"], "deny", "out/.env exists: ");
  } finally { cleanup(dir); }
});

test("no contract: only an apply_patch Add File takes the .env allowance, not an update or a move", async () => {
  const dir = makeRepo(undefined);
  try {
    writeFileSync(join(dir, "a.txt"), "x\n");
    const patch = (body) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } });
    await expectAll(dir, [
      patch("*** Update File: .env\n@@\n+X=1"), patch("*** Update File: a.txt\n*** Move to: .env\n@@\n-x\n+x"),
    ], "deny");
  } finally { cleanup(dir); }
});

test("a target that ends a quoted command string is judged without its quote", async () => {
  const dir = makeRepo(undefined);
  try {
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    await expectAll(dir, [
      bashRedirect('bash -lc "echo x > .env"'), bashRedirect("sh -c 'cp a .env'"), bashRedirect("bash -lc 'echo x >> .mcp.json'"),
      bashRedirect('bash -lc "echo x>.env"'), bashRedirect("sh -c 'tee a .codex/config.toml'"),
    ], "deny", "no contract: ");
  } finally { cleanup(dir); }
  const live = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(live, [
      bashRedirect('bash -lc "echo x > src/.env"'), bashRedirect("sh -c 'cp a src/.env.local'"),
      bashRedirect("sh -c 'rm .sdlc/runs/r1/write-contract.lock.json'"),
    ], "deny", "live contract: ");
    await expectAll(live, [bashRedirect('bash -lc "echo x > src/a.ts"')], "allow", "live contract: ");
  } finally { cleanup(live); }
  assert.deepEqual(extractBashTargets("sh -c 'cp a .env'"), [".env"]);
  assert.deepEqual(extractBashTargets('bash -lc "echo x > \'.env\'"'), [".env"]);
});

test("an apply_patch run through the shell is judged by its file headers, not by its patch text", async () => {
  // Codex applies a shell `apply_patch` itself and hands the hook a Bash call carrying the patch.
  const shellPatch = (headers, body = "+x") => bashRedirect(`apply_patch <<'EOF'\n*** Begin Patch\n${headers}\n${body}\n*** End Patch\nEOF\n`);
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [
      shellPatch("*** Add File: docs/x.md"), shellPatch("*** Add File: .sdlc/local/write-contract.json"),
      shellPatch("*** Update File: src/a.ts\n*** Move to: lib/a.ts", "@@\n-a\n+b"), shellPatch("*** Delete File: README.md", ""),
    ], "deny");
    await expectAll(dir, [
      shellPatch("*** Add File: src/x.ts", "+if (a > b) { y >> z; }\n+rm -rf .sdlc/runs/r1"),
      shellPatch("*** Add File: .sdlc/runs/r1/notes.md"),
    ], "allow", "patch text is file content: ");
  } finally { cleanup(dir); }
  assert.deepEqual(
    extractBashTargets("cd app && apply_patch <<EOF\n*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n+a > c\n*** End Patch\nEOF"),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(extractBashTargets("cat <<EOF > notes.md\n*** Add File: x\nEOF"), ["notes.md"], "no apply_patch, no headers");
});

test("a binding contract refuses even a missing .env, .env.example or .env.test", async () => {
  const dir = makeFrozenRepo(["**"]);
  try {
    await expectAll(dir, [".env", ".env.example", "app/.env.test", bashRedirect("cp .env.test .env")], "deny");
  } finally { cleanup(dir); }
});

test("under every contract state the always-off-limits list holds", async () => {
  for (const extra of [{ strict: true }, { strict: false }, { active: false }]) {
    const dir = makeRepo({ schema_version: 1, active: true, run_id: "x1", allowlist: ["**"], off_limits: [], ...extra });
    try {
      writeFileSync(join(dir, ".env"), "SECRET=1\n");
      await expectAll(dir, [
        ".env", "config/.env.staging", "pkg/.git/config", "pkg/.agents/x.md", "pkg/.codex/config.toml",
      ], "deny", `${JSON.stringify(extra)}: `);
    } finally { cleanup(dir); }
  }
});

// ── item 3: the run's own folder while its contract is live ──

test("live contract: a write into another run's folder is refused, naming the run that holds the project", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    const r = await runHook(dir, applyPatchAdd(".sdlc/runs/r2/discovery.md"));
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /run r1 still holds this project's write contract/);
    assert.match(r.reason, /--abandon --run-id=r1/);
    assert.match(r.reason, /Stop and tell the person/);
  } finally { cleanup(dir); }
});

test("live contract: the run writes its own .sdlc/runs/<run-id>/ folder", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [
      ".sdlc/runs/r1/requirements.md", ".sdlc/runs/r1/design.md", ".sdlc/runs/r1/packets/tp_001.json",
      ".sdlc/runs/r1/gates.jsonl", ".sdlc/runs/r1/state.json", ".sdlc/runs/r1/SUMMARY.md",
      bashRedirect("cat > .sdlc/runs/r1/packets/tp_002.json <<'EOF'\n{}\nEOF"),
      bashRedirect("rm -f .sdlc/runs/r1/packets/tp_002.json"),
    ], "allow");
  } finally { cleanup(dir); }
});

test("live contract: the carve-out is the run's own folder only", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [
      ".sdlc/runs/OTHER/requirements.md", ".sdlc/SUMMARY.md", ".sdlc/local/state.json", ".sdlc/ledger.md",
      ".SDLC/RUNS/r1/requirements.md",
    ], "deny");
    const r = await runHook(dir, applyPatchAdd(".sdlc/ledger.md"));
    assert.match(r.reason, /not in the confirmed allowlist for run r1/);
  } finally { cleanup(dir); }
});

test("live contract: the contract and the run's plugin records are refused, in any case", async () => {
  const dir = makeFrozenRepo(["**"], { projectDefaults: [] });
  try {
    await expectAll(dir, [
      ".sdlc/runs/r1/write-contract.lock.json", ".SDLC/RUNS/r1/WRITE-CONTRACT.LOCK.JSON",
      ".sdlc/runs/r1/write-contract.frozen.json", ".sdlc/runs/r1/skills/pipeline.md",
      ".sdlc/runs/r1/provenance.json", ".sdlc/runs/r1/backups/src/a.ts",
      ".sdlc/local/write-contract.json", ".SDLC/LOCAL/write-contract.json",
      bashRedirect("node -e 1 > .sdlc/local/write-contract.json"),
    ], "deny");
    const r = await runHook(dir, applyPatchAdd(".sdlc/runs/r1/write-contract.lock.json"));
    assert.match(r.reason, /run r1's write contract or a record the plugin keeps for it/);
  } finally { cleanup(dir); }
});

test("live contract: rm, unlink and mv-source of a guarded record are refused; other removals pass", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [
      bashRedirect("rm .sdlc/runs/r1/write-contract.lock.json"),
      bashRedirect("rm -rf .sdlc/runs/r1"),
      bashRedirect("rm -rf -- .sdlc"),
      bashRedirect("unlink '.sdlc/local/write-contract.json'"),
      bashRedirect("mv .sdlc/local/write-contract.json /tmp/x.json"),
      bashRedirect("git rm -q .sdlc/runs/r1/write-contract.frozen.json"),
    ], "deny");
    await expectAll(dir, [bashRedirect("rm src/old.ts"), bashRedirect("rm -f .sdlc/runs/r1/design.md")], "allow");
  } finally { cleanup(dir); }
});

test("scan: a shell word is read as the paths the shell expands it to", () => {
  const forms = (w, o) => wordForms(w, o).map((f) => (f.open ? `open:${f.path}` : f.path));
  assert.deepEqual(forms(".sdlc/runs/r1/{backups,provenance.json}"), [".sdlc/runs/r1/backups", ".sdlc/runs/r1/provenance.json"]);
  assert.deepEqual(forms('.sdlc/runs/r1/back"ups"'), [".sdlc/runs/r1/backups"]);
  assert.deepEqual(forms(".sdlc/runs/r{1..9}/backups"), [".sdlc/runs/r*/backups"]);
  assert.deepEqual(forms("$d/backups"), ["open:**"]);
  assert.deepEqual(forms(".sdlc/runs/$ID/backups"), ["open:.sdlc/runs/**"]);
  assert.deepEqual(forms("$HOME/x"), [`${homedir()}/x`]);
  assert.deepEqual(forms("~/x"), [`${homedir()}/x`]);
  assert.deepEqual(forms("$d/x", { open: false }), [], "an unsure target with a variable is left out");
  assert.deepEqual(extractBashRemovals("rm -r .sdlc/runs/r1/b(ackups|x)"), [".sdlc/runs/r1/b*"], "a zsh glob group is any text");
  assert.deepEqual(extractBashRemovals("rm -rf $(cat list)"), ["$*"]);
});

test("live contract: a glob, brace, quote or variable that may reach a guarded record is refused", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    mkdirSync(join(dir, ".sdlc", "runs", "r1", "backups"), { recursive: true });
    await expectAll(dir, [
      "rm -r .sdlc/runs/r1/backup?", "rm .sdlc/runs/r1/*", "rm -r .sdlc/runs/r1/*", "rm .sdlc/runs/*/write-contract.lock.json",
      "rm .sdlc/local/write-contract.*", "rm -r .sdlc/runs/r1/[bp]*", "rm -r .sdlc/runs/r1/{backups,provenance.json}",
      'rm -r .sdlc/runs/r1/back"ups"', "rm -r .sdlc/runs/r1/back\\ups", "rm -r .sdlc/runs/r?", "rm -r .s*",
      "rm -r .sdlc/runs/r{1..1}/backups", `rm -r ${dir}/.sdlc/runs/r1/backup?`, "d=.sdlc/runs/r1; rm -r $d/backups",
      "rm -r $(echo .sdlc/runs/r1/backups)", "rm -r .sdlc/runs/r1/b(ackups)", "unlink .sdlc/runs/r1/provenance.jso?",
      "mv .sdlc/runs/r1/provenance.jso? src/p.json", "rm -r .SDLC/RUNS/R1/BACKUP?",
      "echo x > .sdlc/runs/r1/write-contract.lock.jso?", "cp /tmp/x .sdlc/runs/r1/provenance.jso?",
      "echo x > .sdlc/runs/r1/p(rovenance.json)", "echo x>.sdlc/runs/r1/provenance.jso?", "touch .sdlc/runs/r1/backups/*",
      "echo x | tee .sdlc/runs/r1/skills/*.md",
    ].map(bashRedirect), "deny");
    await expectAll(dir, [
      "rm .sdlc/runs/r1/notes-*.md", "rm -f *.log", "rm -rf src/*", "rm -rf src/{a,b}.ts", 'rm -rf "$HOME/.cache/mmo-test"',
      "echo x > .sdlc/runs/r1/notes-?.md", "awk '$3>$4' src/a.ts", "rm -f /tmp/mmo-*.txt",
    ].map(bashRedirect), "allow");
    const r = await runHook(dir, bashRedirect("rm -r .sdlc/runs/r1/backup?"));
    assert.match(r.reason, /^\.sdlc\/runs\/r1\/backup\? would remove or move \.sdlc\/runs\/r1\/backups, which run r1 keeps while it is live/);
    const v = await runHook(dir, bashRedirect("d=.sdlc/runs/r1; rm -r $d/backups"));
    assert.match(v.reason, /cannot read before the shell expands it .* Write the path out in full and try again\.$/);
  } finally { cleanup(dir); }
});

test("a glob removal is judged only while a run is live; a patch header is a literal path, not a glob", async () => {
  const dir = makeFrozenRepo(["src/**", "app/**"]);
  try {
    await expectAll(dir, [applyPatchAdd("app/[slug]/page.tsx"), applyPatchAdd("src/*.ts")], "allow");
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    await expectAll(dir, ["rm .sdlc/runs/r1/*", "rm -rf $d/backups"].map(bashRedirect), "allow");
  } finally { cleanup(dir); }
  const plain = makeRepo(undefined);
  try {
    await expectAll(plain, ["rm -rf $X", "rm .sdlc/runs/*/provenance.json"].map(bashRedirect), "allow");
  } finally { cleanup(plain); }
});

test("live contract: a redirect to a device file is not a write outside the project", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [
      bashRedirect("ls 2>/dev/null"), bashRedirect("npm test > /dev/null 2>&1"), bashRedirect("echo x >/dev/stderr"),
      bashRedirect("echo x | tee /dev/tty"),
    ], "allow");
    await expectAll(dir, [bashRedirect("echo x > /tmp/elsewhere.txt"), bashRedirect("echo x > /dev/sda")], "deny");
  } finally { cleanup(dir); }
});

test("a removal of the lock is allowed once the run has ended", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    await expectAll(dir, [bashRedirect("rm .sdlc/runs/r1/write-contract.lock.json")], "allow");
  } finally { cleanup(dir); }
});

test("live contract: the always-off-limits list wins inside the run's folder", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [".sdlc/runs/r1/.env.local", ".sdlc/runs/r1/.git/config"], "deny");
  } finally { cleanup(dir); }
});

test("a contract with no run id, or one that is not a run id, gets no carve-out", async () => {
  for (const run_id of [undefined, "a/b", "../r1"]) {
    const dir = makeRepo({ schema_version: 1, active: true, strict: true, run_id, allowlist: ["src/**"], off_limits: [] });
    try {
      await expectAll(dir, [".sdlc/runs/r1/requirements.md", ".sdlc/runs/a/b/x.md"], "deny", `run_id ${run_id}: `);
    } finally { cleanup(dir); }
  }
});

// ── item 4: a contract binds only while its run is live ──

test("Gate 0 freeze, run, close-out: the todo's repro end to end", async () => {
  const dir = makeFrozenRepo(["src/**"], { runId: "20261013-080506-docs-a1b2c3" });
  const id = "20261013-080506-docs-a1b2c3";
  try {
    await expectAll(dir, [`.sdlc/runs/${id}/requirements.md`, "src/a.ts"], "allow", "live: ");
    await expectAll(dir, ["app/index.ts", ".sdlc/ledger.md"], "deny", "live: ");
    mkdirSync(join(dir, ".sdlc", "runs", id), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "runs", id, "gates.jsonl"), JSON.stringify({ gate: 4, decision: "approved" }) + "\n");
    const close = spawnSync(process.execPath, [WRITE_CONTRACT, "--close", `--run-id=${id}`, `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(close.status, 0, close.stderr);
    await expectAll(dir, [".sdlc/ledger.md", ".sdlc/ledger.json", "app/index.ts"], "allow", "closed: ");
    await expectAll(dir, [".env.local"], "deny", "closed: ");
  } finally { cleanup(dir); }
});

test("an active contract whose run's lock has ended binds nothing", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    const lock = JSON.parse(readFileSync(lockFile(dir, "r1"), "utf8"));
    writeFileSync(lockFile(dir, "r1"), JSON.stringify({ ...lock, ended_at: "2026-10-13T00:00:00.000Z", end_outcome: "interrupted" }));
    assert.equal(JSON.parse(readFileSync(contractFile(dir), "utf8")).active, true);
    await expectAll(dir, ["app/x.ts", ".sdlc/ledger.md"], "allow");
    await expectAll(dir, [".mcp.json"], "deny");
  } finally { cleanup(dir); }
});

// ── item 6: case, links, the hash, the root-only contract ──

test("case: off-limits and the always-off-limits list match in any case; the allowlist does not widen by case", async () => {
  const dir = makeFrozenRepo(["**"], { projectDefaults: [], offLimits: ["src/secrets/**"] });
  try {
    await expectAll(dir, [
      ".ENV", ".Env.Production", "SRC/.Env", ".GIT/hooks/pre-commit", ".Codex/Config.toml", "src/SECRETS/key.pem",
    ], "deny");
  } finally { cleanup(dir); }
  const narrow = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(narrow, ["SRC/a.ts"], "deny");
  } finally { cleanup(narrow); }
});

test("links: a write through a link is judged where it lands", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  const outside = mkdtempSync(join(tmpdir(), "write-contract-outside-"));
  try {
    mkdirSync(join(dir, "src", "real"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    symlinkSync(outside, join(dir, "src", "out"));
    symlinkSync(join(dir, ".git"), join(dir, "src", "gitlink"));
    symlinkSync(contractFile(dir), join(dir, "src", "contract-link.json"));
    symlinkSync(join(outside, "new.txt"), join(dir, "src", "dangling.txt"));
    symlinkSync(join(dir, "docs"), join(dir, "src", "d"));
    symlinkSync(join(dir, "src", "hop2"), join(dir, "src", "hop1"));
    symlinkSync(join(dir, "docs", "chain.md"), join(dir, "src", "hop2"));
    symlinkSync(join(dir, "src", "real", "new.ts"), join(dir, "src", "inside.ts"));
    await expectAll(dir, [
      "src/out/x.ts", "src/gitlink/hooks/pre-commit", "src/contract-link.json", "src/dangling.txt", "src/d/x.md", "src/hop1",
    ], "deny");
    const r = await runHook(dir, applyPatchAdd("src/out/x.ts"));
    assert.match(r.reason, /OUTSIDE the contract's repo root/);
    await expectAll(dir, ["src/inside.ts", "src/real/a.ts"], "allow");
  } finally { cleanup(dir); cleanup(outside); }
});

test("links: a `..` after a link applies where the link lands, not to the name as written", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  const outside = mkdtempSync(join(tmpdir(), "write-contract-outside-"));
  try {
    mkdirSync(join(outside, "deep"));
    mkdirSync(join(dir, "src", "real", "sub"), { recursive: true });
    symlinkSync(join(outside, "deep"), join(dir, "src", "l"));
    symlinkSync(join(dir, "src", "real", "sub"), join(dir, "src", "in"));
    for (const call of [applyPatchAdd("src/l/../evil.txt"), bashRedirect("echo hi > src/l/../evil.txt"), bashRedirect("touch src/l/../../evil.txt")]) {
      const r = await runHook(dir, call);
      assert.equal(r.decision, "deny", call.tool_input.command);
      assert.match(r.reason, /OUTSIDE the contract's repo root/);
    }
    await expectAll(dir, ["src/in/../x.ts", bashRedirect("echo hi > src/in/../x.ts")], "allow");
  } finally { cleanup(dir); cleanup(outside); }
});

test("links, no contract: a `..` after a link that lands in .git is refused", async () => {
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    mkdirSync(join(dir, "src"));
    symlinkSync(join(dir, ".git", "hooks"), join(dir, "src", "h"));
    await expectAll(dir, ["src/h/../config", bashRedirect("echo x > src/h/../config")], "deny");
    await expectAll(dir, ["src/../README.md"], "allow");
  } finally { cleanup(dir); }
});

test("links, no contract: a link into .git or onto an existing .env is refused", async () => {
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    symlinkSync(join(dir, ".env"), join(dir, "src", "env-link"));
    symlinkSync(join(dir, ".git"), join(dir, "src", "gitlink"));
    await expectAll(dir, ["src/env-link", "src/gitlink/config"], "deny");
  } finally { cleanup(dir); }
});

test("a project under a linked folder answers alike whether paths arrive linked or resolved", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    const real = realpathSync(dir);
    for (const [cwd, base] of [[dir, dir], [real, dir], [dir, real], [real, real]]) {
      const ok = await runHook(cwd, applyPatchAdd(join(base, "src", "a.ts")));
      assert.equal(ok.decision, "allow", `${cwd} / ${base}: ${ok.reason}`);
      const no = await runHook(cwd, applyPatchAdd(join(base, "docs", "x.md")));
      assert.equal(no.decision, "deny");
      assert.match(no.reason, /not in the confirmed allowlist/, `${cwd} / ${base}`);
    }
  } finally { cleanup(dir); }
});

test("hash: a contract changed after the freeze refuses every write, the run's own folder included", async () => {
  const tamper = {
    "rewritten (sed -i / node -e)": (dir) => writeFileSync(contractFile(dir), readFileSync(contractFile(dir), "utf8").replace('"src/**"', '"**"')),
    "deleted": (dir) => rmSync(contractFile(dir)),
    "switched off by hand": (dir) => {
      const c = JSON.parse(readFileSync(contractFile(dir), "utf8"));
      writeFileSync(contractFile(dir), JSON.stringify({ ...c, active: false }, null, 2) + "\n");
    },
    "renamed to another run": (dir) => {
      const c = JSON.parse(readFileSync(contractFile(dir), "utf8"));
      writeFileSync(contractFile(dir), JSON.stringify({ ...c, run_id: "r2", allowlist: ["**"] }, null, 2) + "\n");
    },
    "lock deleted": (dir) => rmSync(lockFile(dir, "r1")),
    "a second live lock": (dir) => {
      mkdirSync(join(dir, ".sdlc", "runs", "r0"), { recursive: true });
      writeFileSync(lockFile(dir, "r0"), readFileSync(lockFile(dir, "r1"), "utf8").replaceAll('"r1"', '"r0"'));
    },
  };
  for (const [what, change] of Object.entries(tamper)) {
    const dir = makeFrozenRepo(["src/**"]);
    try {
      change(dir);
      for (const path of ["src/a.ts", ".sdlc/runs/r1/requirements.md"]) {
        const r = await runHook(dir, applyPatchAdd(path));
        assert.equal(r.decision, "deny", `${what}: ${path}`);
        assert.match(r.reason, /changed after run|cannot be trusted|lock is gone/, what);
        assert.match(r.reason, /Stop and tell the person/, what);
        assert.doesNotMatch(r.reason, /strict|bypass|--abandon/, what);
      }
      const rows = decisions(dir);
      assert.equal(rows.at(-1)?.decision, "deny", `${what}: the refusal is recorded`);
      if (what !== "lock deleted" && what !== "a second live lock") {
        abandonRun({ projectRoot: dir, runId: "r1" });
        assert.equal((await runHook(dir, applyPatchAdd("app/x.ts"))).decision, "allow", `${what}: --abandon frees the project`);
      }
    } finally { cleanup(dir); }
  }
});

test("root-only: a contract below the git root, or above it, binds nothing", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    for (const nested of [{ active: false }, { active: true, allowlist: ["**"], off_limits: [] }, "not json {"]) {
      mkdirSync(join(dir, "pkg", ".sdlc", "local"), { recursive: true });
      writeFileSync(join(dir, "pkg", ".sdlc", "local", "write-contract.json"), typeof nested === "string" ? nested : JSON.stringify(nested));
      await expectAll(dir, ["pkg/index.ts"], "deny", `nested ${JSON.stringify(nested)}: `);
    }
  } finally { cleanup(dir); }

  const session = makeFrozenRepo(["src/**"]);
  try {
    mkdirSync(join(session, "vendor", "lib", ".git"), { recursive: true });
    await expectAll(session, ["vendor/lib/x.ts"], "deny", "nested .git: ");
  } finally { cleanup(session); }

  const loose = mkdtempSync(join(tmpdir(), "write-contract-nogit-"));
  try {
    mkdirSync(join(loose, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(loose, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, run_id: "x", allowlist: [], off_limits: [] }));
    await expectAll(loose, ["src/a.ts"], "allow", "non-git folder: ");
    await expectAll(loose, [".env.local"], "deny", "non-git folder: ");
    mkdirSync(join(loose, "inner", ".git"), { recursive: true });
    await expectAll(join(loose, "inner"), ["README.md"], "allow", "git project below a non-git contract: ");
  } finally { cleanup(loose); }
});

test("a named pipe at the contract or lock path never stalls the hook", async (t) => {
  const probe = spawnSync("mkfifo", ["--version"]);
  if (probe.error) return t.skip("mkfifo is not available");
  const dir = makeFrozenRepo(["src/**"]);
  try {
    rmSync(lockFile(dir, "r1"));
    assert.equal(spawnSync("mkfifo", [lockFile(dir, "r1")]).status, 0);
    const started = Date.now();
    const r = await runHook(dir, applyPatchAdd("src/a.ts"));
    assert.ok(Date.now() - started < 5000);
    assert.equal(r.decision, "deny", "the lock is no longer a readable file, so the frozen contract cannot be trusted");
  } finally { cleanup(dir); }
  const legacy = makeRepo(undefined);
  try {
    mkdirSync(join(legacy, ".sdlc", "local"), { recursive: true });
    assert.equal(spawnSync("mkfifo", [contractFile(legacy)]).status, 0);
    const r = await runHook(legacy, applyPatchAdd("src/a.ts"));
    assert.equal(r.decision, "allow");
  } finally { cleanup(legacy); }
});

test("no refusal names a flag or setting that switches the guard off", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    for (const path of ["docs/x.md", "node_modules/a.js", ".sdlc/local/write-contract.json", ".env.local"]) {
      const r = await runHook(dir, applyPatchAdd(path));
      assert.equal(r.decision, "deny", path);
      assert.doesNotMatch(r.reason, /strict\s*=\s*false|--strict-write|bypass/, path);
    }
  } finally { cleanup(dir); }
});

// ── item 7: the decision log in a guard that runs in every session ──

test("no contract: a call creates no .sdlc folder, allowed or refused", async () => {
  const repo = makeRepo(undefined);
  const plain = mkdtempSync(join(tmpdir(), "write-contract-plain-"));
  try {
    for (const dir of [repo, plain]) {
      await runHook(dir, bashRedirect("ls"));
      await runHook(dir, applyPatchAdd("src/a.ts"));
      assert.equal((await runHook(dir, applyPatchAdd(".env.local"))).decision, "deny");
      assert.ok(!existsSync(join(dir, ".sdlc")), `${dir}: no .sdlc may appear`);
    }
  } finally { cleanup(repo); cleanup(plain); }
});

test("no contract: a refusal is recorded only where .sdlc/ already exists, and an allow never is", async () => {
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, ".sdlc"));
    await runHook(dir, applyPatchAdd("src/a.ts"));
    await runHook(dir, bashRedirect("ls"));
    assert.deepEqual(decisions(dir), []);
    await runHook(dir, applyPatchAdd(".env.local"));
    const rows = decisions(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "deny");
    assert.equal(rows[0].wired_by, "plugin");
    assert.equal(rows[0].matched_rule, ".env.*");
  } finally { cleanup(dir); }
});

test("live contract: every call is recorded with the run id and who wired the hook", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await runHook(dir, bashRedirect("ls -la"));
    await runHook(dir, applyPatchAdd("src/a.ts"), ["--wired-by=run"]);
    await runHook(dir, applyPatchAdd("docs/x.md"));
    const rows = decisions(dir);
    assert.deepEqual(rows.map((r) => [r.decision, r.run_id, r.wired_by]), [
      ["allow", "r1", "plugin"], ["allow", "r1", "run"], ["deny", "r1", "plugin"],
    ]);
    assert.equal(rows[1].path, "src/a.ts");
    assert.equal(rows[2].tool_name, "apply_patch");
    for (const r of rows) assert.ok(r.ts >= JSON.parse(readFileSync(contractFile(dir), "utf8")).frozen_at);
  } finally { cleanup(dir); }
});

test("the liveness check passes once the hook has run for the live run, and only then", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    const cmd = `node '${WRITE_CONTRACT}' --assert-guard-live --project-root='${dir}'`;
    await runHook(dir, bashRedirect(cmd));
    const r = spawnSync(process.execPath, [WRITE_CONTRACT, "--assert-guard-live", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally { cleanup(dir); }
  const unguarded = makeFrozenRepo(["src/**"]);
  try {
    const r = spawnSync(process.execPath, [WRITE_CONTRACT, "--assert-guard-live", `--project-root=${unguarded}`], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /did not run in this session/);
    assert.equal(JSON.parse(readFileSync(contractFile(unguarded), "utf8")).active, false);
  } finally { cleanup(unguarded); }
});

test("Gate 0 as the skills give it: the freeze, then the guard check in a hooked call of its own, passes", async () => {
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, ".sdlc"));
    const freezeCmd = `node '${WRITE_CONTRACT}' --freeze --run-id=r1 --allowlist='["src/**"]' --project-root='${dir}'`;
    assert.equal((await runHook(dir, bashRedirect(freezeCmd))).decision, "allow");
    assert.deepEqual(decisions(dir), [], "no contract binds while the hook judges the freeze");
    const frozen = spawnSync("/bin/sh", ["-c", freezeCmd], { cwd: dir, encoding: "utf8" });
    assert.equal(frozen.status, 0, frozen.stderr);
    const checkCmd = frozen.stdout.split("\n").find((l) => l.includes("--assert-guard-live")).replace(/^.*?: (?=node )/, "");
    assert.equal((await runHook(dir, bashRedirect(checkCmd))).decision, "allow");
    const check = spawnSync("/bin/sh", ["-c", checkCmd], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /the write guard is live for run r1 \(wired by plugin\)/);
    assert.equal(JSON.parse(readFileSync(contractFile(dir), "utf8")).active, true);
  } finally { cleanup(dir); }
});

test("Gate 0 in one shell call: the hook judges it before the freeze, so the check finds no row and ends the run", async () => {
  const dir = makeRepo(undefined);
  try {
    mkdirSync(join(dir, ".sdlc"));
    const combined = `node '${WRITE_CONTRACT}' --freeze --run-id=r1 --allowlist='["src/**"]' --project-root='${dir}' && ` +
      `node '${WRITE_CONTRACT}' --assert-guard-live --run-id=r1 --project-root='${dir}'`;
    assert.equal((await runHook(dir, bashRedirect(combined))).decision, "allow");
    assert.deepEqual(decisions(dir), []);
    const r = spawnSync("/bin/sh", ["-c", combined], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /did not run in this session/);
    assert.equal(JSON.parse(readFileSync(lockFile(dir, "r1"), "utf8")).end_outcome, "refused");
    assert.equal(JSON.parse(readFileSync(contractFile(dir), "utf8")).active, false);
  } finally { cleanup(dir); }
});

// ── forms the shell scan reads ──

test("scan: tee writes every file it names, with -a or --append; an fd number before a redirect is no argument", () => {
  assert.deepEqual(extractBashTargets("echo x | tee -a a.txt b.txt"), ["a.txt", "b.txt"]);
  assert.deepEqual(extractBashTargets("echo x | tee --append c.txt | grep x"), ["c.txt"]);
  assert.deepEqual(extractBashTargets("cp src/a.ts src/b.ts 2>/dev/null"), ["src/b.ts"]);
  assert.deepEqual(extractBashTargets("touch a 2>&1"), ["a"]);
  assert.deepEqual(extractBashRemovals("mv a b 2>/dev/null"), ["a"]);
});

test("scan: a redirect with no space before it is read, and judged only by the always-off-limits list and the guarded set", () => {
  const call = (command) => ({ tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(extractNarrowTargets(call("echo hi>.env")), [".env"]);
  assert.deepEqual(extractNarrowTargets(call('echo "x">>.git/config')), [".git/config"]);
  assert.deepEqual(extractNarrowTargets(call("echo hi > .env")), [], "a spaced redirect is a full target already");
  assert.deepEqual(extractNarrowTargets(call("a=1 && b=2>&1")), []);
  assert.deepEqual(extractNarrowTargets(call("x=$(f)->y; z => w; ls 2>/dev/null")), []);
});

test("no contract: an unspaced redirect, tee --append and a .git pointer file are refused", async () => {
  const dir = makeRepo(undefined);
  try {
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    await expectAll(dir, [
      bashRedirect("echo hi>.env"), bashRedirect("echo hi>>.env.local"), bashRedirect("printf x>.mcp.json"),
      bashRedirect("echo x | tee --append .env.production"), bashRedirect("echo x | tee -a notes.txt .git/config"),
      bashRedirect("echo 'gitdir: /x' > .git"), bashRedirect("echo 'gitdir: /x'>pkg/.git"), ".git", "pkg/.GIT",
    ], "deny");
    await expectAll(dir, [
      bashRedirect("node -e 'if (1>0) process.exit(0)'"), bashRedirect("echo x>notes.txt"), ".gitignore", ".github/workflows/ci.yml",
    ], "allow");
  } finally { cleanup(dir); }
});

test("live contract: an unspaced redirect hits the guarded set and the always-off-limits list, never the allowlist", async () => {
  const dir = makeFrozenRepo(["src/**"]);
  try {
    await expectAll(dir, [
      bashRedirect("echo {}>.sdlc/local/write-contract.json"), bashRedirect("echo hi>.env"),
      bashRedirect("echo x | tee --append .sdlc/local/write-contract.json"),
      bashRedirect("echo x | tee -a src/a.ts docs/b.md"),
    ], "deny");
    await expectAll(dir, [
      bashRedirect("awk '$3>100' src/a.ts"), bashRedirect("node -e 'process.exit(a>0?0:1)'"),
      bashRedirect("echo x | tee --append src/a.ts"), bashRedirect("cp src/a.ts src/b.ts 2>/dev/null"),
    ], "allow");
    const rows = decisions(dir).filter((r) => r.decision === "allow");
    assert.ok(rows.every((r) => r.path === null || r.path.startsWith("src/")), JSON.stringify(rows));
  } finally { cleanup(dir); }
});

// ── a project root with a space in it ──

/** A folder named `name` inside a fresh temp folder, as a git project when `git` is set. */
function spacedProject(name, { git = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "write-contract-space-"));
  const dir = join(base, name);
  mkdirSync(git ? join(dir, ".git") : dir, { recursive: true });
  return { base, dir };
}

const escapeSpaces = (p) => p.replace(/ /g, "\\ ");

test("scan: a quoted or escaped word is one target with its spaces kept, and a newline or comment ends an argument list", () => {
  const P = "/w/My Project";
  const R = `${P}/.sdlc/runs/r1`;
  for (const form of [`'${R}/gates.jsonl'`, `"${R}/gates.jsonl"`, `${escapeSpaces(R)}/gates.jsonl`]) {
    assert.deepEqual(extractBashTargets(`printf '{}\\n' >> ${form}`), [`${R}/gates.jsonl`], form);
  }
  assert.deepEqual(extractBashTargets(`cp .env.test '${P}/src/.env'`), [`${P}/src/.env`]);
  assert.deepEqual(extractBashTargets(`echo x | tee -a '${P}/a b.txt' "${P}/c d.txt"`), [`${P}/a b.txt`, `${P}/c d.txt`]);
  assert.deepEqual(extractBashTargets(`sh -c "cp a '${P}/.env'"`), [`${P}/.env`], "a quoted string is read again as shell");
  assert.deepEqual(extractBashTargets("bash -c 'cp a b' && cp 'c d' e").sort(), ["b", "e"]);
  assert.deepEqual(
    extractBashTargets(`cat > '${P}/src/b.js' <<'EOF'\nconst s = "it's";\nEOF\nprintf x >> '${R}/gates.jsonl'`),
    [`${P}/src/b.js`, `${R}/gates.jsonl`],
    "a quote inside a here-document body does not reach the command after it",
  );
  assert.deepEqual(extractBashTargets("cp a b\nls -la"), ["b"]);
  assert.deepEqual(extractBashTargets("cp a b # don't\ncp c d"), ["b", "d"]);
  assert.deepEqual(extractBashRemovals(`rm -f '${R}/write-contract.lock.json'`), [`${R}/write-contract.lock.json`]);
  assert.deepEqual(extractBashRemovals(`mv "${P}/.sdlc/local/write-contract.json" /tmp/x`), [`${P}/.sdlc/local/write-contract.json`]);
});

test("live contract, root with a space: a quoted run-folder or allowlisted path is the run's own write, not a cross-project one", async () => {
  const { base, dir } = spacedProject("My Project");
  try {
    freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"], offLimits: [], strict: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.js"), "a\n");
    const R = join(dir, ".sdlc", "runs", "r1");
    await expectAll(dir, [
      `printf '{"gate":1,"decision":"approved"}\\n' >> '${R}/gates.jsonl'`,
      `printf '{"gate":1,"decision":"approved"}\\n' >> "${R}/gates.jsonl"`,
      `printf '{}\\n' >> ${escapeSpaces(R)}/gates.jsonl`,
      `cat > '${R}/state.json' <<'EOF'\n{"note": "the person's call"}\nEOF`,
      `echo '{}' | tee -a '${R}/gates.jsonl'`,
      `cat > '${dir}/src/b.js' <<'EOF'\nexport const b = 1;\nEOF`,
      `cp '${dir}/src/a.js' '${dir}/src/c.js'`,
    ].map(bashRedirect), "allow");
    assert.ok(decisions(dir).some((r) => r.decision === "allow" && r.path === ".sdlc/runs/r1/gates.jsonl"));
    await expectAll(dir, [
      `printf x > '${dir}/docs/x.md'`,
      `rm -f '${R}/write-contract.lock.json'`,
      `rm -f "${R}/write-contract.frozen.json"`,
      `mv '${dir}/.sdlc/local/write-contract.json' /tmp/x.json`,
      `printf x > '${base}/elsewhere.txt'`,
    ].map(bashRedirect), "deny");
    const r = await runHook(dir, bashRedirect(`printf x > '${dir}/docs/x.md'`));
    assert.match(r.reason, /^docs\/x\.md is not in the confirmed allowlist for run r1/);
    const lock = await runHook(dir, bashRedirect(`rm -f '${R}/write-contract.lock.json'`));
    assert.match(lock.reason, /would remove or move \.sdlc\/runs\/r1\/write-contract\.lock\.json/);
  } finally { cleanup(base); }
});

test("no contract, root with a space: Phase 7's env bootstrap creates a missing .env at its quoted path, and never overwrites one", async () => {
  for (const git of [true, false]) {
    const { base, dir } = spacedProject("My App", { git });
    try {
      mkdirSync(join(dir, ".sdlc"));
      const code = join(dir, "src");
      mkdirSync(code);
      writeFileSync(join(code, ".env.test"), "A=1\n");
      const bootstrap = (target) => `cd '${code}'\nif [ -f .env.test ] && [ ! -f .env ]; then cp .env.test ${target}; fi`;
      const forms = [`'${code}/.env'`, `"${code}/.env"`, `${escapeSpaces(code)}/.env`].map((t) => bashRedirect(bootstrap(t)));
      await expectAll(dir, forms, "allow", `git ${git}: `);
      writeFileSync(join(code, ".env"), "SECRET=1\n");
      await expectAll(dir, [...forms, bashRedirect(`echo X=1 > '${code}/.env'`)], "deny", `git ${git}, .env exists: `);
      const r = await runHook(dir, forms[0]);
      assert.match(r.reason, /My App\/src\/\.env matches always-off-limits pattern "\.env"/);
    } finally { cleanup(base); }
  }
});
