/**
 * plugin/scripts/write-provenance.mjs: the run's record of what it changed, the first-snapshot rule, the close-out
 * reconciliation against git status, and the revert plan built from it. Every case runs in a throwaway git repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  backupName, finalizeProvenance, FOLDER_SNAPSHOT_CAP, initProvenance, PATH_CAP, provenancePath, recordAfter,
  recordBefore, recordFolderBefore, revertPlan, ProvenanceRefusal,
} from "../../plugin/scripts/write-provenance.mjs";
import { endRun, freezeContract } from "../../plugin/scripts/write-contract.mjs";

// The person's git config (hooks, autocrlf, signing) stays out of every git call these tests and the code under test make.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = join(REPO, "plugin", "scripts", "write-provenance.mjs");
const SKILLS = join(REPO, "plugin", "skills");
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

const git = (dir, ...args) => {
  const r = spawnSync("git", [...GIT_ID, "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");

/** A git repo holding `committed` in its first commit. */
function gitRepo(committed = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "prov-")));
  git(dir, "init", "-q");
  for (const [rel, text] of Object.entries(committed)) put(dir, rel, text);
  if (Object.keys(committed).length) { git(dir, "add", "-A"); git(dir, "commit", "-qm", "base"); }
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const prov = (dir, id = "r1") => JSON.parse(readFileSync(provenancePath(dir, id), "utf8"));
const rec = (dir, path, id = "r1") => prov(dir, id).files_touched.filter((r) => r.path === path);
const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--run-id=r1", `--project-root=${dir}`], { cwd: dir, encoding: "utf8" });
/** Runs every command of a revert plan from the project root, as the revert skill does after the person confirms. */
const applyPlan = (plan) => { for (const f of plan.files) if (f.command) execFileSync("/bin/sh", ["-c", f.command]); };

// ── the first snapshot stands ─────────────────────────────────────────────

test("a second write in the same run keeps the first backup and sha_before, and records the final sha_after", () => {
  const root = gitRepo();
  try {
    writeFileSync(join(root, "a.ts"), "original\n");
    cli(root, "--init");
    cli(root, "--before", "--path=a.ts", "--packet-id=p1");
    writeFileSync(join(root, "a.ts"), "attempt 1\n");
    cli(root, "--after", "--path=a.ts", "--packet-id=p1");
    cli(root, "--before", "--path=a.ts", "--packet-id=p1");
    writeFileSync(join(root, "a.ts"), "attempt 2\n");
    cli(root, "--after", "--path=a.ts", "--packet-id=p1");

    const recs = rec(root, "a.ts");
    assert.equal(recs.length, 1, "one record per path per run");
    assert.equal(readFileSync(join(root, recs[0].backup_path), "utf8"), "original\n", "backup is the original");
    assert.notEqual(recs[0].sha_after, null);
    assert.notEqual(recs[0].sha_after, recs[0].sha_before);
  } finally { cleanup(root); }
});

test("each kind of file gets the record revert needs: clean, uncommitted, untracked, new", () => {
  const root = gitRepo({ "src/clean.ts": "clean\n", "src/dirty.ts": "committed\n" });
  try {
    put(root, "src/dirty.ts", "uncommitted work\n");
    put(root, "notes.txt", "untracked\n");
    initProvenance({ root, runId: "r1" });
    for (const p of ["src/clean.ts", "src/dirty.ts", "notes.txt", "src/new.ts"]) recordBefore({ root, runId: "r1", path: p, by: "hook" });

    const [clean] = rec(root, "src/clean.ts");
    assert.deepEqual([clean.existed_before, clean.tracked_in_git, clean.dirty_before, clean.backup_path], [true, true, false, null]);
    const [dirty] = rec(root, "src/dirty.ts");
    assert.deepEqual([dirty.existed_before, dirty.tracked_in_git, dirty.dirty_before], [true, true, true]);
    assert.equal(read(root, dirty.backup_path), "uncommitted work\n", "the backup holds the uncommitted content");
    assert.notEqual(dirty.sha_before, null, "an uncommitted file is told apart by dirty_before and its backup, not sha_before:null");
    const [untracked] = rec(root, "notes.txt");
    assert.deepEqual([untracked.tracked_in_git, untracked.dirty_before], [false, true]);
    assert.equal(read(root, untracked.backup_path), "untracked\n");
    const [created] = rec(root, "src/new.ts");
    assert.deepEqual([created.existed_before, created.sha_before, created.backup_path], [false, null, null]);
    assert.ok(prov(root).files_touched.every((r) => r.recorded_by === "hook"));
  } finally { cleanup(root); }
});

