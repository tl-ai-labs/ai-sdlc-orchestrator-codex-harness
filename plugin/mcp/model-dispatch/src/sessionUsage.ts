/**
 * Conductor usage read from codex's session file
 * ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<stamp>-<thread_id>.jsonl).
 *
 * Booked series: one `token_usage_record` per completed response. `token_count`
 * totals repeat, leave out remote compaction calls and can be overwritten, so
 * they are booked only when a file has no per-response records, and otherwise
 * serve to cross-check the `codex exec --json` stream, which reports the same
 * running totals.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as zlib from "node:zlib";
import { DriverTurnTracker, type DriverTurn } from "./driverUsage.js";
import { bucketsCostUsd, listDriverPriceFn, PRICE_LIST_VERIFIED, priceDriverTokens, type DriverPriceFn, type DriverRate, type PriceContext } from "./driverPricing.js";
import { round6 } from "./pricing.js";
import type { ModelPricing, Policy, PriceTierLabel } from "./types.js";

export type { DriverPriceFn, DriverRate, PriceContext };

export const USAGE_BUCKETS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];
export type Usage = Record<UsageBucket, number>;

export function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

export function toUsage(raw: unknown): Usage {
  const out = zeroUsage();
  if (raw && typeof raw === "object") {
    for (const k of USAGE_BUCKETS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

function addInto(a: Usage, b: Usage): Usage {
  for (const k of USAGE_BUCKETS) a[k] += b[k];
  return a;
}

function minus(a: Usage, b: Usage): Usage {
  const out = zeroUsage();
  for (const k of USAGE_BUCKETS) out[k] = a[k] - b[k];
  return out;
}

function sumUsage(items: Usage[]): Usage {
  return items.reduce((acc, u) => addInto(acc, u), zeroUsage());
}

export function usageEqual(a: Usage, b: Usage): boolean {
  return USAGE_BUCKETS.every((k) => a[k] === b[k]);
}

function isZero(u: Usage): boolean {
  return USAGE_BUCKETS.every((k) => u[k] === 0);
}

function dropped(next: Usage, prev: Usage): boolean {
  return USAGE_BUCKETS.some((k) => next[k] < prev[k]);
}

function ms(ts: string | null | undefined): number {
  return ts ? Date.parse(ts) : NaN;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ── Locating the session file ─────────────────────────────────────────────

const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID_RE.test(value);
}

export function defaultCodexHome(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

export interface RolloutLocation {
  path: string;
  /** Relative to the codex home. */
  rel: string;
  compressed: boolean;
  archived: boolean;
}

/**
 * Matched on the thread-id suffix only: the date directory is the thread's
 * creation date in local time, and a resumed thread keeps appending to its
 * first file.
 */
export function findRolloutFile(codexHome: string, threadId: string): RolloutLocation | null {
  if (!isThreadId(threadId)) return null;
  const plain = `-${threadId}.jsonl`;
  const packed = `-${threadId}.jsonl.zst`;
  const hits: RolloutLocation[] = [];
  const walk = (dir: string, depth: number, archived: boolean) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1, archived);
      } else if (e.name.startsWith("rollout-") && (e.name.endsWith(plain) || e.name.endsWith(packed))) {
        hits.push({ path: full, rel: relative(codexHome, full), compressed: e.name.endsWith(packed), archived });
      }
    }
  };
  walk(join(codexHome, "sessions"), 0, false);
  walk(join(codexHome, "archived_sessions"), 0, true);
  hits.sort((a, b) => Number(a.compressed) - Number(b.compressed) || Number(a.archived) - Number(b.archived));
  return hits[0] ?? null;
}

export function readRolloutText(loc: RolloutLocation): { text: string } | { error: string } {
  try {
    const buf = readFileSync(loc.path);
    if (!loc.compressed) return { text: buf.toString("utf-8") };
    const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    if (typeof zstd !== "function") {
      return { error: `${loc.rel} is compressed (.jsonl.zst) and this Node has no zstd support` };
    }
    return { text: zstd(buf).toString("utf-8") };
  } catch (err) {
    return { error: `${loc.rel} could not be read: ${(err as Error)?.message ?? err}` };
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────

/** Skills that start a run: the two entry points, `pass`, and every intent id in plugin/config/intents.json. */
export const RUN_SKILLS = [
  "greenfield",
  "brownfield",
  "pass",
  "bugfix",
  "deps",
  "docs",
  "feature-extend",
  "feature-new",
  "refactor",
  "test",
] as const;
export const RUN_SKILL_RE = new RegExp(`(^|\\s)\\$mmo-codex:(${RUN_SKILLS.join("|")})(?![\\w-])`);

export interface RolloutMeta {
  id: string | null;
  originator: string | null;
  source: string | null;
  cli_version: string | null;
  model_provider: string | null;
}

export interface RolloutTurn {
  turn_id: string;
  started_at: string | null;
  ended_at: string | null;
  ended_by: "complete" | "aborted" | null;
  model: string | null;
  effort: string | null;
  invokes_run_skill: boolean;
  /** Hosted tool calls the vendor bills per call, on top of tokens. */
  web_search_calls: number;
}

export interface UsageRecord {
  ts: string | null;
  turn_id: string | null;
  response_id: string | null;
  model: string | null;
  usage: Usage;
  compaction: boolean;
}

export interface TokenCountTotal {
  ts: string | null;
  turn_id: string | null;
  total: Usage;
  last: Usage | null;
}

export type UsageSeries = "token_usage_record" | "token_count" | "none";

export interface Rollout {
  meta: RolloutMeta | null;
  /** Sorted by start; a turn with no task_started sorts last. */
  turns: RolloutTurn[];
  records: UsageRecord[];
  /** Which line type `records` came from. */
  series: UsageSeries;
  token_counts: TokenCountTotal[];
  compaction_ids: string[];
  plan_type: string | null;
  torn_lines: number;
  duplicate_records: number;
  token_count_repeats: number;
  token_count_resets: number;
  /** session_meta's and every turn_context's working folder. */
  cwds: string[];
}

const ROLLOUT_KEYS = [
  '"session_meta"',
  '"turn_context"',
  '"task_started"',
  '"task_complete"',
  '"turn_aborted"',
  '"token_usage_record"',
  '"token_count"',
  '"compacted"',
  '"UserMessage"',
  '"web_search_call"',
];

/** Per-response usage rebuilt from consecutive token_count totals, for files with no token_usage_record. */
function recordsFromTokenCounts(counts: TokenCountTotal[]): { records: UsageRecord[]; repeats: number; resets: number } {
  const records: UsageRecord[] = [];
  let prev = zeroUsage();
  let repeats = 0;
  let resets = 0;
  for (const tc of counts) {
    if (usageEqual(tc.total, prev)) {
      repeats++;
      continue;
    }
    let delta: Usage;
    if (dropped(tc.total, prev)) {
      resets++;
      delta = tc.last && !isZero(tc.last) ? tc.last : tc.total;
    } else {
      delta = minus(tc.total, prev);
    }
    prev = tc.total;
    if (!isZero(delta)) {
      records.push({ ts: tc.ts, turn_id: tc.turn_id, response_id: null, model: null, usage: delta, compaction: false });
    }
  }
  return { records, repeats, resets };
}

function countRepeats(counts: TokenCountTotal[]): { repeats: number; resets: number } {
  let repeats = 0;
  let resets = 0;
  let prev: Usage | null = null;
  for (const tc of counts) {
    if (prev && usageEqual(tc.total, prev)) repeats++;
    else if (prev && dropped(tc.total, prev)) resets++;
    prev = tc.total;
  }
  return { repeats, resets };
}

export function parseRollout(text: string): Rollout {
  const turns = new Map<string, RolloutTurn>();
  const turn = (id: string): RolloutTurn => {
    let t = turns.get(id);
    if (!t) {
      t = { turn_id: id, started_at: null, ended_at: null, ended_by: null, model: null, effort: null, invokes_run_skill: false, web_search_calls: 0 };
      turns.set(id, t);
    }
    return t;
  };
  let records: UsageRecord[] = [];
  const seen = new Set<string>();
  const tokenCounts: TokenCountTotal[] = [];
  const compactions = new Set<string>();
  let meta: RolloutMeta | null = null;
  let planType: string | null = null;
  let torn = 0;
  let duplicates = 0;
  let current: string | null = null;
  const cwds = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line || !ROLLOUT_KEYS.some((k) => line.includes(k))) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      torn++;
      continue;
    }
    const p = j?.payload ?? {};
    const ts = str(j?.timestamp);
    if ((j?.type === "session_meta" || j?.type === "turn_context") && str(p.cwd)) cwds.add(p.cwd);
    if (j?.type === "session_meta") {
      meta ??= {
        id: str(p.id),
        originator: str(p.originator),
        source: str(p.source),
        cli_version: str(p.cli_version),
        model_provider: str(p.model_provider),
      };
    } else if (j?.type === "turn_context") {
      const id = str(p.turn_id);
      if (!id) continue;
      const t = turn(id);
      t.model = str(p.model) ?? str(p.collaboration_mode?.settings?.model) ?? t.model;
      t.effort = str(p.effort) ?? str(p.collaboration_mode?.settings?.reasoning_effort) ?? t.effort;
      current = id;
    } else if (j?.type === "token_usage_record") {
      const responseId = str(p.response_id);
      if (responseId) {
        if (seen.has(responseId)) {
          duplicates++;
          continue;
        }
        seen.add(responseId);
      }
      const turnId = str(p.turn_id) ?? current;
      records.push({
        ts,
        turn_id: turnId,
        response_id: responseId,
        model: turnId ? (turns.get(turnId)?.model ?? null) : null,
        usage: toUsage(p.usage),
        compaction: false,
      });
    } else if (j?.type === "response_item") {
      if (p.type === "web_search_call" && current) turn(current).web_search_calls++;
    } else if (j?.type === "compacted") {
      const id = str(p.compaction_response_id);
      if (id) compactions.add(id);
    } else if (j?.type === "event_msg") {
      const id = str(p.turn_id);
      if (p.type === "task_started" && id) {
        const t = turn(id);
        t.started_at = t.started_at ?? ts;
        current = id;
      } else if ((p.type === "task_complete" || p.type === "turn_aborted") && id) {
        const t = turn(id);
        t.ended_at = ts;
        t.ended_by = p.type === "task_complete" ? "complete" : "aborted";
      } else if (p.type === "token_count") {
        if (p.info?.total_token_usage) {
          tokenCounts.push({
            ts,
            turn_id: current,
            total: toUsage(p.info.total_token_usage),
            last: p.info.last_token_usage ? toUsage(p.info.last_token_usage) : null,
          });
        }
        planType = str(p.rate_limits?.plan_type) ?? planType;
      } else if (p.type === "item_completed" && p.item?.type === "UserMessage" && id) {
        const content = Array.isArray(p.item.content) ? p.item.content : [];
        const said = content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n");
        if (RUN_SKILL_RE.test(said)) turn(id).invokes_run_skill = true;
      }
    }
  }

  let series: UsageSeries = "token_usage_record";
  let counts: { repeats: number; resets: number };
  if (records.length === 0 && tokenCounts.length > 0) {
    const derived = recordsFromTokenCounts(tokenCounts);
    records = derived.records;
    counts = derived;
    series = records.length > 0 ? "token_count" : "none";
  } else {
    counts = countRepeats(tokenCounts);
    if (records.length === 0) series = "none";
  }
  for (const r of records) {
    r.compaction = r.response_id !== null && compactions.has(r.response_id);
    r.model ??= r.turn_id ? (turns.get(r.turn_id)?.model ?? null) : null;
  }
  const ordered = [...turns.values()].sort((a, b) => {
    const x = ms(a.started_at);
    const y = ms(b.started_at);
    if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
    if (Number.isNaN(y)) return -1;
    return x - y;
  });
  return {
    meta,
    turns: ordered,
    records,
    series,
    token_counts: tokenCounts,
    compaction_ids: [...compactions],
    plan_type: planType,
    torn_lines: torn,
    duplicate_records: duplicates,
    token_count_repeats: counts.repeats,
    token_count_resets: counts.resets,
    cwds: [...cwds],
  };
}

