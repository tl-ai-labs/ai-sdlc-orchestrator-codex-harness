/**
 * plugin/scripts/write-contract.mjs and plugin/scripts/lib/contract-lock.mjs: the freeze, the lock, close-out,
 * abandon, resume, and the guard-liveness check. The CLI runs as a subprocess; the exported functions are called
 * directly where a test needs a clock or a state the CLI cannot reach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abandonRun, closeContract, endRun, freezeContract, reopenRun, ContractRefusal,
} from "../../plugin/scripts/write-contract.mjs";
import { contractTampered, liveLock } from "../../plugin/scripts/lib/contract-lock.mjs";
import { OFF_LIMITS_DEFAULT } from "../../plugin/scripts/lib/off-limits.mjs";
import "./lib/stand-ins.mjs";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "write-contract.mjs");
const SKILLS = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "skills");
const HYDRATE = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "session-hydrate.mjs");
const SETUP_POLICY = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "setup-policy.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-cli-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const contractPath = (dir) => join(dir, ".sdlc", "local", "write-contract.json");
const lockFile = (dir, id) => join(dir, ".sdlc", "runs", id, "write-contract.lock.json");
const frozenFile = (dir, id) => join(dir, ".sdlc", "runs", id, "write-contract.frozen.json");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const freeze = (dir, id = "r1", allow = '["src/**"]', extra = []) =>
  cli(["--freeze", `--run-id=${id}`, `--allowlist=${allow}`, ...extra, `--project-root=${dir}`], dir);
const gate = (dir, id, line) => {
  mkdirSync(join(dir, ".sdlc", "runs", id), { recursive: true });
  appendFileSync(join(dir, ".sdlc", "runs", id, "gates.jsonl"), JSON.stringify(line) + "\n");
};

// ── freeze ────────────────────────────────────────────────────────────────

test("freeze writes the contract, a frozen copy and a lock holding the contract's SHA-256", () => {
  const dir = makeGitRepo();
  try {
    const r = freeze(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /frozen for run r1/);
    const bytes = readFileSync(contractPath(dir));
    const c = JSON.parse(bytes);
    assert.deepEqual(
      { ...c, frozen_at: "x" },
      { schema_version: 1, active: true, mode: "brownfield", run_id: "r1", strict: true, allowlist: ["src/**"], off_limits: OFF_LIMITS_DEFAULT, frozen_at: "x" },
    );
    const lock = readJson(lockFile(dir, "r1"));
    assert.equal(lock.sha256, sha(bytes));
    assert.equal(lock.run_id, "r1");
    assert.equal(lock.frozen_at, c.frozen_at);
    assert.equal(lock.ended_at, null);
    assert.equal(lock.end_outcome, null);
    assert.deepEqual(readFileSync(frozenFile(dir, "r1")), bytes, "the frozen copy is the contract byte for byte");
  } finally { cleanup(dir); }
});

test("freeze names the guard check as the next command, ready to run in a call of its own", () => {
  const dir = makeGitRepo();
  try {
    const r = freeze(dir);
    assert.equal(r.status, 0, r.stderr);
    const next = r.stdout.split("\n").find((l) => l.includes("--assert-guard-live"));
    assert.ok(next, r.stdout);
    assert.match(next, /in a tool call of its own/);
    assert.ok(next.includes(`'${SCRIPT}' --assert-guard-live --run-id=r1 --project-root='${dir}'`), next);
  } finally { cleanup(dir); }
});

test("freeze merges project.json's off_limits_default with the extras, without duplicates", () => {
  const dir = makeGitRepo();
  try {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ off_limits_default: [".env", "secrets/**"] }));
    const r = freeze(dir, "r1", '["src/**"]', ['--off-limits=[".cursor/rules/**","secrets/**"]']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(contractPath(dir)).off_limits, [".env", "secrets/**", ".cursor/rules/**"]);
  } finally { cleanup(dir); }
});

test("freeze accepts the --name value form and --strict-write=off", () => {
  const dir = makeGitRepo();
  try {
    const r = cli(["--freeze", "--run-id", "r2", "--allowlist", '["docs/**"]', "--strict-write=off", "--project-root", dir], dir);
    assert.equal(r.status, 0, r.stderr);
    const c = readJson(contractPath(dir));
    assert.equal(c.run_id, "r2");
    assert.equal(c.strict, false);
    assert.deepEqual(c.allowlist, ["docs/**"]);
  } finally { cleanup(dir); }
});

test("freeze refuses bad input with exit 2 and writes nothing", () => {
  const cases = [
    ["a run id with a separator", ["--freeze", "--run-id=a/b", '--allowlist=["src/**"]']],
    ["a run id starting with a dot", ["--freeze", "--run-id=.x", '--allowlist=["src/**"]']],
    ["an allowlist that is not JSON", ["--freeze", "--run-id=r1", "--allowlist=src/**"]],
    ["an allowlist that is not an array of strings", ["--freeze", "--run-id=r1", '--allowlist=[1]']],
    ["off-limits that is not an array", ["--freeze", "--run-id=r1", '--allowlist=["src/**"]', '--off-limits={"a":1}']],
    ["no allowlist", ["--freeze", "--run-id=r1"]],
    ["an unknown flag", ["--freeze", "--run-id=r1", '--allowlist=["src/**"]', "--force"]],
    ["a flag with no value", ["--freeze", '--allowlist=["src/**"]', "--run-id"]],
    ["two modes", ["--freeze", "--close", "--run-id=r1", '--allowlist=["src/**"]']],
    ["--strict-write other than off", ["--freeze", "--run-id=r1", '--allowlist=["src/**"]', "--strict-write=on"]],
    ["no mode", ["--run-id=r1"]],
  ];
  for (const [what, args] of cases) {
    const dir = makeGitRepo();
    try {
      const r = cli([...args, `--project-root=${dir}`], dir);
      assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^write-contract: /, what);
      assert.ok(!existsSync(join(dir, ".sdlc")), `${what}: nothing may be written`);
    } finally { cleanup(dir); }
  }
});

test("freeze refuses a folder that is not the root of its git project, and names the root", () => {
  const dir = makeGitRepo();
  const loose = mkdtempSync(join(tmpdir(), "write-contract-nogit-"));
  try {
    mkdirSync(join(dir, "pkg"));
    const sub = freeze(join(dir, "pkg"));
    assert.equal(sub.status, 2);
    assert.match(sub.stderr, /inside the git project at /);
    assert.ok(sub.stderr.includes(dir));
    assert.ok(!existsSync(join(dir, "pkg", ".sdlc")) && !existsSync(join(dir, ".sdlc")));
    const none = freeze(loose);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /not in a git project/);
  } finally { cleanup(dir); cleanup(loose); }
});

test("a run freezes once: a second freeze under the same id is refused, also after the run ended", () => {
  const dir = makeGitRepo();
  try {
    assert.equal(freeze(dir).status, 0);
    const again = freeze(dir, "r1", '["**"]');
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already frozen/);
    gate(dir, "r1", { gate: 4, decision: "approved" });
    assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 0);
    const afterEnd = freeze(dir, "r1", '["**"]');
    assert.equal(afterEnd.status, 2);
    assert.deepEqual(readJson(contractPath(dir)).allowlist, ["src/**"], "the widened scope was never written");
  } finally { cleanup(dir); }
});

test("freeze is refused while another run's lock is live, and allowed once that run ends", () => {
  const dir = makeGitRepo();
  try {
    assert.equal(freeze(dir, "r1").status, 0);
    const other = freeze(dir, "r2");
    assert.equal(other.status, 2);
    assert.match(other.stderr, /run r1 is live/);
    assert.ok(other.stderr.includes(`node '${SCRIPT}' --abandon --run-id=r1 --project-root='${dir}'`), other.stderr);
    assert.equal(readJson(contractPath(dir)).run_id, "r1");
    gate(dir, "r1", { gate: 4, decision: "auto-approved" });
    assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 0);
    assert.equal(freeze(dir, "r2").status, 0, "the next run's Gate 0 freezes");
    assert.equal(readJson(contractPath(dir)).run_id, "r2");
  } finally { cleanup(dir); }
});

test("freeze is refused over an active contract that no lock records", () => {
  const dir = makeGitRepo();
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(contractPath(dir), JSON.stringify({ schema_version: 1, active: true, run_id: "legacy", allowlist: ["**"], off_limits: [] }));
    const r = freeze(dir, "r1");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--abandon --run-id=legacy/);
    assert.equal(readJson(contractPath(dir)).run_id, "legacy");
  } finally { cleanup(dir); }
});

// ── close ─────────────────────────────────────────────────────────────────

test("close is refused while the run is live and its gates.jsonl has no accepted Gate 4", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    gate(dir, "r1", { gate: 1, decision: "approved" });
    const before = readFileSync(contractPath(dir));
    const r = cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /records no accepted Gate 4/);
    assert.deepEqual(readFileSync(contractPath(dir)), before);
    assert.equal(readJson(lockFile(dir, "r1")).ended_at, null);
  } finally { cleanup(dir); }
});

test("a refused close names the full --abandon command, and never the gate line that would make it pass", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    const r = cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(`node '${SCRIPT}' --abandon --run-id=r1 --project-root='${dir}'`), r.stderr);
    assert.doesNotMatch(r.stderr, /"decision"|"gate"|append/, "a drifted conductor is not handed the approval line");
  } finally { cleanup(dir); }
});

test("close after an accepted Gate 4 writes the lock's end record and switches the contract off", () => {
  for (const decision of ["approved", "accepted", "auto-approved"]) {
    const dir = makeGitRepo();
    try {
      freeze(dir);
      gate(dir, "r1", { gate: 4, artifact: "SUMMARY.md", decision });
      const r = cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir);
      assert.equal(r.status, 0, `${decision}: ${r.stderr}`);
      const lock = readJson(lockFile(dir, "r1"));
      assert.ok(lock.ended_at, decision);
      assert.equal(lock.end_outcome, "completed");
      assert.equal(readJson(contractPath(dir)).active, false);
      assert.equal(readJson(frozenFile(dir, "r1")).active, true, "the frozen copy is kept as frozen");
      assert.equal(liveLock(dir), null);
    } finally { cleanup(dir); }
  }
});

test("close reads the Gate 4 answer without regard to case or spacing, and takes the prompt's own `accept`", () => {
  for (const decision of ["accept", "Accept", "Approved", " APPROVED ", "Accepted", "Auto-Approved"]) {
    const dir = makeGitRepo();
    try {
      freeze(dir);
      gate(dir, "r1", { gate: 4, artifact: "SUMMARY.md", decision });
      const r = cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir);
      assert.equal(r.status, 0, `${JSON.stringify(decision)}: ${r.stderr}`);
      assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "completed", decision);
    } finally { cleanup(dir); }
  }
  for (const decision of ["abort", "Aborted"]) {
    const dir = makeGitRepo();
    try {
      freeze(dir);
      gate(dir, "r1", { gate: 3, decision });
      assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 0, decision);
      assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "aborted", decision);
    } finally { cleanup(dir); }
  }
  const dir = makeGitRepo();
  try {
    freeze(dir);
    gate(dir, "r1", { gate: 4, decision: "reject: tighten the docs" });
    gate(dir, "r1", { gate: 2, decision: "Approved" });
    assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 2, "a rejected Gate 4 or another gate's approval is no acceptance");
  } finally { cleanup(dir); }
});

test("close reads a gate record that carries its answer as status, and ignores a pending Gate 4", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    gate(dir, "r1", { gate: 4, status: "pending", run_id: "r1" });
    assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 2, "a pending Gate 4 is not an answer");
    gate(dir, "r1", { gate: 4, status: "approved", run_id: "r1" });
    const r = cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "completed");
  } finally { cleanup(dir); }
});

test("close after an aborted gate ends the run as aborted", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    gate(dir, "r1", { gate: 2, decision: "aborted" });
    assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 0);
    assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "aborted");
  } finally { cleanup(dir); }
});

test("a second close exits 0 and changes nothing", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    gate(dir, "r1", { gate: 4, decision: "approved" });
    assert.equal(cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir).status, 0);
    const contract = readFileSync(contractPath(dir));
    const lock = readFileSync(lockFile(dir, "r1"));
    const r = cli(["--close", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /had already ended/);
    assert.deepEqual(readFileSync(contractPath(dir)), contract);
    assert.deepEqual(readFileSync(lockFile(dir, "r1")), lock);
  } finally { cleanup(dir); }
});

test("close refuses a run the contract does not belong to", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir, "r1");
    gate(dir, "r9", { gate: 4, decision: "approved" });
    const r = cli(["--close", "--run-id=r9", `--project-root=${dir}`], dir);
    assert.equal(r.status, 2);
    assert.equal(readJson(contractPath(dir)).active, true);
  } finally { cleanup(dir); }
});

// ── abandon ───────────────────────────────────────────────────────────────

test("abandon ends a live run as aborted with its reason, switches the contract off and frees the project", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    const r = cli(["--abandon", "--run-id=r1", "--reason=session closed at gate 2", `--project-root=${dir}`], dir);
    assert.equal(r.status, 0, r.stderr);
    const lock = readJson(lockFile(dir, "r1"));
    assert.equal(lock.end_outcome, "aborted");
    assert.equal(lock.end_reason, "session closed at gate 2");
    assert.equal(readJson(contractPath(dir)).active, false);
    assert.equal(freeze(dir, "r2").status, 0);
  } finally { cleanup(dir); }
});

test("abandon switches off a hand-written contract that has no lock", () => {
  const dir = makeGitRepo();
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(contractPath(dir), JSON.stringify({ schema_version: 1, active: true, run_id: "legacy", allowlist: [], off_limits: [] }));
    assert.equal(cli(["--abandon", "--run-id=legacy", `--project-root=${dir}`], dir).status, 0);
    assert.equal(readJson(contractPath(dir)).active, false);
  } finally { cleanup(dir); }
});

test("abandon of a run that holds nothing is refused", () => {
  const dir = makeGitRepo();
  try {
    const r = cli(["--abandon", "--run-id=ghost", `--project-root=${dir}`], dir);
    assert.equal(r.status, 2);
    assert.ok(!existsSync(join(dir, ".sdlc")));
  } finally { cleanup(dir); }
});

test("abandon frees a project whose contract was rewritten to name another run", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    const c = readJson(contractPath(dir));
    writeFileSync(contractPath(dir), JSON.stringify({ ...c, run_id: "r2", allowlist: ["**"] }));
    assert.ok(contractTampered(dir));
    assert.equal(cli(["--abandon", "--run-id=r1", `--project-root=${dir}`], dir).status, 0);
    assert.equal(readJson(contractPath(dir)).active, false);
    assert.equal(contractTampered(dir), null);
  } finally { cleanup(dir); }
});

// ── endRun / reopenRun (called by run.mjs) ────────────────────────────────

test("endRun on a project with no contract does nothing and creates no .sdlc", () => {
  const dir = makeGitRepo();
  try {
    const r = endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    assert.equal(r.found, false);
    assert.ok(!existsSync(join(dir, ".sdlc")));
  } finally { cleanup(dir); }
});

test("endRun ends the lock first, switches the contract off, and is idempotent", () => {
  const dir = makeGitRepo();
  try {
    freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"] });
    const first = endRun({ projectRoot: dir, runId: "r1", outcome: "max_turns", reason: "12 turns" });
    assert.deepEqual([first.ended, first.switched_off], [true, true]);
    const lock = readJson(lockFile(dir, "r1"));
    assert.equal(lock.end_outcome, "max_turns");
    assert.equal(lock.end_reason, "12 turns");
    const second = endRun({ projectRoot: dir, runId: "r1", outcome: "completed" });
    assert.deepEqual([second.ended, second.already_ended, second.switched_off], [false, true, false]);
    assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "max_turns", "the first end record stands");
  } finally { cleanup(dir); }
});

test("reopenRun puts a stopped run's frozen contract back and makes its lock live", () => {
  const dir = makeGitRepo();
  try {
    const { sha256 } = freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"] });
    endRun({ projectRoot: dir, runId: "r1", outcome: "interrupted" });
    assert.equal(readJson(contractPath(dir)).active, false);
    const r = reopenRun({ projectRoot: dir, runId: "r1" });
    assert.equal(r.reopened, true);
    assert.equal(sha(readFileSync(contractPath(dir))), sha256, "the contract is the frozen bytes again");
    const lock = readJson(lockFile(dir, "r1"));
    assert.equal(lock.ended_at, null);
    assert.equal(lock.reopened_at.length, 1);
    assert.equal(contractTampered(dir), null);
    assert.equal(liveLock(dir).run_id, "r1");
  } finally { cleanup(dir); }
});

test("reopenRun leaves a run with no lock alone, and keeps a live one live with the resume stamped in its lock", () => {
  const dir = makeGitRepo();
  try {
    assert.deepEqual(reopenRun({ projectRoot: dir, runId: "r1" }), { run_id: "r1", reopened: false, live: false });
    assert.equal(existsSync(join(dir, ".sdlc")), false);
    const { sha256 } = freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"] });
    const at = new Date("2030-01-01T00:00:00.000Z");
    assert.deepEqual(reopenRun({ projectRoot: dir, runId: "r1", now: at }), { run_id: "r1", reopened: false, live: true });
    const lock = readJson(lockFile(dir, "r1"));
    assert.deepEqual(lock.reopened_at, [at.toISOString()]);
    assert.equal(lock.ended_at, null);
    assert.equal(sha(readFileSync(contractPath(dir))), sha256, "the contract is not touched");
    assert.equal(contractTampered(dir), null);
  } finally { cleanup(dir); }
});

test("reopenRun refuses a completed or aborted run, a changed frozen copy, another live run, or a newer contract", () => {
  const ended = (outcome) => {
    const dir = makeGitRepo();
    freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"] });
    endRun({ projectRoot: dir, runId: "r1", outcome });
    return dir;
  };
  for (const outcome of ["completed", "aborted"]) {
    const dir = ended(outcome);
    try {
      assert.throws(() => reopenRun({ projectRoot: dir, runId: "r1" }), ContractRefusal, outcome);
    } finally { cleanup(dir); }
  }
  let dir = ended("stopped");
  try {
    const f = readJson(frozenFile(dir, "r1"));
    writeFileSync(frozenFile(dir, "r1"), JSON.stringify({ ...f, allowlist: ["**"] }, null, 2) + "\n");
    assert.throws(() => reopenRun({ projectRoot: dir, runId: "r1" }), /no longer matches/);
  } finally { cleanup(dir); }
  dir = ended("stopped");
  try {
    freezeContract({ projectRoot: dir, runId: "r2", allowlist: ["docs/**"] });
    assert.throws(() => reopenRun({ projectRoot: dir, runId: "r1" }), /run r2 is live/);
    endRun({ projectRoot: dir, runId: "r2", outcome: "completed" });
    assert.throws(() => reopenRun({ projectRoot: dir, runId: "r1" }), /now belongs to run r2/);
  } finally { cleanup(dir); }
});

test("close and abandon are the same functions the CLI runs", () => {
  const dir = makeGitRepo();
  try {
    freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"] });
    assert.throws(() => closeContract({ projectRoot: dir, runId: "r1" }), ContractRefusal);
    const r = abandonRun({ projectRoot: dir, runId: "r1" });
    assert.equal(r.reason, "abandoned by the person");
    assert.equal(r.switched_off, true);
  } finally { cleanup(dir); }
});

// ── tamper detection ──────────────────────────────────────────────────────

test("contractTampered: a live lock whose contract changed, vanished or is doubled cannot be trusted", () => {
  const dir = makeGitRepo();
  try {
    freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"] });
    assert.equal(contractTampered(dir), null);
    const original = readFileSync(contractPath(dir));
    writeFileSync(contractPath(dir), original.toString().replace('"src/**"', '"**"'));
    assert.match(contractTampered(dir), /changed after run r1 froze it/);
    rmSync(contractPath(dir));
    assert.match(contractTampered(dir), /the file is gone/);
    writeFileSync(contractPath(dir), original);
    assert.equal(contractTampered(dir), null);
    mkdirSync(join(dir, ".sdlc", "runs", "r0"), { recursive: true });
    writeFileSync(lockFile(dir, "r0"), readFileSync(lockFile(dir, "r1")).toString().replaceAll('"r1"', '"r0"'));
    assert.match(contractTampered(dir), /2 runs hold a live write-contract lock/);
    rmSync(join(dir, ".sdlc", "runs", "r0"), { recursive: true });
    rmSync(lockFile(dir, "r1"));
    assert.match(contractTampered(dir), /that run's lock is gone/);
  } finally { cleanup(dir); }
});

// ── the guard-liveness check ──────────────────────────────────────────────

test("a file write that fails exits 2 with one write-contract line, not a stack trace", () => {
  const dir = makeGitRepo();
  try {
    writeFileSync(join(dir, ".sdlc"), "not a folder\n");
    const r = freeze(dir);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^write-contract: failed: .*ENOTDIR/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  } finally { cleanup(dir); }
});

test("a live lock is a pending run for session-hydrate and an active run for setup-policy, until the run ends", () => {
  const dir = makeGitRepo();
  try {
    assert.equal(freeze(dir, "r1").status, 0);
    const hydrate = () => JSON.parse(spawnSync(process.execPath, [HYDRATE, "--json"], { cwd: dir, encoding: "utf8" }).stdout);
    const active = () => JSON.parse(spawnSync(process.execPath, [SETUP_POLICY, "--guard-active-run", "--project-root", dir], { cwd: dir, encoding: "utf8" }).stdout);
    const resume = hydrate().resume;
    assert.equal(resume.pending, true);
    assert.equal(resume.kind, "run");
    assert.equal(resume.run_id, "r1");
    assert.equal(resume.write_contract, "live");
    assert.match(hydrate().marker, /run r1 still holds the write contract/);
    assert.deepEqual({ ...active() }, { active: true, run_id: "r1", phase: null, status: "live", write_contract: "live" });
    abandonRun({ projectRoot: dir, runId: "r1", reason: "test" });
    assert.equal(hydrate().resume, null);
    assert.equal(active().active, false);
  } finally { cleanup(dir); }
});

test("assert-guard-live passes on a decision row for the run stamped after the freeze", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    const frozenAt = readJson(contractPath(dir)).frozen_at;
    appendFileSync(join(dir, ".sdlc", "local", "guard-decisions.jsonl"),
      JSON.stringify({ ts: frozenAt, decision: "allow", run_id: "r1", wired_by: "plugin" }) + "\n");
    const r = cli(["--assert-guard-live", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /live for run r1 \(wired by plugin\)/);
    assert.equal(readJson(contractPath(dir)).active, true);
  } finally { cleanup(dir); }
});

test("assert-guard-live with no row since the freeze exits 2, says the guard did not run, and ends the run", () => {
  const dir = makeGitRepo();
  try {
    freeze(dir);
    appendFileSync(join(dir, ".sdlc", "local", "guard-decisions.jsonl"),
      JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", decision: "allow", run_id: "r1" }) + "\n" +
      JSON.stringify({ ts: "2999-01-01T00:00:00.000Z", decision: "allow", run_id: "other" }) + "\n");
    const r = cli(["--assert-guard-live", `--project-root=${dir}`], dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /did not run in this session/);
    assert.match(r.stderr, /\/hooks/);
    assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "refused");
    assert.equal(readJson(contractPath(dir)).active, false);
  } finally { cleanup(dir); }
});

test("assert-guard-live after a resume counts only hook rows since the latest resume", () => {
  const dir = makeGitRepo();
  const decisions = join(dir, ".sdlc", "local", "guard-decisions.jsonl");
  const row = (ts) => appendFileSync(decisions, JSON.stringify({ ts, decision: "allow", run_id: "r1", wired_by: "plugin" }) + "\n");
  try {
    freezeContract({ projectRoot: dir, runId: "r1", allowlist: ["src/**"], now: new Date("2030-01-01T00:00:00.000Z") });
    row("2030-01-01T00:00:01.000Z");
    assert.equal(cli(["--assert-guard-live", "--run-id=r1", `--project-root=${dir}`], dir).status, 0, "Gate 0's check passes");
    endRun({ projectRoot: dir, runId: "r1", outcome: "stopped", now: new Date("2030-01-01T00:01:00.000Z") });

    reopenRun({ projectRoot: dir, runId: "r1", now: new Date("2030-01-02T00:00:00.000Z") });
    let r = cli(["--assert-guard-live", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 2, "the earlier session's rows do not prove the hook runs in this one");
    assert.match(r.stderr, /did not run in this session/);
    assert.equal(readJson(lockFile(dir, "r1")).end_outcome, "refused");
    assert.equal(readJson(contractPath(dir)).active, false);

    reopenRun({ projectRoot: dir, runId: "r1", now: new Date("2030-01-03T00:00:00.000Z") });
    row("2030-01-03T00:00:05.000Z");
    r = cli(["--assert-guard-live", "--run-id=r1", `--project-root=${dir}`], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(contractPath(dir)).active, true);

    reopenRun({ projectRoot: dir, runId: "r1", now: new Date("2030-01-04T00:00:00.000Z") });
    assert.equal(cli(["--assert-guard-live", "--run-id=r1", `--project-root=${dir}`], dir).status, 2,
      "a run resumed while still live is checked again too");
  } finally { cleanup(dir); }
});

test("assert-guard-live refuses with exit 2 when no frozen contract is live", () => {
  const dir = makeGitRepo();
  try {
    assert.equal(cli(["--assert-guard-live", `--project-root=${dir}`], dir).status, 2);
    freeze(dir);
    assert.equal(cli(["--assert-guard-live", "--run-id=r9", `--project-root=${dir}`], dir).status, 2);
  } finally { cleanup(dir); }
});

// ── the skills' Gate 0 text ───────────────────────────────────────────────

/** Every fenced code block in the skill files, with the file it came from. */
function skillCodeBlocks() {
  const blocks = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)) blocks.push({ file: full, body: m[1] });
      }
    }
  };
  walk(SKILLS);
  return blocks;
}

test("no skill puts the freeze and the guard check in one code block, so neither runs in the other's shell call", () => {
  const blocks = skillCodeBlocks();
  const both = blocks.filter((b) => b.body.includes("--freeze") && b.body.includes("--assert-guard-live"));
  assert.deepEqual(both.map((b) => b.file), [], "the hook judges a call before it runs: a combined call leaves no row after the freeze");
  for (const skill of ["pipeline", "brownfield-guide"]) {
    const own = blocks.filter((b) => b.file.includes(`${skill}/SKILL.md`));
    assert.ok(own.some((b) => /write-contract\.mjs' --freeze/.test(b.body)), `${skill}: freezes at Gate 0`);
    assert.ok(own.some((b) => /write-contract\.mjs' --assert-guard-live/.test(b.body)), `${skill}: checks the guard after it`);
  }
});

test("no skill step tells a run to add to or append to an .env file, which the hook refuses once it exists", () => {
  const steps = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) {
        readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          if (/^\s*(?:\d+\.|[-*])\s*(?:Append|Add)\b[^\n]*`\.env/i.test(line)) steps.push(`${full}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(SKILLS);
  assert.deepEqual(steps, []);
});
