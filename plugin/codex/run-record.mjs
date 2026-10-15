/**
 * The driver's own record of a run: driver-events.jsonl (format v1), the
 * evidence a finished invocation leaves, the outcome it maps to, and the
 * driver-manifest.json rebuilt from the record.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";

import { codexEvents } from "./telemetry/event-reader.mjs";
import { findCodexWarnings, findPinRejection } from "./telemetry/fairnessPin.mjs";
import { driverTurns, summarizeDriverTurns } from "../mcp/model-dispatch/dist/driverUsage.js";
import { driverPriceRecord, listDriverPriceFn, PRICE_LIST_VERIFIED } from "../mcp/model-dispatch/dist/driverPricing.js";
import { ACCEPTED_STATUSES, codeWrittenSummary } from "../scripts/write-manifest.mjs";
import { gate4Accepted, gateDecision, gateNumber, isAbortDecision, readGateLines } from "../scripts/lib/gate-record.mjs";

export const RECORD_VERSION = 1;
export const STDOUT_LINE_MAX = 4096;
export const STDERR_TAIL_MAX = 2000;
/** Where a conductor under --gates=prompt puts a question for the person that is not a gate. */
export const QUESTION_FILE = "question.json";

/** outcome → whether a person or a rule meant it, and the driver's exit code (interrupted: 128 + signal). */
export const OUTCOMES = {
  completed: { deliberate: null, exit: 0 },
  aborted: { deliberate: true, exit: 4 },
  halted: { deliberate: true, exit: 4 },
  refused: { deliberate: true, exit: 4 },
  stopped: { deliberate: true, exit: 4 },
  cost_cap: { deliberate: true, exit: 4 },
  pin_rejected: { deliberate: true, exit: 1 },
  max_turns: { deliberate: false, exit: 3 },
  codex_failed: { deliberate: false, exit: 1 },
  interrupted: { deliberate: false, exit: null },
};

export function outcomeExitCode(outcome, signal = null) {
  if (outcome === "interrupted") return 128 + (osConstants.signals[signal] ?? 0);
  const entry = OUTCOMES[outcome];
  if (!entry) throw new Error(`run-record: unknown outcome '${outcome}'`);
  return entry.exit;
}

export function isDeliberate(outcome) {
  return OUTCOMES[outcome]?.deliberate === true;
}

export function appendRecord(runDir, record) {
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, "driver-events.jsonl"), JSON.stringify({ v: RECORD_VERSION, ...record }) + "\n");
}

export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

/** The run_end that closes the latest driver process, or null while it runs (or after it was killed). */
export function lastRunEnd(records) {
  let end = null;
  for (const r of records) {
    if (r.kind === "invocation_start") end = null;
    else if (r.kind === "run_end") end = r;
  }
  return end;
}

/**
 * How the previous driver process ended: its run_end, an `outcome: 'killed'`
 * stand-in when it started an invocation and never wrote one, or null for a
 * new or legacy record.
 */
export function previousRunEnd(records) {
  let last = null;
  for (const r of records) {
    if (r.legacy) continue;
    if (r.kind === "invocation_start" || r.kind === "run_end") last = r;
  }
  if (!last) return null;
  if (last.kind === "run_end") return last;
  return { kind: "run_end", outcome: "killed", deliberate: false, reason: "the driver stopped without writing run_end" };
}

/** `ps -o etime=` prints `[[dd-]hh:]mm:ss`. */
export function parseEtime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

function processStartMs(pid) {
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const secs = r.status === 0 ? parseEtime(r.stdout) : null;
  return secs === null ? null : Date.now() - secs * 1000;
}

/**
 * Whether the driver process a record names still runs. A pid is reused once
 * its process is gone, so a process that started after the record was
 * written is someone else.
 */
export function driverAlive(pid, recordedAt) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code !== "EPERM") return false;
  }
  const started = processStartMs(pid);
  const at = Date.parse(recordedAt ?? "");
  // etime has whole-second resolution.
  return !(started !== null && Number.isFinite(at) && started > at + 2000);
}