export type LoadedRollout =
  | { status: "found"; location: RolloutLocation; rollout: Rollout }
  | { status: "missing" }
  | { status: "unreadable"; location: RolloutLocation; reason: string };

export function loadRollout(codexHome: string, threadId: string): LoadedRollout {
  const location = findRolloutFile(codexHome, threadId);
  if (!location) return { status: "missing" };
  const read = readRolloutText(location);
  if ("error" in read) return { status: "unreadable", location, reason: read.error };
  const rollout = parseRollout(read.text);
  if (!rollout.meta) return { status: "unreadable", location, reason: `${location.rel} has no session_meta line` };
  // A completed turn always ran the model, so no usage line at all means the format moved, not $0.
  const completed = completedTurns(rollout.turns);
  if (rollout.series === "none" && completed > 0) {
    return { status: "unreadable", location, reason: `${location.rel} has ${completed} completed turn(s) but ${NO_USAGE_LINES}` };
  }
  return { status: "found", location, rollout };
}

const NO_USAGE_LINES = "no token_usage_record or token_count line";

function completedTurns(turns: RolloutTurn[]): number {
  return turns.filter((t) => t.ended_by === "complete").length;
}

// ── Run-folder inputs ─────────────────────────────────────────────────────

export const SESSION_MARKERS_FILE = "driver-session.jsonl";
export const DRIVER_EVENTS_FILE = "driver-events.jsonl";
export const DRIVER_USAGE_FILE = "driver-usage.json";
export const DRIVER_COST_MODELED_FILE = "driver-cost-modeled.jsonl";
export const TELEMETRY_FILE = "telemetry.jsonl";
export const RUN_JSON_FILE = "run.json";

/** The byte size of each append-only file a measurement reads, so a later append shows. */
export function driverUsageInputs(runDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of [DRIVER_EVENTS_FILE, SESSION_MARKERS_FILE]) {
    try {
      out[f] = statSync(join(runDir, f)).size;
    } catch {
      out[f] = 0;
    }
  }
  return out;
}

/**
 * False once driver-events.jsonl or driver-session.jsonl has grown since the
 * driver-usage.json `usage` was collected: a resumed run spent past it. A
 * file that records no inputs predates the check and counts as fresh.
 */
export function driverUsageIsFresh(runDir: string, usage: any): boolean {
  const inputs = usage?.inputs;
  if (!inputs || typeof inputs !== "object") return true;
  const now = driverUsageInputs(runDir);
  return Object.entries(now).every(([f, size]) => typeof inputs[f] !== "number" || inputs[f] === size);
}

/** Threads a codex-cli dispatch of this run ran in (telemetry.jsonl codex_thread_id): never the conductor's. */
export function nestedDispatchThreads(runDir: string): Set<string> {
  const out = new Set<string>();
  for (const ev of readJsonl(join(runDir, TELEMETRY_FILE))) {
    if (isThreadId(ev?.codex_thread_id)) out.add(ev.codex_thread_id);
  }
  return out;
}

/** The conductor threads start-run.mjs recorded in run.json, one per start or resume; empty when none did. */
export function recordedConductorThreads(runDir: string): Set<string> {
  const out = new Set<string>();
  const path = join(runDir, RUN_JSON_FILE);
  if (!existsSync(path)) return out;
  try {
    const run = JSON.parse(readFileSync(path, "utf-8"));
    for (const st of Array.isArray(run?.starts) ? run.starts : []) {
      if (isThreadId(st?.codex_thread_id)) out.add(st.codex_thread_id);
    }
  } catch {
    // An unreadable run.json scopes nothing; the markers stand on their own.
  }
  return out;
}

/** Torn lines are skipped: these files are appended to while they are read. */
export function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

export interface SessionMarker {
  ts: string;
  thread_id: string;
  tool: string | null;
  policy: string | null;
  pid: number | null;
  /** The real path of the run folder the marker came from, when it was read from another run's. */
  run?: string;
}

/** The tool name collect-driver-usage.mjs --from-conductor writes when a run's end is recorded. */
export const COLLECTION_MARKER_TOOL = "collect_driver_usage";
/** The tool name start-run.mjs writes when a run starts or resumes in a session. */
export const START_MARKER_TOOL = "start_run";