test("a file uncommitted at the run's start is hashed at init, not backed up", () => {
  const root = gitRepo({ "a.ts": "committed\n" });
  try {
    put(root, "a.ts", "work in progress\n");
    put(root, "scratch.md", "draft\n");
    const p = initProvenance({ root, runId: "r1" });
    assert.deepEqual(Object.keys(p.dirty_at_start).sort(), ["a.ts", "scratch.md"]);
    assert.match(p.dirty_at_start["a.ts"], /^sha256:[0-9a-f]{64}$/);
    assert.equal(p.files_touched.length, 0);
    assert.ok(!existsSync(join(root, ".sdlc", "runs", "r1", "backups")), "init copies nothing");
    assert.equal(p.git_head_before, git(root, "rev-parse", "HEAD").trim());
  } finally { cleanup(root); }
});

test("a clean file changed before its first snapshot by a write the hook did not see is put back from git", () => {
  const root = gitRepo({ "a.ts": "original\n" });
  try {
    initProvenance({ root, runId: "r1" });
    put(root, "a.ts", "sed -i edit\n");
    recordBefore({ root, runId: "r1", path: "a.ts", by: "hook" });
    put(root, "a.ts", "patched\n");
    finalizeProvenance({ root, runId: "r1" });
    const [r] = rec(root, "a.ts");
    assert.deepEqual([r.dirty_before, r.backup_path], [false, null]);
    assert.ok(prov(root).unrecorded_changes.some((u) => u.path === "a.ts"), "the unseen write is reported");
    applyPlan(revertPlan({ root, runId: "r1" }));
    assert.equal(read(root, "a.ts"), "original\n");
  } finally { cleanup(root); }
});

// ── close-out ─────────────────────────────────────────────────────────────

test("finalize fills each open sha_after from disk, stamps the end, and a second finalize changes nothing", () => {
  const root = gitRepo({ "a.ts": "a\n", "b.ts": "b\n" });
  try {
    initProvenance({ root, runId: "r1" });
    recordBefore({ root, runId: "r1", path: "a.ts", by: "hook" });
    recordBefore({ root, runId: "r1", path: "b.ts", by: "hook" });
    put(root, "a.ts", "a2\n");
    unlinkSync(join(root, "b.ts"));
    git(root, "add", "a.ts");
    git(root, "commit", "-qm", "run commit");
    const first = finalizeProvenance({ root, runId: "r1", now: new Date("2026-10-13T10:00:00Z") });
    assert.equal(first.finalized_at, "2026-10-13T10:00:00.000Z");
    assert.equal(first.git_head_after, git(root, "rev-parse", "HEAD").trim());
    assert.equal(first.commits.length, 1);
    const [a] = rec(root, "a.ts");
    assert.match(a.sha_after, /^sha256:/);
    assert.equal(a.written_at, "2026-10-13T10:00:00.000Z");
    assert.equal(rec(root, "b.ts")[0].sha_after, null, "a deleted file ends with no hash");

    put(root, "a.ts", "edited after the run\n");
    const again = finalizeProvenance({ root, runId: "r1" });
    assert.equal(again.finalized_at, first.finalized_at);
    assert.equal(rec(root, "a.ts")[0].sha_after, a.sha_after, "a closed record is not rewritten");
  } finally { cleanup(root); }
});

test("a closed record takes no snapshot; reopening it keeps the first snapshots and reopens their end state", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    initProvenance({ root, runId: "r1" });
    recordBefore({ root, runId: "r1", path: "a.ts", by: "hook" });
    put(root, "a.ts", "a2\n");
    finalizeProvenance({ root, runId: "r1" });
    assert.equal(recordBefore({ root, runId: "r1", path: "c.ts", by: "hook" }), null);
    assert.equal(rec(root, "c.ts").length, 0);

    const before = rec(root, "a.ts")[0];
    const p = initProvenance({ root, runId: "r1", reopen: true });
    assert.equal(p.finalized_at, null);
    assert.equal(p.reopened.length, 1);
    const [a] = rec(root, "a.ts");
    assert.equal(a.sha_before, before.sha_before);
    assert.equal(a.sha_after, null, "the resumed run's end state is read again at its close");
    assert.ok(recordBefore({ root, runId: "r1", path: "c.ts", by: "hook" }));
  } finally { cleanup(root); }
});

