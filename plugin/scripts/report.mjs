#!/usr/bin/env node
/**
 * Post-run cost report for one run folder. Money comes only from
 * telemetry.jsonl and the driver files; manifest.json and
 * driver-manifest.json supply identity and status, never a cost.
 *
 * Usage: node plugin/scripts/report.mjs <run-folder | project .sdlc> [--markdown | --json]
 */

import {
  closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTOR, ACTOR_LEGEND, gutter } from "./lib/actors.mjs";
import { costProvenance } from "./lib/cost-provenance.mjs";
import { driverUsageIsFresh } from "./lib/driver-usage-fresh.mjs";

export const REPORT_SCRIPT = fileURLToPath(import.meta.url);

/** Phases that produce SDLC output, in pipeline order. Every other phase is runner overhead. */
export const SDLC_PHASES = [
  "discovery", "requirements_analysis", "architecture_design", "change_plan", "plan_task_packets",
  "codegen", "tests", "docs", "test_run", "senior_code_review", "security_review",
];
const OVERHEAD_ORDER = ["debug", "refactor", "final_report", "driver_loop"];
const OVERHEAD_NOTE = "Runner overhead is dispatched work outside the SDLC phases: debug retries, refactor passes, the final report, and any phase the bridge does not name.";
const PROVENANCES = ["vendor", "estimated", "modeled", "none", "unknown"];

export const RUN_TOTAL_LABEL = "Run total = dispatched + driver";

/** Files that make a folder a run folder. manifest.json is left out: a project root can have its own. */
const RUN_MARKERS = ["telemetry.jsonl", "driver-cost-modeled.jsonl", "driver-usage.json", "driver-events.jsonl", "driver-manifest.json"];

// ─── input ────────────────────────────────────────────────────────────

function readJsonl(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((v) => v && typeof v === "object" && !Array.isArray(v));
}

function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : 0);
const count = (v) => (Array.isArray(v) ? v.length : Number.isInteger(v) && v >= 0 ? v : undefined);
const strings = (v) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))] : []);
// Money is summed in integer micro-dollars so the parts add up to the totals exactly.
const micros = (v) => (isNum(v) ? Math.round(v * 1e6) : 0);
const dollars = (m) => (m == null ? null : m / 1e6);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function readRun(runDir) {
  const at = (name) => join(runDir, name);
  let receipts = [];
  try {
    receipts = readdirSync(at("delegation"))
      .filter((n) => n.startsWith("worker-delegation-") && n.endsWith(".json"))
      .sort()
      .map((n) => readJson(join(at("delegation"), n)))
      .filter((r) => r && Object.keys(r).length > 0);
  } catch { /* no delegation folder */ }
  const driverUsage = readJson(at("driver-usage.json"));
  return {
    runDir,
    events: readJsonl(at("telemetry.jsonl")),
    driverRows: readJsonl(at("driver-cost-modeled.jsonl")),
    driverFile: isFile(at("driver-cost-modeled.jsonl")),
    driverUsage,
    driverUsageFresh: driverUsageIsFresh(runDir, driverUsage),
    driverStream: readJsonl(at("driver-events.jsonl")),
    manifest: readJson(at("manifest.json")) ?? {},
    driverManifest: readJson(at("driver-manifest.json")) ?? {},
    runJson: readJson(at("run.json")) ?? {},
    receipts,
    selected: null,
  };
}

const usableUsage = (u) => (u && isNum(u.cost_usd_modeled) ? u : null);

/** True when the folder holds anything a report can describe, even a run that stopped before its first priced turn. */
export function hasRunData(run) {
  return run.events.length > 0 || run.driverFile || usableUsage(run.driverUsage) != null
    || run.driverStream.length > 0 || Object.keys(run.driverManifest ?? {}).length > 0;
}

const hasRunFiles = (dir) => RUN_MARKERS.some((f) => existsSync(join(dir, f)));

