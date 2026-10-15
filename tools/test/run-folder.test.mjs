/** One folder per run under <root>/.sdlc/runs/<run-id>/, and how --resume finds it again. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRunDirApart,
  generateRunId,
  isRunId,
  lastGateMode,
  resolveCodeDir,
  resolveRun,
  resolveRunDir,
  runSettings,
  UsageError,
} from "../../plugin/codex/run-folder.mjs";
import { RUN_ID_RE, runDirFor } from "../../plugin/scripts/lib/run-id.mjs";

const THREAD = "01a1340d-41da-7e31-84cd-b0907e9bc31f";

function project() {
  return mkdtempSync(join(tmpdir(), "run-folder-"));
}

function writeRecord(dir, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "driver-events.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function recordFor(runId, threadId = THREAD) {
  return [
    { v: 1, kind: "invocation_start", run_id: runId, invocation: 1, at: "2026-10-13T00:00:00.000Z", mode: "fresh", policy: "gpt-plus-flash", gates: "auto-approve" },
    { v: 1, kind: "codex", invocation: 1, thread_id: threadId, received_at: "2026-10-13T00:00:01.000Z", event: { type: "thread.started", thread_id: threadId } },
    { v: 1, kind: "invocation_end", invocation: 1, at: "2026-10-13T00:00:02.000Z", thread_id: threadId, exit_status: 0, ended_by: "exit" },
  ];
}

test("the run id module is the folder rule: no separator, no leading dot", () => {
  for (const bad of ["../x", "a/b", ".hidden", "", "a\\b", "x".repeat(101)]) assert.equal(isRunId(bad), false, bad);
  for (const good of ["pass1", "20261013-120000-bugfix-a7f3c1", THREAD, "r.1_a-b"]) assert.equal(isRunId(good), true, good);
  assert.equal(RUN_ID_RE.test("ok"), true);
  assert.equal(runDirFor("/p", "r1"), join("/p", ".sdlc", "runs", "r1"));
});

test("generateRunId is YYYYMMDD-HHMMSS-<intent|mode|run>-<6 hex>, in UTC", () => {
  const now = new Date("2026-10-13T07:08:09.000Z");
  assert.equal(generateRunId({ now, intent: "bugfix", rand: () => "a7f3c1" }), "20261013-070809-bugfix-a7f3c1");
  assert.equal(generateRunId({ now, mode: "greenfield", rand: () => "000000" }), "20261013-070809-greenfield-000000");
  assert.match(generateRunId(), /^\d{8}-\d{6}-[a-z-]+-[0-9a-f]{6}$/);
});

test("with no --output-dir the run folder is <root>/.sdlc/runs/<id>", () => {
  assert.equal(resolveRunDir({ projectRoot: "/p", runId: "r1" }), join("/p", ".sdlc", "runs", "r1"));
});

test("a relative --output-dir resolves against --project-root, not the shell's cwd", () => {
  assert.equal(
    resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir: "out/run1", mode: "greenfield" }),
    join("/p", "out", "run1"),
  );
});

test("--output-dir may not be the project root, the shared .sdlc, or outside the project", () => {
  for (const outputDir of [".sdlc", "/p/.sdlc", ".", "/p", "../elsewhere", "/tmp/x"]) {
    assert.throws(
      () => resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir, mode: "greenfield" }),
      UsageError,
      outputDir,
    );
  }
});

test("--output-dir is greenfield-only: brownfield and unspecified modes keep the canonical folder", () => {
  assert.throws(() => resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir: "out", mode: "brownfield" }), /greenfield only/);
  assert.throws(() => resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir: "out" }), /greenfield only/);
  assert.equal(
    resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir: ".sdlc/runs/r1", mode: "brownfield" }),
    join("/p", ".sdlc", "runs", "r1"),
    "naming the canonical folder is allowed in any mode",
  );
});

test("generated code defaults to <root>/src for greenfield and to the repo root for brownfield or no mode", () => {
  assert.equal(resolveCodeDir({ projectRoot: "/p", mode: "greenfield" }), join("/p", "src"));
  assert.equal(resolveCodeDir({ projectRoot: "/p" }), "/p", "a run with no mode is handled as brownfield");
  assert.equal(resolveCodeDir({ projectRoot: "/p", mode: "brownfield" }), "/p");
  assert.equal(resolveCodeDir({ projectRoot: "/p", codeDir: "app" }), join("/p", "app"));
  assert.equal(resolveCodeDir({ projectRoot: "/p", codeDir: "." }), "/p");
});

test("--code-dir must stay inside the project and out of .sdlc", () => {
  for (const codeDir of ["../sibling", "/elsewhere", ".sdlc", ".sdlc/runs/r1/app"]) {
    assert.throws(() => resolveCodeDir({ projectRoot: "/p", codeDir }), UsageError, codeDir);
  }
});

test("a fresh start into a folder that already holds a record is refused", () => {
  const root = project();
  try {
    writeRecord(runDirFor(root, "r1"), recordFor("r1"));
    assert.throws(() => resolveRun({ projectRoot: root, runIdFlag: "r1" }), /already has a record.*--resume=r1/);
    const legacy = join(root, "out");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SUMMARY.md"), "old run");
    assert.throws(
      () => resolveRun({ projectRoot: root, runIdFlag: "r2", outputDir: "out", mode: "greenfield" }),
      /already holds SUMMARY\.md/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bad --run-id is refused before it can name a path", () => {
  assert.throws(() => resolveRun({ projectRoot: "/p", runIdFlag: "../escape" }), UsageError);
});

test("--resume=<run-id> finds the folder and the last thread it recorded", () => {
  const root = project();
  try {
    writeRecord(runDirFor(root, "r1"), recordFor("r1"));
    const run = resolveRun({ projectRoot: root, resume: "r1" });
    assert.equal(run.runId, "r1");
    assert.equal(run.runDir, runDirFor(root, "r1"));
    assert.equal(run.resume.threadId, THREAD);
    assert.equal(run.resume.foreignThread, false);
    assert.throws(() => resolveRun({ projectRoot: root, resume: "r1", runIdFlag: "other" }), /does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--resume=<thread id> finds the run that recorded it", () => {
  const root = project();
  try {
    writeRecord(runDirFor(root, "r1"), recordFor("r1"));
    const run = resolveRun({ projectRoot: root, resume: THREAD });
    assert.equal(run.runId, "r1");
    assert.equal(run.resume.threadId, THREAD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--resume of a thread no run recorded opens a new folder that resumes it", () => {
  const root = project();
  try {
    const unknown = "01a1340e-168b-7322-a276-d1a40c7d59d8";
    const run = resolveRun({ projectRoot: root, resume: unknown, runIdFlag: "r9" });
    assert.equal(run.runDir, runDirFor(root, "r9"));
    assert.deepEqual(run.resume, { threadId: unknown, foreignThread: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--resume of something that is neither a recorded run nor a thread id is refused", () => {
  const root = project();
  try {
    assert.throws(() => resolveRun({ projectRoot: root, resume: "no-such-run" }), /no run record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--output-dir inside .sdlc must be the run's own canonical folder", () => {
  for (const outputDir of [".sdlc/local", ".sdlc/runs", ".sdlc/runs/other", ".sdlc/baseline/x"]) {
    assert.throws(
      () => resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir, mode: "greenfield" }),
      /inside \.sdlc/,
      outputDir,
    );
  }
  assert.equal(
    resolveRunDir({ projectRoot: "/p", runId: "r1", outputDir: ".sdlc/runs/r1", mode: "greenfield" }),
    join("/p", ".sdlc", "runs", "r1"),
  );
});

test("a custom run folder and the code directory stay apart", () => {
  const apart = (runDir, codeDir) => assertRunDirApart({ projectRoot: "/p", runId: "r1", runDir, codeDir });
  assert.throws(() => apart("/p/src", "/p/src"), /inside the code directory/);
  assert.throws(() => apart("/p/src/records", "/p/src"), /inside the code directory/);
  assert.throws(() => apart("/p/records", "/p"), /inside the code directory/, "a code dir at the root leaves only the canonical folder");
  assert.throws(() => apart("/p/app", "/p/app/src"), /inside the run folder/);
  apart("/p/records", "/p/src");
  apart(join("/p", ".sdlc", "runs", "r1"), "/p");
});

test("runSettings falls back to a run_end that stopped the run before its first spawn", () => {
  const capped = [{ v: 1, kind: "run_end", outcome: "cost_cap", run_id: "r2", policy: "gpt-seat-plus-flash", run_mode: "greenfield", gates: "auto-approve" }];
  assert.equal(runSettings(capped).policy, "gpt-seat-plus-flash");
  assert.equal(lastGateMode(capped), "auto-approve");
  const full = recordFor("r1");
  assert.equal(runSettings(full).kind, "invocation_start");
  assert.equal(lastGateMode([...full, { v: 1, kind: "run_end", outcome: "aborted", gates: "auto-abort" }]), "auto-abort");
  assert.equal(runSettings([]), null);
  assert.equal(lastGateMode([]), null);
});

test("--resume finds a custom --output-dir whose record holds only a run_end", () => {
  const root = project();
  try {
    const dir = join(root, "records", "r2");
    writeRecord(dir, [{ v: 1, kind: "run_end", outcome: "cost_cap", run_id: "r2", policy: "gpt-plus-flash" }]);
    const run = resolveRun({ projectRoot: root, resume: "r2", outputDir: "records/r2" });
    assert.equal(run.runId, "r2");
    assert.equal(run.runDir, dir);
    assert.equal(run.resume.threadId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
