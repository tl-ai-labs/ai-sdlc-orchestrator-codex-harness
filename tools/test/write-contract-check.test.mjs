/**
 * Unit tests for plugin/codex/hooks/write-contract-check.mjs — the PreToolUse
 * hook that refuses off-limits or not-in-manifest writes during brownfield
 * runs, rebuilt for codex's payload shapes and reply protocol.
 *
 * Testing shape: subprocess-based, piping the codex hook payload shape on
 * stdin and asserting the JSON reply's permissionDecision — codex ignores a
 * bare exit code (verified live, docs/verification/p1-codex-runtime.md), so
 * unlike the source repo's Claude-side version of this test, decisions are
 * read from stdout JSON, not from the process exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "codex", "hooks", "write-contract-check.mjs");

/** Run the hook with the given tool call payload. Returns { decision, reason, stderr }. */
function runHook(cwd, payload) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn("node", [HOOK], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        resolvePromise({
          decision: parsed.hookSpecificOutput?.permissionDecision,
          reason: parsed.hookSpecificOutput?.permissionDecisionReason,
          stderr,
        });
      } catch (e) {
        reject(new Error(`hook did not reply with valid JSON: ${stdout}\nstderr: ${stderr}\n${e}`));
      }
    });
    p.stdin.end(JSON.stringify({ cwd, ...payload }));
  });
}

function makeRepo(contract) {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  if (contract !== undefined) {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return dir;
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

test("strict=false downgrades an off_limits hit to allow", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: false,
    allowlist: [], off_limits: [".env*"],
  });
  try {
    const r = await runHook(dir, applyPatchAdd(".env"));
    assert.equal(r.decision, "allow");
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

test("Bash: cp into a directory (trailing slash) is not treated as a specific file target", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, bashRedirect("cp file.txt some-dir/"));
    assert.equal(r.decision, "allow", "directory-destination form is intentionally not resolved to a file target here");
  } finally { cleanup(dir); }
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

test("pre-contract safety net: still refuses the enforcement state under .sdlc/local/", async () => {
  // Narrowing the pattern must not open the guard's own footing: the write
  // contract and the decision log stay tamper-proof.
  const dir = makeRepo(undefined);
  try {
    for (const path of [".sdlc/local/write-contract.json", ".sdlc/local/guard-decisions.jsonl"]) {
      const r = await runHook(dir, applyPatchAdd(path));
      assert.equal(r.decision, "deny", `${path} is enforcement state and must stay protected`);
    }
  } finally { cleanup(dir); }
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
