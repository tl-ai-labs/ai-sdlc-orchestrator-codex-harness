#!/usr/bin/env node
/**
 * Session-hydrate. Reads the project's committed brownfield state (project.json,
 * last few ledger rows, baseline metadata, live setup-status) and emits a
 * compact JSON payload the orchestrator uses to produce a one-line
 * "SDLC: N prior runs (last: <intent>, <age>); baseline <state>; <resume>"
 * marker at session start (and to make the correct routing decision on
 * first /mmo:brownfield invocation — normal task vs resume interrupted setup
 * vs first-time-in-this-repo).
 *
 * Purely a reader. Never writes state, never mutates anything.
 *
 * Usage:
 *   node session-hydrate.mjs                    # walks up from cwd for .sdlc/
 *   node session-hydrate.mjs --sdlc /abs/.sdlc  # explicit
 *   node session-hydrate.mjs --json             # default; JSON on stdout
 *   node session-hydrate.mjs --marker           # print only the one-line marker
 *
 * Output JSON schema (v1):
 *   { schema_version, sdlc_root, marker,
 *     project: {…} | null,
 *     baseline: { present, git_head, built_at, staleness_hint } | null,
 *     recent_runs: [{ run_id, intent, started_at, outcome, files_touched, spend_usd }, …],
 *     recent_runs_total: N,
 *     resume: { pending: bool, run_id, section, checkpoint, at, staleness } | null,
 *     concurrent: { possible: bool, pid, run_id, started_at } | null }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const MMO_REL = ".sdlc";
const MAX_RECENT_RUNS = 3;

// ─── path discovery ──────────────────────────────────────────────────

function findSdlcRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const c = join(dir, MMO_REL);
    if (existsSync(c)) return c;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ─── safe readers (always fail-open) ─────────────────────────────────

function safeReadJson(path) {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ─── humanization ────────────────────────────────────────────────────

function humanAge(iso) {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diff = Date.now() - then;
  const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  const d = Math.floor(diff / day);
  return d === 1 ? "1d ago" : `${d}d ago`;
}

// ─── ledger reader ───────────────────────────────────────────────────

function readLedger(sdlc) {
  // Prefer the JSON mirror; markdown is human-only.
  const json = safeReadJson(join(sdlc, "ledger.json"));
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.runs)) return json.runs;
  return [];
}

function shapeRun(row) {
  // Ledger row schema is defined loose on purpose — accept any of a few
  // reasonable field names to survive minor schema drift.
  return {
    run_id: row.run_id ?? row.id ?? null,
    intent: row.intent ?? null,
    started_at: row.started_at ?? row.timestamp ?? row.ts ?? null,
    outcome: row.outcome ?? row.status ?? null,
    files_touched: row.files_touched ?? row.files ?? null,
    spend_usd: row.spend_usd ?? row.cost_usd ?? row.cost ?? null,
    branch: row.branch ?? null,
    plugin_version: row.plugin_version ?? null,
  };
}

// ─── baseline hint ───────────────────────────────────────────────────

function baselineHint(sdlc) {
  const cur = safeReadJson(join(sdlc, "baseline", "current.json"));
  if (!cur) return null;
  return {
    present: true,
    schema_version: cur.schema_version ?? null,
    git_head: cur?.git?.head ?? null,
    built_at: cur.built_at ?? null,
    stacks: Array.isArray(cur.stacks) ? cur.stacks.map((s) => s.stack ?? s.manifest).filter(Boolean) : [],
  };
}

// ─── resume state ────────────────────────────────────────────────────

function readResume(sdlc) {
  const s = safeReadJson(join(sdlc, "local", "state.json"));
  const setup = safeReadJson(join(sdlc, "local", "setup-status.json"));

  // Setup-status is checked first; an interrupted setup is more urgent than an
  // interrupted task run because tasks can't proceed until setup completes.
  if (setup && Array.isArray(setup.sections_pending) && setup.sections_pending.length > 0) {
    const first = setup.sections_pending[0];
    return {
      pending: true,
      kind: "setup",
      section: typeof first === "object" ? first.number ?? first.name ?? null : first,
      at: setup.timestamp ?? setup.last_updated ?? null,
    };
  }

  if (s && s.status && s.status !== "complete" && s.status !== "aborted") {
    return {
      pending: true,
      kind: "run",
      run_id: s.run_id ?? null,
      phase: s.phase ?? null,
      checkpoint: s.checkpoint ?? s.next_packet_index ?? null,
      status: s.status,
      at: s.timestamp ?? s.updated_at ?? null,
    };
  }

  return null;
}

// ─── concurrent-run advisory (v1 marker file, not a real lock) ───────

function readConcurrent(sdlc) {
  const marker = safeReadJson(join(sdlc, "local", "run.marker"));
  if (!marker || !marker.pid || !marker.started_at) return null;

  // 10-minute freshness bound: older markers are almost certainly stale
  // (session crashed, machine slept). Per §14.2 — v1.5 replaces with a
  // real portable lock.
  const startedMs = Date.parse(marker.started_at);
  if (Number.isNaN(startedMs) || Date.now() - startedMs > 10 * 60 * 1000) return null;

  // If the PID is still alive on this machine, that's a real signal. On
  // shared filesystems or across-machine mounts this is best-effort; the
  // v1 contract is advisory anyway.
  let alive = false;
  try {
    process.kill(marker.pid, 0); // signal 0 = "does the process exist?"
    alive = true;
  } catch { /* ESRCH → not alive */ }
  if (!alive) return null;

  return {
    possible: true,
    pid: marker.pid,
    run_id: marker.run_id ?? null,
    started_at: marker.started_at,
    age: humanAge(marker.started_at),
  };
}

