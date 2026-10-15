/**
 * Provenance through the write hook and write-contract.mjs: the freeze opens the record, the hook snapshots each file
 * before an allowed write, and the end of the run closes the record with git status reconciled. The hook runs as a
 * subprocess on Codex's payload shape, in throwaway git repos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertGuardLive, endRun, freezeContract, reopenRun } from "../../plugin/scripts/write-contract.mjs";
import { finalizeProvenance, initProvenance, provenancePath, revertPlan } from "../../plugin/scripts/write-provenance.mjs";
import { decideCall, shellPatchTargets } from "../../plugin/scripts/lib/write-guard.mjs";

// The person's git config (hooks, autocrlf, signing) stays out of every git call these tests and the hook make.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOK = join(REPO, "plugin", "codex", "hooks", "write-contract-check.mjs");
const CONTRACT_CLI = join(REPO, "plugin", "scripts", "write-contract.mjs");
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

const git = (dir, ...args) => {
  const r = spawnSync("git", [...GIT_ID, "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

/** A git repo with `committed` in its first commit. */
function gitRepo(committed) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "prov-hook-")));
  git(dir, "init", "-q");
  for (const [rel, text] of Object.entries(committed)) put(dir, rel, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}
const freeze = (dir, opts = {}) => freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"], ...opts });

function runHook(cwd, payload) {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [HOOK], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", () => {
      try { done({ decision: out === "" ? "allow" : JSON.parse(out).hookSpecificOutput.permissionDecision, stderr: err }); }
      catch (e) { fail(new Error(`neither an empty allow nor a JSON deny: ${out}\n${err}\n${e}`)); }
    });
    p.stdin.end(JSON.stringify({ cwd, ...payload }));
  });
}
const patch = (...lines) => ({ tool_name: "apply_patch", tool_input: { command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") } });
const update = (path) => patch(`*** Update File: ${path}`, "@@", "-x", "+y");
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

/** Asks the hook first, and writes only when it allows, as Codex does. */
async function write(dir, path, text, payload = update(path)) {
  const r = await runHook(dir, payload);
  if (r.decision === "allow") put(dir, path, text);
  return r;
}
const provFile = (dir) => provenancePath(dir, "r1");
const records = (dir) => (existsSync(provFile(dir)) ? JSON.parse(readFileSync(provFile(dir), "utf8")).files_touched : []);
const decisions = (dir) => readFileSync(join(dir, ".sdlc", "local", "guard-decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// ── the freeze and the end of the run ─────────────────────────────────────

test("the freeze opens the run's provenance record, with HEAD and the start-of-run work hashed", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    put(dir, "src/a.ts", "wip\n");
    const r = freeze(dir, { intent: "bugfix" });
    assert.deepEqual([r.provenance.files_touched, r.provenance.finalized], [0, false]);
    const p = JSON.parse(readFileSync(provFile(dir), "utf8"));
    assert.equal(p.intent, "bugfix");
    assert.equal(p.opened_by, "init");
    assert.equal(p.git_head_before, git(dir, "rev-parse", "HEAD").trim());
    assert.deepEqual(Object.keys(p.dirty_at_start), ["src/a.ts"]);
  } finally { cleanup(dir); }
});

test("--freeze takes --intent and refuses a malformed one", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    const bad = spawnSync(process.execPath, [CONTRACT_CLI, "--freeze", "--run-id=r1", '--allowlist=["src/**"]', "--intent=Bug Fix", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--intent/);
    const ok = spawnSync(process.execPath, [CONTRACT_CLI, "--freeze", "--run-id=r1", '--allowlist=["src/**"]', "--intent=docs", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(provFile(dir), "utf8")).intent, "docs");
  } finally { cleanup(dir); }
});

test("a provenance failure at the freeze warns and still freezes", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    mkdirSync(provFile(dir), { recursive: true });
    const r = spawnSync(process.execPath, [CONTRACT_CLI, "--freeze", "--run-id=r1", '--allowlist=["src/**"]', `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARN: provenance record \.sdlc\/runs\/r1\/provenance\.json: .*less to restore/);
    assert.match(r.stdout, /frozen for run r1/);
  } finally { cleanup(dir); }
});

test("a freeze over a closed record of the same run id warns that nothing will be snapshotted", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    initProvenance({ root: dir, runId: "r1" });
    finalizeProvenance({ root: dir, runId: "r1" });
    const r = spawnSync(process.execPath, [CONTRACT_CLI, "--freeze", "--run-id=r1", '--allowlist=["src/**"]', `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /a closed record for run r1 is already there/);
  } finally { cleanup(dir); }
});

test("closing a run that changed nothing says so", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    freeze(dir);
    const r = spawnSync(process.execPath, [CONTRACT_CLI, "--abandon", "--run-id=r1", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /the run changed no files \(\.sdlc\/runs\/r1\/provenance\.json\)/);
  } finally { cleanup(dir); }
});

