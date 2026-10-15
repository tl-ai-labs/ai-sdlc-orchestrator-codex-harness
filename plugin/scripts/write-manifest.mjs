#!/usr/bin/env node
/**
 * Writes a run's manifest.json from its own records (telemetry.jsonl,
 * gates.jsonl, driver-usage.json, driver-manifest.json) with the bridge's
 * buildManifest, and, with --summary, renders SUMMARY.md from it.
 *
 * Usage:
 *   node write-manifest.mjs <run-dir> --run-id=<id> --policy=<name>
 *        [--project-root=<dir>] [--code-dir=<dir>]
 *        [--status=provisional|accepted|auto-approved|rejected] [--summary]
 *
 * `--k v` works as well as `--k=v`, and `--pass` is another name for
 * `--run-id`. Exit 0 written, 1 failed, 2 usage error.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../mcp/model-dispatch/dist/telemetry.js";
import { costProvenance } from "./lib/cost-provenance.mjs";
import { driverUsageIsFresh } from "./lib/driver-usage-fresh.mjs";
import { productCounts } from "./lib/product-count.mjs";
import { isRunId } from "./lib/run-id.mjs";
import { gateDecision } from "./lib/gate-record.mjs";
import { ACCEPTED_STATUSES, codeWrittenSummary, isCodeWritten, MANIFEST_WRITER, renderRunSummary, sha256 } from "./lib/run-summary.mjs";

export { ACCEPTED_STATUSES, codeWrittenSummary, MANIFEST_WRITER };
export const SCHEMA_VERSION = 1;

/** What the conductor may pass: the state of the final acceptance. */
export const CONDUCTOR_STATUSES = ["provisional", "accepted", "auto-approved", "rejected"];
/** What run.mjs writes when a run ends any other way (run-finalize.mjs maps outcomes to these). */
export const RUN_STATUSES = ["incomplete", "aborted", "halted", "refused", "stopped", "cost_cap", "failed", "pin_rejected", "interrupted"];

/** A gate line as recorded, with its answer under `decision` even when the conductor wrote `status`. */
function manifestGate(row) {
  if (row === null || typeof row !== "object" || Array.isArray(row) || row.decision !== undefined) return row;
  const decision = gateDecision(row);
  return decision ? { ...row, decision } : row;
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const FLAGS = { value: ["run-id", "pass", "policy", "project-root", "code-dir", "status"], boolean: ["summary"] };

export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    if (!raw.startsWith("--")) {
      if (a.runDir !== undefined) throw new UsageError(`unexpected extra argument '${raw}'`);
      a.runDir = raw;
      continue;
    }
    const eq = raw.indexOf("=");
    let name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (FLAGS.boolean.includes(name)) {
      const v = eq === -1 ? "true" : raw.slice(eq + 1);
      if (v !== "true" && v !== "false") throw new UsageError(`--${name} takes no value`);
      a[name] = v === "true";
      continue;
    }
    if (!FLAGS.value.includes(name)) throw new UsageError(`unknown flag --${name}`);
    let value = eq === -1 ? argv[i + 1] : raw.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || String(value).startsWith("--")) throw new UsageError(`--${name} needs a value`);
      i += 1;
    }
    if (String(value) === "") throw new UsageError(`--${name} needs a value`);
    if (name === "pass") name = "run-id";
    if (a[name] !== undefined) throw new UsageError(`--${name} is given more than once`);
    a[name] = String(value);
  }
  if (!a.runDir) throw new UsageError("the run folder is missing");
  if (!a["run-id"]) throw new UsageError("--run-id is missing");
  if (!a.policy) throw new UsageError("--policy is missing");
  if (a.status !== undefined && !CONDUCTOR_STATUSES.includes(a.status)) {
    throw new UsageError(`--status=${a.status} is not one of ${CONDUCTOR_STATUSES.join(", ")}`);
  }
  return {
    runDir: a.runDir,
    runId: a["run-id"],
    policy: a.policy,
    projectRoot: a["project-root"],
    codeDir: a["code-dir"],
    status: a.status,
    summary: a.summary === true,
  };
}