function listRuns(runsDir) {
  let entries;
  try { entries = readdirSync(runsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ id: e.name, dir: join(runsDir, e.name) }))
    .filter((r) => hasRunFiles(r.dir))
    .map((r) => ({ ...r, started: startedAt(r.dir) }))
    .sort((a, b) => b.started - a.started || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const EDGE_BYTES = 64 * 1024;

/** The first or last complete JSON line of a file, read without loading all of it. */
function edgeLine(path, which) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, EDGE_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, which === "first" ? 0 : size - len);
    let lines = buf.toString("utf8").split("\n");
    // A cut at the window's edge leaves a partial line there; drop it.
    if (len < size) lines = which === "first" ? lines.slice(0, -1) : lines.slice(1);
    const ordered = which === "first" ? lines : lines.reverse();
    for (const l of ordered) {
      if (!l.trim()) continue;
      try { const v = JSON.parse(l); if (v && typeof v === "object") return v; } catch { /* torn line */ }
    }
  } catch { /* unreadable */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

const timeOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** When a run started: its driver manifest or run.json, else manifest.json, else its first recorded event, else file times. */
function startedAt(dir) {
  for (const name of ["driver-manifest.json", "run.json", "manifest.json"]) {
    const t = timeOf(readJson(join(dir, name))?.started_at);
    if (t != null) return t;
  }
  const first = edgeLine(join(dir, "driver-events.jsonl"), "first");
  const recorded = timeOf(first?.at) ?? timeOf(first?.received_at)
    ?? timeOf(edgeLine(join(dir, "telemetry.jsonl"), "first")?.ts)
    ?? timeOf(edgeLine(join(dir, "driver-cost-modeled.jsonl"), "first")?.ts);
  if (recorded != null) return recorded;
  const times = RUN_MARKERS.map((f) => { try { return statSync(join(dir, f)).mtimeMs; } catch { return Infinity; } });
  const earliest = Math.min(...times);
  return Number.isFinite(earliest) ? earliest : 0;
}

/** The last time a folder's own run files record, for a legacy .sdlc that predates runs/. */
function lastRecordedAt(dir) {
  const d = readJson(join(dir, "driver-manifest.json"));
  const times = [
    timeOf(d?.ended_at), timeOf(d?.started_at), timeOf(readJson(join(dir, "manifest.json"))?.started_at),
    timeOf(edgeLine(join(dir, "telemetry.jsonl"), "last")?.ts),
    timeOf(edgeLine(join(dir, "driver-cost-modeled.jsonl"), "last")?.ts),
    timeOf(edgeLine(join(dir, "driver-events.jsonl"), "last")?.at),
  ].filter((t) => t != null);
  return times.length ? Math.max(...times) : startedAt(dir);
}

/**
 * A run folder reports itself. A project's .sdlc (holding `runs/`) reports
 * the run that started last; a project root is read as its .sdlc, and a
 * folder of run folders (.sdlc/runs itself) reports its latest. A legacy
 * .sdlc with run files of its own reports them only when they are newer
 * than every run under runs/.
 */
export function locateRun(dir) {
  const sdlc = join(dir, ".sdlc");
  if (!hasRunFiles(dir) && isDir(sdlc)) {
    const inner = locateRun(sdlc);
    if (hasRunFiles(inner.runDir)) return { runDir: inner.runDir, selected: inner.selected ?? { rule: "sdlc", runs_dir: null, runs: 0 } };
  }
  const runsDir = join(dir, "runs");
  const runs = isDir(runsDir) ? listRuns(runsDir) : [];
  const latest = { rule: "latest", runs_dir: runsDir, runs: runs.length };
  if (hasRunFiles(dir)) {
    if (!runs.length) return { runDir: dir, selected: null };
    if (lastRecordedAt(dir) > runs[0].started) {
      return { runDir: dir, selected: { rule: "folder", runs_dir: runsDir, runs: runs.length } };
    }
    return { runDir: runs[0].dir, selected: { ...latest, older_folder_files: true } };
  }
  if (runs.length) return { runDir: runs[0].dir, selected: latest };
  const children = listRuns(dir);
  if (children.length) return { runDir: children[0].dir, selected: { rule: "latest", runs_dir: dir, runs: children.length } };
  return { runDir: dir, selected: null };
}

// ─── identity ─────────────────────────────────────────────────────────

/**
 * driver-manifest.json is written by run.mjs; manifest.json may be
 * model-written, so it ranks second. Both manifest spellings are read:
 * `run_id`/`policy` (what runs write) and `pass`/`policy_name` (buildManifest).
 */
export function identity(run) {
  const m = run.manifest ?? {};
  const d = run.driverManifest ?? {};
  const policyOf = (x) => str(x?.policy) ?? str(x?.policy?.name) ?? str(x?.policy_name);
  const firstEvent = (pick) => {
    for (const e of run.events) { const v = pick(e); if (v) return v; }
    return undefined;
  };
  const policySources = [
    ["driver-manifest.json", policyOf(d)],
    ["manifest.json", policyOf(m)],
    // Never driver-cost-modeled.jsonl: older runs hard-code its policy name.
    ["telemetry.jsonl", firstEvent((e) => str(e.routing?.policy_name))],
  ].filter(([, v]) => v).map(([source, policy]) => ({ source, policy }));
  const rj = run.runJson ?? {};
  const wallSec = (x) => (Date.parse(x.ended_at) - Date.parse(x.started_at)) / 1000;
  const positive = (v) => (isNum(v) && v > 0 ? v : undefined);
  const exitCode = [d.exit_code, m.exit_code, m.driver?.exit_code].find(Number.isInteger);
  const usageWindow = run.driverUsage?.window && typeof run.driverUsage.window === "object" ? run.driverUsage.window : {};
  const windowFrom = [
    ["driver-manifest.json", str(d.started_at), str(d.ended_at)],
    ["run.json", str(rj.started_at), str(rj.ended_at)],
    ["driver-usage.json", str(usageWindow.start), str(usageWindow.end)],
  ].find(([, start]) => start);
  return {
    run_window: windowFrom ? { start: windowFrom[1], end: windowFrom[2] ?? null, source: windowFrom[0] } : null,
    driver_price: d.driver_price && typeof d.driver_price === "object" ? d.driver_price : null,
    price_list_verified: str(d.price_list_verified) ?? str(run.driverUsage?.price_list_verified) ?? null,
    run_id: str(d.run_id) ?? str(m.run_id) ?? str(m.pass) ?? str(m.pass_id) ?? firstEvent((e) => str(e.pass)) ?? basename(run.runDir),
    policy: policySources[0]?.policy ?? null,
    policy_sources: policySources,
    policy_disagreement: new Set(policySources.map((s) => s.policy)).size > 1,
    // manifest.json's start is its first dispatch, or the moment it was written when nothing was dispatched.
    started_at: str(d.started_at) ?? str(rj.started_at) ?? str(m.started_at) ?? null,
    duration_sec: positive(wallSec(d)) ?? positive(wallSec(rj)) ?? positive(m.duration_sec) ?? positive(m.total_wall_clock_sec) ?? null,
    outcome: str(d.outcome) ?? str(m.outcome) ?? str(m.driver?.outcome) ?? null,
    outcome_reason: str(d.outcome_reason) ?? str(m.outcome_reason) ?? str(m.driver?.outcome_reason) ?? null,
    exit_code: exitCode ?? null,
    pin: d.pin && typeof d.pin === "object" ? d.pin : null,
    driver_auth: str(d.driver_auth) ?? str(m.driver?.driver_auth) ?? null,
  };
}

// ─── aggregation ──────────────────────────────────────────────────────

/**
 * Turns that started and never completed, per invocation (v1) or per
 * thread.started segment (legacy), keyed by the thread they ran on.
 */
function streamIncompleteTurns(lines) {
  const segments = new Map();
  const segment = (key) => {
    if (!segments.has(key)) segments.set(key, { thread: null, started: 0, completed: 0, endDeficit: 0 });
    return segments.get(key);
  };
  let legacy = 0;
  for (const line of lines) {
    // driver-events.jsonl v1 wraps each codex event; legacy files hold bare events.
    const v1 = line.v === 1;
    const ev = v1 ? (line.kind === "codex" ? line.event : null) : line;
    if (!v1 && ev?.type === "thread.started") legacy += 1;
    const seg = segment(v1 ? `inv:${line.invocation ?? "?"}` : `legacy:${legacy}`);
    seg.thread = str(ev?.type === "thread.started" ? ev.thread_id : undefined) ?? (v1 ? str(line.thread_id) : undefined) ?? seg.thread;
    if (v1 && line.kind === "invocation_end" && line.turns && typeof line.turns === "object") {
      seg.endDeficit = Math.max(seg.endDeficit, num(line.turns.started) - num(line.turns.completed));
    }
    if (ev?.type === "turn.started") seg.started += 1;
    else if (ev?.type === "turn.completed") seg.completed += 1;
  }
  const byThread = {};
  let total = 0;
  for (const seg of segments.values()) {
    const n = Math.max(0, seg.started - seg.completed, seg.endDeficit);
    if (!n) continue;
    total += n;
    byThread[seg.thread ?? ""] = (byThread[seg.thread ?? ""] ?? 0) + n;
  }
  return { total, byThread };
}

const SOURCE_TEXT = {
  "exec-stream": "codex exec --json turn usage",
  "session-file": "codex session file",
  mixed: "codex session file, and the exec stream for threads with no session file",
};

function describeUnpriced(v) {
  const one = (e) => {
    if (typeof e === "string") return e;
    if (!e || typeof e !== "object") return undefined;
    const turns = count(e.turns);
    const detail = [turns != null ? plural(turns, "turn") : null, str(e.reason)].filter(Boolean).join("; ");
    return `${str(e.model) ?? "unnamed model"}${detail ? ` (${detail})` : ""}`;
  };
  if (Array.isArray(v)) return v.map(one).filter(Boolean);
  if (v && typeof v === "object") return Object.keys(v);
  if (Number.isInteger(v) && v > 0) return [`${plural(v, "turn")} on an unpriced model`];
  return [];
}

/** Cross-check verdicts of driver-usage.json (sessionUsage.ts CrossCheckVerdict) that count as verified. */
const VERIFIED_VERDICTS = new Set(["equal", "equal_with_explained_gap"]);

/** Qualifiers the collector writes into cost_source. */
const COST_SOURCE_QUALIFIERS = [
  ["INCOMPLETE", /\bINCOMPLETE\b/],
  ["LOWER BOUND", /\bLOWER BOUND\b/],
  ["PROVISIONAL", /\bPROVISIONAL\b/],
  ["WHOLE THREAD", /\bWHOLE THREAD\b/],
  ["UPPER BOUND", /\bupper bound\b/i],
  ["TIER UNVERIFIED", /\bTIER UNVERIFIED\b/],
];

/** The buckets the exec stream and the session file are compared on; cache writes only when either side has any. */
const CHECK_BUCKETS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

function bucketRows(exec, session) {
  const has = (k) => num(exec?.[k]) !== 0 || num(session?.[k]) !== 0;
  const keys = [...CHECK_BUCKETS, ...(has("cache_write_input_tokens") ? ["cache_write_input_tokens"] : [])];
  return keys.map((bucket) => {
    const e = exec && isNum(exec[bucket]) ? exec[bucket] : null;
    const x = session && isNum(session[bucket]) ? session[bucket] : null;
    return { bucket, exec_stream: e, session_file: x, difference: e == null || x == null ? null : x - e };
  });
}

/**
 * The cross-check as token counts: each thread's exec-stream total against
 * what the session file books for it, and each invocation's exec-stream
 * share against the session-file responses inside it. Difference is session
 * file minus exec stream; `note` says what explains an invocation's.
 */
function tokenCheck(cc) {
  if (!cc || typeof cc !== "object" || !Array.isArray(cc.threads)) return null;
  return {
    verdict: verdictOf(cc) ?? null,
    verified: typeof cc.verified === "boolean" ? cc.verified : VERIFIED_VERDICTS.has(verdictOf(cc)),
    threads: cc.threads.filter((t) => t && typeof t === "object").map((t) => ({
      thread_id: str(t.thread_id) ?? null,
      verdict: str(t.verdict) ?? null,
      buckets: bucketRows(t.exec_stream_tokens, t.session_tokens),
    })),
    invocations: (Array.isArray(cc.invocations) ? cc.invocations : []).filter((i) => i && typeof i === "object").map((i) => ({
      invocation: i.invocation ?? null,
      thread_id: str(i.thread_id) ?? null,
      status: str(i.status) ?? null,
      note: str(i.reason) ?? null,
      buckets: bucketRows(i.exec_delta, i.session_turn_tokens),
    })),
  };
}

function verificationOf(costSource, verifiedFlag, cc) {
  const verdict = cc && typeof cc === "object" ? verdictOf(cc) : undefined;
  const verified = typeof verifiedFlag === "boolean" ? verifiedFlag
    : typeof cc?.verified === "boolean" ? cc.verified
    : verdict ? VERIFIED_VERDICTS.has(verdict) : null;
  const qualifiers = costSource
    ? COST_SOURCE_QUALIFIERS.map(([q, re]) => [q, costSource.search(re)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]).map(([q]) => q)
    : [];
  if (verified == null && !qualifiers.length) return null;
  return { verified: verified === true, qualifiers };
}

/** driver-usage.json excluded_threads, as the report shows them. */
function excludedThreads(v) {
  return (Array.isArray(v) ? v : [])
    .filter((e) => e && str(e.thread_id))
    .map((e) => ({ thread_id: str(e.thread_id), reason: str(e.reason) ?? null, conductor_turns_left_out: e.conductor_turns_left_out === true }));
}

const excludedText = (list) => list.map((e) => `${e.thread_id}${e.reason ? ` (${e.reason})` : ""}`).join("; ");

/** The threads a driver-usage.json priced from their session file: "all", or a Set. */
function sessionBookedThreads(usage) {
  const source = str(usage.source);
  if (source === "session-file") return "all";
  const threads = Array.isArray(usage.threads) ? usage.threads : [];
  return new Set(threads.filter((t) => t?.booked_from === "session-file").map((t) => str(t.thread_id)).filter(Boolean));
}

/** Per-turn flags (driverUsage.ts DriverTurnFlag), in display order. */
const DRIVER_FLAGS = ["baseline_unknown", "cumulative_reset", "zero_usage", "no_thread_id"];

/** Flag name -> number of complete rows carrying it, or null when only driver-manifest.json names it. */
function driverFlagCounts(complete, d) {
  const counts = {};
  for (const r of complete) for (const f of strings(r.driver_flags)) counts[f] = (counts[f] ?? 0) + 1;
  for (const f of strings(d.driver_cost_flags)) if (!(f in counts)) counts[f] = null;
  const order = (f) => (DRIVER_FLAGS.includes(f) ? DRIVER_FLAGS.indexOf(f) : DRIVER_FLAGS.length);
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : 1)));
}