test("finalize reconciles git status: writes the hook did not see are recorded, start-of-run work is left alone", () => {
  const root = gitRepo({ "src/clean.ts": "clean\n", "src/gone.ts": "gone\n", "src/wip.ts": "base\n", "src/kept.ts": "base\n", "package-lock.json": "{}\n" });
  try {
    put(root, "src/wip.ts", "wip at start\n");
    put(root, "src/kept.ts", "kept at start\n");
    // A second back, so a file made just after init is newer even where the disk clock ticks coarsely.
    initProvenance({ root, runId: "r1", now: new Date(Date.now() - 1000) });
    put(root, "src/clean.ts", "changed by sed\n");
    put(root, "package-lock.json", '{"lockfileVersion":3}\n');
    unlinkSync(join(root, "src/gone.ts"));
    put(root, "src/fresh.ts", "made by a script\n");
    put(root, "src/wip.ts", "wip changed by the run\n");
    const p = finalizeProvenance({ root, runId: "r1" });

    const byPath = Object.fromEntries(p.files_touched.map((r) => [r.path, r]));
    for (const path of ["src/clean.ts", "package-lock.json"]) {
      assert.deepEqual([byPath[path].recorded_by, byPath[path].existed_before, byPath[path].backup_path], ["finalize", true, null], path);
    }
    assert.deepEqual([byPath["src/gone.ts"].existed_before, byPath["src/gone.ts"].sha_after], [true, null]);
    assert.deepEqual([byPath["src/fresh.ts"].existed_before, byPath["src/fresh.ts"].sha_before], [false, null]);
    assert.ok(!byPath["src/wip.ts"] && !byPath["src/kept.ts"], "files uncommitted at the start get no record");
    assert.deepEqual(p.unrecorded_changes.map((u) => u.path), ["src/wip.ts"], "start-of-run work the run changed is reported, not claimed");

    const plan = revertPlan({ root, runId: "r1" });
    assert.equal(plan.files.find((f) => f.path === "src/fresh.ts").action, "delete");
    for (const f of plan.files) {
      assert.match(f.conflict, /^close-out found it in git status/, `${f.path}: a change the hook never saw is undone only on the person's choice`);
      assert.doesNotMatch(f.conflict, /allowlist/, `${f.path}: with no frozen contract there is no allowlist to name`);
    }
    applyPlan(plan);
    assert.equal(read(root, "src/clean.ts"), "clean\n");
    assert.equal(read(root, "package-lock.json"), "{}\n");
    assert.equal(read(root, "src/gone.ts"), "gone\n");
    assert.ok(!existsSync(join(root, "src/fresh.ts")));
    assert.equal(read(root, "src/kept.ts"), "kept at start\n");
  } finally { cleanup(root); }
});

// ── revert ────────────────────────────────────────────────────────────────

test("revert puts back the pre-run bytes after repeated writes, a shell edit and a delete", () => {
  const root = gitRepo({ "src/a.ts": "a original\n", "src/b.ts": "b original\n", "src/c.ts": "c original\n" });
  try {
    put(root, "src/b.ts", "b uncommitted\n");
    put(root, "todo.md", "untracked\n");
    const statusBefore = git(root, "status", "--porcelain");
    initProvenance({ root, runId: "r1" });
    for (const attempt of [1, 2, 3]) {
      for (const p of ["src/a.ts", "src/b.ts", "todo.md", "src/new.ts"]) {
        recordBefore({ root, runId: "r1", path: p, by: "hook" });
        put(root, p, `attempt ${attempt}\n`);
      }
    }
    put(root, "src/c.ts", "shell edit\n");
    finalizeProvenance({ root, runId: "r1" });
    const plan = revertPlan({ root, runId: "r1" });
    assert.ok(plan.finalized);
    assert.deepEqual(Object.fromEntries(plan.files.map((f) => [f.path, f.action])), {
      "src/a.ts": "git-checkout", "src/b.ts": "restore-backup", "todo.md": "restore-backup", "src/new.ts": "delete", "src/c.ts": "git-checkout",
    });
    assert.ok(plan.files.filter((f) => f.recorded_by === "hook").every((f) => f.conflict === null), JSON.stringify(plan.files));
    assert.match(plan.files.find((f) => f.path === "src/c.ts").conflict, /^close-out found it/, "the shell edit no hook saw waits for the person");
    applyPlan(plan);
    assert.equal(read(root, "src/a.ts"), "a original\n");
    assert.equal(read(root, "src/b.ts"), "b uncommitted\n");
    assert.equal(read(root, "todo.md"), "untracked\n");
    assert.equal(read(root, "src/c.ts"), "c original\n");
    assert.ok(!existsSync(join(root, "src/new.ts")));
    const statusAfter = git(root, "status", "--porcelain").split("\n").filter((l) => l && !l.includes(".sdlc/")).join("\n");
    assert.equal(statusAfter, statusBefore.trimEnd(), "git status is what it was before the run");
    assert.ok(revertPlan({ root, runId: "r1" }).files.every((f) => f.action === "none"), "a second plan has nothing left to do");
  } finally { cleanup(root); }
});

test("the revert plan is refused while a run is live, and for a run with no record", () => {
  const root = gitRepo({ "src/a.ts": "a\n" });
  try {
    assert.throws(() => revertPlan({ root, runId: "r1" }), (e) => e instanceof ProvenanceRefusal && /no readable provenance record/.test(e.message));
    freezeContract({ projectRoot: root, runId: "r1", allowlist: ["src/**"] });
    assert.throws(() => revertPlan({ root, runId: "r1" }), /run r1 is live/);
    const r = cli(root, "--plan");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^write-provenance: run r1 is live/);
  } finally { cleanup(root); }
});