test("closing the run finalizes the record and catches a shell edit the hook missed", async () => {
  const dir = gitRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
  try {
    freeze(dir);
    await write(dir, "src/a.ts", "patched\n");
    put(dir, "src/b.ts", "sed -i edit\n");
    appendFileSync(join(dir, ".sdlc", "runs", "r1", "gates.jsonl"), JSON.stringify({ gate: 4, decision: "approved" }) + "\n");
    const r = spawnSync(process.execPath, [CONTRACT_CLI, "--close", "--run-id=r1", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 file\(s\) recorded in \.sdlc\/runs\/r1\/provenance\.json; undo the run with \$mmo-codex:revert r1/);
    assert.match(r.stderr, /WARN: 1 file\(s\) changed by writes the hook did not see/);
    const p = JSON.parse(readFileSync(provFile(dir), "utf8"));
    assert.ok(p.finalized_at);
    const by = Object.fromEntries(p.files_touched.map((f) => [f.path, f.recorded_by]));
    assert.deepEqual(by, { "src/a.ts": "hook", "src/b.ts": "finalize" });
  } finally { cleanup(dir); }
});

test("abandon and a headless endRun finalize too; reopenRun reopens the record", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    freeze(dir);
    const ended = endRun({ projectRoot: dir, runId: "r1", outcome: "interrupted" });
    assert.equal(ended.provenance.finalized, true);
    const reopened = reopenRun({ projectRoot: dir, runId: "r1" });
    assert.equal(reopened.provenance.finalized, false);
    const p = JSON.parse(readFileSync(provFile(dir), "utf8"));
    assert.equal(p.finalized_at, null);
    assert.equal(p.reopened.length, 1);
    const r = spawnSync(process.execPath, [CONTRACT_CLI, "--abandon", "--run-id=r1", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(readFileSync(provFile(dir), "utf8")).finalized_at);
  } finally { cleanup(dir); }
});

test("ending a run that already ended does not re-close its record", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    freeze(dir);
    endRun({ projectRoot: dir, runId: "r1", outcome: "stopped" });
    const closedAt = JSON.parse(readFileSync(provFile(dir), "utf8")).finalized_at;
    put(dir, "src/a.ts", "hand edit after the run\n");
    const again = endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    assert.equal(again.provenance, undefined);
    const p = JSON.parse(readFileSync(provFile(dir), "utf8"));
    assert.equal(p.finalized_at, closedAt);
    assert.equal(p.files_touched.length, 0, "an edit after the run is not the run's");
  } finally { cleanup(dir); }
});

test("a guard check that finds no hook record ends the run and closes its provenance record", () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    freeze(dir);
    put(dir, "src/a.ts", "written with no hook running\n");
    const r = assertGuardLive({ projectRoot: dir, runId: "r1" });
    assert.equal(r.live, false);
    const p = JSON.parse(readFileSync(provFile(dir), "utf8"));
    assert.ok(p.finalized_at, "the refused run's record is closed");
    assert.deepEqual(p.files_touched.map((f) => [f.path, f.recorded_by]), [["src/a.ts", "finalize"]]);
  } finally { cleanup(dir); }
});

// ── the hook takes the snapshots ──────────────────────────────────────────

test("an allowed patch is snapshotted before it lands, and a second patch keeps the first snapshot", async () => {
  const dir = gitRepo({ "src/a.ts": "committed\n" });
  try {
    put(dir, "src/a.ts", "uncommitted work\n");
    freeze(dir);
    assert.equal((await write(dir, "src/a.ts", "attempt 1\n")).decision, "allow");
    assert.equal((await write(dir, "src/a.ts", "attempt 2\n")).decision, "allow");
    const recs = records(dir);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].recorded_by, "hook");
    assert.equal(read(dir, recs[0].backup_path), "uncommitted work\n", "the backup is the pre-run content");
    const allows = decisions(dir).filter((d) => d.decision === "allow" && d.path === "src/a.ts");
    assert.deepEqual(allows.map((d) => d.snapshots), [1, 1]);
  } finally { cleanup(dir); }
});

test("a moved file records both paths, and shell writes and removals are snapshotted", async () => {
  const dir = gitRepo({ "src/old.ts": "old\n", "src/c.ts": "c\n" });
  try {
    put(dir, "src/scratch.ts", "untracked scratch\n");
    freeze(dir);
    assert.equal((await runHook(dir, patch("*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", "-old", "+new"))).decision, "allow");
    assert.equal((await runHook(dir, bash("printf x > src/c.ts"))).decision, "allow");
    assert.equal((await runHook(dir, bash("rm src/scratch.ts"))).decision, "allow");
    const by = Object.fromEntries(records(dir).map((r) => [r.path, r]));
    assert.deepEqual(Object.keys(by).sort(), ["src/c.ts", "src/new.ts", "src/old.ts", "src/scratch.ts"]);
    assert.equal(by["src/new.ts"].existed_before, false);
    assert.equal(read(dir, by["src/scratch.ts"].backup_path), "untracked scratch\n", "an untracked file a shell rm removes is backed up");
  } finally { cleanup(dir); }
});