/** Threads whose last complete row reported zero usage: no later running total carries that turn. */
function zeroUsageAtThreadEnd(complete) {
  const last = new Map();
  for (const r of complete) last.set(str(r.thread_id) ?? "", r);
  return [...last.values()].filter((r) => strings(r.driver_flags).includes("zero_usage")).length;
}

const turnsText = (n, fallback) => (n == null ? fallback : plural(n, "driver turn"));

const boundOf = (floor, ceiling) => (floor && ceiling ? "mixed" : floor ? "floor" : ceiling ? "ceiling" : "exact");
const combineBounds = (...bounds) => boundOf(
  bounds.some((b) => b === "floor" || b === "mixed"),
  bounds.some((b) => b === "ceiling" || b === "mixed"),
);

function driverSummary(run) {
  const d = run.driverManifest ?? {};
  const rows = run.driverRows;
  const isIncompleteRow = (r) => r.status === "incomplete" || r.incomplete === true;
  const complete = rows.filter((r) => !isIncompleteRow(r));
  const incompleteRows = rows.filter(isIncompleteRow);
  const manifestIncomplete = [d.driver_turns_incomplete, d.incomplete_turns].find((v) => Number.isInteger(v) && v >= 0) ?? 0;
  const stream = streamIncompleteTurns(run.driverStream);
  const incomplete = Math.max(incompleteRows.length, manifestIncomplete, stream.total);
  // A later running total on the same thread holds these turns' tokens, so the figure has them.
  const coveredByThread = {};
  for (const r of incompleteRows) {
    if (str(r.covered_by)) coveredByThread[str(r.thread_id) ?? ""] = (coveredByThread[str(r.thread_id) ?? ""] ?? 0) + 1;
  }
  const manifestCovered = Number.isInteger(d.driver_turns_incomplete_covered) ? d.driver_turns_incomplete_covered : 0;
  const covered = Math.min(incomplete, Math.max(Object.values(coveredByThread).reduce((n, c) => n + c, 0), manifestCovered));
  const rowThreads = strings(rows.map((r) => r.thread_id));
  const collected = usableUsage(run.driverUsage);
  // A resumed run spent past an older collection; its live rows are the newer figure.
  const staleUsage = collected != null && run.driverUsageFresh === false;
  const usage = staleUsage && run.driverFile ? null : collected;
  const base = {
    measured: false, booked_from: null, source: null, cost_source: null, verification: null,
    turns: 0, turns_incomplete: incomplete, turns_incomplete_unpriced: incomplete - covered, turns_incomplete_covered: covered,
    m: null, input_tokens: null, cached_input_tokens: null, output_tokens: null,
    thread_ids: strings(d.thread_ids).length ? strings(d.thread_ids) : rowThreads,
    window: null, unpriced: [], cross_check: d.driver_cross_check ?? null, flags: {},
    token_check: null, tier_unverified_turns: 0, stale_collection: staleUsage, excluded_threads: [],
  };
  const floorFacts = [];
  const ceilingFacts = [];
  const eitherFacts = [];
  let driver = base;
  if (usage) {
    const tokens = usage.tokens && typeof usage.tokens === "object" ? usage.tokens : usage;
    const tokIn = [tokens.input_tokens, tokens.input].find(isNum);
    const tokCached = [tokens.cached_input_tokens, tokens.input_cached].find(isNum) ?? 0;
    const tokOut = [tokens.output_tokens, tokens.output].find(isNum);
    const costSource = str(usage.cost_source) ?? null;
    const crossCheck = usage.cross_check ?? base.cross_check;
    // The session file holds the usage of turns the exec stream never completed, so only
    // incomplete turns on threads booked from the exec stream are missing from the figure.
    const booked = sessionBookedThreads(usage);
    let unpricedIncomplete = base.turns_incomplete_unpriced;
    let coveredIncomplete = covered;
    if (booked === "all") {
      unpricedIncomplete = 0;
      coveredIncomplete = 0;
    } else if (booked.size) {
      const rowsByThread = {};
      for (const r of incompleteRows) rowsByThread[str(r.thread_id) ?? ""] = (rowsByThread[str(r.thread_id) ?? ""] ?? 0) + 1;
      const keys = [...new Set([...Object.keys(stream.byThread), ...Object.keys(rowsByThread)])];
      const perThread = (k) => Math.max(stream.byThread[k] ?? 0, rowsByThread[k] ?? 0);
      const coveredIn = (k) => Math.min(perThread(k), coveredByThread[k] ?? 0);
      const attributed = keys.reduce((n, k) => n + perThread(k), 0);
      const fromStream = keys.filter((k) => !booked.has(k));
      coveredIncomplete = fromStream.reduce((n, k) => n + coveredIn(k), 0);
      unpricedIncomplete = fromStream.reduce((n, k) => n + perThread(k) - coveredIn(k), 0) + Math.max(0, incomplete - attributed);
    }
    driver = {
      ...base,
      measured: true,
      booked_from: "driver-usage.json",
      source: SOURCE_TEXT[str(usage.source)] ?? str(usage.source) ?? "driver-usage.json",
      cost_source: costSource,
      verification: verificationOf(costSource, usage.verified, crossCheck),
      turns: Array.isArray(usage.turns) ? usage.turns.filter((t) => isNum(t?.cost_usd)).length : count(usage.turns) ?? complete.length,
      turns_incomplete_unpriced: unpricedIncomplete,
      turns_incomplete_covered: coveredIncomplete,
      m: micros(usage.cost_usd_modeled),
      // Fresh input, as driver-cost-modeled.jsonl and telemetry.jsonl store it.
      input_tokens: tokIn == null ? null : Math.max(0, tokIn - tokCached),
      cached_input_tokens: tokIn == null ? null : tokCached,
      output_tokens: tokOut ?? null,
      thread_ids: strings(usage.thread_ids).length ? strings(usage.thread_ids) : base.thread_ids,
      window: usage.window ?? null,
      unpriced: describeUnpriced(usage.unpriced),
      cross_check: crossCheck,
      token_check: tokenCheck(crossCheck),
      tier_unverified_turns: Array.isArray(usage.turns) ? usage.turns.filter((t) => t?.price_tier === "unverified").length : num(usage.tier_unverified_turns),
      excluded_threads: excludedThreads(usage.excluded_threads),
    };
    if (staleUsage) floorFacts.push("driver-usage.json was collected before the run's last recorded activity; run collect-driver-usage.mjs again for the later turns");
    const threads = Array.isArray(usage.threads) ? usage.threads : [];
    const unread = threads.filter((t) => t && t.booked_from == null && t.rollout !== "found").map((t) => str(t.thread_id)).filter(Boolean);
    if (unread.length) floorFacts.push(`${plural(unread.length, "conductor thread")} had no readable session file (${unread.join(", ")})`);
    const leftOut = driver.excluded_threads.filter((e) => e.conductor_turns_left_out).map((e) => e.thread_id);
    if (leftOut.length) {
      floorFacts.push(`This run's turns in ${plural(leftOut.length, "conductor thread")} (${leftOut.join(", ")}) are left out, as run.json records no start of this run there`);
    }
    const searches = num(usage.tokens?.web_search_calls);
    if (searches > 0) floorFacts.push(`${plural(searches, "hosted web search call")} ${searches === 1 ? "is" : "are"} billed per call and not priced`);
    const w = usage.window && typeof usage.window === "object" ? usage.window : {};
    if (w.lower_bound === true) floorFacts.push("The driver window opens at the first dispatch turn and leaves out the conductor turns before it");
    if (w.provisional === true) floorFacts.push("The closing driver turn was still running when the figure was collected");
    const baselines = crossCheck && typeof crossCheck.exec_stream_baseline === "object" ? crossCheck.exec_stream_baseline ?? {} : {};
    const unknownBase = Object.entries(baselines).filter(([t, b]) => b === "unknown" && !(booked === "all" || booked.has(t))).map(([t]) => t);
    if (unknownBase.length || (costSource && /\bupper bound\b/i.test(costSource))) {
      ceilingFacts.push("The first exec-stream total of a resumed thread with no session file includes turns from before this run");
    }
    if (w.start_anchor === "whole_thread") {
      ceilingFacts.push("No marker scopes the driver window, which covers the whole conductor thread and can hold turns outside this run");
    }
  } else if (run.driverFile) {
    const priced = complete.filter((r) => isNum(r.cost_usd));
    driver = {
      ...base,
      measured: true,
      booked_from: "driver-cost-modeled.jsonl",
      source: SOURCE_TEXT[str(d.driver_cost_source) ?? str(complete[0]?.usage_source) ?? "exec-stream"]
        ?? str(d.driver_cost_source) ?? str(complete[0]?.usage_source),
      verification: verificationOf(null, undefined, base.cross_check),
      turns: priced.length,
      m: priced.reduce((s, r) => s + micros(r.cost_usd), 0),
      input_tokens: complete.reduce((s, r) => s + num(r.input_tokens), 0),
      cached_input_tokens: complete.reduce((s, r) => s + num(r.input_tokens_cached), 0),
      output_tokens: complete.reduce((s, r) => s + num(r.output_tokens), 0),
      flags: driverFlagCounts(complete, d),
      tier_unverified_turns: complete.filter((r) => r.price_tier === "unverified").length,
    };
    if (staleUsage) floorFacts.push("driver-usage.json predates the run's last invocation, so the driver figure is the exec stream's from driver-cost-modeled.jsonl; run collect-driver-usage.mjs again to cross-check it");
    const unpricedRows = complete.length - priced.length;
    if (unpricedRows > 0) driver.unpriced = [`${plural(unpricedRows, "turn")} with no cost recorded`];
    const flags = driver.flags;
    if ("baseline_unknown" in flags) {
      ceilingFacts.push(`${turnsText(flags.baseline_unknown, "A driver turn")} resumed a thread with no earlier total in this run folder and ${flags.baseline_unknown === 1 || flags.baseline_unknown == null ? "was" : "were"} priced at the thread's whole running total`);
    }
    if ("cumulative_reset" in flags) {
      eitherFacts.push(`The thread's running total dropped on ${turnsText(flags.cumulative_reset, "a driver turn")}, which ${flags.cumulative_reset > 1 ? "were" : "was"} priced at the new total`);
    }
    const zeroAtEnd = zeroUsageAtThreadEnd(complete);
    if (zeroAtEnd > 0) {
      floorFacts.push(`The last driver turn on ${plural(zeroAtEnd, "thread")} reported zero usage, and no later total carries ${zeroAtEnd === 1 ? "it" : "them"}`);
    }
  }
  if (driver.measured) {
    if (driver.turns_incomplete_unpriced > 0) floorFacts.unshift(`${plural(driver.turns_incomplete_unpriced, "driver turn")} reported no usage`);
    if (driver.tier_unverified_turns > 0) {
      floorFacts.push(`${plural(driver.tier_unverified_turns, "driver turn")} summed more than a long-context threshold of input with no per-response sizes, and ${driver.tier_unverified_turns === 1 ? "was" : "were"} priced at the standard card; a request above the threshold bills more`);
    }
    if (driver.unpriced.length > 0) floorFacts.push(`Unpriced driver turns (${driver.unpriced.join(", ")}) are not in the driver figure`);
    const completeFlag = usage ? [usage.cost_complete, usage.complete].find((b) => typeof b === "boolean") : d.driver_cost_complete;
    const flagged = driver.verification?.qualifiers.some((q) => q === "INCOMPLETE" || q === "LOWER BOUND" || q === "PROVISIONAL");
    if (!floorFacts.length && !ceilingFacts.length && !eitherFacts.length && (completeFlag === false || flagged)) {
      floorFacts.push("The driver cost is marked incomplete");
    }
  }
  const bound = driver.measured
    ? boundOf(floorFacts.length + eitherFacts.length > 0, ceilingFacts.length + eitherFacts.length > 0)
    : "exact";
  return { ...driver, bound, floor_facts: floorFacts, ceiling_facts: ceilingFacts, either_facts: eitherFacts };
}