test("the revert plan holds back a file changed after the run, or written by a later run", () => {
  const root = gitRepo({ "a.ts": "a\n", "b.ts": "b\n" });
  try {
    initProvenance({ root, runId: "r1", now: new Date("2026-10-13T10:00:00Z") });
    for (const p of ["a.ts", "b.ts"]) { recordBefore({ root, runId: "r1", path: p }); put(root, p, "run 1\n"); }
    finalizeProvenance({ root, runId: "r1" });
    put(root, "a.ts", "hand edit after the run\n");
    initProvenance({ root, runId: "r2", now: new Date("2026-10-13T11:00:00Z") });
    recordBefore({ root, runId: "r2", path: "b.ts" });
    put(root, "b.ts", "run 2\n");
    finalizeProvenance({ root, runId: "r2" });
    const files = Object.fromEntries(revertPlan({ root, runId: "r1" }).files.map((f) => [f.path, f]));
    assert.match(files["a.ts"].conflict, /changed after the run/);
    assert.match(files["b.ts"].conflict, /later run also wrote it \(r2\)/);
  } finally { cleanup(root); }
});

test("an edit the person makes during the run is held back, and the run's own changes still revert", () => {
  const root = gitRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n", "src/mine.ts": "mine v1\n" });
  try {
    freezeContract({ projectRoot: root, runId: "r1", allowlist: ["src/a.ts", "src/b.ts"] });
    recordBefore({ root, runId: "r1", path: "src/a.ts", by: "hook" });
    put(root, "src/a.ts", "a by the run\n");
    put(root, "src/b.ts", "b by a sed the hook could not read\n");
    put(root, "src/mine.ts", "mine v2: the person's work during a gate pause\n");
    put(root, "src/theirs.ts", "a new file the person made\n");
    endRun({ projectRoot: root, runId: "r1", outcome: "completed" });

    const plan = revertPlan({ root, runId: "r1" });
    const by = Object.fromEntries(plan.files.map((f) => [f.path, f]));
    assert.deepEqual([by["src/a.ts"].action, by["src/a.ts"].conflict], ["git-checkout", null]);
    assert.deepEqual([by["src/mine.ts"].action, by["src/mine.ts"].recorded_by], ["git-checkout", "finalize"]);
    assert.match(by["src/mine.ts"].conflict, /the change may be the user's, and it is outside the run's confirmed allowlist$/);
    assert.match(by["src/theirs.ts"].conflict, /outside the run's confirmed allowlist$/);
    assert.match(by["src/b.ts"].conflict, /the change may be the user's$/, "inside the allowlist the plan does not say whose it is");

    for (const f of plan.files) if (f.command && !f.conflict) execFileSync("/bin/sh", ["-c", f.command]);
    assert.equal(read(root, "src/a.ts"), "a\n");
    assert.equal(read(root, "src/mine.ts"), "mine v2: the person's work during a gate pause\n", "the clean batch never touches the person's edit");
    assert.equal(read(root, "src/theirs.ts"), "a new file the person made\n");
  } finally { cleanup(root); }
});

test("dirtyOnly records a file only when a backup keeps its uncommitted or untracked content", () => {
  const root = gitRepo({ "clean.ts": "clean\n", "wip.ts": "committed\n" });
  try {
    put(root, "wip.ts", "uncommitted\n");
    put(root, "notes.md", "untracked\n");
    initProvenance({ root, runId: "r1" });
    for (const p of ["clean.ts", "missing.ts"]) assert.equal(recordBefore({ root, runId: "r1", path: p, by: "hook", dirtyOnly: true }), null, p);
    for (const p of ["wip.ts", "notes.md"]) {
      const r = recordBefore({ root, runId: "r1", path: p, by: "hook", dirtyOnly: true });
      assert.equal(read(root, r.backup_path), p === "wip.ts" ? "uncommitted\n" : "untracked\n", p);
    }
    assert.deepEqual(prov(root).files_touched.map((r) => r.path), ["wip.ts", "notes.md"]);
    recordBefore({ root, runId: "r1", path: "clean.ts", by: "hook" });
    assert.ok(recordBefore({ root, runId: "r1", path: "clean.ts", by: "hook", dirtyOnly: true }), "a file already on record stays on record");
  } finally { cleanup(root); }
});

test("a folder the run removes has its uncommitted, untracked and tracked files recorded, and revert brings them back", () => {
  const root = gitRepo({ "src/old/keep.ts": "keep\n", "src/old/deep/wip.ts": "committed\n", "src/other.ts": "other\n" });
  try {
    put(root, "src/old/deep/wip.ts", "uncommitted\n");
    put(root, "src/old/notes.md", "untracked notes\n");
    initProvenance({ root, runId: "r1" });
    assert.equal(recordFolderBefore({ root, runId: "r1", path: "src/old", by: "hook" }), 3);
    const by = Object.fromEntries(prov(root).files_touched.map((r) => [r.path, r]));
    assert.deepEqual(Object.keys(by).sort(), ["src/old/deep/wip.ts", "src/old/keep.ts", "src/old/notes.md"]);
    assert.equal(read(root, by["src/old/notes.md"].backup_path), "untracked notes\n");
    assert.equal(read(root, by["src/old/deep/wip.ts"].backup_path), "uncommitted\n");
    assert.deepEqual([by["src/old/keep.ts"].tracked_in_git, by["src/old/keep.ts"].backup_path], [true, null]);
    assert.equal(recordFolderBefore({ root, runId: "r1", path: "src/old", by: "hook" }), 3, "a second removal keeps the first snapshots");
    for (const p of ["src/other.ts", ".sdlc", ".git", "nowhere"]) assert.equal(recordFolderBefore({ root, runId: "r1", path: p }), 0, p);

    rmSync(join(root, "src/old"), { recursive: true });
    finalizeProvenance({ root, runId: "r1" });
    const plan = revertPlan({ root, runId: "r1" });
    assert.ok(plan.files.every((f) => f.conflict === null && f.recorded_by === "hook"), JSON.stringify(plan.files));
    applyPlan(plan);
    assert.equal(read(root, "src/old/keep.ts"), "keep\n");
    assert.equal(read(root, "src/old/deep/wip.ts"), "uncommitted\n");
    assert.equal(read(root, "src/old/notes.md"), "untracked notes\n");
  } finally { cleanup(root); }
});

test("a folder removal snapshots at most FOLDER_SNAPSHOT_CAP files and reports the folder past that", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    mkdirSync(join(root, "gen"));
    for (let i = 0; i <= FOLDER_SNAPSHOT_CAP; i++) writeFileSync(join(root, "gen", `f${i}.txt`), `${i}\n`);
    initProvenance({ root, runId: "r1" });
    assert.equal(recordFolderBefore({ root, runId: "r1", path: "gen", by: "hook" }), FOLDER_SNAPSHOT_CAP);
    const p = prov(root);
    assert.equal(p.files_touched.length, FOLDER_SNAPSHOT_CAP);
    assert.match(p.unrecorded_changes.find((u) => u.path === "gen/").reason, /the rest have none/);
  } finally { cleanup(root); }
});

