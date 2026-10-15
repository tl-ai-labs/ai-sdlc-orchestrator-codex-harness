// Builds codex 0.160.x-shaped session files and driver-events.jsonl lines from
// invented values. No real session text is copied into these fixtures.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PIN = "gpt-5.6-terra";
const BUCKETS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];

export function u(input, cached = 0, output = 0, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
  };
}

const zero = () => u(0);
const add = (a, b) => Object.fromEntries(BUCKETS.map((k) => [k, a[k] + b[k]]));
const withTotal = (x) => ({ ...x, total_tokens: x.input_tokens + x.output_tokens });

export class SyntheticRollout {
  constructor({
    threadId,
    originator = "codex_exec",
    source = "exec",
    start = "2026-10-13T10:00:00.000Z",
    records = true,
    planType = null,
    cwd = null,
  }) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.records = records;
    this.planType = planType;
    this.clock = Date.parse(start);
    this.lines = [];
    this.total = zero();
    this.turns = [];
    this.turnCount = 0;
    this.responseCount = 0;
    this.push({
      type: "session_meta",
      payload: { id: threadId, session_id: threadId, originator, source, cli_version: "0.160.1", model_provider: "openai", ...(cwd ? { cwd } : {}) },
    }, 0);
  }

  push(obj, step = 10) {
    this.clock += step;
    const timestamp = new Date(this.clock).toISOString();
    this.lines.push({ timestamp, ordinal: this.lines.length, ...obj });
    return timestamp;
  }

  tokenCount(total, last) {
    return this.push({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: withTotal(total), last_token_usage: withTotal(last), model_context_window: 258400 },
        rate_limits: { plan_type: this.planType },
      },
    });
  }

  /**
   * responses: [{ usage, compaction?, repeat? }]. end: "complete" | "aborted" | null (still running).
   * resetBefore overwrites the token_count total with zeros before the turn's responses. cwd is the
   * turn_context's working folder (default: the session's).
   */
  turn({ text = "continue", model = PIN, effort = "high", responses = [], end = "complete", resetBefore = false, gap = 1000, webSearches = 0, cwd = this.cwd } = {}) {
    const turnId = `turn-${String(++this.turnCount).padStart(4, "0")}-${this.threadId.slice(0, 8)}`;
    const startedAt = this.push({ type: "event_msg", payload: { type: "task_started", turn_id: turnId, model_context_window: 258400 } }, gap);
    this.push({
      type: "turn_context",
      payload: { turn_id: turnId, ...(cwd ? { cwd } : {}), model, effort, collaboration_mode: { mode: "default", settings: { model, reasoning_effort: effort } } },
    });
    this.push({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: this.threadId,
        turn_id: turnId,
        item: { type: "UserMessage", id: `msg-${turnId}`, content: [{ type: "text", text }] },
      },
    });
    for (let i = 0; i < webSearches; i++) {
      this.push({ type: "response_item", payload: { type: "web_search_call", id: `ws_${turnId}_${i}`, status: "completed", action: { type: "search", query: "synthetic" } } });
    }
    if (resetBefore) {
      this.total = zero();
      this.tokenCount(zero(), zero());
    }
    let lastAt = startedAt;
    for (const r of responses) {
      const responseId = `resp_${++this.responseCount}`;
      if (this.records) {
        lastAt = this.push({
          type: "token_usage_record",
          payload: { thread_id: this.threadId, turn_id: turnId, response_id: responseId, usage: withTotal(r.usage) },
        });
      }
      if (r.compaction) {
        this.push({ type: "compacted", payload: { message: "", compaction_response_id: responseId } });
        lastAt = this.tokenCount(this.total, zero());
      } else {
        this.total = add(this.total, r.usage);
        lastAt = this.tokenCount(this.total, r.usage);
        if (r.repeat) lastAt = this.tokenCount(this.total, r.usage);
      }
    }
    let endedAt = null;
    if (end) {
      endedAt = this.push({ type: "event_msg", payload: { type: end === "complete" ? "task_complete" : "turn_aborted", turn_id: turnId } });
    }
    const info = { id: turnId, started_at: startedAt, ended_at: endedAt, last_at: lastAt, cumulative: { ...this.total } };
    this.turns.push(info);
    return info;
  }

  text() {
    return this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  write(codexHome, { dir = "sessions/2026/10/13", compressed = false, extra = "" } = {}) {
    const folder = join(codexHome, dir);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `rollout-2026-10-13T10-00-00-${this.threadId}.jsonl${compressed ? ".zst" : ""}`);
    writeFileSync(path, this.text() + extra);
    return path;
  }
}

const shift = (iso, delta) => new Date(Date.parse(iso) + delta).toISOString();

/**
 * One driver-events.jsonl v1 invocation per entry: { turn, mode?, usage?, failed?, incomplete?, open? }.
 * `usage` overrides the turn.completed total; `open` leaves out invocation_end.
 */
export function driverEventLines(threadId, invocations, { runId = "run-1", policy = "gpt-plus-flash" } = {}) {
  const lines = [];
  invocations.forEach((inv, k) => {
    const n = k + 1;
    const mode = inv.mode ?? (k === 0 ? "fresh" : "resume");
    const at = shift(inv.turn.started_at, -5);
    lines.push({ v: 1, kind: "invocation_start", run_id: runId, invocation: n, at, mode, resume_thread_id: mode === "resume" ? threadId : null, policy });
    const codex = (event) => lines.push({ v: 1, kind: "codex", invocation: n, thread_id: threadId, received_at: at, event });
    codex({ type: "thread.started", thread_id: threadId });
    codex({ type: "turn.started" });
    if (inv.failed) codex({ type: "turn.failed", error: { message: "synthetic failure" } });
    else if (!inv.incomplete) codex({ type: "turn.completed", usage: inv.usage ?? inv.turn.cumulative });
    if (!inv.open) {
      lines.push({
        v: 1,
        kind: "invocation_end",
        invocation: n,
        at: shift(inv.turn.ended_at ?? inv.turn.last_at, 5),
        thread_id: threadId,
        exit_status: inv.failed || inv.incomplete ? 1 : 0,
        ended_by: inv.incomplete ? "driver_signal" : "exit",
      });
    }
  });
  return lines;
}

export function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function marker(threadId, ts, tool = "execute_with_model") {
  return { ts, thread_id: threadId, tool, policy: "gpt-plus-flash", pid: 4242 };
}

export function inside(turn, ms = 1) {
  return shift(turn.started_at, ms);
}