export function readSessionMarkers(runDir: string): SessionMarker[] {
  return readJsonl(join(runDir, SESSION_MARKERS_FILE))
    .filter((m) => isThreadId(m?.thread_id) && !Number.isNaN(ms(m?.ts)))
    .map((m) => ({
      ts: m.ts,
      thread_id: m.thread_id,
      tool: str(m.tool),
      policy: str(m.policy),
      pid: typeof m.pid === "number" ? m.pid : null,
    }));
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Markers the other runs left, read from every run folder in the run's own
 * `.sdlc/runs/` and in `<folder>/.sdlc/runs/` for each of `folders` and each
 * folder above it. start-run.mjs puts a run at the session's working folder
 * or at its git toplevel, so the session file's working folders reach every
 * run started in that chat.
 */
export function otherRunMarkers(runDir: string, folders: string[] = []): SessionMarker[] {
  const own = realPath(runDir);
  const roots = new Set<string>();
  const parent = dirname(resolve(runDir));
  if (basename(parent) === "runs" && basename(dirname(parent)) === ".sdlc") roots.add(realPath(parent));
  for (const folder of folders) {
    for (let d = resolve(folder); ; d = dirname(d)) {
      const runs = join(d, ".sdlc", "runs");
      if (existsSync(runs)) roots.add(realPath(runs));
      if (dirname(d) === d) break;
    }
  }
  const out: SessionMarker[] = [];
  for (const runs of roots) {
    let entries;
    try {
      entries = readdirSync(runs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = join(runs, e.name);
      if (!e.isDirectory() || dir === own) continue;
      out.push(...readSessionMarkers(dir).map((m) => ({ ...m, run: dir })));
    }
  }
  return out;
}

/** One `codex exec` process, read from driver-events.jsonl (v1 lines, or a legacy bare stream). */
export interface ExecInvocation {
  invocation: number | null;
  thread_id: string | null;
  mode: "fresh" | "resume" | null;
  policy: string | null;
  started_at: string | null;
  ended_at: string | null;
  completed_turns: number;
  failed_turns: number;
  zero_usage_turns: number;
  /** The last non-zero turn.completed usage: the thread's running total at that point. */
  cumulative: Usage | null;
  legacy: boolean;
}

function newInvocation(partial: Partial<ExecInvocation>): ExecInvocation {
  return {
    invocation: null,
    thread_id: null,
    mode: null,
    policy: null,
    started_at: null,
    ended_at: null,
    completed_turns: 0,
    failed_turns: 0,
    zero_usage_turns: 0,
    cumulative: null,
    legacy: false,
    ...partial,
  };
}

function applyCodexEvent(inv: ExecInvocation, ev: any): void {
  if (ev?.type === "thread.started" && isThreadId(ev.thread_id)) {
    inv.thread_id = ev.thread_id;
  } else if (ev?.type === "turn.completed") {
    inv.completed_turns++;
    const u = toUsage(ev.usage);
    // All zeros means no token update reached exec, not a reset.
    if (isZero(u)) inv.zero_usage_turns++;
    else inv.cumulative = u;
  } else if (ev?.type === "turn.failed") {
    inv.failed_turns++;
  }
}

export function parseDriverEvents(lines: any[]): ExecInvocation[] {
  const invs: ExecInvocation[] = [];
  const find = (n: unknown): ExecInvocation | undefined => {
    for (let i = invs.length - 1; i >= 0; i--) {
      if (!invs[i].legacy && invs[i].invocation === n) return invs[i];
    }
    return undefined;
  };
  const seenThreads = new Set<string>();
  let legacy: ExecInvocation | null = null;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (line.v !== undefined && typeof line.kind === "string") {
      const n = typeof line.invocation === "number" ? line.invocation : null;
      if (line.kind === "invocation_start") {
        invs.push(
          newInvocation({
            invocation: n,
            mode: line.mode === "fresh" || line.mode === "resume" ? line.mode : null,
            thread_id: isThreadId(line.resume_thread_id) ? line.resume_thread_id : null,
            policy: str(line.policy),
            started_at: str(line.at),
          }),
        );
      } else if (line.kind === "codex" || line.kind === "invocation_end") {
        let inv = find(n);
        if (!inv) {
          inv = newInvocation({ invocation: n });
          invs.push(inv);
        }
        if (isThreadId(line.thread_id)) inv.thread_id = line.thread_id;
        if (line.kind === "codex") applyCodexEvent(inv, line.event);
        else inv.ended_at = str(line.at);
      }
    } else if (typeof line.type === "string") {
      if (!legacy || line.type === "thread.started") {
        legacy = newInvocation({ legacy: true });
        invs.push(legacy);
      }
      applyCodexEvent(legacy, line);
      if (line.type === "thread.started" && legacy.thread_id) {
        legacy.mode = seenThreads.has(legacy.thread_id) ? "resume" : null;
        seenThreads.add(legacy.thread_id);
      }
    }
  }
  return invs;
}

// ── Windows ───────────────────────────────────────────────────────────────

export interface Span {
  start: string | null;
  end: string | null;
}

export interface DriverWindow {
  start: string | null;
  end: string | null;
  start_anchor: "command_turn" | "start_run_turn" | "first_dispatch_turn" | "first_marker" | "invocation_start" | "whole_thread";
  end_anchor: "last_marker_turn" | "invocation_end" | "open" | "whole_thread";
  exact: boolean;
  lower_bound: boolean;
  provisional: boolean;
  /** Turns between the window's first and last that belong to another run, or to none. */
  left_out_turns?: number;
}

function inSpan(t: number, s: Span): boolean {
  const a = s.start ? ms(s.start) : -Infinity;
  const b = s.end ? ms(s.end) : Infinity;
  return t >= a && t <= b;
}

export function turnsInSpans(rollout: Rollout, spans: Span[]): RolloutTurn[] {
  return rollout.turns.filter((t) => {
    const s = ms(t.started_at);
    return !Number.isNaN(s) && spans.some((span) => inSpan(s, span));
  });
}

/**
 * One span per invocation in `invs`. An invocation with no invocation_end
 * (the driver was killed) is closed at its first turn, bounded by the next
 * invocation's start in `all`: `codex exec` runs one turn per process, and an
 * open span would take in every later turn of a thread resumed elsewhere.
 */
export function invocationSpans(invs: ExecInvocation[], all: ExecInvocation[], rollout: Rollout): Span[] {
  const starts = all.map((i) => ms(i.started_at)).filter((t) => !Number.isNaN(t));
  return invs.map((inv) => {
    if (inv.ended_at || !inv.started_at) return { start: inv.started_at, end: inv.ended_at };
    const from = ms(inv.started_at);
    const next = starts.filter((t) => t > from).reduce((a, b) => Math.min(a, b), Infinity);
    const turn = rollout.turns.find((t) => {
      const s = ms(t.started_at);
      return s >= from && s < next;
    });
    return { start: inv.started_at, end: turn?.started_at ?? inv.started_at };
  });
}

export interface ExecSessionFacts {
  /** Per-response usage for each invocation, keyed by invocation number. */
  requests: Map<number, Usage[]>;
  /** Running totals for threads whose first invocation resumes a thread this run folder has no earlier record of. */
  baselines: Record<string, Usage>;
}

/**
 * What the session file adds to an exec stream (`lines`, driver-events.jsonl)
 * for pricing it: each invocation's per-response usage, so a turn the stream
 * reports only as a sum is priced response by response; and, for a thread
 * first seen in a resume, its total before that invocation, so the first
 * turn is not priced at the thread's whole running total. Left out of
 * `requests`: threads with no per-response records, invocations with more
 * than one completed turn, and compaction calls (the stream's totals omit
 * them).
 */
export function execSessionFacts(lines: any[], codexHome: string): ExecSessionFacts {
  const all = parseDriverEvents(lines).filter((i) => !i.legacy && i.started_at && typeof i.invocation === "number");
  const out: ExecSessionFacts = { requests: new Map(), baselines: {} };
  const threads = [...new Set(all.map((i) => i.thread_id).filter((t): t is string => isThreadId(t)))];
  for (const thread of threads) {
    const loaded = loadRollout(codexHome, thread);
    if (loaded.status !== "found") continue;
    const rollout = loaded.rollout;
    const invs = all.filter((i) => i.thread_id === thread);
    if (invs[0].mode === "resume") {
      const before = lastTokenCountAtOrBefore(rollout, ms(invs[0].started_at) - 1);
      if (before) out.baselines[thread] = before.total;
    }
    if (rollout.series !== "token_usage_record") continue;
    const spans = invocationSpans(invs, all, rollout);
    invs.forEach((inv, k) => {
      if (inv.completed_turns !== 1) return;
      const ids = new Set(turnsInSpans(rollout, [spans[k]]).map((t) => t.turn_id));
      const usages = rollout.records.filter((r) => r.turn_id && ids.has(r.turn_id) && !r.compaction).map((r) => r.usage);
      if (usages.length > 0) out.requests.set(inv.invocation as number, usages);
    });
  }
  return out;
}

/** A marker as the interactive window reads it; `run` names the run folder it came from. */
export interface RunMarker {
  ts: string;
  run?: string | null;
  tool?: string | null;
}

interface TaggedMarker {
  t: number;
  run: string;
  closing: boolean;
  start: boolean;
}

interface MarkerSegment {
  run: string;
  first: number;
  last: number;
  /** The segment opens with start-run.mjs's marker, so nothing of the run comes before its turn. */
  started: boolean;
}

const THIS_RUN = "(this run)";
const ANOTHER_RUN = "(another run)";

function tagMarkers(markers: RunMarker[], run: (m: RunMarker) => string): TaggedMarker[] {
  return markers
    .map((m) => ({ t: ms(m.ts), run: run(m), closing: m.tool === COLLECTION_MARKER_TOOL, start: m.tool === START_MARKER_TOOL }))
    .filter((m) => !Number.isNaN(m.t));
}

/**
 * Every run's markers on one thread, in time order, merged into segments of
 * consecutive markers from one run. A collection marker after another run's
 * marker was written from that run's session (a discard there), so it claims
 * no turn.
 */
function markerSegments(markers: TaggedMarker[]): MarkerSegment[] {
  const sorted = [...markers].sort((a, b) => a.t - b.t || (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));
  const out: MarkerSegment[] = [];
  for (const m of sorted) {
    const prev = out.at(-1);
    if (prev?.run === m.run) prev.last = m.t;
    else if (!m.closing || !prev) out.push({ run: m.run, first: m.t, last: m.t, started: m.start });
  }
  return out;
}

interface MarkerAttribution {
  window: DriverWindow;
  turns: RolloutTurn[];
  /** For a turn this run shares with another run's segment, the responses that are this run's. */
  records: Map<string, UsageRecord[]>;
}

interface TurnShare {
  lo: number;
  hi: number;
  records: UsageRecord[] | null;
}

/**
 * Interactive route. Each segment of this run's markers opens at the latest
 * `$mmo-codex:<run skill>` turn after the previous segment's last marker and
 * at or before its own first one, else at the turn holding that first marker
 * (a lower bound unless start-run.mjs wrote it: interview turns come before
 * the first dispatch), and closes at the end of the turn holding its last
 * marker. A turn two segments share is
 * split at the earlier segment's last marker: each response goes to the run
 * whose marker follows it, so every response belongs to exactly one run.
 */
function attributeMarkers(rollout: Rollout, own: RunMarker[], others: RunMarker[], ownRun: string): MarkerAttribution | null {
  const mine = tagMarkers(own, () => ownRun);
  if (mine.length === 0) return null;
  const segments = markerSegments([...mine, ...tagMarkers(others, (m) => str(m.run) ?? ANOTHER_RUN)]);
  const turns = rollout.turns.filter((t) => !Number.isNaN(ms(t.started_at)));
  const containing = (t: number) => {
    let k = -1;
    for (let i = 0; i < turns.length && ms(turns[i].started_at) <= t; i++) k = i;
    return k;
  };
  const ranges = segments.map((seg, g) => {
    const floor = g > 0 ? segments[g - 1].last : -Infinity;
    let command = -1;
    for (let i = 0; i < turns.length && ms(turns[i].started_at) <= seg.first; i++) {
      if (turns[i].invokes_run_skill && ms(turns[i].started_at) > floor) command = i;
    }
    const at = containing(seg.first);
    const anchored = command !== -1 || (seg.started && at !== -1);
    return { seg, open: command !== -1 ? command : Math.max(at, 0), close: containing(seg.last), command: command !== -1, anchored, atTurn: at !== -1 };
  });

  const recordsOf = new Map<string, UsageRecord[]>();
  for (const r of rollout.records) {
    if (!r.turn_id) continue;
    const list = recordsOf.get(r.turn_id) ?? [];
    list.push(r);
    recordsOf.set(r.turn_id, list);
  }
  const shares = new Map<number, TurnShare>();
  const claimedBy: typeof ranges = [];
  ranges.forEach((r, g) => {
    if (r.seg.run !== ownRun) return;
    const prev = ranges[g - 1];
    const next = ranges[g + 1];
    const after = prev && prev.close === r.open ? prev.seg.last : -Infinity;
    const upTo = next && next.open === r.close ? r.seg.last : Infinity;
    let claimed = false;
    for (let i = r.open; i <= r.close; i++) {
      const lo = i === r.open ? after : -Infinity;
      const hi = i === r.close ? upTo : Infinity;
      let records: UsageRecord[] | null = null;
      if (lo !== -Infinity || hi !== Infinity) {
        const all = recordsOf.get(turns[i].turn_id) ?? [];
        // A response with no timestamp goes with the end of its turn.
        records = all.filter((x) => {
          const t = ms(x.ts);
          const at = Number.isNaN(t) ? Infinity : t;
          return at > lo && at <= hi;
        });
        if (records.length === 0 && (all.length > 0 || hi !== Infinity)) continue;
      }
      claimed = true;
      const held = shares.get(i);
      if (!held) shares.set(i, { lo, hi, records });
      else {
        held.lo = Math.min(held.lo, lo);
        held.hi = Math.max(held.hi, hi);
        held.records = held.records && records ? [...held.records, ...records] : null;
      }
    }
    if (claimed) claimedBy.push(r);
  });

  const idx = [...shares.keys()].sort((a, b) => a - b);
  const records = new Map<string, UsageRecord[]>();
  const owned = idx.map((i) => {
    const share = shares.get(i) as TurnShare;
    if (!share.records) return turns[i];
    records.set(turns[i].turn_id, share.records);
    return share.hi === Infinity ? turns[i] : { ...turns[i], web_search_calls: 0 };
  });
  const iso = (t: number) => new Date(t).toISOString();
  if (idx.length === 0) {
    const times = mine.map((m) => m.t);
    return {
      window: {
        start: iso(Math.min(...times)),
        end: iso(Math.max(...times)),
        start_anchor: "first_marker",
        end_anchor: "last_marker_turn",
        exact: false,
        lower_bound: false,
        provisional: false,
      },
      turns: [],
      records,
    };
  }
  const first = claimedBy[0];
  const head = shares.get(idx[0]) as TurnShare;
  const tail = shares.get(idx[idx.length - 1]) as TurnShare;
  const lastTurn = turns[idx[idx.length - 1]];
  const end = lastTurn.ended_at ?? (tail.hi !== Infinity ? iso(tail.hi) : null);
  const leftOut = idx[idx.length - 1] - idx[0] + 1 - idx.length;
  return {
    window: {
      start: head.lo !== -Infinity ? iso(head.lo) : first.command || first.atTurn ? turns[idx[0]].started_at : iso(first.seg.first),
      end,
      start_anchor: first.command ? "command_turn" : first.anchored ? "start_run_turn" : first.atTurn ? "first_dispatch_turn" : "first_marker",
      end_anchor: end ? "last_marker_turn" : "open",
      exact: claimedBy.every((r) => r.anchored) && end !== null,
      lower_bound: claimedBy.some((r) => !r.anchored),
      provisional: end === null,
      ...(leftOut > 0 ? { left_out_turns: leftOut } : {}),
    },
    turns: owned,
    records,
  };
}

/** True when this run's markers on a thread claim any of it once every run's markers there are merged. */
function claimsThread(own: RunMarker[], others: RunMarker[], ownRun: string): boolean {
  const tagged = [...tagMarkers(own, () => ownRun), ...tagMarkers(others, (m) => str(m.run) ?? ANOTHER_RUN)];
  return markerSegments(tagged).some((s) => s.run === ownRun);
}

/**
 * The interactive window of `markers` on one thread, given the markers other
 * runs left on it (each with the `run` folder it came from); null when no
 * marker has a usable time.
 */
export function windowFromMarkers(
  rollout: Rollout,
  markers: RunMarker[],
  otherRuns: RunMarker[] = [],
  ownRun: string = THIS_RUN,
): DriverWindow | null {
  return attributeMarkers(rollout, markers, otherRuns, ownRun)?.window ?? null;
}

function headlessWindow(invs: ExecInvocation[]): DriverWindow {
  const byTime = (a: string, b: string) => ms(a) - ms(b);
  const starts = invs.map((i) => i.started_at).filter((s): s is string => Boolean(s)).sort(byTime);
  const ends = invs.map((i) => i.ended_at).filter((s): s is string => Boolean(s)).sort(byTime);
  const open = invs.some((i) => !i.ended_at);
  return {
    start: starts[0] ?? null,
    end: open ? null : (ends.at(-1) ?? null),
    start_anchor: "invocation_start",
    end_anchor: open ? "open" : "invocation_end",
    exact: !open,
    lower_bound: false,
    provisional: open,
  };
}

function wholeThreadWindow(rollout: Rollout): DriverWindow {
  const started = rollout.turns.filter((t) => t.started_at);
  const last = started.at(-1);
  return {
    start: started[0]?.started_at ?? null,
    end: last?.ended_at ?? null,
    start_anchor: "whole_thread",
    end_anchor: last?.ended_at ? "whole_thread" : "open",
    exact: false,
    lower_bound: false,
    provisional: !last?.ended_at,
  };
}

function combineWindows(windows: DriverWindow[]): DriverWindow | null {
  if (windows.length <= 1) return windows[0] ?? null;
  const earliest = windows.reduce((a, b) => (ms(b.start) < ms(a.start) ? b : a));
  const open = windows.some((w) => w.end === null);
  const latest = open ? null : windows.reduce((a, b) => (ms(b.end) > ms(a.end) ? b : a));
  const leftOut = windows.reduce((n, w) => n + (w.left_out_turns ?? 0), 0);
  return {
    start: windows.some((w) => w.start === null) ? null : earliest.start,
    end: latest ? latest.end : null,
    start_anchor: earliest.start_anchor,
    end_anchor: latest ? latest.end_anchor : "open",
    exact: windows.every((w) => w.exact),
    lower_bound: windows.some((w) => w.lower_bound),
    provisional: windows.some((w) => w.provisional),
    ...(leftOut > 0 ? { left_out_turns: leftOut } : {}),
  };
}

// ── Pricing ───────────────────────────────────────────────────────────────

export interface DriverPin {
  model: string;
  effort: string | null;
}

/** The policy's top-level `driver:` block when it has one, else its `gpt` model entry. */
export function driverPin(policy: Policy | null | undefined): DriverPin | null {
  if (!policy) return null;
  const driver = policy.driver;
  if (driver && str(driver.model_name)) {
    return { model: driver.model_name, effort: str(driver.reasoning?.effort) };
  }
  const gpt = policy.models?.find((m) => m.id === "gpt");
  if (gpt && str(gpt.model_name)) return { model: gpt.model_name, effort: str(gpt.reasoning?.effort) };
  return null;
}

/** The conductor's default price function: the dated price list, at the day each response was spent. */
export function defaultDriverPriceFn(policy: Policy | null | undefined): DriverPriceFn {
  return listDriverPriceFn(policy);
}

/** Codex counts cached input inside input_tokens and reasoning inside output_tokens. */
export function usageCostUsd(u: Usage, p: ModelPricing): number {
  return bucketsCostUsd(u, p);
}

export interface DriverTurnUsage {
  thread_id: string;
  turn_id: string;
  invocation: number | null;
  usage_source: "session-file" | "exec-stream";
  model: string | null;
  effort: string | null;
  started_at: string | null;
  ended_at: string | null;
  ended_by: "complete" | "aborted" | null;
  requests: number;
  compaction_requests: number;
  web_search_calls: number;
  tokens: Usage;
  cost_usd: number | null;
  unpriced_reason: string | null;
  /** `long_context` when a response crossed a tier; `unverified` when only a sum over responses was known. */
  price_tier: PriceTierLabel | null;
  long_context_requests: number;
}

export interface UnpricedEntry {
  model: string | null;
  turns: number;
  requests: number;
  tokens: Usage;
  reason: string;
}

interface PricedTurns {
  turns: DriverTurnUsage[];
  tokens: Usage;
  requests: number;
  compaction_requests: number;
  cost_usd: number;
  unpriced: UnpricedEntry[];
}

function unpricedReason(model: string | null, pin: DriverPin | null): string | null {
  if (!pin) return "the policy names no driver pin";
  if (model !== pin.model) return `session model ${model ?? "unknown"} is not the pin ${pin.model}`;
  return null;
}

/** Prices each response on its own, and only when it ran on the pinned model. */
function priceTurns(
  threadId: string,
  rollout: Rollout,
  turns: RolloutTurn[],
  pin: DriverPin | null,
  priceFn: DriverPriceFn,
  invocationOf: (t: RolloutTurn) => number | null,
  only?: Map<string, UsageRecord[]>,
): PricedTurns {
  const byTurn = new Map<string, UsageRecord[]>();
  for (const r of rollout.records) {
    if (!r.turn_id) continue;
    const list = byTurn.get(r.turn_id) ?? [];
    list.push(r);
    byTurn.set(r.turn_id, list);
  }
  const out: PricedTurns = { turns: [], tokens: zeroUsage(), requests: 0, compaction_requests: 0, cost_usd: 0, unpriced: [] };
  const unpriced = new Map<string, UnpricedEntry>();
  for (const t of turns) {
    const recs = only?.get(t.turn_id) ?? byTurn.get(t.turn_id) ?? [];
    const tokens = zeroUsage();
    let cost = 0;
    let priced = 0;
    let reason: string | null = null;
    let long = 0;
    let unverified = 0;
    let standard = 0;
    const touched = new Set<UnpricedEntry>();
    for (const r of recs) {
      addInto(tokens, r.usage);
      const model = r.model ?? t.model;
      let why = unpricedReason(model, pin);
      if (!why && pin) {
        // A token_count difference can span responses, so it proves no tier.
        const size: PriceContext =
          rollout.series === "token_count"
            ? { aggregateInputTokens: r.usage.input_tokens, aggregate: true }
            : { requestInputTokens: r.usage.input_tokens };
        const pricing = priceFn(pin.model, r.ts, size);
        if (pricing) {
          cost += usageCostUsd(r.usage, pricing);
          priced++;
          if (pricing.tier === "long_context") long++;
          else if (pricing.tier === "unverified") unverified++;
          else standard++;
        } else {
          why = `no price for ${pin.model}${r.ts ? ` on ${r.ts.slice(0, 10)}` : ""}`;
        }
      }
      if (why) {
        reason = why;
        const key = `${model ?? ""}|${why}`;
        const entry = unpriced.get(key) ?? { model, turns: 0, requests: 0, tokens: zeroUsage(), reason: why };
        entry.requests++;
        addInto(entry.tokens, r.usage);
        unpriced.set(key, entry);
        touched.add(entry);
      }
    }
    for (const entry of touched) entry.turns++;
    const compactions = recs.filter((r) => r.compaction).length;
    out.turns.push({
      thread_id: threadId,
      turn_id: t.turn_id,
      invocation: invocationOf(t),
      usage_source: "session-file",
      model: t.model,
      effort: t.effort,
      started_at: t.started_at,
      ended_at: t.ended_at,
      ended_by: t.ended_by,
      requests: recs.length,
      compaction_requests: compactions,
      web_search_calls: t.web_search_calls,
      tokens,
      cost_usd: reason && priced === 0 ? null : round6(cost),
      unpriced_reason: reason,
      price_tier: unverified > 0 ? "unverified" : long > 0 ? "long_context" : standard > 0 ? "standard" : null,
      long_context_requests: long,
    });
    addInto(out.tokens, tokens);
    out.requests += recs.length;
    out.compaction_requests += compactions;
    out.cost_usd += cost;
  }
  out.unpriced = [...unpriced.values()];
  return out;
}

function mergeUnpriced(entries: UnpricedEntry[]): UnpricedEntry[] {
  const merged = new Map<string, UnpricedEntry>();
  for (const e of entries) {
    const key = `${e.model ?? ""}|${e.reason}`;
    const m = merged.get(key);
    if (!m) merged.set(key, { ...e, tokens: { ...e.tokens } });
    else {
      m.turns += e.turns;
      m.requests += e.requests;
      addInto(m.tokens, e.tokens);
    }
  }
  return [...merged.values()];
}

// ── Exec stream and cross-check (headless route) ──────────────────────────

export type ExecBaseline = "zero" | "session-file" | "unknown";

export interface ExecThreadTotals {
  delta: Usage;
  baseline: ExecBaseline;
  reset: boolean;
  per_invocation: { inv: ExecInvocation; delta: Usage | null }[];
  /**
   * Invocations after the last turn.completed. A failed invocation followed by
   * a completed one is not counted: the next running total includes its tokens.
   */
  unreported: number;
}

/**
 * Prices a thread from consecutive differences of its running totals, by the
 * same rule driver-cost-modeled.jsonl uses (driverUsage.ts DriverTurnTracker).
 * A thread whose first invocation is not known to be fresh subtracts
 * `sessionBaseline` when the session file supplies one; without it the first
 * difference is the whole total.
 */
export function execThreadTotals(invs: ExecInvocation[], sessionBaseline: Usage | null): ExecThreadTotals {
  const first = invs[0];
  const thread = first?.thread_id ?? "(no thread id)";
  const fresh = !first || first.mode === "fresh";
  const baseline: ExecBaseline = fresh ? "zero" : sessionBaseline ? "session-file" : "unknown";
  const tracker = new DriverTurnTracker(!fresh && sessionBaseline ? { baselines: { [thread]: sessionBaseline } } : {});
  const out: ExecThreadTotals = { delta: zeroUsage(), baseline, reset: false, per_invocation: [], unreported: 0 };
  invs.forEach((inv, k) => {
    const mode = k === 0 && fresh ? "fresh" : "resume";
    tracker.push({ v: 1, kind: "invocation_start", invocation: k + 1, mode, resume_thread_id: mode === "resume" ? thread : null });
    const turns: DriverTurn[] = [];
    if (inv.cumulative) {
      turns.push(...tracker.push({ v: 1, kind: "codex", invocation: k + 1, thread_id: thread, event: { type: "turn.started" } }));
      turns.push(...tracker.push({ v: 1, kind: "codex", invocation: k + 1, thread_id: thread, event: { type: "turn.completed", usage: inv.cumulative } }));
    }
    turns.push(...tracker.push({ v: 1, kind: "invocation_end", invocation: k + 1, ended_by: "exit" }));
    const done = turns.find((t) => t.status === "complete" && t.delta);
    if (!done) {
      out.per_invocation.push({ inv, delta: null });
      out.unreported++;
      return;
    }
    out.unreported = 0;
    if (done.flags.includes("cumulative_reset")) out.reset = true;
    const d = toUsage(done.delta);
    addInto(out.delta, d);
    out.per_invocation.push({ inv, delta: d });
  });
  return out;
}

/**
 * Every `difference` below is the session file minus the exec stream, per
 * bucket. An invocation's status compares the pair it prints, `exec_delta`
 * against `session_turn_tokens`; the running totals are kept for reference.
 */
export interface InvocationCheck {
  invocation: number | null;
  thread_id: string;
  turn_id: string | null;
  status: "equal" | "equal_with_explained_gap" | "differs" | "incomplete" | "unmatched" | "no_session_file";
  /** turn.completed usage: the thread's running total when the invocation ended. */
  exec_cumulative: Usage | null;
  /** The session file's token_count total at the end of the matching turn. */
  session_total: Usage | null;
  /** This invocation's own spend in the exec stream: its running total minus the one before. */
  exec_delta: Usage | null;
  /** Σ token_usage_record over the session-file turns that ran in this invocation. */
  session_turn_tokens: Usage | null;
  /** session_turn_tokens minus exec_delta. */
  difference: Usage | null;
  /** Compaction calls in this invocation's turns: codex leaves them out of its running total. */
  compaction_requests: number;
  compaction_tokens: Usage;
  /** Earlier invocations that reported no usage, whose turns this invocation's running total also counts. */
  carried_invocations: (number | null)[];
  carried_tokens: Usage;
  /** `exec` and `session` are the row's figures; `unexplained` is the part of their difference nothing above explains. */
  differing?: { bucket: UsageBucket; exec: number; session: number; unexplained: number }[];
  reason?: string;
}

export type CrossCheckVerdict =
  | "equal"
  | "equal_with_explained_gap"
  | "no_exec_usage"
  | "unchecked"
  | "unexplained_gap"
  | "reset"
  | "mismatch"
  | "no_session_file";

const VERDICT_RANK: CrossCheckVerdict[] = [
  "equal",
  "equal_with_explained_gap",
  "no_exec_usage",
  "unchecked",
  "unexplained_gap",
  "reset",
  "mismatch",
  "no_session_file",
];

export interface CrossCheckGap {
  thread_id: string;
  bucket: UsageBucket;
  difference: number;
}

export interface ThreadCrossCheck {
  thread_id: string;
  verdict: CrossCheckVerdict;
  exec_stream_baseline: ExecBaseline | null;
  /** What is booked: Σ token_usage_record over the thread's window. Null with no session file. */
  session_tokens: Usage | null;
  /** Σ of the thread's per-invocation exec-stream deltas. Null when the run has no invocation on it. */
  exec_stream_tokens: Usage | null;
  difference: Usage | null;
  compaction_requests: number;
  compaction_tokens: Usage;
  /** Turns of invocations that never reported usage, whose records only the session file holds. */
  incomplete_turns: number;
  incomplete_tokens: Usage;
  /** Invocations after the thread's last turn.completed: spend the exec stream cannot see. */
  unreported_invocations: number;
  token_count_reset: boolean;
  gap: CrossCheckGap | null;
}

export interface CrossCheck {
  verdict: CrossCheckVerdict;
  verified: boolean;
  mapping: "invocation_window" | "order";
  threads: ThreadCrossCheck[];
  invocations: InvocationCheck[];
  /** Over the threads compared with the exec stream; `threads` has every one. */
  session_tokens: Usage;
  /** Over every thread with an exec-stream invocation. */
  exec_stream_tokens: Usage;
  exec_stream_baseline: Record<string, ExecBaseline>;
  exec_stream_cost_usd: number | null;
  compaction_requests: number;
  compaction_tokens: Usage;
  incomplete_invocations: number;
  incomplete_turns: number;
  incomplete_tokens: Usage;
  unreported_invocations: number;
  /** Invocations that reported usage but have no turn in the session file: spend the booked figure leaves out. */
  missing_invocations: number;
  token_count_reset: boolean;
  /** The first thread's unexplained gap; every thread's is in `threads`. */
  gap: CrossCheckGap | null;
  missing_threads: string[];
  unchecked_threads: string[];
}

function lastTokenCountAtOrBefore(rollout: Rollout, t: number): TokenCountTotal | null {
  let hit: TokenCountTotal | null = null;
  for (const tc of rollout.token_counts) {
    const at = ms(tc.ts);
    if (!Number.isNaN(at) && at <= t) hit = tc;
  }
  return hit;
}

/**
 * Exact per-bucket comparison of each invocation's exec-stream spend with the
 * session-file responses of its turns. The two may differ only by compaction
 * calls (absent from the running total) and by the turns of earlier
 * invocations that never reached turn.completed, which the next running
 * total counts. `spans` null maps invocations to turns by order.
 */
function checkThread(
  threadId: string,
  invs: ExecInvocation[],
  spans: Span[] | null,
  rollout: Rollout,
  windowTurns: RolloutTurn[],
): { thread: ThreadCrossCheck; invocations: InvocationCheck[]; exec: ExecThreadTotals; execRequests: Usage[][] } {
  const windowIds = new Set(windowTurns.map((t) => t.turn_id));
  const windowRecords = rollout.records.filter((r) => r.turn_id && windowIds.has(r.turn_id));
  const session = sumUsage(windowRecords.map((r) => r.usage));
  const recordsOf = (turns: RolloutTurn[]) => {
    const ids = new Set(turns.map((t) => t.turn_id));
    return windowRecords.filter((r) => ids.has(r.turn_id as string));
  };
  const tokensOf = (records: UsageRecord[]) => sumUsage(records.map((r) => r.usage));

  const firstStart = windowTurns.length ? ms(windowTurns[0].started_at) : NaN;
  const before = Number.isNaN(firstStart) ? null : lastTokenCountAtOrBefore(rollout, firstStart - 1);
  const t0 = before ? before.total : zeroUsage();
  const exec = execThreadTotals(invs, t0);

  // A legacy stream has no clock: invocation k maps to the k-th of the thread's last turns.
  const ordered = spans ? [] : windowTurns.slice(-invs.length);
  const offset = invs.length - ordered.length;
  const turnsOf = (k: number): RolloutTurn[] => {
    if (!spans) return ordered[k - offset] ? [ordered[k - offset]] : [];
    return windowTurns.filter((t) => inSpan(ms(t.started_at), spans[k]));
  };

  const checks: InvocationCheck[] = [];
  const execRequests: Usage[][] = [];
  const compactionRecords: UsageRecord[] = [];
  // Invocations with no turn.completed since the last one that had it.
  let pending: { invocation: number | null; records: UsageRecord[] }[] = [];
  let lastMatched: TokenCountTotal | null = null;
  for (let k = 0; k < invs.length; k++) {
    const inv = invs[k];
    const turns = turnsOf(k);
    const matched = turns.at(-1) ?? null;
    const own = recordsOf(turns);
    const ownCompaction = own.filter((r) => r.compaction);
    execRequests.push(own.filter((r) => !r.compaction).map((r) => r.usage));
    const cumulative = inv.cumulative;
    const base: Omit<InvocationCheck, "status"> = {
      invocation: inv.invocation ?? k + 1,
      thread_id: threadId,
      turn_id: matched?.turn_id ?? null,
      exec_cumulative: cumulative,
      session_total: null,
      exec_delta: exec.per_invocation[k]?.delta ?? null,
      session_turn_tokens: tokensOf(own),
      difference: null,
      compaction_requests: ownCompaction.length,
      compaction_tokens: tokensOf(ownCompaction),
      carried_invocations: [],
      carried_tokens: zeroUsage(),
    };
    if (!cumulative) {
      pending.push({ invocation: base.invocation, records: own });
      checks.push({ ...base, status: "incomplete" });
      continue;
    }
    const carried = pending.flatMap((p) => p.records);
    base.carried_invocations = pending.map((p) => p.invocation);
    base.carried_tokens = tokensOf(carried.filter((r) => !r.compaction));
    pending = [];
    compactionRecords.push(...ownCompaction, ...carried.filter((r) => r.compaction));
    if (!matched) {
      checks.push({ ...base, status: "unmatched", reason: "no session-file turn starts inside the invocation" });
      continue;
    }
    const end = ms(matched.ended_at ?? inv.ended_at);
    const tc = lastTokenCountAtOrBefore(rollout, Number.isNaN(end) ? Infinity : end);
    if (!tc) {
      checks.push({ ...base, status: "unmatched", reason: "the session file has no token_count total for the turn" });
      continue;
    }
    lastMatched = tc;
    const execDelta = base.exec_delta ?? zeroUsage();
    const sessionTurns = base.session_turn_tokens ?? zeroUsage();
    const expected = addInto(minus(sessionTurns, base.compaction_tokens), base.carried_tokens);
    const differing = USAGE_BUCKETS.filter((b) => execDelta[b] !== expected[b]).map((b) => ({
      bucket: b,
      exec: execDelta[b],
      session: sessionTurns[b],
      unexplained: expected[b] - execDelta[b],
    }));
    const compared = { ...base, session_total: tc.total, difference: minus(sessionTurns, execDelta) };
    const explained = explainedParts(compared);
    if (differing.length) {
      const what = differing.map((d) => `${d.bucket} ${signedCount(d.unexplained)}`).join(", ");
      const beyond = explained.length ? `, beyond ${explained.join(" and ")}` : "";
      checks.push({ ...compared, status: "differs", differing, reason: `${what} unexplained${beyond}` });
    } else if (explained.length) {
      checks.push({ ...compared, status: "equal_with_explained_gap", reason: explained.join("; ") });
    } else {
      checks.push({ ...compared, status: "equal" });
    }
  }

  const lastAt = lastMatched ? ms(lastMatched.ts) : -Infinity;
  // Turns of invocations after the last turn.completed: only the session file holds them.
  const incompleteRecords = pending.flatMap((p) => p.records);
  const compaction = tokensOf(compactionRecords);
  const incomplete = tokensOf(incompleteRecords);

  let reset = false;
  let prev: Usage | null = null;
  for (const tc of rollout.token_counts) {
    const at = ms(tc.ts);
    if (Number.isNaN(at) || (!Number.isNaN(firstStart) && at < firstStart) || at > lastAt) continue;
    if (prev && dropped(tc.total, prev)) reset = true;
    prev = tc.total;
  }

  // Anything else in the window that no invocation's spend accounts for is the gap.
  const explained = minus(minus(session, compaction), incomplete);
  const off = USAGE_BUCKETS.find((b) => explained[b] !== exec.delta[b]);
  const gap = off ? { thread_id: threadId, bucket: off, difference: explained[off] - exec.delta[off] } : null;

  let verdict: CrossCheckVerdict;
  if (checks.some((c) => c.status === "differs" || c.status === "unmatched")) verdict = "mismatch";
  else if (reset) verdict = "reset";
  else if (gap) verdict = "unexplained_gap";
  else if (!checks.some((c) => c.status === "equal" || c.status === "equal_with_explained_gap")) verdict = "no_exec_usage";
  else if (compactionRecords.length > 0 || incompleteRecords.length > 0) verdict = "equal_with_explained_gap";
  else verdict = "equal";

  return {
    thread: {
      thread_id: threadId,
      verdict,
      exec_stream_baseline: exec.baseline,
      session_tokens: session,
      exec_stream_tokens: exec.delta,
      difference: minus(session, exec.delta),
      compaction_requests: compactionRecords.length,
      compaction_tokens: compaction,
      incomplete_turns: new Set(incompleteRecords.map((r) => r.turn_id)).size,
      incomplete_tokens: incomplete,
      unreported_invocations: exec.unreported,
      token_count_reset: reset,
      gap,
    },
    invocations: checks,
    exec,
    execRequests,
  };
}

const signedCount = (n: number) => `${n > 0 ? "+" : ""}${n}`;

/** What, besides the exec stream, an invocation's session-file responses hold. */
function explainedParts(c: Pick<InvocationCheck, "compaction_requests" | "compaction_tokens" | "carried_invocations" | "carried_tokens">): string[] {
  const parts: string[] = [];
  if (!isZero(c.compaction_tokens)) parts.push(`${c.compaction_requests} compaction call(s) only in the session file`);
  if (!isZero(c.carried_tokens)) {
    const which = c.carried_invocations.map((n) => n ?? "?").join(", ");
    parts.push(`the running total also counts invocation ${which}, which reported no usage`);
  }
  return parts;
}

/** A thread with no readable session file: the exec stream alone, nothing to compare. */
function execOnlyCheck(threadId: string, exec: ExecThreadTotals): { thread: ThreadCrossCheck; invocations: InvocationCheck[] } {
  return {
    thread: {
      thread_id: threadId,
      verdict: "no_session_file",
      exec_stream_baseline: exec.baseline,
      session_tokens: null,
      exec_stream_tokens: exec.delta,
      difference: null,
      compaction_requests: 0,
      compaction_tokens: zeroUsage(),
      incomplete_turns: 0,
      incomplete_tokens: zeroUsage(),
      unreported_invocations: exec.unreported,
      token_count_reset: false,
      gap: null,
    },
    invocations: exec.per_invocation.map(({ inv, delta }, k) => ({
      invocation: inv.invocation ?? k + 1,
      thread_id: threadId,
      turn_id: null,
      status: "no_session_file",
      exec_cumulative: inv.cumulative,
      session_total: null,
      exec_delta: delta,
      session_turn_tokens: null,
      difference: null,
      compaction_requests: 0,
      compaction_tokens: zeroUsage(),
      carried_invocations: [],
      carried_tokens: zeroUsage(),
    })),
  };
}

/** A thread booked from its session file with no invocation of this run on it (`--thread`). */
function uncheckedThread(threadId: string, session: Usage): ThreadCrossCheck {
  return {
    thread_id: threadId,
    verdict: "unchecked",
    exec_stream_baseline: null,
    session_tokens: session,
    exec_stream_tokens: null,
    difference: null,
    compaction_requests: 0,
    compaction_tokens: zeroUsage(),
    incomplete_turns: 0,
    incomplete_tokens: zeroUsage(),
    unreported_invocations: 0,
    token_count_reset: false,
    gap: null,
  };
}

function crossCheckLabel(cc: CrossCheck): string {
  switch (cc.verdict) {
    case "equal": {
      const carried = cc.invocations.filter((i) => i.status === "equal_with_explained_gap").length;
      if (!carried) return "session file + exec stream (every invocation equal)";
      return `session file + exec stream (equal; ${carried} invocation(s) also count the turns of an earlier one that reported no usage)`;
    }
    case "equal_with_explained_gap":
      return (
        `session file + exec stream (equal; ${cc.compaction_requests} compaction call(s) and ` +
        `${cc.incomplete_turns} incomplete turn(s) only in the session file)`
      );
    case "no_exec_usage":
      return "session file (the exec stream reported no usage for any invocation; unverified)";
    case "unchecked":
      return `session file (${cc.unchecked_threads.length} thread(s) booked with no exec-stream invocation to compare; unverified)`;
    case "unexplained_gap":
      return (
        `session file (every invocation equal, but ${cc.gap?.bucket} differs by ${cc.gap?.difference} ` +
        `with no compaction call or incomplete turn to explain it; unverified)`
      );
    case "reset":
      return "session file (a token_count total dropped inside the window, so the exec stream cannot be compared; unverified)";
    case "mismatch": {
      const bad = cc.invocations.find((i) => i.status === "differs" || i.status === "unmatched");
      if (bad?.status === "differs" && bad.differing?.length) {
        const d = bad.differing[0];
        return `session file (exec stream DISAGREES on invocation ${bad.invocation}: ${d.bucket} ${d.exec} vs ${d.session}; unverified)`;
      }
      return `session file (exec stream DISAGREES on invocation ${bad?.invocation ?? "?"}: ${bad?.reason ?? "no match"}; unverified)`;
    }
    case "no_session_file": {
      const missing = cc.missing_threads;
      const upper = missing.some((id) => cc.exec_stream_baseline[id] === "unknown")
        ? "; upper bound: includes the resumed session's earlier turns"
        : "";
      if (missing.length < cc.threads.length) {
        return (
          `session file + exec stream (${missing.length} of ${cc.threads.length} thread(s) had no readable session file ` +
          `and were booked from the exec stream: ${missing.join(", ")}; unverified${upper})`
        );
      }
      const which = missing.length > 1 ? `${missing.length} threads` : "the thread";
      return `exec stream (no readable session file for ${which}; unverified${upper})`;
    }
  }
}

// ── Measurement ───────────────────────────────────────────────────────────

export type DriverRoute = "headless" | "interactive";

export interface DriverThreadInfo {
  thread_id: string;
  rollout: "found" | "missing" | "unreadable";
  rollout_file: string | null;
  reason: string | null;
  booked_from: "session-file" | "exec-stream" | null;
  usage_series: UsageSeries | null;
  originator: string | null;
  source: string | null;
  cli_version: string | null;
  plan_type: string | null;
  window: DriverWindow | null;
}

export interface ExcludedThread {
  thread_id: string;
  reason: string;
  /** This run's conductor turns are in it, so the figure is missing them. */
  conductor_turns_left_out: boolean;
}

export interface DriverUsageReport {
  schema_version: 1;
  route: DriverRoute;
  source: "session-file" | "exec-stream" | "mixed";
  cost_source: string;
  verified: boolean;
  provenance: "modeled";
  thread_ids: string[];
  threads: DriverThreadInfo[];
  window: DriverWindow | null;
  pin: DriverPin | null;
  policy: { name: string | null; version: number | null };
  turns: DriverTurnUsage[];
  tokens: Usage & { requests: number; compaction_requests: number; web_search_calls: number };
  cost_usd_modeled: number;
  /**
   * False when a token or tool call was left unpriced, a thread went unread,
   * or a thread booked from the exec stream has an unknown baseline or an
   * invocation that reported no usage.
   */
  cost_complete: boolean;
  unpriced: UnpricedEntry[];
  cross_check: CrossCheck | null;
  /** Threads a marker or the exec stream named that the figure leaves out, and why. */
  excluded_threads: ExcludedThread[];
  /** Turns whose summed input crossed a tier threshold with no per-response sizes, billed at the standard card. */
  tier_unverified_turns: number;
  price_list_verified: string;
}

export interface MeasureOptions {
  runDir: string;
  policy: Policy | null;
  codexHome?: string;
  env?: Record<string, string | undefined>;
  route?: DriverRoute;
  /** Added to the threads the run folder names (`--thread`). */
  threadIds?: string[];
  priceFn?: DriverPriceFn;
  crossCheck?: boolean;
  /** Ignore legacy driver-events lines, which carry no clock to scope a window. */
  ignoreLegacy?: boolean;
  /** Read as if appended to driver-session.jsonl, for a measurement that must not write. */
  markers?: SessionMarker[];
}

export type MeasureResult =
  | { ok: true; report: DriverUsageReport }
  | { ok: false; code: "no_threads" | "no_rollout"; message: string; unreadable?: string[]; excluded?: ExcludedThread[] };

interface ThreadResult {
  info: DriverThreadInfo;
  turns: DriverTurnUsage[];
  tokens: Usage;
  requests: number;
  compaction_requests: number;
  cost_usd: number;
  cost_complete: boolean;
  unpriced: UnpricedEntry[];
  window: DriverWindow | null;
  check: { thread: ThreadCrossCheck; invocations: InvocationCheck[] } | null;
  exec: ExecThreadTotals | null;
  /** Per invocation, the session file's responses inside it, which prove the exec stream's tier. */
  execRequests?: Usage[][];
}

function execStreamThread(
  info: DriverThreadInfo,
  invs: ExecInvocation[],
  pin: DriverPin | null,
  priceFn: DriverPriceFn,
): ThreadResult {
  const exec = execThreadTotals(invs, null);
  let cost = 0;
  let unpricedAny = false;
  const turns: DriverTurnUsage[] = exec.per_invocation.map(({ inv, delta }) => {
    const priced = delta && pin ? priceExecDelta(delta, inv, pin, priceFn) : null;
    if (priced?.cost_usd != null) cost += priced.cost_usd;
    else if (delta) unpricedAny = true;
    return {
      thread_id: info.thread_id,
      turn_id: `invocation-${inv.invocation ?? "?"}`,
      invocation: inv.invocation,
      usage_source: "exec-stream",
      model: pin?.model ?? null,
      effort: pin?.effort ?? null,
      started_at: inv.started_at,
      ended_at: inv.ended_at,
      ended_by: null,
      requests: 0,
      compaction_requests: 0,
      web_search_calls: 0,
      tokens: delta ?? zeroUsage(),
      cost_usd: priced?.cost_usd != null ? round6(priced.cost_usd) : null,
      unpriced_reason: !delta
        ? "no turn.completed in this invocation"
        : !pin
          ? "the policy names no driver pin"
          : (priced?.unpriced_reason ?? null),
      price_tier: priced?.tier ?? null,
      long_context_requests: 0,
    };
  });
  info.booked_from = "exec-stream";
  return {
    info,
    turns,
    tokens: exec.delta,
    requests: 0,
    compaction_requests: 0,
    cost_usd: cost,
    cost_complete: pin !== null && !unpricedAny && exec.baseline !== "unknown" && exec.unreported === 0,
    unpriced: [],
    window: headlessWindow(invs),
    check: execOnlyCheck(info.thread_id, exec),
    exec,
  };
}

/**
 * One invocation's exec-stream share of its thread, priced at the day it
 * ended: response by response when the session file's responses for it are
 * given, else as a sum, which proves no tier.
 */
function priceExecDelta(delta: Usage, inv: ExecInvocation, pin: DriverPin, priceFn: DriverPriceFn, requests: Usage[] | null = null) {
  return priceDriverTokens(delta, pin.model, inv.ended_at ?? inv.started_at, priceFn, requests && requests.length ? requests : null);
}

function missingInvocations(check: ThreadResult["check"]): number {
  return (check?.invocations ?? []).filter((c) => c.status === "unmatched" && c.turn_id === null).length;
}

function combineChecks(results: ThreadResult[], byOrder: boolean, pin: DriverPin | null, priceFn: DriverPriceFn): CrossCheck {
  const threads = results.map((r) => r.check?.thread).filter((t): t is ThreadCrossCheck => Boolean(t));
  const compared = threads.filter((t) => t.verdict !== "no_session_file" && t.verdict !== "unchecked");
  const execTotals = results.map((r) => r.exec).filter((e): e is ExecThreadTotals => e !== null);
  const execTokens = sumUsage(execTotals.map((e) => e.delta));
  const baselines: Record<string, ExecBaseline> = {};
  for (const r of results) if (r.exec) baselines[r.info.thread_id] = r.exec.baseline;
  const allInvs = execTotals.flatMap((e) => e.per_invocation.map((p) => p.inv));
  let execCost: number | null = pin ? 0 : null;
  for (const r of results) {
    (r.exec?.per_invocation ?? []).forEach((p, k) => {
      if (!p.delta || execCost === null) return;
      const priced = priceExecDelta(p.delta, p.inv, pin!, priceFn, r.execRequests?.[k] ?? null);
      execCost = priced.cost_usd === null ? null : execCost + priced.cost_usd;
    });
  }
  const verdict = threads.reduce<CrossCheckVerdict>(
    (worst, t) => (VERDICT_RANK.indexOf(t.verdict) > VERDICT_RANK.indexOf(worst) ? t.verdict : worst),
    "equal",
  );
  const sum = (pick: (t: ThreadCrossCheck) => number) => threads.reduce((n, t) => n + pick(t), 0);
  return {
    verdict,
    verified: verdict === "equal" || verdict === "equal_with_explained_gap",
    mapping: byOrder ? "order" : "invocation_window",
    threads,
    invocations: results.flatMap((r) => r.check?.invocations ?? []),
    session_tokens: sumUsage(compared.map((t) => t.session_tokens ?? zeroUsage())),
    exec_stream_tokens: execTokens,
    exec_stream_baseline: baselines,
    exec_stream_cost_usd: execCost === null ? null : round6(execCost),
    compaction_requests: sum((t) => t.compaction_requests),
    compaction_tokens: sumUsage(threads.map((t) => t.compaction_tokens)),
    incomplete_invocations: allInvs.filter((i) => !i.cumulative).length,
    incomplete_turns: sum((t) => t.incomplete_turns),
    incomplete_tokens: sumUsage(threads.map((t) => t.incomplete_tokens)),
    unreported_invocations: sum((t) => t.unreported_invocations),
    missing_invocations: results.reduce((n, r) => n + missingInvocations(r.check), 0),
    token_count_reset: threads.some((t) => t.token_count_reset),
    gap: threads.find((t) => t.gap)?.gap ?? null,
    missing_threads: threads.filter((t) => t.verdict === "no_session_file").map((t) => t.thread_id),
    unchecked_threads: threads.filter((t) => t.verdict === "unchecked").map((t) => t.thread_id),
  };
}

export function measureDriverUsage(opts: MeasureOptions): MeasureResult {
  const codexHome = opts.codexHome ?? defaultCodexHome(opts.env);
  const priceFn = opts.priceFn ?? defaultDriverPriceFn(opts.policy);
  const pin = driverPin(opts.policy);
  let invocations = parseDriverEvents(readJsonl(join(opts.runDir, DRIVER_EVENTS_FILE)));
  if (opts.ignoreLegacy) invocations = invocations.filter((i) => !i.legacy);
  const markers = [
    ...readSessionMarkers(opts.runDir),
    ...(opts.markers ?? []).filter((m) => isThreadId(m?.thread_id) && !Number.isNaN(ms(m?.ts))),
  ];
  const route: DriverRoute = opts.route ?? (invocations.length > 0 ? "headless" : "interactive");

  const threadIds: string[] = [];
  let excluded: ExcludedThread[] = [];
  const workers = nestedDispatchThreads(opts.runDir);
  const conductors = route === "interactive" ? recordedConductorThreads(opts.runDir) : new Set<string>();
  const ownRun = realPath(opts.runDir);
  const rollouts = new Map<string, LoadedRollout>();
  const rolloutOf = (id: string): LoadedRollout => {
    let loaded = rollouts.get(id);
    if (!loaded) rollouts.set(id, (loaded = loadRollout(codexHome, id)));
    return loaded;
  };
  const chatFolders = () =>
    [...new Set([...markers.map((m) => m.thread_id), ...(opts.threadIds ?? [])])]
      .filter((id) => isThreadId(id) && !workers.has(id))
      .flatMap((id) => {
        const loaded = rolloutOf(id);
        return loaded.status === "found" ? loaded.rollout.cwds : [];
      });
  const otherMarkers = route === "interactive" ? otherRunMarkers(opts.runDir, chatFolders()) : [];
  const ownOn = (id: string) => markers.filter((m) => m.thread_id === id);
  const othersOn = (id: string) => otherMarkers.filter((m) => m.thread_id === id);
  const exclude = (id: string, reason: string, leftOut = false) => {
    if (!excluded.some((e) => e.thread_id === id)) excluded.push({ thread_id: id, reason, conductor_turns_left_out: leftOut });
  };
  const addThread = (id: unknown, recorded: boolean) => {
    if (!isThreadId(id) || threadIds.includes(id)) return;
    if (workers.has(id)) return exclude(id, "a codex-cli dispatch of this run ran in it (telemetry.jsonl codex_thread_id)");
    if (recorded && route === "interactive") {
      if (!claimsThread(ownOn(id), othersOn(id), ownRun)) {
        return exclude(id, "it holds only an end-of-run collection for this run, after another run's marker");
      }
      if (conductors.size > 0 && !conductors.has(id)) return exclude(id, "run.json records no start of this run in it", true);
    }
    threadIds.push(id);
  };
  // Headless threads come from the exec stream only: a codex exec started from
  // a codex shell can inherit that shell's CODEX_THREAD_ID, so markers may name
  // the parent session instead.
  if (route === "headless") invocations.forEach((i) => addThread(i.thread_id, true));
  else markers.forEach((m) => addThread(m.thread_id, true));
  (opts.threadIds ?? []).forEach((id) => addThread(id, false));
  excluded = excluded.filter((e) => !threadIds.includes(e.thread_id));
  if (threadIds.length === 0) {
    const skipped = excluded.length ? ` (left out as not the conductor's: ${excluded.map((e) => `${e.thread_id}, ${e.reason}`).join("; ")})` : "";
    return {
      ok: false,
      code: "no_threads",
      excluded,
      message:
        route === "headless"
          ? `no codex thread id in ${join(opts.runDir, DRIVER_EVENTS_FILE)}${skipped}; pass --thread=<id>`
          : `no conductor thread recorded in ${join(opts.runDir, SESSION_MARKERS_FILE)}${skipped}; pass --thread=<id>`,
    };
  }

  const results: ThreadResult[] = [];
  const unread: DriverThreadInfo[] = [];
  let byOrder = false;

  for (const threadId of threadIds) {
    const loaded = rolloutOf(threadId);
    const info: DriverThreadInfo = {
      thread_id: threadId,
      rollout: loaded.status,
      rollout_file: loaded.status === "missing" ? null : loaded.location.rel,
      reason: loaded.status === "unreadable" ? loaded.reason : null,
      booked_from: null,
      usage_series: null,
      originator: null,
      source: null,
      cli_version: null,
      plan_type: null,
      window: null,
    };
    const invs = invocations.filter((i) => i.thread_id === threadId);
    const fallBack = () => {
      if (route === "headless" && invs.length > 0) {
        const r = execStreamThread(info, invs, pin, priceFn);
        info.window = r.window;
        results.push(r);
      } else {
        unread.push(info);
      }
    };

    if (loaded.status !== "found") {
      fallBack();
      continue;
    }

    const rollout = loaded.rollout;
    Object.assign(info, {
      booked_from: "session-file",
      usage_series: rollout.series,
      originator: rollout.meta?.originator ?? null,
      source: rollout.meta?.source ?? null,
      cli_version: rollout.meta?.cli_version ?? null,
      plan_type: rollout.plan_type,
    });

    const legacy = invs.length > 0 && invs.every((i) => i.legacy || !i.started_at);
    let window: DriverWindow;
    let windowTurns: RolloutTurn[];
    let spans: Span[] | null = null;
    let shared: Map<string, UsageRecord[]> | undefined;
    if (route === "headless" && invs.length > 0 && !legacy) {
      spans = invocationSpans(invs, invocations, rollout);
      window = headlessWindow(invs);
      windowTurns = turnsInSpans(rollout, spans);
    } else {
      const attributed = route === "interactive" ? attributeMarkers(rollout, ownOn(threadId), othersOn(threadId), ownRun) : null;
      window = attributed?.window ?? wholeThreadWindow(rollout);
      windowTurns = attributed ? attributed.turns : rollout.turns.filter((t) => t.started_at);
      shared = attributed?.records;
      byOrder = byOrder || (route === "headless" && legacy);
    }
    info.window = window;

    const windowIds = new Set(windowTurns.map((t) => t.turn_id));
    const completed = completedTurns(windowTurns);
    if (completed > 0 && !rollout.records.some((r) => r.turn_id && windowIds.has(r.turn_id))) {
      info.rollout = "unreadable";
      info.reason = `${loaded.location.rel} has ${NO_USAGE_LINES} in the window's ${completed} completed turn(s)`;
      info.booked_from = null;
      fallBack();
      continue;
    }

    const invocationOf = (t: RolloutTurn): number | null => {
      if (!spans) return null;
      const at = ms(t.started_at);
      const k = spans.findIndex((span) => inSpan(at, span));
      return k === -1 ? null : invs[k].invocation;
    };
    const priced = priceTurns(threadId, rollout, windowTurns, pin, priceFn, invocationOf, shared);
    let check: ThreadResult["check"] = null;
    let exec: ExecThreadTotals | null = null;
    let execRequests: Usage[][] | undefined;
    if (route === "headless" && opts.crossCheck !== false) {
      if (invs.length > 0) {
        const c = checkThread(threadId, invs, spans, rollout, windowTurns);
        check = { thread: c.thread, invocations: c.invocations };
        exec = c.exec;
        execRequests = c.execRequests;
      } else {
        check = { thread: uncheckedThread(threadId, priced.tokens), invocations: [] };
      }
    }
    results.push({
      info,
      turns: priced.turns,
      tokens: priced.tokens,
      requests: priced.requests,
      compaction_requests: priced.compaction_requests,
      cost_usd: priced.cost_usd,
      cost_complete: priced.unpriced.length === 0 && missingInvocations(check) === 0,
      unpriced: priced.unpriced,
      window,
      check,
      exec,
      execRequests,
    });
  }

  if (results.length === 0) {
    const unreadable = unread.filter((t) => t.reason).map((t) => t.reason as string);
    return {
      ok: false,
      code: "no_rollout",
      unreadable,
      message:
        `no readable session file for thread(s) ${threadIds.join(", ")} under ${codexHome}` +
        `${unreadable.length ? ` (${unreadable.join("; ")})` : ""}. ` +
        `Pass --codex-home=<dir> if codex keeps its state elsewhere, or --thread=<id> for another thread.`,
    };
  }

  const crossCheck =
    route === "headless" && opts.crossCheck !== false && results.some((r) => r.check)
      ? combineChecks(results, byOrder, pin, priceFn)
      : null;
  const bookedFrom = new Set(results.map((r) => r.info.booked_from));
  const source: DriverUsageReport["source"] = bookedFrom.size > 1 ? "mixed" : bookedFrom.has("exec-stream") ? "exec-stream" : "session-file";
  const unpriced = mergeUnpriced(results.flatMap((r) => r.unpriced));
  const window = combineWindows(results.map((r) => r.window).filter((w): w is DriverWindow => w !== null));

  let costSource: string;
  if (crossCheck) costSource = crossCheckLabel(crossCheck);
  else if (route === "interactive") costSource = "session file (interactive; no exec stream to cross-check; unverified)";
  else costSource = "session file (no exec-stream invocation to cross-check; unverified)";
  if (results.some((r) => r.info.usage_series === "token_count")) {
    costSource += "; booked from token_count totals: the session file has no per-response records";
  }
  if (results.some((r) => r.window?.start_anchor === "whole_thread")) costSource += "; WHOLE THREAD: no marker scopes the window";
  if (window?.provisional && route === "interactive") costSource += "; PROVISIONAL: the closing turn was still running";
  if (window?.lower_bound) costSource += "; LOWER BOUND: the window opens at the first dispatch turn";
  if (unread.length > 0) costSource += `; INCOMPLETE: no readable session file for ${unread.length} thread(s)`;
  const leftOut = excluded.filter((e) => e.conductor_turns_left_out);
  if (leftOut.length > 0) {
    costSource += `; INCOMPLETE: this run's turns in ${leftOut.length} conductor thread(s) left out, as run.json records no start of this run there`;
  }
  if (unpriced.length > 0) costSource += "; INCOMPLETE: unpriced tokens excluded";
  const unreported = results
    .filter((r) => r.info.booked_from === "exec-stream")
    .reduce((n, r) => n + (r.exec?.unreported ?? 0), 0);
  if (unreported > 0) costSource += `; INCOMPLETE: ${unreported} invocation(s) reported no usage`;
  const missing = crossCheck?.missing_invocations ?? 0;
  if (missing > 0) costSource += `; INCOMPLETE: ${missing} invocation(s) missing from the session file`;
  const webSearches = results.reduce((n, r) => n + r.turns.reduce((m, t) => m + t.web_search_calls, 0), 0);
  if (webSearches > 0) costSource += `; INCOMPLETE: ${webSearches} hosted web search call(s), billed per call, not priced`;
  const tierUnverified = results.reduce((n, r) => n + r.turns.filter((t) => t.price_tier === "unverified").length, 0);
  if (tierUnverified > 0) {
    costSource += `; TIER UNVERIFIED: ${tierUnverified} turn(s) priced at the standard card from summed input above a long-context threshold`;
  }

  const tokens = sumUsage(results.map((r) => r.tokens));
  const policy = opts.policy;
  return {
    ok: true,
    report: {
      schema_version: 1,
      route,
      source,
      cost_source: costSource,
      verified: crossCheck?.verified ?? false,
      provenance: "modeled",
      thread_ids: threadIds,
      threads: [...results.map((r) => r.info), ...unread],
      window,
      pin,
      policy: { name: policy?.name ?? null, version: typeof policy?.version === "number" ? policy.version : null },
      turns: results.flatMap((r) => r.turns),
      tokens: {
        ...tokens,
        requests: results.reduce((n, r) => n + r.requests, 0),
        compaction_requests: results.reduce((n, r) => n + r.compaction_requests, 0),
        web_search_calls: webSearches,
      },
      cost_usd_modeled: round6(results.reduce((s, r) => s + r.cost_usd, 0)),
      cost_complete: unread.length === 0 && leftOut.length === 0 && webSearches === 0 && results.every((r) => r.cost_complete),
      unpriced,
      cross_check: crossCheck,
      excluded_threads: excluded,
      tier_unverified_turns: tierUnverified,
      price_list_verified: PRICE_LIST_VERIFIED,
    },
  };
}

// ── Cost cap ──────────────────────────────────────────────────────────────

export type DriverSpendSource =
  | "driver-cost-modeled"
  | "driver-usage"
  | "session-file"
  | "exec-stream"
  | "unpriced"
  | "none";

export interface DriverSpend {
  usd: number;
  source: DriverSpendSource;
  note: string | null;
  /** Parts of the conductor's spend the figure leaves out, such as "tokens on gpt-6.1-sol". */
  not_counted: string[];
  /** A conductor thread is recorded, but its spend could not be read. */
  unmeasured: boolean;
}

export interface DriverSpendOptions {
  env?: Record<string, string | undefined>;
  codexHome?: string;
  priceFn?: DriverPriceFn;
}

/** driver-usage.json when it parses and holds a figure, else null. */
export function readDriverUsageFile(runDir: string): any | null {
  const path = join(runDir, DRIVER_USAGE_FILE);
  if (!existsSync(path)) return null;
  try {
    const usage = JSON.parse(readFileSync(path, "utf-8"));
    return typeof usage?.cost_usd_modeled === "number" && Number.isFinite(usage.cost_usd_modeled) ? usage : null;
  } catch {
    return null;
  }
}

/** Read from a live report or a parsed driver-usage.json, so every field is checked. */
function notCounted(report: any): string[] {
  const out: string[] = [];
  const unpriced: any[] = Array.isArray(report?.unpriced) ? report.unpriced : [];
  const models = [...new Set(unpriced.map((u) => str(u?.model) ?? "an unknown model"))];
  if (models.length > 0) out.push(`tokens on ${models.join(", ")}`);
  const searches = report?.tokens?.web_search_calls;
  if (typeof searches === "number" && searches > 0) out.push(`${searches} hosted web search call(s)`);
  const threads: any[] = Array.isArray(report?.threads) ? report.threads : [];
  const unread = threads.filter((t) => typeof t?.rollout === "string" && t.rollout !== "found" && !t.booked_from).length;
  if (unread > 0) out.push(`${unread} thread(s) with no readable session file`);
  const missing = report?.cross_check?.missing_invocations;
  if (typeof missing === "number" && missing > 0) out.push(`${missing} invocation(s) missing from the session file`);
  const leftOut = leftOutThreads(report?.excluded_threads);
  if (leftOut > 0) out.push(`this run's turns in ${leftOut} conductor thread(s) run.json records no start of this run in`);
  return out;
}

function leftOutThreads(excluded: unknown): number {
  return Array.isArray(excluded) ? excluded.filter((e) => e?.conductor_turns_left_out === true).length : 0;
}

interface RunningSpend {
  usd: number;
  invocations: number[];
  /** Incomplete driver rows whose tokens this figure, or a later row's running total, holds. */
  counted: Set<number>;
  not_counted: string[];
}

const ZERO_USAGE_FLAG = "zero_usage";

/**
 * The session-file cost of the invocations no complete driver row reports
 * yet: the one running now, and a killed or zero-usage one before it, whose
 * tokens only a later running total would carry. `rows` are the parsed
 * driver-cost-modeled.jsonl lines.
 */
function runningInvocationSpend(runDir: string, policy: Policy, rows: any[], opts: DriverSpendOptions): RunningSpend {
  const out: RunningSpend = { usd: 0, invocations: [], counted: new Set(), not_counted: [] };
  const invs = parseDriverEvents(readJsonl(join(runDir, DRIVER_EVENTS_FILE))).filter(
    (i) => !i.legacy && typeof i.invocation === "number" && isThreadId(i.thread_id),
  );
  const reporting = rows.filter(
    (r) => r?.status === "complete" && !(Array.isArray(r.driver_flags) && r.driver_flags.includes(ZERO_USAGE_FLAG)),
  );
  if (invs.length === 0 || reporting.some((r) => typeof r.invocation !== "number")) return out;
  const reportedUpTo = (thread: string) =>
    reporting.filter((r) => r.thread_id === thread || r.thread_id == null).reduce((n, r) => Math.max(n, r.invocation), -Infinity);
  for (const r of rows) {
    if (r?.status === "incomplete" && typeof r.invocation === "number" && isThreadId(r.thread_id) && r.invocation < reportedUpTo(r.thread_id)) {
      out.counted.add(r.invocation);
    }
  }
  // Read live only while an invocation is still running; then it covers every invocation after the last
  // reported one. With none running, an ended invocation with no complete row is an incomplete turn.
  const unreported = invs.filter((i) => (i.invocation as number) > reportedUpTo(i.thread_id as string));
  const pending = unreported.some((i) => !i.ended_at) ? unreported : [];
  if (pending.length === 0) return out;
  out.invocations = pending.map((i) => i.invocation as number);
  const label = `invocation(s) ${out.invocations.join(", ")}`;
  const measured = measureDriverUsage({
    runDir,
    policy,
    codexHome: opts.codexHome ?? defaultCodexHome(opts.env),
    env: opts.env,
    priceFn: opts.priceFn,
    crossCheck: false,
    ignoreLegacy: true,
  });
  if (!measured.ok) {
    out.not_counted.push(`${label} not yet reported (no readable session file)`);
    return out;
  }
  const read = new Set(measured.report.threads.filter((t) => t.booked_from === "session-file").map((t) => t.thread_id));
  const unread = pending.filter((i) => !read.has(i.thread_id as string)).map((i) => i.invocation as number);
  const wanted = new Set(out.invocations.filter((n) => !unread.includes(n)));
  const turns = measured.report.turns.filter((t) => t.usage_source === "session-file" && t.invocation !== null && wanted.has(t.invocation));
  out.usd = turns.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  for (const n of wanted) out.counted.add(n);
  const unpriced = turns.filter((t) => t.unpriced_reason).length;
  if (unpriced > 0) out.not_counted.push(`${unpriced} unpriced turn(s) of ${label}`);
  if (unread.length > 0) out.not_counted.push(`invocation(s) ${unread.join(", ")} not yet reported (no readable session file)`);
  return out;
}

/**
 * The conductor's modeled spend for a run folder, from one source only, in
 * the order the cost report books it: driver-usage.json while nothing was
 * recorded after it, else the complete rows of driver-cost-modeled.jsonl
 * plus the session file's turns of the invocations no row reports yet (the
 * one running), else the session file read live (which also covers the turn
 * still running).
 */
export function driverSpendForCap(runDir: string, policy: Policy, opts: DriverSpendOptions = {}): DriverSpend {
  const usage = readDriverUsageFile(runDir);
  if (usage && driverUsageIsFresh(runDir, usage)) {
    return {
      usd: round6(usage.cost_usd_modeled),
      source: "driver-usage",
      note: str(usage.cost_source),
      not_counted: notCounted(usage),
      unmeasured: false,
    };
  }

  const all = readJsonl(join(runDir, DRIVER_COST_MODELED_FILE));
  const rows = all.filter((r) => r?.status === "complete" && typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd));
  if (rows.length > 0) {
    const usd = rows.reduce((s, r) => s + r.cost_usd, 0);
    const running = runningInvocationSpend(runDir, policy, all, opts);
    // A covered row's tokens are in the covering complete row's delta; a running invocation's are read live.
    const incomplete = all.filter(
      (r) => r?.status === "incomplete" && !str(r.covered_by) && !running.counted.has(r.invocation),
    ).length;
    const unpricedRows = all.filter((r) => r?.status === "complete" && r.cost_usd == null).length;
    const notCountedRows = [
      ...(incomplete > 0 ? [`${incomplete} incomplete driver turn(s)`] : []),
      ...(unpricedRows > 0 ? [`${unpricedRows} unpriced driver turn(s)`] : []),
      ...running.not_counted,
    ];
    const pending = running.invocations.length
      ? `, plus the session file's turns of ${running.invocations.length} invocation(s) not yet reported (${running.invocations.join(", ")})`
      : "";
    return {
      usd: round6(usd + running.usd),
      source: "driver-cost-modeled",
      note: `${rows.length} complete driver turn(s)${pending}`,
      not_counted: notCountedRows,
      unmeasured: false,
    };
  }

  const codexHome = opts.codexHome ?? defaultCodexHome(opts.env);
  const measured = measureDriverUsage({
    runDir,
    policy,
    codexHome,
    env: opts.env,
    priceFn: opts.priceFn,
    crossCheck: false,
    ignoreLegacy: true,
  });
  // The collector's messages name its own flags; this note ends up in a refusal the conductor prints.
  if (!measured.ok) {
    if (measured.code === "no_threads") {
      const leftOut = leftOutThreads(measured.excluded);
      if (leftOut > 0) {
        const note = `this run's turns are in ${leftOut} conductor thread(s) run.json records no start of this run in`;
        return { usd: 0, source: "none", note, not_counted: [], unmeasured: true };
      }
      return { usd: 0, source: "none", note: "no conductor thread recorded in this run folder", not_counted: [], unmeasured: false };
    }
    const note = measured.unreadable?.length
      ? `the conductor's session file could not be used (${measured.unreadable[0]})`
      : `the conductor's session file was not found under ${codexHome}`;
    return { usd: 0, source: "none", note, not_counted: [], unmeasured: true };
  }
  const r = measured.report;
  if (!r.pin) {
    return { usd: 0, source: "unpriced", note: "the policy names no driver pin, so the conductor is not priced", not_counted: [], unmeasured: false };
  }
  if (r.cost_usd_modeled === 0 && r.unpriced.length > 0) {
    return { usd: 0, source: "unpriced", note: r.unpriced.map((u) => u.reason).join("; "), not_counted: [], unmeasured: false };
  }
  return {
    usd: r.cost_usd_modeled,
    source: r.source === "exec-stream" ? "exec-stream" : "session-file",
    note: r.cost_source,
    not_counted: notCounted(r),
    unmeasured: false,
  };
}