test("a dirty file whose backup is missing is reported, never checked out over", () => {
  const root = gitRepo({ "a.ts": "committed\n" });
  try {
    put(root, "a.ts", "uncommitted\n");
    initProvenance({ root, runId: "r1" });
    const r = recordBefore({ root, runId: "r1", path: "a.ts" });
    put(root, "a.ts", "run\n");
    finalizeProvenance({ root, runId: "r1" });
    unlinkSync(join(root, r.backup_path));
    const [f] = revertPlan({ root, runId: "r1" }).files;
    assert.equal(f.action, "cannot");
    assert.equal(f.command, null);
    assert.match(f.reason, /backup/);
  } finally { cleanup(root); }
});

// ── what close-out must not claim ─────────────────────────────────────────

test("an ignored file a .gitignore change uncovers is reported as there before the run, never planned for deletion", () => {
  const root = gitRepo({ ".gitignore": "config.local.json\n", "a.ts": "a\n" });
  try {
    put(root, "config.local.json", "the person's local config\n");
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(join(root, "config.local.json"), hourAgo, hourAgo);
    initProvenance({ root, runId: "r1" });
    assert.ok(!Object.hasOwn(prov(root).dirty_at_start, "config.local.json"), "git status skips an ignored file");
    recordBefore({ root, runId: "r1", path: ".gitignore", by: "hook" });
    put(root, ".gitignore", "dist/\n");
    const p = finalizeProvenance({ root, runId: "r1" });

    assert.equal(rec(root, "config.local.json").length, 0);
    const [u] = p.unrecorded_changes.filter((x) => x.path === "config.local.json");
    assert.match(u.reason, /there before the run/);
    const plan = revertPlan({ root, runId: "r1" });
    assert.deepEqual(plan.files.map((f) => [f.path, f.action]), [[".gitignore", "git-checkout"]]);
    assert.equal(plan.unrecorded_changes.find((x) => x.path === "config.local.json").has_record, false);
    applyPlan(plan);
    assert.equal(read(root, "config.local.json"), "the person's local config\n");
    assert.equal(read(root, ".gitignore"), "config.local.json\n");
  } finally { cleanup(root); }
});