// ─── marker line ─────────────────────────────────────────────────────

function buildMarker({ recentRuns, recentRunsTotal, baseline, resume, concurrent }) {
  const parts = [];

  if (recentRunsTotal === 0) {
    parts.push("no prior runs recorded");
  } else {
    const last = recentRuns[0];
    const intent = last?.intent ? `last: ${last.intent}` : "last: unknown";
    const age = humanAge(last?.started_at);
    parts.push(`${recentRunsTotal} prior run${recentRunsTotal === 1 ? "" : "s"} (${intent}, ${age})`);
  }

  if (baseline) {
    parts.push(baseline.git_head ? `baseline at ${baseline.git_head.slice(0, 7)}` : "baseline present");
  } else {
    parts.push("no baseline");
  }

  if (resume?.pending) {
    if (resume.kind === "setup") parts.push(`interrupted setup at section ${resume.section ?? "?"}`);
    else parts.push(`resume: run ${resume.run_id ?? "?"} at ${resume.phase ?? "?"}`);
  } else {
    parts.push("no open resume checkpoint");
  }

  if (concurrent?.possible) {
    parts.push(`⚠ another run may be in progress (PID ${concurrent.pid}, ${concurrent.age})`);
  }

  return "SDLC: " + parts.join("; ") + ".";
}

// ─── main ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { sdlc: null, markerOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sdlc") args.sdlc = argv[++i] ?? null;
    else if (a === "--marker") args.markerOnly = true;
    else if (a === "--json") args.markerOnly = false;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const sdlc = args.sdlc ? resolve(args.sdlc) : findSdlcRoot();

  // No .sdlc/ anywhere → this session isn't a brownfield project. Emit a
  // benign payload so callers can no-op cleanly.
  if (!sdlc) {
    const payload = {
      schema_version: 1,
      sdlc_root: null,
      marker: null,
      project: null,
      baseline: null,
      recent_runs: [],
      recent_runs_total: 0,
      resume: null,
      concurrent: null,
    };
    if (args.markerOnly) return;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const project = safeReadJson(join(sdlc, "project.json"));
  const ledgerAll = readLedger(sdlc);
  const recentRuns = ledgerAll.slice(-MAX_RECENT_RUNS).reverse().map(shapeRun);
  const baseline = baselineHint(sdlc);
  const resume = readResume(sdlc);
  const concurrent = readConcurrent(sdlc);

  const marker = buildMarker({
    recentRuns,
    recentRunsTotal: ledgerAll.length,
    baseline,
    resume,
    concurrent,
  });

  if (args.markerOnly) {
    process.stdout.write(marker + "\n");
    return;
  }

  const payload = {
    schema_version: 1,
    sdlc_root: sdlc,
    marker,
    project: project ? {
      schema_version: project.schema_version ?? null,
      stacks: project.stacks ?? null,
      test_command: project.test_command ?? null,
      plugin_version_bounds: project.plugin_version_bounds ?? null,
      default_policy: project.default_policy ?? null,
    } : null,
    baseline,
    recent_runs: recentRuns,
    recent_runs_total: ledgerAll.length,
    resume,
    concurrent,
  };

  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

try {
  main();
} catch (e) {
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    error: e?.message ?? String(e),
    marker: null,
  }) + "\n");
  process.exit(0);
}