function provenanceTag(counts) {
  const kinds = Object.entries(counts).filter(([, n]) => n > 0).map(([k]) => k);
  if (kinds.length > 1) return "~";
  // `none` is a phase that made no model call, so its zeros are facts; `?` means nobody labelled it.
  return { vendor: "V", estimated: "E", modeled: "M", none: "–", unknown: "?" }[kinds[0]] ?? "?";
}

export function provenanceOf(e) {
  return costProvenance(e) ?? "unknown";
}

/** Everything the report shows, as plain data. `--json` prints exactly this. */
export function summarize(run) {
  const zeroCounts = () => Object.fromEntries(PROVENANCES.map((k) => [k, 0]));
  const phases = new Map();
  const byProv = Object.fromEntries(PROVENANCES.map((k) => [k, { calls: 0, m: 0, partial: 0 }]));
  const sdlc = { calls: 0, m: 0 };
  const overhead = { calls: 0, m: 0 };
  const packets = new Map();

  for (const e of run.events) {
    const phase = str(e.phase) ?? "unknown";
    const isSdlc = SDLC_PHASES.includes(phase);
    const cost = micros(e.cost_usd);
    const prov = provenanceOf(e);
    byProv[prov].calls += 1;
    byProv[prov].m += cost;
    if (e.usage_complete === false) byProv[prov].partial += 1;
    const bucket = isSdlc ? sdlc : overhead;
    bucket.calls += 1;
    bucket.m += cost;

    const rec = phases.get(phase) ?? { phase, sdlc: isSdlc, calls: 0, tokIn: 0, tokCached: 0, tokOut: 0, m: 0, prov: zeroCounts() };
    rec.calls += 1;
    rec.tokIn += num(e.input_tokens);
    rec.tokCached += num(e.input_tokens_cached);
    rec.tokOut += num(e.output_tokens);
    rec.m += cost;
    rec.prov[prov] += 1;
    phases.set(phase, rec);

    // A dispatch's attempts collapse into one record per packet.
    const tid = e.task_id;
    if (tid && (e.attempt_number != null || e.ceiling_used != null)) {
      const pkt = packets.get(tid) ?? { task_id: tid, phase, attempts: 0, capped: false, resends: 0, final_ceiling: e.ceiling_used ?? null, m: 0 };
      const later = isNum(e.attempt_number) ? e.attempt_number > 1 : pkt.attempts > 0;
      // A later attempt with no retry_reason predates the field, when doubling was the only retry.
      const reason = later ? str(e.retry_reason) ?? "output_cap" : null;
      if (reason === "output_cap") pkt.capped = true;
      if (reason === "transient") pkt.resends += 1;
      pkt.attempts += 1;
      if (e.ceiling_used != null) pkt.final_ceiling = e.ceiling_used;
      pkt.m += cost;
      packets.set(tid, pkt);
    }
  }

  const phaseOut = (rec) => ({
    phase: rec.phase, calls: rec.calls, input_tokens: rec.tokIn, cached_input_tokens: rec.tokCached, output_tokens: rec.tokOut,
    cost_usd: dollars(rec.m), provenance: provenanceTag(rec.prov), provenance_counts: rec.prov,
  });
  const seen = [...phases.keys()];
  const sdlcRows = SDLC_PHASES.filter((p) => phases.has(p)).map((p) => phaseOut(phases.get(p)));
  const overheadOrder = [...OVERHEAD_ORDER.filter((p) => phases.has(p)), ...seen.filter((p) => !SDLC_PHASES.includes(p) && !OVERHEAD_ORDER.includes(p))];
  const overheadRows = overheadOrder.map((p) => phaseOut(phases.get(p)));

  const driver = driverSummary(run);
  const dispatchedM = sdlc.m + overhead.m;
  const meteredM = byProv.vendor.m + byProv.estimated.m;
  const unlabelledM = byProv.none.m + byProv.unknown.m;
  const driverM = driver.measured ? driver.m : null;
  const partialCalls = PROVENANCES.reduce((n, k) => n + byProv[k].partial, 0);
  const dispatchedBound = partialCalls > 0 ? "floor" : "exact";
  const runBound = combineBounds(dispatchedBound, driver.bound);
  const mixed = runBound === "mixed";
  const floorReasons = driver.floor_facts.map((f) => `${f}, so ${mixed ? "that cost is missing from the figure" : "the run cost is at least this"}.`);
  const ceilingReasons = driver.ceiling_facts.map((f) => `${f}, so ${mixed ? "the figure can count more than this run spent" : "the run cost is at most this"}.`);
  if (partialCalls > 0) {
    floorReasons.push(`${plural(partialCalls, "dispatched call")} returned partial usage, so ${partialCalls === 1 ? "its" : "their"} cost is at least what is shown.`);
  }
  const eitherReasons = driver.either_facts.map((f) => `${f}, so the figure can be higher or lower than this run spent.`);
  if (mixed && floorReasons.length && ceilingReasons.length) {
    ceilingReasons.push("Those pull in opposite directions, so the run total is neither a floor nor a ceiling.");
  }
  const cc = driver.cross_check;
  const unverifiedNote = driver.measured && cc && typeof cc === "object" && driver.verification && !driver.verification.verified
    ? `The driver figure is UNVERIFIED: ${crossCheckDetail(cc)}.`
    : null;
  const modeledBound = combineBounds(byProv.modeled.partial > 0 ? "floor" : "exact", driver.bound);

  const id = identity(run);
  const dm = run.driverManifest ?? {};
  const notices = [];
  if (str(dm.pin_rejection)) notices.push({ kind: "pin_rejection", title: "Pin rejected during this run", text: dm.pin_rejection });
  if (str(dm.cost_cap_stop)) notices.push({ kind: "cost_cap_stop", title: "Stopped at the cost cap", text: dm.cost_cap_stop });
  if (id.policy_disagreement) {
    notices.push({
      kind: "policy_disagreement",
      title: "Policy names disagree",
      text: id.policy_sources.map((s) => `${s.source} says ${s.policy}`).join("; "),
    });
  }
  const warnings = Array.isArray(dm.codex_warnings) ? dm.codex_warnings.map((w) => str(w) ?? str(w?.message)).filter(Boolean) : [];
  if (warnings.length) {
    notices.push({
      kind: "codex_warnings",
      title: `Codex warnings during this run (${warnings.length})`,
      text: warnings.length === 1 ? warnings[0] : `${warnings[0]} (and ${warnings.length - 1} more in driver-manifest.json)`,
    });
  }

  const packetRows = (keep) => [...packets.values()]
    .filter(keep)
    .sort((a, b) => b.attempts - a.attempts)
    .map(({ m, capped: _c, ...p }) => ({ ...p, cost_usd: dollars(m) }));

  const { m: _m, ...driverOut } = driver;
  return {
    schema_version: 1,
    run_dir: run.runDir,
    selected: run.selected ?? null,
    identity: id,
    dispatched: {
      calls: sdlc.calls + overhead.calls,
      cost_usd: dollars(dispatchedM),
      sdlc: { calls: sdlc.calls, cost_usd: dollars(sdlc.m) },
      overhead: { calls: overhead.calls, cost_usd: dollars(overhead.m) },
      phases: sdlcRows,
      overhead_phases: overheadRows,
      by_provenance: Object.fromEntries(PROVENANCES.map((k) => [k, { calls: byProv[k].calls, cost_usd: dollars(byProv[k].m) }])),
      partial_usage_calls: partialCalls,
    },
    driver: { ...driverOut, cost_usd: dollars(driverM) },
    totals: {
      dispatched_usd: dollars(dispatchedM),
      dispatched_bound: dispatchedBound,
      dispatched_is_floor: dispatchedBound === "floor",
      driver_usd: dollars(driverM),
      driver_bound: driver.bound,
      driver_is_floor: driver.bound === "floor",
      run_total_usd: driverM == null ? null : dollars(dispatchedM + driverM),
      run_total_bound: runBound,
      run_total_is_floor: runBound === "floor",
      vendor_metered_usd: dollars(meteredM),
      vendor_metered_is_floor: byProv.vendor.partial + byProv.estimated.partial > 0,
      estimated_usd: dollars(byProv.estimated.m),
      estimated_is_floor: byProv.estimated.partial > 0,
      modeled_usd: driverM == null ? null : dollars(byProv.modeled.m + driverM),
      modeled_bound: modeledBound,
      modeled_is_floor: modeledBound === "floor",
      modeled_dispatched_usd: dollars(byProv.modeled.m),
      modeled_dispatched_is_floor: byProv.modeled.partial > 0,
      modeled_driver_usd: dollars(driverM),
      unlabelled_usd: dollars(unlabelledM),
      unlabelled_is_floor: byProv.none.partial + byProv.unknown.partial > 0,
      floor_reasons: floorReasons,
      ceiling_reasons: ceilingReasons,
      either_reasons: eitherReasons,
      unverified_note: unverifiedNote,
    },
    retried: packetRows((p) => p.capped)
      .map(({ resends: _r, ...p }) => p),
    resent: packetRows((p) => p.resends > 0)
      .map(({ final_ceiling: _c, ...p }) => p),
    delegated_packets: run.receipts.length,
    notices,
  };
}