function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function readJsonLines(path) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { rows: [], skipped: 0 };
  }
  const rows = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const finite = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const NUMERIC = ["cost_usd", "input_tokens", "input_tokens_cached", "output_tokens"];

/** Telemetry events buildManifest can sum: a `ts` to sort on and finite numbers; a missing figure counts as 0 and is noted. */
function usableEvents(rows, notes) {
  const events = [];
  let noTs = 0;
  let noFigure = 0;
  for (const r of rows) {
    if (typeof r.ts !== "string") {
      noTs++;
      continue;
    }
    const e = { ...r };
    for (const k of NUMERIC) {
      if (finite(e[k]) === null) {
        if (k === "cost_usd") noFigure++;
        e[k] = 0;
      }
    }
    events.push(e);
  }
  if (noTs) notes.push(`${noTs} telemetry event(s) without a ts left out`);
  if (noFigure) notes.push(`${noFigure} telemetry event(s) carry no cost_usd; each is counted as $0`);
  return events;
}

/**
 * Dispatched cost by provenance (a seat adapter's floor is modeled, as in
 * the cost report) in micro-dollars, the unit buildManifest
 * rounds `total_cost_usd` to. Each bucket is its raw sum rounded down, and
 * the micro-dollars left over go to the buckets with the largest remainders,
 * so the buckets add up to `totalUsd` (default: the rounded sum) exactly.
 */
export function byProvenance(events, totalUsd) {
  const raw = { vendor: 0, estimated: 0, modeled: 0, none: 0, unlabelled: 0 };
  let sum = 0;
  for (const e of events) {
    raw[costProvenance(e) ?? "unlabelled"] += e.cost_usd;
    sum += e.cost_usd;
  }
  const keys = Object.keys(raw);
  const micro = Object.fromEntries(keys.map((k) => [k, Math.floor(raw[k] * 1e6)]));
  const rest = (k) => raw[k] * 1e6 - micro[k];
  const left = Math.round((totalUsd ?? sum) * 1e6) - keys.reduce((s, k) => s + micro[k], 0);
  if (left >= 0 && left <= keys.length) {
    for (const k of keys.slice().sort((a, b) => rest(b) - rest(a)).slice(0, left)) micro[k] += 1;
  } else {
    micro[keys.reduce((a, b) => (Math.abs(raw[b]) > Math.abs(raw[a]) ? b : a))] += left;
  }
  return Object.fromEntries(keys.map((k) => [k, micro[k] / 1e6]));
}

function driverBlock(dm) {
  if (!dm) return null;
  return {
    codex_invocations: dm.codex_invocations ?? null,
    driver_turns: dm.driver_turns ?? null,
    driver_turns_incomplete: dm.driver_turns_incomplete ?? null,
    driver_turns_incomplete_covered: dm.driver_turns_incomplete_covered ?? null,
    driver_cost_usd_modeled: finite(dm.driver_cost_usd_modeled),
    driver_cost_complete: dm.driver_cost_complete ?? null,
    outcome: dm.outcome ?? null,
    outcome_reason: dm.outcome_reason ?? null,
    exit_code: dm.exit_code ?? null,
    thread_ids: Array.isArray(dm.thread_ids) ? dm.thread_ids : [],
    pin: dm.pin ?? null,
    driver_auth: dm.driver_auth ?? null,
    driver_price: dm.driver_price ?? null,
    price_list_verified: dm.price_list_verified ?? null,
    driver_cost_source: dm.driver_cost_source ?? null,
    driver_verified: typeof dm.driver_verified === "boolean" ? dm.driver_verified : null,
  };
}

/**
 * Turns missing from driver-usage.json's figure: invocations after a thread's
 * last reported total, on threads it booked from the exec stream. The session
 * file prices the turns of every other thread. Null when the file names no threads.
 */