test("nothing is recorded for a denied write, with no contract, or for a shell target that is not a literal path", async () => {
  const dir = gitRepo({ "src/a.ts": "a\n", "docs/x.md": "x\n" });
  try {
    assert.equal((await runHook(dir, update("src/a.ts"))).decision, "allow");
    assert.ok(!existsSync(join(dir, ".sdlc")), "greenfield: no contract, no record, no .sdlc");
    freeze(dir);
    assert.equal((await runHook(dir, update("docs/x.md"))).decision, "deny");
    assert.equal((await runHook(dir, bash('cat a > "$OUT"'))).decision, "deny");
    assert.equal((await runHook(dir, bash("rm src/*.tmp"))).decision, "allow");
    assert.deepEqual(records(dir), []);
  } finally { cleanup(dir); }
});

const shellPatch = (path) => bash(`apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: ${path}\n@@\n-x\n+y\n*** End Patch\nEOF`);
const applyClean = (plan) => { for (const f of plan.files) if (f.command && !f.conflict) execFileSync("/bin/sh", ["-c", f.command]); };

test("a shell apply_patch to a route file with [ or $ in its name is snapshotted, and revert restores its work", async () => {
  const dir = gitRepo({ "app/[slug]/page.tsx": "committed\n", "app/posts.$id.tsx": "committed\n" });
  try {
    for (const p of ["app/[slug]/page.tsx", "app/posts.$id.tsx"]) put(dir, p, `uncommitted ${p}\n`);
    freeze(dir, { allowlist: ["app/**"] });
    assert.deepEqual(shellPatchTargets(shellPatch("app/[slug]/page.tsx").tool_input.command), ["app/[slug]/page.tsx"]);
    assert.deepEqual(shellPatchTargets("cat <<'EOF'\n*** Update File: x.ts\nEOF"), [], "header text outside a shell apply_patch is not a target");
    for (const p of ["app/[slug]/page.tsx", "app/posts.$id.tsx"]) assert.equal((await write(dir, p, "run edit\n", shellPatch(p))).decision, "allow");
    assert.deepEqual(records(dir).map((r) => [r.path, !!r.backup_path]), [["app/[slug]/page.tsx", true], ["app/posts.$id.tsx", true]]);
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    applyClean(revertPlan({ root: dir, runId: "r1" }));
    for (const p of ["app/[slug]/page.tsx", "app/posts.$id.tsx"]) assert.equal(read(dir, p), `uncommitted ${p}\n`);
  } finally { cleanup(dir); }
});

test("a redirect with no space before > snapshots a file holding uncommitted work and leaves a clean one to close-out", async () => {
  const dir = gitRepo({ "src/a.ts": "committed\n", "src/clean.ts": "clean\n" });
  try {
    put(dir, "src/a.ts", "uncommitted work\n");
    freeze(dir);
    const out = decideCall({ cwd: dir, ...bash("printf x>src/a.ts") });
    assert.deepEqual([out.decision, out.bound.length, out.unsure.map((b) => b.target)], ["allow", 0, ["src/a.ts"]]);
    for (const command of ["printf x>src/a.ts", "printf x>src/clean.ts"]) {
      assert.equal((await runHook(dir, bash(command))).decision, "allow");
      execFileSync("/bin/sh", ["-c", command], { cwd: dir });
    }
    assert.deepEqual(records(dir).map((r) => r.path), ["src/a.ts"]);
    assert.equal(read(dir, records(dir)[0].backup_path), "uncommitted work\n");
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    const plan = revertPlan({ root: dir, runId: "r1" });
    assert.deepEqual(plan.files.map((f) => [f.path, f.action, f.recorded_by]), [["src/a.ts", "restore-backup", "hook"], ["src/clean.ts", "git-checkout", "finalize"]]);
    applyClean(plan);
    assert.equal(read(dir, "src/a.ts"), "uncommitted work\n");
  } finally { cleanup(dir); }
});