// ─── formatting ───────────────────────────────────────────────────────

const fmtUSD = (n) => `$${n.toFixed(4)}`;
const fmtCompact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtDuration = (sec) => {
  if (!sec) return null;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
};

function outcomeText(id) {
  return `${id.outcome}${id.exit_code != null ? ` (exit ${id.exit_code})` : ""}${id.outcome_reason ? ` — ${id.outcome_reason}` : ""}`;
}

function selectedText(sel, runDir) {
  if (sel.rule === "sdlc") return `the run files in ${runDir}, the project's .sdlc folder`;
  if (sel.rule !== "latest") {
    return `this folder's own run files, newer than the ${plural(sel.runs, "run folder")} in ${sel.runs_dir}`;
  }
  const older = sel.older_folder_files ? `; the older run files kept directly in ${dirname(sel.runs_dir)} are not shown` : "";
  return `the latest of ${plural(sel.runs, "run")} in ${sel.runs_dir} (pass a run folder to report another${older})`;
}

function windowText(w) {
  if (typeof w === "string") return w;
  const start = str(w?.start), end = str(w?.end);
  const leftOut = Number.isInteger(w?.left_out_turns) && w.left_out_turns > 0
    ? ` (${plural(w.left_out_turns, "turn")} inside it ${w.left_out_turns === 1 ? "is" : "are"} another run's or no run's, and not counted)`
    : "";
  return start || end ? `${start ?? "?"} → ${end ?? "open"}${leftOut}` : null;
}

/** Verdict names proposed for driver-manifest.json driver_cross_check, read as sessionUsage.ts names. */
const VERDICT_ALIASES = { agree: "equal", differ: "mismatch", unavailable: "no_session_file" };

const verdictOf = (cc) => {
  const v = str(cc?.verdict) ?? str(cc?.status);
  return VERDICT_ALIASES[v] ?? v;
};

function crossCheckDetail(cc) {
  const verdict = verdictOf(cc);
  const bad = Array.isArray(cc.invocations) ? cc.invocations.find((i) => i?.status === "differs" || i?.status === "unmatched") : null;
  const diff = Array.isArray(bad?.differing) ? bad.differing[0] : null;
  const at = bad?.invocation != null ? ` on invocation ${bad.invocation}` : "";
  // Earlier sessionUsage.ts output names this field trailing_turns.
  const incompleteTurns = num(cc.incomplete_turns ?? cc.trailing_turns);
  const unchecked = strings(cc.unchecked_threads).length;
  const carried = Array.isArray(cc.invocations) ? cc.invocations.filter((i) => i?.status === "equal_with_explained_gap").length : 0;
  return {
    equal: carried
      ? `equal; ${plural(carried, "invocation")} also ${carried === 1 ? "counts" : "count"} the turns of an earlier one that reported no usage`
      : "every invocation's exec-stream total equals the session file",
    equal_with_explained_gap: `equal; the session file also holds ${plural(num(cc.compaction_requests), "compaction call")} and ${plural(incompleteTurns, "incomplete turn")} the exec stream never reported`,
    no_exec_usage: "the exec stream reported no usage to compare",
    unchecked: `${unchecked > 1 ? `${unchecked} threads were` : unchecked === 1 ? "1 thread was" : "a thread was"} booked from the session file with no exec-stream invocation to compare`,
    unexplained_gap: cc.gap?.bucket ? `${cc.gap.bucket} differs by ${cc.gap.difference} with nothing to explain it` : "the totals differ with nothing to explain the gap",
    reset: "a token_count total dropped inside the window, so the two cannot be compared",
    mismatch: diff ? `the exec stream disagrees${at}: ${diff.bucket} ${diff.exec} vs ${diff.session} in the session file` : `the exec stream disagrees with the session file${at}`,
    no_session_file: "no session file to compare against",
  }[verdict] ?? verdict ?? "recorded";
}

function crossCheckText(cc) {
  if (typeof cc === "string") return cc;
  if (!cc || typeof cc !== "object") return null;
  const verified = typeof cc.verified === "boolean" ? cc.verified : VERIFIED_VERDICTS.has(verdictOf(cc));
  const figures = Object.entries(cc)
    .filter(([k, v]) => isNum(v) && /usd|cost/i.test(k))
    .map(([k, v]) => `${k === "exec_stream_cost_usd" ? "exec stream" : k} ${fmtUSD(v)}`);
  return `${verified ? "verified" : "UNVERIFIED"}: ${crossCheckDetail(cc)}${figures.length ? ` (${figures.join(", ")})` : ""}`;
}

const verificationText = (v) => (v ? [v.verified ? "verified" : "UNVERIFIED", ...v.qualifiers].join(" · ") : null);

const rate = (n) => (isNum(n) ? n.toFixed(2) : "?");
const card = (c) => `${rate(c?.input)} / ${rate(c?.input_cached)} / ${rate(c?.output)}`;