function unpricedIncompleteTurns(usage) {
  if (!Array.isArray(usage.threads)) return null;
  const fromStream = new Set(usage.threads.filter((t) => t?.booked_from === "exec-stream").map((t) => t.thread_id));
  const checks = Array.isArray(usage.cross_check?.threads) ? usage.cross_check.threads : [];
  return checks
    .filter((t) => fromStream.has(t?.thread_id))
    .reduce((n, t) => n + (Number.isInteger(t.unreported_invocations) ? t.unreported_invocations : 0), 0);
}

/** Incomplete turns no later running total on their thread carries: the ones missing from driver-manifest.json's figure. */
function uncoveredIncompleteTurns(dm) {
  if (!Number.isInteger(dm.driver_turns_incomplete)) return null;
  const covered = Number.isInteger(dm.driver_turns_incomplete_covered) ? dm.driver_turns_incomplete_covered : 0;
  return Math.max(0, dm.driver_turns_incomplete - covered);
}

/**
 * The conductor's modeled cost: the session collector's driver-usage.json,
 * which books the session file where the exec stream disagrees with it, else
 * run.mjs's driver-manifest.json. The cost report reads them in the same
 * order, and both pass over a driver-usage.json a resumed run has spent past.
 */
function driverTotals(runDir, dm) {
  const usage = readJson(join(runDir, "driver-usage.json"));
  const stale = usage && !driverUsageIsFresh(runDir, usage) && dm && finite(dm.driver_cost_usd_modeled) !== null;
  if (usage && !stale && finite(usage.cost_usd_modeled) !== null) {
    return {
      driver_cost_usd_modeled: usage.cost_usd_modeled,
      driver_turns_incomplete: unpricedIncompleteTurns(usage),
      driver_cost_source: "driver-usage.json",
      driver_usage: {
        cost_source: typeof usage.cost_source === "string" ? usage.cost_source : null,
        verified: typeof usage.verified === "boolean" ? usage.verified : null,
        cost_complete: typeof usage.cost_complete === "boolean" ? usage.cost_complete : null,
        unpriced: Array.isArray(usage.unpriced) ? usage.unpriced : [],
      },
    };
  }
  if (dm && finite(dm.driver_cost_usd_modeled) !== null) {
    return {
      driver_cost_usd_modeled: dm.driver_cost_usd_modeled,
      driver_turns_incomplete: uncoveredIncompleteTurns(dm),
      driver_cost_source: "driver-manifest.json",
      driver_usage: null,
    };
  }
  return { driver_cost_usd_modeled: null, driver_turns_incomplete: null, driver_cost_source: null, driver_usage: null };
}

function defaultProjectRoot(runDir) {
  const parts = runDir.split(sep);
  const n = parts.length;
  if (n >= 4 && parts[n - 3] === ".sdlc" && parts[n - 2] === "runs") return parts.slice(0, n - 3).join(sep) || sep;
  return process.cwd();
}

/**
 * Builds and writes manifest.json; with `summary`, SUMMARY.md first. A
 * summary that cannot be written leaves a note and the manifest stands.
 * Returns {manifestPath, summaryPath, manifest, events, notes}.
 */