test("a write the hook did not see that the run then committed is recorded from the commit and reverted", () => {
  const root = gitRepo({ "a.ts": "a\n", "b.ts": "b\n" });
  try {
    initProvenance({ root, runId: "r1" });
    recordBefore({ root, runId: "r1", path: "a.ts", by: "hook" });
    put(root, "a.ts", "a run\n");
    put(root, "b.ts", "b sed edit\n");
    git(root, "commit", "-qam", "run commit");
    const p = finalizeProvenance({ root, runId: "r1" });
    assert.equal(p.commits.length, 1);
    const [b] = rec(root, "b.ts");
    assert.deepEqual([b.recorded_by, b.existed_before, b.tracked_in_git], ["finalize", true, true]);
    applyPlan(revertPlan({ root, runId: "r1" }));
    assert.equal(read(root, "a.ts"), "a\n");
    assert.equal(read(root, "b.ts"), "b\n");
  } finally { cleanup(root); }
});

test("a nested repository listed at the start is not reported as a change when the run changed nothing", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    put(root, "vendor/lib/x.ts", "x\n");
    git(join(root, "vendor", "lib"), "init", "-q");
    const p0 = initProvenance({ root, runId: "r1" });
    assert.ok(Object.hasOwn(p0.dirty_at_start, "vendor/lib/"));
    const p = finalizeProvenance({ root, runId: "r1" });
    assert.deepEqual([p.files_touched, p.unrecorded_changes], [[], []]);
  } finally { cleanup(root); }
});

test("in a repo with eol filters, a reverted file shows none on a second plan", () => {
  const root = gitRepo({ ".gitattributes": "*.ts text eol=crlf\n", "a.ts": "a\nb\n" });
  try {
    unlinkSync(join(root, "a.ts"));
    git(root, "checkout", "--", "a.ts");
    assert.equal(read(root, "a.ts"), "a\r\nb\r\n");
    initProvenance({ root, runId: "r1" });
    put(root, "a.ts", "sed edit\r\n");
    finalizeProvenance({ root, runId: "r1" });
    const first = revertPlan({ root, runId: "r1" });
    assert.deepEqual(first.files.map((f) => [f.path, f.action]), [["a.ts", "git-checkout"]]);
    applyPlan(first);
    assert.equal(read(root, "a.ts"), "a\r\nb\r\n");
    const [again] = revertPlan({ root, runId: "r1" }).files;
    assert.deepEqual([again.action, again.conflict], ["none", null]);
  } finally { cleanup(root); }
});

test("without git, a file is backed up before its write and close-out has nothing to reconcile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prov-nogit-")));
  try {
    put(root, "notes.md", "original\n");
    const p0 = initProvenance({ root, runId: "r1" });
    assert.deepEqual([p0.dirty_at_start, p0.git_head_before], [null, null]);
    const r = recordBefore({ root, runId: "r1", path: "notes.md", by: "hook" });
    assert.deepEqual([r.tracked_in_git, r.dirty_before], [false, true]);
    put(root, "notes.md", "run\n");
    put(root, "made.md", "a write no hook saw\n");
    const p = finalizeProvenance({ root, runId: "r1" });
    assert.ok(p.finalized_at);
    assert.deepEqual([p.files_touched.length, p.unrecorded_changes], [1, []]);
    const plan = revertPlan({ root, runId: "r1" });
    assert.deepEqual(plan.files.map((f) => f.action), ["restore-backup"]);
    applyPlan(plan);
    assert.equal(read(root, "notes.md"), "original\n");
  } finally { cleanup(root); }
});

test("past PATH_CAP dirty files the start state is marked truncated and close-out reports paths instead of claiming them", () => {
  const root = gitRepo({ "src/clean.ts": "clean\n" });
  try {
    mkdirSync(join(root, "gen"));
    for (let i = 0; i <= PATH_CAP; i++) writeFileSync(join(root, "gen", `f${i}.txt`), `${i}\n`);
    const p0 = initProvenance({ root, runId: "r1" });
    assert.equal(p0.dirty_at_start_truncated, true);
    assert.equal(Object.keys(p0.dirty_at_start).length, PATH_CAP);
    const r = recordBefore({ root, runId: "r1", path: "src/clean.ts", by: "hook" });
    assert.deepEqual([r.tracked_in_git, r.dirty_before, r.backup_path], [true, false, null], "the snapshot asks git about the file itself");
    put(root, "src/clean.ts", "run\n");
    put(root, "src/made.ts", "no hook saw this\n");
    const p = finalizeProvenance({ root, runId: "r1" });
    assert.equal(rec(root, "src/made.ts").length, 0);
    assert.match(p.unrecorded_changes.find((u) => u.path === "src/made.ts").reason, /not fully recorded/);
    applyPlan(revertPlan({ root, runId: "r1" }));
    assert.equal(read(root, "src/clean.ts"), "clean\n");
    assert.ok(existsSync(join(root, "src/made.ts")), "a file the run may not have made is left alone");
  } finally { cleanup(root); }
});