/** driver-manifest.json driver_price, as one line. */
function priceText(price, listVerified) {
  if (!price) return null;
  if (!price.rates) return `${price.model}: unpriced (${price.unpriced_reason ?? "no list entry"})`;
  const basis = price.basis === "custom" ? "the policy's pricing_override block" : `price list, verified ${price.verified ?? listVerified ?? "?"}`;
  const tiers = (price.tiers ?? []).map((t) => `; over ${Number(t.above_input_tokens).toLocaleString("en-US")} input tokens ${card(t)}`).join("");
  return `${price.model} ${card(price.rates)} per 1M input / cached / output (${basis})${tiers}`;
}

function windowLine(w) {
  if (!w?.start) return null;
  return `${w.start} → ${w.end ?? "open"} (UTC, from ${w.source})`;
}

const BUCKET_LABEL = {
  input_tokens: "input", cached_input_tokens: "cached input", output_tokens: "output",
  reasoning_output_tokens: "reasoning", cache_write_input_tokens: "cache write",
};
const signed = (n) => (n == null ? "?" : n > 0 ? `+${n}` : String(n));

function checkCells(buckets) {
  return buckets.map((b) => `${BUCKET_LABEL[b.bucket] ?? b.bucket} ${b.exec_stream ?? "-"}/${b.session_file ?? "-"} (${signed(b.difference)})`).join(" · ");
}

/** Only a floor bound lets the note call the driver figure a floor; with a ceiling reason as well it is neither. */
function incompleteNote(dr) {
  const priced = dr.turns_incomplete - dr.turns_incomplete_unpriced;
  const floor = dr.bound === "floor";
  const covered = dr.turns_incomplete_covered ?? 0;
  if (covered > 0) {
    const session = priced - covered;
    const parts = [`${covered === dr.turns_incomplete ? "" : `${covered} `}held in a later running total on the same thread`];
    if (session > 0) parts.push(`${session} priced from the session file`);
    if (dr.turns_incomplete_unpriced > 0) parts.push(`${dr.turns_incomplete_unpriced} with no usage anywhere, ${floor ? "a floor" : "missing from the figure"}`);
    return `no usage reported; ${parts.join("; ")}`;
  }
  if (priced <= 0) return floor ? "no usage reported; the cost is a floor" : "no usage reported; their cost is missing from the figure";
  if (dr.turns_incomplete_unpriced === 0) return "no exec-stream usage; priced from the session file";
  return `${dr.turns_incomplete_unpriced} with no usage anywhere, ${floor ? "a floor" : "missing from the figure"}; the rest priced from the session file`;
}

function flagsText(flags) {
  const names = Object.entries(flags ?? {});
  return names.length ? names.map(([f, n]) => (n == null ? f : `${f} (${plural(n, "turn")})`)).join(", ") : null;
}

/** The paragraph under the driver figure, by how the driver signed in. */
function driverCostNote(auth, { markdown = false } = {}) {
  const lead = markdown
    ? ["Codex reports no wallet or usage figures, so this is derived from turn token", "counts at the dated price list's rates."]
    : ["Codex reports no wallet figures, so this is token counts at the price list's rates."];
  if (auth === "api_key") {
    return [
      ...lead,
      "The driver signed in with an API key, so OpenAI bills these tokens; this",
      `figure is computed from the token counts, ${markdown ? "**not**" : "not"} read from a bill. The run`,
      "total adds it as modeled, not as metered.",
    ];
  }
  const notBilled = markdown
    ? ["It is **not** an amount anyone was billed — a driver running on a ChatGPT seat", "may have cost nothing in money at all. The run total adds it as modeled, not as", "metered."]
    : ["It is NOT an amount anyone was billed — a driver on a ChatGPT seat may have", "cost nothing in money. The run total adds it as modeled, not as metered."];
  const signedIn = auth === "chatgpt" ? ["The driver signed in with ChatGPT, so these tokens were not billed per token."] : [];
  return [...lead, ...notBilled, ...signedIn];
}

/** An API-key driver is billed per token, so its modeled share is not seat work. */
const modeledLabel = (auth) => (auth === "api_key" ? "Modeled total" : "Modeled (seat) total");

const DASHBOARD_HINT = "The driver signed in with an OpenAI API key: compare its tokens with the OpenAI usage dashboard for this window.";

const BOUND_PREFIX = { floor: "at least ", ceiling: "at most ", mixed: "about " };
const amount = (usd, bound = "exact") => (usd == null ? "not measured" : `${BOUND_PREFIX[bound === true ? "floor" : bound] ?? ""}${fmtUSD(usd)}`);
const runTotalAmount = (t) => amount(t.run_total_usd, t.run_total_bound);
const boundNotes = (t) => [...t.floor_reasons, ...t.ceiling_reasons, ...t.either_reasons, ...(t.unverified_note ? [t.unverified_note] : [])];
const showUnlabelled = (r) => r.dispatched.by_provenance.unknown.calls > 0 || r.totals.unlabelled_usd !== 0;

function provenanceLine(r) {
  return Object.entries(r.dispatched.by_provenance)
    .filter(([, v]) => v.calls > 0)
    .map(([k, v]) => `${v.calls} ${k}`)
    .join(", ");
}

