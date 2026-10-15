/**
 * Where a run's record lives: one folder per run, `<root>/.sdlc/runs/<run-id>/`,
 * and how `--resume` finds it again.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { isRunId, runDirFor, RUN_ID_RE } from "../scripts/lib/run-id.mjs";
import { parseDriverRecords } from "../mcp/model-dispatch/dist/driverUsage.js";

export { isRunId, runDirFor, RUN_ID_RE };

export const DRIVER_EVENTS = "driver-events.jsonl";
/** The record start-run.mjs keeps for a run started in a codex session. */
export const SESSION_RUN_RECORD = "run.json";

/** Files that only a run writes. A fresh run refuses a folder holding any of them. */
export const RUN_RECORD_FILES = [DRIVER_EVENTS, SESSION_RUN_RECORD, "SUMMARY.md", "manifest.json", "gates.jsonl", "telemetry.jsonl"];

function sessionRunHint(runDir, runId) {
  return (
    `run ${runId} already has a record from a codex session (${join(runDir, SESSION_RUN_RECORD)}); ` +
    `continue it from a session with start-run.mjs --resume=${runId}`
  );
}

/** A bad flag or a refusal before anything is spent: exit 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value) {
  return typeof value === "string" && THREAD_ID_RE.test(value);
}

const pad = (n) => String(n).padStart(2, "0");

/** `YYYYMMDD-HHMMSS-<intent|mode|run>-<6 hex>`, in UTC. */
export function generateRunId({ mode, intent, now = new Date(), rand = () => randomBytes(3).toString("hex") } = {}) {
  const d = now instanceof Date ? now : new Date(now);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}-${intent ?? mode ?? "run"}-${rand()}`;
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The run folder. `--output-dir` is a greenfield-only override that resolves
 * against the project root and must stay inside it: the workspace-write
 * sandbox lets the conductor write only there.
 */
export function resolveRunDir({ projectRoot, runId, outputDir, mode }) {
  const canonical = runDirFor(projectRoot, runId);
  if (outputDir === undefined || outputDir === null) return canonical;
  const p = resolve(projectRoot, outputDir);
  const sdlc = join(projectRoot, ".sdlc");
  if (p === projectRoot || p === sdlc) {
    throw new UsageError(
      `--output-dir=${outputDir} is the folder every run shares. Drop --output-dir; this run's folder is ${canonical}.`,
    );
  }
  if (!inside(projectRoot, p)) {
    throw new UsageError(
      `--output-dir=${outputDir} resolves to ${p}, outside --project-root ${projectRoot}. ` +
        "The conductor's sandbox can only write inside the project.",
    );
  }
  if (inside(sdlc, p) && p !== canonical) {
    throw new UsageError(
      `--output-dir=${outputDir} is inside .sdlc, which holds the project's shared state and the per-run folders. ` +
        `Drop --output-dir (this run's folder is ${canonical}), or name a folder outside .sdlc.`,
    );
  }
  if (mode !== "greenfield" && p !== canonical) {
    throw new UsageError(
      `--output-dir applies to --mode=greenfield only. A ${mode ?? "brownfield or unspecified"} run keeps its ` +
        `record at ${canonical}; drop --output-dir, or pass --mode=greenfield.`,
    );
  }
  return p;
}

/**
 * Generated code: `--code-dir` against the project root, else `<root>/src`
 * (greenfield) or `<root>` (brownfield, and a run with no mode, which the
 * driver handles as brownfield). It must stay inside the project, where the
 * sandbox lets the conductor write, and out of `.sdlc`.
 */
export function resolveCodeDir({ projectRoot, codeDir, mode }) {
  if (!codeDir) return mode === "greenfield" ? join(projectRoot, "src") : projectRoot;
  const p = resolve(projectRoot, codeDir);
  if (p !== projectRoot && !inside(projectRoot, p)) {
    throw new UsageError(
      `--code-dir=${codeDir} resolves to ${p}, outside --project-root ${projectRoot}. ` +
        "The conductor's sandbox can only write inside the project.",
    );
  }
  const sdlc = join(projectRoot, ".sdlc");
  if (p === sdlc || inside(sdlc, p)) {
    throw new UsageError(`--code-dir=${codeDir} is inside .sdlc, where run records live. Point it at the application's folder.`);
  }
  return p;
}

/**
 * A custom run folder and the code directory stay apart: run bookkeeping
 * never lands in the code directory, and code never lands in the run folder.
 * The canonical folder may sit inside a brownfield code directory (the repo).
 */
export function assertRunDirApart({ projectRoot, runId, runDir, codeDir }) {
  if (runDir === runDirFor(projectRoot, runId)) return;
  if (runDir === codeDir || inside(codeDir, runDir)) {
    throw new UsageError(
      `the run folder ${runDir} is inside the code directory ${codeDir}. Pick an --output-dir outside it, ` +
        "or drop --output-dir.",
    );
  }
  if (inside(runDir, codeDir)) {
    throw new UsageError(`the code directory ${codeDir} is inside the run folder ${runDir}. Pick a --code-dir outside it.`);
  }
}

export function readRunRecords(runDir) {
  const path = join(runDir, DRIVER_EVENTS);
  if (!existsSync(path)) return [];
  return parseDriverRecords(readFileSync(path, "utf-8"));
}

export function firstInvocationStart(records) {
  return records.find((r) => r.kind === "invocation_start" && !r.legacy) ?? null;
}

/**
 * Whether a resumed session was first told a run folder other than `runDir`:
 * `{from}`, where `from` is null for a thread this folder did not start (its
 * first prompt is not on record), or null when the folder is the one it was told.
 */