// ── the plan checks the record it reads ───────────────────────────────────

test("an edited record cannot steer a revert command into the shell, outside the project or into .git/", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "prov-out-")));
  try {
    writeFileSync(join(outsideDir, "victim.txt"), "outside\n");
    initProvenance({ root, runId: "r1" });
    recordBefore({ root, runId: "r1", path: "a.ts" });
    put(root, "a.ts", "run\n");
    finalizeProvenance({ root, runId: "r1" });
    const file = provenancePath(root, "r1");
    const p = JSON.parse(readFileSync(file, "utf8"));
    p.git_head_before = "HEAD; echo INJECTED #";
    p.commits = ["$(touch pwned)"];
    const base = { existed_before: false, sha_before: null, sha_after: null, tracked_in_git: false, dirty_before: false, backup_path: null };
    symlinkSync(outsideDir, join(root, "out"));
    for (const path of ["../outside.txt", ".git/config", "out/victim.txt", "/etc/hosts"]) p.files_touched.push({ ...base, path });
    put(root, "kept.md", "untracked\n");
    p.files_touched.push({ ...base, path: "kept.md", existed_before: true, dirty_before: true, sha_before: "sha256:x", backup_path: ".sdlc/runs/r1/backups/../../../../out/victim.txt" });
    writeFileSync(file, JSON.stringify(p));

    const plan = revertPlan({ root, runId: "r1" });
    assert.equal(plan.git_head_before, null);
    assert.deepEqual(plan.commits, []);
    for (const f of plan.files) {
      assert.equal(f.action, "cannot", f.path);
      assert.equal(f.command, null, f.path);
    }
    assert.match(plan.files.find((f) => f.path === "a.ts").reason, /no commit/);
    assert.match(plan.files.find((f) => f.path === "out/victim.txt").reason, /outside the project/);
    assert.match(plan.files.find((f) => f.path === "kept.md").reason, /backups\/ folder/);
    assert.equal(readFileSync(join(outsideDir, "victim.txt"), "utf8"), "outside\n");
  } finally { cleanup(root); cleanup(outsideDir); }
});

test("backups/ carries its own .gitignore, so git never lists a copy of an uncommitted file", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    put(root, "a.ts", "uncommitted\n");
    initProvenance({ root, runId: "r1" });
    const r = recordBefore({ root, runId: "r1", path: "a.ts", by: "hook" });
    assert.equal(read(root, ".sdlc/runs/r1/backups/.gitignore"), "*\n");
    assert.notEqual(backupName(".gitignore"), ".gitignore");
    const listed = git(root, "status", "--porcelain", "--untracked-files=all");
    assert.ok(!listed.includes("backups/"), listed);
    assert.equal(read(root, r.backup_path), "uncommitted\n");
  } finally { cleanup(root); }
});

// ── the record file ───────────────────────────────────────────────────────

test("a lock a dead writer left behind is broken after ten seconds", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    initProvenance({ root, runId: "r1" });
    const lock = `${provenancePath(root, "r1")}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    assert.ok(recordBefore({ root, runId: "r1", path: "a.ts", by: "hook" }));
    assert.equal(rec(root, "a.ts").length, 1);
    assert.ok(!existsSync(lock));
  } finally { cleanup(root); }
});

test("eight hook calls at once leave eight records", async () => {
  const root = gitRepo();
  try {
    for (let i = 0; i < 8; i++) put(root, `f${i}.ts`, `${i}\n`);
    initProvenance({ root, runId: "r1" });
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((done) => {
      spawn(process.execPath, [SCRIPT, "--before", `--path=f${i}.ts`, "--run-id=r1", `--project-root=${root}`], { stdio: "ignore" }).on("close", done);
    })));
    assert.equal(prov(root).files_touched.length, 8);
    assert.ok(!existsSync(`${provenancePath(root, "r1")}.lock`), "the lock is released");
  } finally { cleanup(root); }
});

test("backups of a/b.ts and a__b.ts are distinct files holding their own bytes", () => {
  const root = gitRepo();
  try {
    put(root, "a/b.ts", "nested\n");
    put(root, "a__b.ts", "flat\n");
    assert.notEqual(backupName("a/b.ts"), backupName("a__b.ts"));
    const nested = recordBefore({ root, runId: "r1", path: "a/b.ts" });
    const flat = recordBefore({ root, runId: "r1", path: "a__b.ts" });
    assert.equal(read(root, nested.backup_path), "nested\n");
    assert.equal(read(root, flat.backup_path), "flat\n");
    assert.ok(Buffer.byteLength(backupName(`${"deep/".repeat(80)}x.ts`)) < 255, "a long path still makes a legal file name");
  } finally { cleanup(root); }
});

test("an unsafe run id is refused and nothing is written outside the run folders", () => {
  const root = gitRepo();
  try {
    put(root, "a.ts", "a\n");
    assert.throws(() => recordBefore({ root, runId: "../x", path: "a.ts" }), ProvenanceRefusal);
    assert.throws(() => initProvenance({ root, runId: ".hidden" }), ProvenanceRefusal);
    const r = spawnSync(process.execPath, [SCRIPT, "--before", "--path=a.ts", "--run-id=../x", `--project-root=${root}`], { encoding: "utf8" });
    assert.equal(r.status, 0, "the CLI fails open");
    assert.match(r.stderr, /run id/);
    assert.ok(!existsSync(join(root, ".sdlc")) && !existsSync(join(root, "x")));
  } finally { cleanup(root); }
});

test("the run's own records, git's store, folders and links are never recorded", () => {
  const root = gitRepo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "prov-outside-")));
  try {
    initProvenance({ root, runId: "r1" });
    put(root, "dir/x.ts", "x\n");
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    for (const p of [".sdlc/runs/r1/notes.md", ".SDLC/runs/r1/notes.md", ".git/config", "dir", "link.txt", join(outside, "secret.txt"), "../escape.ts"]) {
      assert.equal(recordBefore({ root, runId: "r1", path: p }), null, p);
    }
    assert.equal(prov(root).files_touched.length, 0);
    assert.ok(!existsSync(join(root, ".sdlc", "runs", "r1", "backups")));
  } finally { cleanup(root); cleanup(outside); }
});

test("importing the module runs nothing and leaves no file behind", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "prov-import-")));
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(SCRIPT)}); console.log("alive");`], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "alive");
    assert.deepEqual(readdirSync(dir), []);
  } finally { cleanup(dir); }
});