function renderText(r) {
  const out = [];
  const p = (s = "") => out.push(s);
  const id = r.identity;
  const pin = id.pin ?? {};
  const t = r.totals;
  const dr = r.driver;
  const rule = `  ${"─".repeat(70)}`;
  const money = (label, value) => p(`  ${label.padEnd(Math.max(label.length + 1, 70 - value.length))}${value}`);
  const counted = (label, calls, value) => p(`  ${label.padEnd(27)}${String(calls).padStart(6)}${"".padStart(26)}${value.padStart(11)}`);
  const phaseRow = (ph, indent = "") => {
    const tok = `${fmtCompact(ph.input_tokens)} / ${fmtCompact(num(ph.cached_input_tokens))} / ${fmtCompact(ph.output_tokens)}`;
    p(`  ${(indent + ph.phase).padEnd(22)}${ph.provenance.padStart(5)}${String(ph.calls).padStart(6)}${tok.padStart(26)}${fmtUSD(ph.cost_usd).padStart(11)}`);
  };
  const field = (label, value) => p(`  ${label.padEnd(24)}${value}`);
  const wrappedField = (label, value, width = 54) => {
    const lines = [];
    for (const word of String(value).split(" ")) {
      const last = lines.length - 1;
      if (last >= 0 && lines[last].length + 1 + word.length <= width) lines[last] += ` ${word}`;
      else lines.push(word);
    }
    lines.forEach((l, i) => field(i === 0 ? label : "", l));
  };
  const figure = (label, value, note = "") => p(`  ${label.padEnd(24)}${String(value).padStart(13)}${note}`);

  const box = "─".repeat(66);
  p();
  p(`┌${box}┐`);
  p(`│ ${`Run report — ${id.run_id}`.padEnd(64)} │`);
  p(`└${box}┘`);
  p();
  p(`  Policy:    ${id.policy ?? "—"}`);
  if (pin.model) p(`  Model pin: ${pin.model}  ·  effort ${pin.effort}`);
  if (pin.sandbox) p(`  Sandbox:   ${pin.sandbox}  ·  approval ${pin.approval_policy}`);
  p(`  Started:   ${id.started_at ?? "—"}`);
  const duration = fmtDuration(id.duration_sec);
  if (duration) p(`  Duration:  ${duration}`);
  const win = windowLine(id.run_window);
  if (win) p(`  Window:    ${win}`);
  if (id.outcome) p(`  Outcome:   ${outcomeText(id)}`);
  if (r.selected) p(`  Selected:  ${selectedText(r.selected, r.run_dir)}`);
  if (win && id.driver_auth === "api_key") p(`  Check:     ${DASHBOARD_HINT}`);
  p();

  if (r.dispatched.calls > 0) {
    p(`  Dispatched work`);
    p();
    p(`  ${"Phase".padEnd(22)}${"Prov".padStart(5)}${"Calls".padStart(6)}${"Tokens in / cached / out".padStart(26)}${"Cost".padStart(11)}`);
    p(rule);
    for (const ph of r.dispatched.phases) phaseRow(ph);
    p(rule);
    counted("SDLC total", r.dispatched.sdlc.calls, fmtUSD(r.dispatched.sdlc.cost_usd));
    if (r.dispatched.overhead.calls > 0) {
      counted("Runner overhead", r.dispatched.overhead.calls, fmtUSD(r.dispatched.overhead.cost_usd));
      for (const ph of r.dispatched.overhead_phases) phaseRow(ph, "  ");
    }
    counted("Dispatched total", r.dispatched.calls, amount(r.dispatched.cost_usd, t.dispatched_bound));
    p();
    p(`  Tokens: fresh input / cached input / output.`);
    if (r.dispatched.overhead.calls > 0) p(`  ${OVERHEAD_NOTE}`);
    p();
  } else {
    p(`  No dispatched calls recorded.`);
    p();
  }

  p(`  Driver loop — modeled, not measured`);
  p();
  if (!dr.measured) {
    p(`  Not measured. This run folder has no driver-cost-modeled.jsonl or driver-usage.json.`);
    if (dr.turns_incomplete > 0) p(`  driver-events.jsonl shows ${plural(dr.turns_incomplete, "turn")} that reported no usage.`);
  } else if (dr.turns === 0 && dr.turns_incomplete === 0 && dr.cost_usd === 0 && !dr.unpriced.length) {
    p(`  No driver turns recorded.`);
  } else {
    field("Source", dr.source);
    if (dr.cost_source) wrappedField("Cost source", dr.cost_source);
    const ver = verificationText(dr.verification);
    if (ver) field("Verification", ver);
    if (dr.thread_ids.length) field(dr.thread_ids.length === 1 ? "Thread" : "Threads", dr.thread_ids.join(", "));
    const win = dr.window ? windowText(dr.window) : null;
    if (win) field("Window", win);
    figure("Turns", dr.turns);
    if (dr.turns_incomplete > 0) figure("Incomplete turns", dr.turns_incomplete, `  (${incompleteNote(dr)})`);
    if (dr.input_tokens != null && dr.output_tokens != null) {
      figure("Tokens (in / out)", `${fmtCompact(dr.input_tokens)} / ${fmtCompact(dr.output_tokens)}`);
    }
    if (dr.cached_input_tokens > 0) figure("Cached input", fmtCompact(dr.cached_input_tokens));
    figure("Modeled cost", fmtUSD(dr.cost_usd));
    if (dr.unpriced.length) field("Unpriced", dr.unpriced.join(", "));
    if (dr.excluded_threads.length) wrappedField("Left out", excludedText(dr.excluded_threads));
    const flags = flagsText(dr.flags);
    if (flags) field("Flags", flags);
    const cc = dr.cross_check ? crossCheckText(dr.cross_check) : null;
    if (cc) field("Cross-check", cc);
    const price = priceText(id.driver_price, id.price_list_verified);
    if (price) wrappedField("Price", price);
    if (dr.token_check) {
      p();
      p(`  Token cross-check: exec stream / session file (session minus exec)`);
      for (const t of dr.token_check.threads) p(`    thread ${t.thread_id} — ${t.verdict}: ${checkCells(t.buckets)}`);
      for (const i of dr.token_check.invocations) {
        p(`    invocation ${i.invocation} — ${i.status}: ${checkCells(i.buckets)}${i.note ? ` — ${i.note}` : ""}`);
      }
    }
    p();
    for (const l of driverCostNote(id.driver_auth)) p(`  ${l}`);
  }
  p();

  p(`  Run total`);
  p();
  money("Dispatched total", amount(t.dispatched_usd, t.dispatched_bound));
  money("Driver loop — modeled", amount(t.driver_usd, t.driver_bound));
  p(rule);
  money(RUN_TOTAL_LABEL, runTotalAmount(t));
  p();
  money("Vendor-metered total", amount(t.vendor_metered_usd, t.vendor_metered_is_floor));
  if (r.dispatched.by_provenance.estimated.calls > 0) money("  of which estimated (no usage block returned)", amount(t.estimated_usd, t.estimated_is_floor));
  money(modeledLabel(id.driver_auth), amount(t.modeled_usd, t.modeled_bound));
  money("  of which dispatched", amount(t.modeled_dispatched_usd, t.modeled_dispatched_is_floor));
  money("  of which driver loop", amount(t.modeled_driver_usd, t.driver_bound));
  if (showUnlabelled(r)) money("Unlabelled provenance", amount(t.unlabelled_usd, t.unlabelled_is_floor));
  p();
  if (t.run_total_usd == null) {
    p(`  The driver loop was not measured, so this run has no total. Dispatched work`);
    p(`  alone is ${amount(t.dispatched_usd, t.dispatched_bound)}; it is not the run's cost.`);
  } else if (t.modeled_usd > 0) {
    p(`  Modeled figures are token counts at the price list's rates, not a bill.`);
  }
  for (const reason of boundNotes(t)) p(`  ${reason}`);
  p();

  if (r.retried.length > 0) {
    p(`  Packets that hit the output cap`);
    p();
    for (const k of r.retried) {
      p(`  ${gutter(ACTOR.handoff)}${k.task_id.padEnd(22)} ${String(k.phase).padEnd(20)} ${k.attempts} attempts → ${fmtUSD(k.cost_usd)}`);
    }
    p();
  }

  if (r.resent.length > 0) {
    p(`  Packets resent after a transient failure`);
    p();
    for (const k of r.resent) {
      p(`  ${gutter(ACTOR.handoff)}${k.task_id.padEnd(22)} ${String(k.phase).padEnd(20)} ${plural(k.resends, "resend")}, ${k.attempts} attempts → ${fmtUSD(k.cost_usd)}`);
    }
    p();
  }

  if (r.delegated_packets > 0) {
    p(`  Delegated to an agent worker`);
    p();
    p(`  ${r.delegated_packets} packet(s) ran as agent sessions rather than single completion calls.`);
    p();
    for (const [tag, meaning] of ACTOR_LEGEND) p(`  ${tag}  ${meaning}`);
    p();
  }

  p(`  Provenance key: V vendor-metered · E estimated · M modeled · – no model call · ~ mixed · ? unlabelled`);
  const provLine = provenanceLine(r);
  if (provLine) p(`  Dispatched events: ${provLine}`);
  for (const n of r.notices) {
    p();
    p(`  ! ${n.title}: ${n.text}`);
  }
  p();
  return out.join("\n");
}