export function movedRunFolder(records, runDir, { foreignThread = false } = {}) {
  if (foreignThread) return { from: null };
  const first = firstInvocationStart(records);
  if (!first) return null;
  if (first.mode === "resume") return { from: null };
  return typeof first.output_dir === "string" && first.output_dir !== runDir ? { from: first.output_dir } : null;
}

/**
 * The settings a run started with (run_id, policy, run_mode, intent, gates,
 * code_dir, brief_path): its first invocation_start, else the run_end of a
 * driver that stopped before its first spawn.
 */
export function runSettings(records) {
  return firstInvocationStart(records) ?? records.find((r) => r.kind === "run_end" && !r.legacy && r.policy) ?? null;
}

/** The gate mode the latest driver process used. */
export function lastGateMode(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r.legacy && (r.kind === "invocation_start" || r.kind === "run_end") && typeof r.gates === "string") return r.gates;
  }
  return null;
}

/** The last thread id the record names, or null when no invocation got one. */
export function lastThreadId(records) {
  let id = null;
  for (const r of records) {
    if (r.kind === "codex" && r.event?.type === "thread.started" && typeof r.event.thread_id === "string") {
      id = r.event.thread_id;
    } else if ((r.kind === "codex" || r.kind === "invocation_end") && typeof r.thread_id === "string") {
      id = r.thread_id;
    }
  }
  return id;
}

function runDirs(projectRoot) {
  const root = join(projectRoot, ".sdlc", "runs");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isRunId(e.name) && existsSync(join(root, e.name, DRIVER_EVENTS)))
    .map((e) => join(root, e.name))
    .sort((a, b) => statSync(join(b, DRIVER_EVENTS)).mtimeMs - statSync(join(a, DRIVER_EVENTS)).mtimeMs);
}

/** The run folder whose record names this codex thread, newest first. */
export function findRunByThread(projectRoot, threadId) {
  for (const dir of runDirs(projectRoot)) {
    const records = readRunRecords(dir);
    const hit = records.some(
      (r) =>
        r.thread_id === threadId ||
        (r.kind === "codex" && r.event?.type === "thread.started" && r.event.thread_id === threadId),
    );
    if (hit) return { runDir: dir, records };
  }
  return null;
}

function refuseExistingRecord(runDir, runId) {
  if (existsSync(join(runDir, DRIVER_EVENTS))) {
    throw new UsageError(
      `run ${runId} already has a record at ${runDir}; continue it with --resume=${runId}, or choose a new --run-id.`,
    );
  }
  if (existsSync(join(runDir, SESSION_RUN_RECORD))) {
    throw new UsageError(`${sessionRunHint(runDir, runId)}, or choose a new --run-id.`);
  }
  const leftovers = RUN_RECORD_FILES.filter((f) => existsSync(join(runDir, f)));
  if (leftovers.length) {
    throw new UsageError(
      `${runDir} already holds ${leftovers.join(", ")} from an earlier run. Choose a new --run-id` +
        " (or a new --output-dir) so this run's record is its own.",
    );
  }
}

/**
 * Which run this invocation of the driver belongs to.
 *
 * Fresh: a new folder (generated id unless --run-id), refused when it already
 * holds a record. --resume=<x>: x is a run id with a record, or a codex thread
 * id found in some run's record. A thread id with no record anywhere starts a
 * new folder that resumes that thread; its earlier cost lives elsewhere.
 */
export function resolveRun({ projectRoot, resume, runIdFlag, outputDir, mode, intent, now, rand }) {
  if (runIdFlag !== undefined && !isRunId(runIdFlag)) {
    throw new UsageError(
      `--run-id=${runIdFlag} cannot name a folder: use letters, digits, '.', '_' and '-', not starting with '.'.`,
    );
  }

  if (resume === undefined || resume === null) {
    const runId = runIdFlag ?? generateRunId({ mode, intent, now, rand });
    const runDir = resolveRunDir({ projectRoot, runId, outputDir, mode });
    refuseExistingRecord(runDir, runId);
    return { runId, runDir, records: [], resume: null };
  }

  let found = null;
  if (outputDir !== undefined) {
    const dir = resolve(projectRoot, outputDir);
    const records = readRunRecords(dir);
    const first = runSettings(records);
    if (first && (first.run_id === resume || lastThreadId(records) === resume)) found = { runDir: dir, records };
  }
  if (!found && isRunId(resume)) {
    const dir = runDirFor(projectRoot, resume);
    const records = readRunRecords(dir);
    if (records.length) found = { runDir: dir, records };
  }
  if (!found && isThreadId(resume)) found = findRunByThread(projectRoot, resume);

  if (found) {
    const first = runSettings(found.records);
    const runId = first?.run_id ?? basename(found.runDir);
    if (runIdFlag !== undefined && runIdFlag !== runId) {
      throw new UsageError(`--run-id=${runIdFlag} does not match the run --resume=${resume} names (${runId}).`);
    }
    return {
      runId,
      runDir: found.runDir,
      records: found.records,
      resume: { threadId: lastThreadId(found.records), foreignThread: false },
    };
  }

  if (isThreadId(resume)) {
    const runId = runIdFlag ?? generateRunId({ mode, intent, now, rand });
    const runDir = resolveRunDir({ projectRoot, runId, outputDir, mode });
    refuseExistingRecord(runDir, runId);
    return { runId, runDir, records: [], resume: { threadId: resume, foreignThread: true } };
  }

  if (isRunId(resume) && existsSync(join(runDirFor(projectRoot, resume), SESSION_RUN_RECORD))) {
    throw new UsageError(`--resume=${resume}: ${sessionRunHint(runDirFor(projectRoot, resume), resume)}.`);
  }
  throw new UsageError(
    `--resume=${resume}: no run record under ${join(projectRoot, ".sdlc", "runs")} names it. ` +
      "Pass a run id (the folder name) or a codex thread id.",
  );
}