test("recordAfter fills one record's end hash for a manual --after", () => {
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    recordBefore({ root, runId: "r1", path: "a.ts" });
    put(root, "a.ts", "a2\n");
    const r = recordAfter({ root, runId: "r1", path: "a.ts" });
    assert.match(r.sha_after, /^sha256:/);
    assert.equal(recordAfter({ root, runId: "r1", path: "never.ts" }), null);
  } finally { cleanup(root); }
});

// ── the skills say who records ────────────────────────────────────────────

test("no skill tells the conductor to run write-provenance.mjs --before or --after", () => {
  for (const skill of ["pipeline", "brownfield-guide"]) {
    const text = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
    assert.ok(!/write-provenance\.mjs[^\n]*--(before|after)/.test(text), `${skill} tells the conductor to record writes itself`);
    assert.ok(/hook snapshots/.test(text), `${skill} does not say the write hook takes the snapshots`);
  }
});

test("the revert skill reads the plan and keys an uncommitted file on its backup, not on sha_before:null", () => {
  const text = readFileSync(join(SKILLS, "revert", "SKILL.md"), "utf8");
  assert.ok(!/sha_before:\s*null`?\s*\|/.test(text), "a dirty tracked file has a sha_before; keying on null loses its work");
  for (const re of [/write-provenance\.mjs' --plan/, /dirty_before/, /unrecorded_changes/, /finalized_at/]) assert.ok(re.test(text), `the revert skill does not mention ${re}`);
  assert.match(text, /To override the dirty check for one file, the user runs that file's\s+`command` from the plan/);
  assert.doesNotMatch(text, /they\s+run `git checkout/, "a checkout override throws away the work a backup kept");
});

test("the revert skill carries no renderer placeholder, and its plan command runs once <plugin-root> is filled in", () => {
  const text = readFileSync(join(SKILLS, "revert", "SKILL.md"), "utf8");
  assert.equal(text.match(/\{\{[A-Z_]+\}\}/g), null, "Codex hands the model this skill raw, and no renderer fills it");
  assert.ok(text.includes("/skills/revert/SKILL.md"), "the skill says how to find the plugin root from its own path");
  const line = text.split("\n").find((l) => l.includes("write-provenance.mjs' --plan"));
  assert.match(line, /^node '<plugin-root>\/scripts\/write-provenance\.mjs' --plan --run-id=<run-id>$/);
  const root = gitRepo({ "a.ts": "a\n" });
  try {
    initProvenance({ root, runId: "r1" });
    recordBefore({ root, runId: "r1", path: "a.ts" });
    put(root, "a.ts", "run\n");
    finalizeProvenance({ root, runId: "r1" });
    mkdirSync(join(root, "sub"));
    const command = line.replaceAll("<plugin-root>", join(REPO, "plugin")).replaceAll("<run-id>", "r1");
    const r = spawnSync("/bin/sh", ["-c", command], { cwd: join(root, "sub"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.project_root, root, "run from a subfolder, it finds the project at the git top level");
    assert.deepEqual(plan.files.map((f) => [f.path, f.action]), [["a.ts", "git-checkout"]]);
  } finally { cleanup(root); }
});