test("rm -r of a folder snapshots the work inside it, and revert brings the folder back", async () => {
  const dir = gitRepo({ "src/old/keep.ts": "keep\n", "src/a.ts": "a\n" });
  try {
    put(dir, "src/old/notes.md", "untracked notes\n");
    freeze(dir);
    assert.equal((await runHook(dir, bash("rm -r src/old"))).decision, "allow");
    execFileSync("/bin/sh", ["-c", "rm -r src/old"], { cwd: dir });
    assert.deepEqual(records(dir).map((r) => r.path).sort(), ["src/old/keep.ts", "src/old/notes.md"]);
    assert.equal(decisions(dir).at(-1).snapshots, 2);
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    const plan = revertPlan({ root: dir, runId: "r1" });
    assert.ok(plan.files.every((f) => f.conflict === null), JSON.stringify(plan.files));
    applyClean(plan);
    assert.equal(read(dir, "src/old/keep.ts"), "keep\n");
    assert.equal(read(dir, "src/old/notes.md"), "untracked notes\n");
  } finally { cleanup(dir); }
});

test("a copy into a folder snapshots each file it overwrites, and revert puts their work back", async () => {
  const dir = gitRepo({ "src/a.ts": "a\n", "src/lib/b.ts": "b\n" });
  const src = mkdtempSync(join(tmpdir(), "prov-cp-src-"));
  try {
    put(dir, "src/a.ts", "uncommitted a\n");
    put(dir, "src/lib/b.ts", "uncommitted b\n");
    put(src, "a.ts", "template a\n");
    freeze(dir);
    assert.equal((await runHook(dir, bash(`cp ${src}/a.ts src/`))).decision, "allow");
    execFileSync("/bin/sh", ["-c", `cp ${src}/a.ts src/`], { cwd: dir });
    assert.deepEqual(records(dir).map((r) => r.path), ["src/a.ts"], "the file cp lands on, not the folder it names");
    assert.equal((await runHook(dir, bash('cp -R "$TPL"/. src/lib/'))).decision, "allow");
    assert.deepEqual(records(dir).map((r) => r.path).sort(), ["src/a.ts", "src/lib/b.ts"], "an unlisted folder copy snapshots what is there");
    put(dir, "src/lib/b.ts", "template b\n");
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    applyClean(revertPlan({ root: dir, runId: "r1" }));
    assert.equal(read(dir, "src/a.ts"), "uncommitted a\n");
    assert.equal(read(dir, "src/lib/b.ts"), "uncommitted b\n");
  } finally { cleanup(dir); cleanup(src); }
});

test("a write strict:false allows outside the allowlist is recorded; a run-folder write is not", async () => {
  const dir = gitRepo({ "src/a.ts": "a\n", "docs/x.md": "x\n" });
  try {
    freeze(dir, { strict: false });
    assert.equal((await write(dir, "docs/x.md", "y\n")).decision, "allow");
    assert.equal((await runHook(dir, patch("*** Add File: .sdlc/runs/r1/notes.md", "+n"))).decision, "allow");
    assert.deepEqual(records(dir).map((r) => r.path), ["docs/x.md"]);
  } finally { cleanup(dir); }
});

test("a closed record takes no snapshot even while a contract still binds", async () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "r1", allowlist: ["src/**"], off_limits: [] }));
    initProvenance({ root: dir, runId: "r1" });
    finalizeProvenance({ root: dir, runId: "r1" });
    assert.equal((await runHook(dir, update("src/a.ts"))).decision, "allow");
    assert.deepEqual(records(dir), []);
  } finally { cleanup(dir); }
});

test("a snapshot that fails still lets the write through, and says so", async () => {
  const dir = gitRepo({ "src/a.ts": "a\n" });
  try {
    freeze(dir);
    rmSync(provFile(dir));
    mkdirSync(provFile(dir));
    const r = await runHook(dir, update("src/a.ts"));
    assert.equal(r.decision, "allow");
    assert.match(r.stderr, /WARN: no provenance snapshot of src\/a\.ts/);
    assert.equal(decisions(dir).at(-1).snapshots, 0);
  } finally { cleanup(dir); }
});

test("hook snapshots across repeated writes, then revert, give back the pre-run bytes", async () => {
  const dir = gitRepo({ "src/a.ts": "a original\n", "src/b.ts": "b committed\n" });
  try {
    put(dir, "src/b.ts", "b uncommitted\n");
    freeze(dir);
    for (const n of [1, 2]) {
      await write(dir, "src/a.ts", `a attempt ${n}\n`);
      await write(dir, "src/b.ts", `b attempt ${n}\n`);
      await write(dir, "src/new.ts", `new ${n}\n`, patch("*** Add File: src/new.ts", `+new ${n}`));
    }
    endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    for (const f of revertPlan({ root: dir, runId: "r1" }).files) if (f.command) execFileSync("/bin/sh", ["-c", f.command]);
    assert.equal(read(dir, "src/a.ts"), "a original\n");
    assert.equal(read(dir, "src/b.ts"), "b uncommitted\n");
    assert.ok(!existsSync(join(dir, "src/new.ts")));
  } finally { cleanup(dir); }
});
