#!/usr/bin/env node
/**
 * Writes <run-dir>/driver-usage.json: the conductor's modeled cost, read from
 * its codex session file and priced from the dated price list, and, for a
 * headless run, cross-checked token for token against the exec stream in
 * driver-events.jsonl. run-finalize.mjs runs it at every run end.
 *
 *   node plugin/scripts/collect-driver-usage.mjs <run-dir> [--codex-home=<dir>]
 *     [--thread=<id>]... [--policy=<name> | --policy-path=<file>] [--project-root=<dir>]
 *     [--route=headless|interactive] [--from-conductor] [--dry-run]
 *
 * Exit 0 written (or printed, with --dry-run), 1 nothing to measure, 2 usage error.
 */

import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  DRIVER_EVENTS_FILE,
  DRIVER_USAGE_FILE,
  driverUsageInputs,
  isThreadId,
  measureDriverUsage,
  parseDriverEvents,
  readJsonl,
  readSessionMarkers,
} from "../mcp/model-dispatch/dist/sessionUsage.js";
import { loadPolicy, loadPolicyFromPath } from "../mcp/model-dispatch/dist/policy.js";
import { readRunJson } from "../codex/interactive-run.mjs";
import { appendSessionMarker } from "../codex/session-marker.mjs";
import { isMain } from "./lib/is-main.mjs";
import { exitAfterFlush } from "./lib/exit.mjs";

export const DEFAULT_POLICY = "gpt-plus-flash";
const VALUE_FLAGS = new Set(["codex-home", "thread", "policy", "policy-path", "project-root", "route"]);
const BOOL_FLAGS = new Set(["from-conductor", "dry-run"]);

export class UsageError extends Error {}

export function parseCollectorArgs(argv) {
  const out = { runDir: null, threads: [], fromConductor: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (out.runDir) throw new UsageError(`one run directory only, got '${out.runDir}' and '${a}'`);
      out.runDir = a;
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL_FLAGS.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} takes no value`);
      if (key === "from-conductor") out.fromConductor = true;
      else out.dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`unknown flag --${key}`);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (!value || (eq === -1 && value.startsWith("--"))) throw new UsageError(`--${key} needs a value`);
    if (key === "thread") {
      if (!isThreadId(value)) throw new UsageError(`--thread '${value}' is not a codex thread id`);
      out.threads.push(value);
    }
    else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  if (!out.runDir) throw new UsageError("a run directory is required");
  if (out.route && out.route !== "headless" && out.route !== "interactive") {
    throw new UsageError(`--route must be headless or interactive, got '${out.route}'`);
  }
  if (out.policy && out.policyPath) throw new UsageError("pass --policy or --policy-path, not both");
  return out;
}

/** `<root>/.sdlc/runs/<id>` or a legacy `<root>/.sdlc`; anything else names no project. */
export function inferProjectRoot(runDir) {
  const parent = dirname(runDir);
  if (basename(parent) === "runs" && basename(dirname(parent)) === ".sdlc") return dirname(dirname(parent));
  if (basename(runDir) === ".sdlc") return parent;
  return null;
}

/**
 * The policy the run itself named: the file run.mjs or start-run.mjs priced it
 * from while that file still exists, else the driver's invocation record, else
 * the latest dispatch marker.
 */
export function recordedPolicy(runDir) {
  const lines = readJsonl(join(runDir, DRIVER_EVENTS_FILE));
  const recordedFile =
    lines.filter((l) => l?.kind === "invocation_start" && typeof l.policy_path === "string").map((l) => l.policy_path).at(-1) ??
    readRunJson(runDir)?.policy_path;
  if (typeof recordedFile === "string" && isAbsolute(recordedFile) && existsSync(recordedFile)) return recordedFile;
  const fromDriver = parseDriverEvents(lines)
    .map((i) => i.policy)
    .filter(Boolean)
    .at(-1);
  return fromDriver ?? readSessionMarkers(runDir).map((m) => m.policy).filter(Boolean).at(-1) ?? null;
}

export function resolveCollectorPolicy({ runDir, policyName, policyPath, projectRoot }) {
  if (policyPath) return loadPolicyFromPath(resolve(policyPath));
  const named = policyName ?? recordedPolicy(runDir);
  if (named && (named.includes("/") || named.endsWith(".yaml"))) return loadPolicyFromPath(resolve(named));
  const root = projectRoot ? resolve(projectRoot) : inferProjectRoot(runDir);
  return loadPolicy({ policyName: named ?? DEFAULT_POLICY, projectRoot: root ?? undefined });
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

/**
 * Never throws: a run's finalisation calls this, and a figure that cannot be
 * collected must not change the run's outcome.
 */
export function collectDriverUsage(runDir, opts = {}) {
  const dir = resolve(runDir);
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m) => console.error(m));
  const now = opts.now ?? (() => new Date().toISOString());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, code: "no_run_dir", message: `${dir} is not a directory` };
  }
  let policy;
  try {
    policy = opts.policy ?? resolveCollectorPolicy({ runDir: dir, policyName: opts.policyName, policyPath: opts.policyPath, projectRoot: opts.projectRoot });
  } catch (err) {
    return { ok: false, code: "policy", message: `could not load the run's policy: ${err?.message ?? err}` };
  }
  const extraMarkers = [];
  if (opts.fromConductor) {
    const marker = { tool: "collect_driver_usage", policy: policy.name };
    if (!env.CODEX_THREAD_ID) warn("collect-driver-usage: --from-conductor needs CODEX_THREAD_ID, which codex sets in its shells; no marker written.");
    // A dry run measures as if marked but leaves driver-session.jsonl alone: a marker would widen every later window.
    else if (opts.dryRun) extraMarkers.push({ ts: now(), thread_id: env.CODEX_THREAD_ID.trim(), ...marker, pid: process.pid });
    else appendSessionMarker(dir, marker, { env, now, warn });
  }
  let measured;
  try {
    measured = measureDriverUsage({
      runDir: dir,
      policy,
      codexHome: opts.codexHome ? resolve(opts.codexHome) : undefined,
      env,
      route: opts.route,
      threadIds: opts.threadIds,
      priceFn: opts.priceFn,
      markers: extraMarkers,
    });
  } catch (err) {
    return { ok: false, code: "read", message: `could not read the conductor's usage: ${err?.message ?? err}` };
  }
  if (!measured.ok) return { ok: false, code: measured.code, message: measured.message };
  const report = { ...measured.report, inputs: driverUsageInputs(dir), collected_at: now() };
  const path = join(dir, DRIVER_USAGE_FILE);
  if (!opts.dryRun) {
    try {
      writeAtomic(path, JSON.stringify(report, null, 2) + "\n");
    } catch (err) {
      return { ok: false, code: "write", message: `could not write ${path}: ${err?.message ?? err}` };
    }
  }
  return { ok: true, report, path, written: !opts.dryRun };
}