/** The driver process still working on this run (mid-turn, or waiting at a gate), or null. */
export function liveDriver(records, alive = driverAlive) {
  let last = null;
  for (const r of records) {
    if (r.legacy) continue;
    if (r.kind === "invocation_start" || r.kind === "run_end") last = r;
  }
  if (last?.kind !== "invocation_start" || last.driver_pid === undefined || last.driver_pid === null) return null;
  return alive(last.driver_pid, last.at) ? { pid: last.driver_pid, invocation: last.invocation, at: last.at } : null;
}

/** The newest run_end anywhere in the record, whether or not a later process started after it. */
export function latestRunEnd(records) {
  let end = null;
  for (const r of records) if (r.kind === "run_end") end = r;
  return end;
}

export function invocationCount(records) {
  return records.filter((r) => r.kind === "invocation_start").length;
}

function readLines(path) {
  try {
    return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

function parseJsonLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      continue;
    }
  }
  return out;
}

export function countLines(path) {
  return readLines(path).length;
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Filesystem mtimes and Date.now() are not taken at the same instant; this keeps a write made right at the start fresh. */
const FRESH_SLACK_MS = 5;

function writtenSince(path, sinceMs) {
  const m = mtimeMs(path);
  return m !== null && m + FRESH_SLACK_MS >= sinceMs;
}

/** Files a conductor writes to say why it stopped. */
const STOP_FILES = ["preflight.json", "stop.json", QUESTION_FILE];

/**
 * What a stop.json says the person must decide or provide, or null. With
 * `existing`, a missing record reads as "" (nothing was there) rather than null.
 */
export function stopNeeds(stop, existing = false) {
  if (!stop) return existing ? "" : null;
  return typeof stop.needs === "string" && stop.needs.trim() ? stop.needs.trim() : null;
}

/** The JSON body of a stamp() value, or null. */
function stampedJson(stamped) {
  if (typeof stamped !== "string") return null;
  try {
    return JSON.parse(stamped.slice(stamped.indexOf(":") + 1));
  } catch {
    return null;
  }
}

function stamp(path) {
  const m = mtimeMs(path);
  if (m === null) return null;
  try {
    return `${m}:${readFileSync(path, "utf-8")}`;
  } catch {
    return `${m}:`;
  }
}

/**
 * What the stop check compares against: each stop file's mtime and content,
 * and the guard log's length, taken just before an invocation starts. Two
 * invocations can start within a millisecond or two of each other (a gate
 * answer), which an mtime-against-start-time check cannot tell apart.
 */
export function snapshotStopEvidence(runDir, projectRoot) {
  const files = {};
  for (const name of STOP_FILES) files[name] = stamp(join(runDir, name));
  return { files, guardLines: countLines(join(projectRoot, ".sdlc", "local", "guard-decisions.jsonl")) };
}

export { gateDecision, gateNumber, readGateLines };

/** The latest Gate 4 line when it accepts the run, or null. */
export function gate4Acceptance(runDir) {
  return gate4Accepted(readGateLines(runDir));
}

/**
 * Completion needs the latest Gate 4 line to accept the run, and the final
 * report written after it: a SUMMARY.md that write-manifest.mjs wrote
 * since the run began, with the manifest's status accepted or auto-approved
 * (the Gate 4 re-run, after any close-out). Phase 9's first SUMMARY.md is
 * provisional and comes before Gate 4. `summaryReason` says why a SUMMARY.md
 * on disk does not count.
 */
export function completionEvidence(runDir, runStartedAtMs) {
  const summary = join(runDir, "SUMMARY.md");
  const exists = existsSync(summary);
  const fresh = exists && (runStartedAtMs == null || writtenSince(summary, runStartedAtMs - 2000));
  let byCode = fresh ? codeWrittenSummary(runDir) : { ok: false, reason: exists ? "SUMMARY.md is older than this run" : null };
  if (byCode.ok && !ACCEPTED_STATUSES.includes(byCode.status)) {
    byCode = {
      ok: false,
      reason: `manifest.json's status is ${byCode.status}: Phase 9's command has not been run again with --status=accepted (or --status=auto-approved) since Gate 4`,
    };
  }
  const accepted = gate4Acceptance(runDir) !== null;
  return { summary: byCode.ok, summaryReason: byCode.ok ? null : byCode.reason, gate4: accepted, complete: byCode.ok && accepted };
}

/** A completed run's reason, in the words its Gate 4 line recorded: an unattended run says auto-approved. */
export function completionReason(runDir) {
  return `write-manifest.mjs wrote SUMMARY.md and Gate 4 was ${gateDecision(gate4Acceptance(runDir)) || "accepted"}`;
}

/**
 * Why an invocation's turn ended, from evidence written during that
 * invocation only. Returns {outcome, reason, gate?, question?} or null when
 * nothing in the folder says the run stopped (a context-ceiling stop, so
 * resume). `gate_pending` and `question_pending` wait for the person.
 */
export function stopCheck({
  runDir,
  projectRoot,
  runId,
  gateMode,
  startedAtMs,
  gatesLinesBefore = 0,
  runStartedAtMs = null,
  events = [],
  before = null,
}) {
  const fresh = (name) => {
    const path = join(runDir, name);
    if (!before) return writtenSince(path, startedAtMs);
    const now = stamp(path);
    return now !== null && now !== before.files[name];
  };
  const newGates = parseJsonLines(readLines(join(runDir, "gates.jsonl")).slice(gatesLinesBefore));
  const last = newGates[newGates.length - 1];
  if (gateMode === "prompt" && last && gateDecision(last) === "pending") {
    const gate = gateNumber(last);
    return { outcome: "gate_pending", gate, reason: `gate ${gate ?? "?"} is waiting for an answer` };
  }
  const aborted = newGates.find((l) => isAbortDecision(gateDecision(l)));
  if (aborted) {
    const note = aborted.note ? `: ${aborted.note}` : "";
    return { outcome: "aborted", reason: `gate ${gateNumber(aborted) ?? "?"} aborted${note}` };
  }

  const preflightPath = join(runDir, "preflight.json");
  if (fresh("preflight.json")) {
    const pre = readJson(preflightPath);
    if (pre && pre.ok === false) return { outcome: "halted", reason: pre.halt_reason ?? "preflight reported ok:false" };
  }

  const guardLog = readLines(join(projectRoot, ".sdlc", "local", "guard-decisions.jsonl"));
  const guard = parseJsonLines(before ? guardLog.slice(before.guardLines) : guardLog);
  const deny = guard.find(
    (d) =>
      d.decision === "deny" &&
      (before || Date.parse(d.ts) + FRESH_SLACK_MS >= startedAtMs) &&
      (d.run_id === undefined || d.run_id === null || d.run_id === runId),
  );
  if (deny) return { outcome: "refused", reason: `${deny.path ?? "a write"}: ${deny.reason ?? "refused by the write contract"}` };

  const stopPath = join(runDir, "stop.json");
  if (fresh("stop.json")) {
    const stop = readJson(stopPath);
    const reason = stop?.reason ?? "the conductor wrote stop.json";
    const needs = stopNeeds(stop);
    if (needs) return { outcome: "stopped", reason: `${reason} (needs: ${needs})` };
    // A stop.json that names nothing for the person to decide is a progress note: resume once,
    // and stop when the resumed turn writes another one.
    if (!before || stopNeeds(stampedJson(before.files["stop.json"]), true) === null) return { outcome: "stopped", reason };
  }

  if (fresh(QUESTION_FILE)) {
    const q = readJson(join(runDir, QUESTION_FILE));
    const question = typeof q?.question === "string" && q.question.trim() ? q.question.trim() : null;
    if (gateMode === "prompt") {
      return { outcome: "question_pending", question, reason: "the conductor is waiting for an answer to its question" };
    }
    return {
      outcome: "stopped",
      reason: `the conductor asked a question nobody can answer under --gates=${gateMode}${question ? `: ${question}` : ""}`,
    };
  }

  const rejection = findPinRejection(events);
  if (rejection) return { outcome: "pin_rejected", reason: `the codex CLI rejected the pinned model or effort — ${rejection}` };

  if (completionEvidence(runDir, runStartedAtMs).complete) {
    return { outcome: "completed", reason: completionReason(runDir) };
  }
  return null;
}

function uniqueInOrder(values) {
  return [...new Set(values.filter((v) => v !== undefined && v !== null))];
}

/**
 * driver-manifest.json, rebuilt whole from the record. `turnPricing` is
 * {model, priceFn, requestsFor?} (run-finalize.mjs driverTurnPricing); a
 * bare `pricing` card still works and is labelled custom. `policy` names
 * the driver's price record; `baselines` are known running totals for
 * threads first seen in a resume.
 */
export function buildDriverManifest(records, { runId, policyName, policyRecord, policy, pin, sandbox, approvalPolicy, pricing, turnPricing, baselines, driverAuth }) {
  const starts = records.filter((r) => r.kind === "invocation_start");
  const ends = records.filter((r) => r.kind === "invocation_end");
  const events = codexEvents(records);
  const turns = driverTurns(records, { baselines });
  const summary = summarizeDriverTurns(turns, turnPricing ?? pricing ?? { model: pin?.model, priceFn: listDriverPriceFn(policy ?? null) });
  const end = lastRunEnd(records);
  const lastEnd = ends[ends.length - 1] ?? null;
  return {
    run_id: runId,
    policy: policyName,
    ...policyRecord,
    gates: uniqueInOrder(starts.map((s) => s.gates)).join(", ") || null,
    pin: { ...pin, sandbox, approval_policy: approvalPolicy },
    started_at: starts[0]?.at ?? null,
    ended_at: end?.at ?? lastEnd?.at ?? null,
    codex_exit_status: lastEnd?.exit_status ?? null,
    driver_turns: summary.turns,
    driver_turns_incomplete: summary.turns_incomplete,
    driver_turns_incomplete_covered: summary.turns_incomplete_covered,
    driver_turns_unpriced: summary.turns_unpriced,
    driver_turns_tier_unverified: summary.turns_tier_unverified,
    driver_cost_complete: summary.turns_incomplete === summary.turns_incomplete_covered && summary.turns_unpriced === 0,
    driver_cost_flags: summary.flags,
    driver_cost_source: "exec stream (driver-cost-modeled.jsonl)",
    codex_invocations: starts.length,
    completed: end?.outcome === "completed",
    cost_cap_stop: end?.outcome === "cost_cap" ? end.reason : null,
    driver_cost_usd_modeled: summary.cost_usd,
    driver_price: pin?.model ? driverPriceRecord(policy ?? null, pin.model, starts[0]?.at ?? new Date()) : null,
    price_list_verified: PRICE_LIST_VERIFIED,
    pin_rejection: findPinRejection(events),
    events_captured: events.length,
    thread_ids: summary.thread_ids,
    outcome: end?.outcome ?? null,
    outcome_reason: end?.reason ?? null,
    exit_code: end?.exit_code ?? null,
    codex_warnings: findCodexWarnings(events),
    driver_auth: driverAuth ?? "unknown",
  };
}

/** `codex login status` wording → how the conductor authenticates. The text itself is never kept. */
export function classifyDriverAuth(text) {
  const s = String(text ?? "");
  if (/logged in using chatgpt/i.test(s)) return "chatgpt";
  if (/logged in using an api key/i.test(s)) return "api_key";
  return "unknown";
}