function renderMarkdown(r) {
  const out = [];
  const p = (s = "") => out.push(s);
  const id = r.identity;
  const pin = id.pin ?? {};
  const t = r.totals;
  const dr = r.driver;
  const phaseRow = (ph, prefix = "") => {
    p(`| ${prefix}\`${ph.phase}\` | ${ph.provenance} | ${ph.calls} | ${fmtCompact(ph.input_tokens)} / ${fmtCompact(num(ph.cached_input_tokens))} / ${fmtCompact(ph.output_tokens)} | ${fmtUSD(ph.cost_usd)} |`);
  };

  p(`# Run report — ${id.run_id}`);
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| Policy | \`${id.policy ?? "—"}\` |`);
  if (pin.model) p(`| Model pin | \`${pin.model}\`, effort \`${pin.effort}\` |`);
  p(`| Started | ${id.started_at ?? "—"} |`);
  const duration = fmtDuration(id.duration_sec);
  if (duration) p(`| Duration | ${duration} |`);
  const win = windowLine(id.run_window);
  if (win) p(`| Window | ${win} |`);
  if (id.outcome) p(`| Outcome | ${outcomeText(id)} |`);
  if (r.selected) p(`| Selected | ${selectedText(r.selected, r.run_dir)} |`);
  if (id.price_list_verified) p(`| Price list | verified ${id.price_list_verified} |`);
  p();
  if (win && id.driver_auth === "api_key") {
    p(`_${DASHBOARD_HINT}_`);
    p();
  }

  if (r.dispatched.calls > 0) {
    p(`## Dispatched work`);
    p();
    p(`| Phase | Prov | Calls | Tokens (in / cached / out) | Cost |`);
    p(`|---|:---:|---:|---|---:|`);
    for (const ph of r.dispatched.phases) phaseRow(ph);
    p(`| **SDLC total** | | ${r.dispatched.sdlc.calls} | | **${fmtUSD(r.dispatched.sdlc.cost_usd)}** |`);
    if (r.dispatched.overhead.calls > 0) {
      p(`| Runner overhead | | ${r.dispatched.overhead.calls} | | ${fmtUSD(r.dispatched.overhead.cost_usd)} |`);
      for (const ph of r.dispatched.overhead_phases) phaseRow(ph, "↳ ");
    }
    p(`| **Dispatched total** | | ${r.dispatched.calls} | | **${amount(r.dispatched.cost_usd, t.dispatched_bound)}** |`);
    p();
    p(`_Tokens: fresh input / cached input / output.${r.dispatched.overhead.calls > 0 ? ` ${OVERHEAD_NOTE}` : ""}_`);
    p();
  } else {
    p(`## Dispatched work`);
    p();
    p(`_No dispatched calls recorded._`);
    p();
  }

  p(`## Driver loop — modeled, not measured`);
  p();
  if (!dr.measured) {
    p(`_Not measured. This run folder has no \`driver-cost-modeled.jsonl\` or \`driver-usage.json\`._`);
    if (dr.turns_incomplete > 0) p(`_\`driver-events.jsonl\` shows ${plural(dr.turns_incomplete, "turn")} that reported no usage._`);
  } else if (dr.turns === 0 && dr.turns_incomplete === 0 && dr.cost_usd === 0 && !dr.unpriced.length) {
    p(`_No driver turns recorded._`);
  } else {
    const tokens = dr.input_tokens != null && dr.output_tokens != null ? `${fmtCompact(dr.input_tokens)} / ${fmtCompact(dr.output_tokens)}` : "—";
    p(`| Source | Turns | Incomplete | Tokens (in / out) | Modeled cost |`);
    p(`|---|---:|---:|---|---:|`);
    p(`| ${dr.source} | ${dr.turns} | ${dr.turns_incomplete} | ${tokens} | ${fmtUSD(dr.cost_usd)} |`);
    p();
    const bullets = [];
    if (dr.cost_source) bullets.push(`Cost source: ${dr.cost_source}`);
    const ver = verificationText(dr.verification);
    if (ver) bullets.push(`Verification: ${ver}`);
    if (dr.thread_ids.length) bullets.push(`${dr.thread_ids.length === 1 ? "Thread" : "Threads"}: ${dr.thread_ids.map((x) => `\`${x}\``).join(", ")}`);
    const win = dr.window ? windowText(dr.window) : null;
    if (win) bullets.push(`Window: ${win}`);
    if (dr.turns_incomplete > 0) bullets.push(`Incomplete turns: ${incompleteNote(dr)}`);
    if (dr.cached_input_tokens > 0) bullets.push(`Cached input: ${fmtCompact(dr.cached_input_tokens)}`);
    if (dr.unpriced.length) bullets.push(`Unpriced: ${dr.unpriced.join(", ")}`);
    if (dr.excluded_threads.length) {
      bullets.push(`Left out: ${dr.excluded_threads.map((e) => `\`${e.thread_id}\`${e.reason ? ` (${e.reason})` : ""}`).join("; ")}`);
    }
    const flags = flagsText(dr.flags);
    if (flags) bullets.push(`Flags: ${flags}`);
    const cc = dr.cross_check ? crossCheckText(dr.cross_check) : null;
    if (cc) bullets.push(`Cross-check: ${cc}`);
    const price = priceText(id.driver_price, id.price_list_verified);
    if (price) bullets.push(`Price: ${price}`);
    for (const b of bullets) p(`- ${b}`);
    if (bullets.length) p();
    if (dr.token_check) {
      p(`### Token cross-check: exec stream against the session file`);
      p();
      p(`| Scope | Status | Bucket | Exec stream | Session file | Difference |`);
      p(`|---|---|---|---:|---:|---:|`);
      const rows = (scope, status, buckets) => {
        for (const b of buckets) {
          p(`| ${scope} | ${status ?? "—"} | ${BUCKET_LABEL[b.bucket] ?? b.bucket} | ${b.exec_stream ?? "—"} | ${b.session_file ?? "—"} | ${signed(b.difference)} |`);
        }
      };
      for (const t of dr.token_check.threads) rows(`thread \`${t.thread_id}\``, t.verdict, t.buckets);
      for (const i of dr.token_check.invocations) rows(`invocation ${i.invocation}`, i.status, i.buckets);
      p();
      const notes = dr.token_check.invocations.filter((i) => i.note);
      for (const i of notes) p(`- Invocation ${i.invocation} (${i.status}): ${i.note}.`);
      if (notes.length) p();
      p(`_Difference is the session file minus the exec stream. A thread row compares the whole thread, and its status also counts the invocation rows under it. An invocation row compares that invocation's share of the running total with the session-file responses inside it, and its status compares those same two figures._`);
      p();
    }
    for (const l of driverCostNote(id.driver_auth, { markdown: true })) p(`> ${l}`);
  }
  p();

  p(`## Run total`);
  p();
  p(`| Line | Amount |`);
  p(`|---|---:|`);
  p(`| Dispatched total | ${amount(t.dispatched_usd, t.dispatched_bound)} |`);
  p(`| Driver loop — modeled | ${amount(t.driver_usd, t.driver_bound)} |`);
  p(`| **${RUN_TOTAL_LABEL}** | **${runTotalAmount(t)}** |`);
  p(`| Vendor-metered total | ${amount(t.vendor_metered_usd, t.vendor_metered_is_floor)} |`);
  if (r.dispatched.by_provenance.estimated.calls > 0) p(`| ↳ estimated (no usage block returned) | ${amount(t.estimated_usd, t.estimated_is_floor)} |`);
  p(`| ${modeledLabel(id.driver_auth)} | ${amount(t.modeled_usd, t.modeled_bound)} |`);
  p(`| ↳ dispatched | ${amount(t.modeled_dispatched_usd, t.modeled_dispatched_is_floor)} |`);
  p(`| ↳ driver loop | ${amount(t.modeled_driver_usd, t.driver_bound)} |`);
  if (showUnlabelled(r)) p(`| Unlabelled provenance | ${amount(t.unlabelled_usd, t.unlabelled_is_floor)} |`);
  p();
  if (t.run_total_usd == null) {
    p(`_The driver loop was not measured, so this run has no total. Dispatched work alone is ${amount(t.dispatched_usd, t.dispatched_bound)}; it is not the run's cost._`);
  } else if (t.modeled_usd > 0) {
    p(`_Modeled figures are token counts at the price list's rates, not a bill._`);
  }
  for (const reason of boundNotes(t)) p(`_${reason}_`);
  p();

  if (r.retried.length > 0) {
    p(`## Packets that hit the output cap`);
    p();
    p(`| Packet | Phase | Attempts | Final ceiling | Cost |`);
    p(`|---|---|---:|---:|---:|`);
    for (const k of r.retried) p(`| \`${k.task_id}\` | ${k.phase} | ${k.attempts} | ${k.final_ceiling ?? "—"} | ${fmtUSD(k.cost_usd)} |`);
    p();
  }

  if (r.resent.length > 0) {
    p(`## Packets resent after a transient failure`);
    p();
    p(`| Packet | Phase | Resends | Attempts | Cost |`);
    p(`|---|---|---:|---:|---:|`);
    for (const k of r.resent) p(`| \`${k.task_id}\` | ${k.phase} | ${k.resends} | ${k.attempts} | ${fmtUSD(k.cost_usd)} |`);
    p();
  }

  if (r.delegated_packets > 0) {
    p(`## Delegated to an agent worker`);
    p();
    p(`${r.delegated_packets} packet(s) ran as agent sessions rather than single completion calls.`);
    p();
  }

  p(`---`);
  p();
  p(`_Provenance key: V = vendor-metered, E = estimated, M = modeled, – = no model call (skipped or in-session), ~ = mixed within phase, ? = unlabelled._`);
  const provLine = provenanceLine(r);
  if (provLine) p(`_Dispatched events: ${provLine}._`);
  for (const n of r.notices) {
    p();
    p(`> **${n.title}:** ${n.text}`);
  }
  return out.join("\n");
}

export function render(report, { markdown = false } = {}) {
  return markdown ? renderMarkdown(report) : renderText(report);
}

// ─── entry points ─────────────────────────────────────────────────────

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The command that reports a run folder, with this script's absolute path. */
export function reportCommand(runDir, { markdown = false } = {}) {
  return `node ${shellQuote(REPORT_SCRIPT)} ${shellQuote(runDir)}${markdown ? " --markdown" : ""}`;
}

/** Writes `<runDir>/report.md`. Returns its path, or null when the folder holds nothing to report. */
export function writeReport(runDir, { file = "report.md" } = {}) {
  const run = readRun(runDir);
  if (!hasRunData(run)) return null;
  const path = join(runDir, file);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, render(summarize(run), { markdown: true }) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

const usage = (self) => `Usage: node '${self}' <run-folder | project .sdlc folder> [--markdown | --json]`;

export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }, self = process.argv[1] ?? REPORT_SCRIPT) {
  let format = "text";
  const positional = [];
  for (const arg of argv) {
    if (arg === "--markdown" || arg === "--json") {
      const wanted = arg.slice(2);
      if (format !== "text" && format !== wanted) {
        io.err("report: pass --markdown or --json, not both.");
        io.err(usage(self));
        return 2;
      }
      format = wanted;
    } else if (arg === "--help" || arg === "-h") {
      io.out(usage(self));
      return 0;
    } else if (arg.startsWith("-")) {
      io.err(`report: unknown option ${arg}`);
      io.err(usage(self));
      return 2;
    } else {
      positional.push(arg);
    }
  }
  const target = positional.length === 1 ? resolve(positional[0]) : null;
  if (!target || !isDir(target)) {
    io.err(usage(self));
    io.err(`Example: node '${self}' .sdlc/runs/<run-id>   (or .sdlc for the latest run)`);
    return 2;
  }

  const { runDir, selected } = locateRun(target);
  const run = readRun(runDir);
  run.selected = selected;
  if (!hasRunData(run)) {
    io.err(`No telemetry found in ${runDir}${selected?.rule === "latest" ? ` (the latest run in ${selected.runs_dir})` : ""}.`);
    io.err("Expected telemetry.jsonl (dispatched calls) and/or driver-cost-modeled.jsonl or driver-usage.json (driver turns).");
    io.err("Confirm the run actually started — a run halted at preflight produces neither.");
    return 2;
  }
  const report = summarize(run);
  io.out(format === "json" ? JSON.stringify(report, null, 2) : render(report, { markdown: format === "markdown" }));
  return 0;
}

function invokedDirectly() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1] ?? ""));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