export function summaryLine(report, path, written) {
  const usd = `$${report.cost_usd_modeled.toFixed(6)}`;
  return `driver usage: ${usd} modeled, ${report.cost_source}${written ? ` -> ${path}` : " (dry run, nothing written)"}`;
}

const CHECK_BUCKETS = [
  ["input_tokens", "input"],
  ["cached_input_tokens", "cached input"],
  ["output_tokens", "output"],
  ["reasoning_output_tokens", "reasoning"],
];

/**
 * The exec-stream versus session-file token comparison, one line per thread
 * and per invocation: each bucket as `exec/session (difference)`, the
 * difference being session minus exec.
 */
export function crossCheckLines(report) {
  const cc = report?.cross_check;
  if (!cc) return [];
  const cell = (exec, session) =>
    CHECK_BUCKETS.map(([k, label]) => {
      const a = exec ? exec[k] : null;
      const b = session ? session[k] : null;
      const d = a == null || b == null ? "?" : b - a;
      return `${label} ${a ?? "-"}/${b ?? "-"} (${d})`;
    }).join(", ");
  const lines = [`token cross-check: ${cc.verdict}${cc.verified ? ", verified" : ", UNVERIFIED"} (exec stream/session file, difference)`];
  for (const t of cc.threads ?? []) lines.push(`  thread ${t.thread_id}: ${t.verdict}; ${cell(t.exec_stream_tokens, t.session_tokens)}`);
  for (const i of cc.invocations ?? []) {
    const note = i.reason ? ` — ${i.reason}` : "";
    lines.push(`  invocation ${i.invocation} (${i.thread_id}): ${i.status}; ${cell(i.exec_delta, i.session_turn_tokens)}${note}`);
  }
  return lines;
}

function cli() {
  let args;
  try {
    args = parseCollectorArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`collect-driver-usage: ${err.message}`);
    console.error("usage: node plugin/scripts/collect-driver-usage.mjs <run-dir> [--codex-home=<dir>] [--thread=<id>] [--policy=<name>|--policy-path=<file>] [--project-root=<dir>] [--route=headless|interactive] [--from-conductor] [--dry-run]");
    exitAfterFlush(2);
    return;
  }
  const result = collectDriverUsage(args.runDir, {
    codexHome: args.codexHome,
    threadIds: args.threads,
    policyName: args.policy,
    policyPath: args.policyPath,
    projectRoot: args.projectRoot,
    route: args.route,
    fromConductor: args.fromConductor,
    dryRun: args.dryRun,
  });
  if (!result.ok) {
    console.error(`collect-driver-usage: ${result.message}`);
    exitAfterFlush(result.code === "no_run_dir" || result.code === "policy" ? 2 : 1);
    return;
  }
  if (args.dryRun) console.log(JSON.stringify(result.report, null, 2));
  else {
    console.log(summaryLine(result.report, result.path, result.written));
    for (const line of crossCheckLines(result.report)) console.log(line);
  }
  exitAfterFlush(0);
}

if (isMain(import.meta.url, process.argv[1])) {
  cli();
}