export function writeManifest({ runDir, runId, policy, projectRoot, codeDir, status, summary = false, now = () => new Date() }) {
  if (!runDir) throw new UsageError("the run folder is missing");
  if (!isRunId(runId)) throw new UsageError(`--run-id=${runId} is not a run id`);
  if (typeof policy !== "string" || !policy) throw new UsageError("--policy is missing");
  if (status !== undefined && status !== null && ![...CONDUCTOR_STATUSES, ...RUN_STATUSES].includes(status)) {
    throw new UsageError(`status '${status}' is not one of ${[...CONDUCTOR_STATUSES, ...RUN_STATUSES].join(", ")}`);
  }
  const dir = resolve(runDir);
  if (!existsSync(dir)) throw new UsageError(`run folder ${dir} does not exist`);
  const parent = basename(dirname(dir));
  if (parent === "runs" && basename(dirname(dirname(dir))) === ".sdlc" && basename(dir) !== runId) {
    throw new UsageError(`--run-id=${runId} does not match the run folder ${dir} (run ${basename(dir)})`);
  }
  const root = resolve(projectRoot ?? defaultProjectRoot(dir));
  const notes = [];

  const telemetry = readJsonLines(join(dir, "telemetry.jsonl"));
  if (telemetry.skipped) notes.push(`${telemetry.skipped} telemetry.jsonl line(s) could not be read and are left out`);
  const events = usableEvents(telemetry.rows, notes);
  const gates = readJsonLines(join(dir, "gates.jsonl"));
  if (gates.skipped) notes.push(`${gates.skipped} gates.jsonl line(s) could not be read and are left out`);

  let artifacts;
  if (codeDir) {
    try {
      const { counts, note } = productCounts({ codeDir: resolve(root, codeDir), runDir: dir, projectRoot: root });
      if (counts) artifacts = { files: counts.files, loc: counts.loc };
      if (note) notes.push(note);
    } catch (e) {
      notes.push(`file counts left out: ${e?.message ?? e}`);
    }
  } else {
    notes.push("file counts left out: no --code-dir was given");
  }

  const manifestPath = join(dir, "manifest.json");
  const existing = readJson(manifestPath);
  const kept = isCodeWritten(existing) && CONDUCTOR_STATUSES.includes(existing.status) ? existing.status : null;
  const dm = readJson(join(dir, "driver-manifest.json"));
  const { pass, policy_name, ...rollups } = buildManifest(events, { pass: runId, policy_name: policy });
  // buildManifest leaves `artifacts` out of a manifest with no events, so they are set below either way.
  delete rollups.artifacts;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    written_by: MANIFEST_WRITER,
    written_at: now().toISOString(),
    status: status ?? kept ?? "provisional",
    route: existsSync(join(dir, "driver-events.jsonl")) ? "headless" : "interactive",
    run_id: runId,
    pass,
    policy,
    policy_name,
    started_at: rollups.started_at,
    ended_at: rollups.ended_at,
    duration_sec: rollups.duration_sec,
    total_cost_usd: rollups.total_cost_usd,
    totals: {
      dispatched_cost_usd: rollups.total_cost_usd,
      by_provenance: byProvenance(events, rollups.total_cost_usd),
      ...driverTotals(dir, dm),
    },
    ...rollups,
    ...(artifacts ? { artifacts } : {}),
    gates: gates.rows.map(manifestGate),
    driver: driverBlock(dm),
    summary: null,
    notes,
  };

  let summaryPath = null;
  if (summary) {
    try {
      const text = renderRunSummary(manifest, { runDir: dir });
      writeAtomic(join(dir, "SUMMARY.md"), text);
      summaryPath = join(dir, "SUMMARY.md");
      manifest.summary = { path: "SUMMARY.md", sha256: sha256(text), written_at: manifest.written_at };
    } catch (e) {
      notes.push(`SUMMARY.md was not written: ${e?.message ?? e}`);
    }
  }
  // The SUMMARY.md on disk is still the one the previous manifest describes.
  if (!manifest.summary && existing?.summary?.sha256 && codeWrittenSummary(dir).ok) manifest.summary = existing.summary;
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, summaryPath, manifest, events: events.length, notes };
}

export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  try {
    const r = writeManifest(parseArgs(argv));
    const m = r.manifest;
    io.out.write(
      `manifest written: ${r.manifestPath} — dispatched $${m.totals.dispatched_cost_usd} over ${r.events} event(s), ${m.gates.length} gate line(s), status ${m.status}\n`,
    );
    if (r.summaryPath) io.out.write(`summary written: ${r.summaryPath}\n`);
    for (const n of r.notes) io.out.write(`note: ${n}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err.write(`write-manifest: ${e.message}\n`);
      io.err.write("usage: node write-manifest.mjs <run-dir> --run-id=<id> --policy=<name> [--project-root=<dir>] [--code-dir=<dir>] [--status=<status>] [--summary]\n");
      return 2;
    }
    io.err.write(`write-manifest failed: ${e?.message ?? e}\n`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1] ?? ""));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main();
