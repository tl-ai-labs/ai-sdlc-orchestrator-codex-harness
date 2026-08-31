/**
 * Telemetry — append-only JSONL writer + rollup builder for manifest.json.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryEvent } from "./types.js";

export function appendEvent(jsonlPath: string, ev: TelemetryEvent): void {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  appendFileSync(jsonlPath, JSON.stringify(ev) + "\n", "utf-8");
}

/**
 * Normalize an event handed to us by a model rather than measured by this
 * server (the direct tier — orchestrator phases that never pass through
 * `execute_with_model`). A model has no clock, so its `ts` and `latency_ms`
 * are invented. Stamp arrival time server-side and record latency as null
 * (the honest value — this server never saw the call). `buildManifest` sorts
 * by `ts` to derive run duration, so placeholder timestamps would corrupt it.
 */
export function normalizeDirectTierEvent(
  ev: TelemetryEvent,
  now: Date = new Date(),
): TelemetryEvent {
  return { ...ev, ts: now.toISOString(), latency_ms: null };
}

export function readEvents(jsonlPath: string): TelemetryEvent[] {
  if (!existsSync(jsonlPath)) return [];
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as TelemetryEvent);
}

export interface Manifest {
  pass: string;
  policy_name: string;
  started_at: string;
  ended_at: string;
  duration_sec: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_input_tokens_cached: number;
  total_output_tokens: number;
  model_breakdown: Record<string, { calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
  /** Older manifests without token fields still load; dashboard falls back. */
  phase_breakdown: Record<string, {
    calls: number;
    cost_usd: number;
    models: string[];
    input_tokens?: number;
    input_tokens_cached?: number;
    output_tokens?: number;
    by_model?: Record<string, {
      calls: number;
      cost_usd: number;
      input_tokens: number;
      input_tokens_cached: number;
      output_tokens: number;
    }>;
  }>;
  module_breakdown: Record<string, { calls: number; cost_usd: number }>;
  task_type_breakdown: Record<string, { calls: number; cost_usd: number }>;
  artifacts?: { files: number; loc: number; tests: number; test_pass_rate: number };
  quality_scores?: Record<string, number>;
}

export function buildManifest(events: TelemetryEvent[], opts: {
  pass: string;
  policy_name: string;
  artifacts?: Manifest["artifacts"];
}): Manifest {
  if (events.length === 0) {
    const now = new Date().toISOString();
    return emptyManifest(opts.pass, opts.policy_name, now);
  }
  const sorted = events.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const started_at = sorted[0].ts;
  const ended_at = sorted[sorted.length - 1].ts;
  const duration_sec = Math.max(
    1,
    Math.round((Date.parse(ended_at) - Date.parse(started_at)) / 1000)
  );

  const model_breakdown: Manifest["model_breakdown"] = {};
  const phase_breakdown: Manifest["phase_breakdown"] = {};
  const module_breakdown: Manifest["module_breakdown"] = {};
  const task_type_breakdown: Manifest["task_type_breakdown"] = {};
  let total_cost_usd = 0,
    total_input_tokens = 0,
    total_input_tokens_cached = 0,
    total_output_tokens = 0;

  for (const ev of events) {
    total_cost_usd += ev.cost_usd;
    total_input_tokens += ev.input_tokens;
    total_input_tokens_cached += ev.input_tokens_cached;
    total_output_tokens += ev.output_tokens;

    const mb = (model_breakdown[ev.model] ??= {
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
    mb.calls++;
    mb.cost_usd += ev.cost_usd;
    mb.input_tokens += ev.input_tokens;
    mb.output_tokens += ev.output_tokens;

    const pb = (phase_breakdown[ev.phase] ??= {
      calls: 0, cost_usd: 0, models: [],
      input_tokens: 0, input_tokens_cached: 0, output_tokens: 0,
      by_model: {},
    });
    pb.calls++;
    pb.cost_usd += ev.cost_usd;
    pb.input_tokens = (pb.input_tokens ?? 0) + ev.input_tokens;
    pb.input_tokens_cached = (pb.input_tokens_cached ?? 0) + ev.input_tokens_cached;
    pb.output_tokens = (pb.output_tokens ?? 0) + ev.output_tokens;
    if (!pb.models.includes(ev.model)) pb.models.push(ev.model);
    const pbm = ((pb.by_model ??= {})[ev.model] ??= {
      calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0,
    });
    pbm.calls++;
    pbm.cost_usd += ev.cost_usd;
    pbm.input_tokens += ev.input_tokens;
    pbm.input_tokens_cached += ev.input_tokens_cached;
    pbm.output_tokens += ev.output_tokens;

    const modb = (module_breakdown[ev.module] ??= { calls: 0, cost_usd: 0 });
    modb.calls++;
    modb.cost_usd += ev.cost_usd;

    const tb = (task_type_breakdown[ev.task_type] ??= { calls: 0, cost_usd: 0 });
    tb.calls++;
    tb.cost_usd += ev.cost_usd;
  }

  const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  total_cost_usd = r6(total_cost_usd);
  for (const k of Object.keys(model_breakdown))
    model_breakdown[k].cost_usd = r6(model_breakdown[k].cost_usd);
  for (const k of Object.keys(phase_breakdown)) {
    phase_breakdown[k].cost_usd = r6(phase_breakdown[k].cost_usd);
    const bm = phase_breakdown[k].by_model;
    if (bm) for (const mk of Object.keys(bm)) bm[mk].cost_usd = r6(bm[mk].cost_usd);
  }
  for (const k of Object.keys(module_breakdown))
    module_breakdown[k].cost_usd = r6(module_breakdown[k].cost_usd);
  for (const k of Object.keys(task_type_breakdown))
    task_type_breakdown[k].cost_usd = r6(task_type_breakdown[k].cost_usd);

  return {
    pass: opts.pass,
    policy_name: opts.policy_name,
    started_at,
    ended_at,
    duration_sec,
    total_cost_usd,
    total_input_tokens,
    total_input_tokens_cached,
    total_output_tokens,
    model_breakdown,
    phase_breakdown,
    module_breakdown,
    task_type_breakdown,
    artifacts: opts.artifacts,
  };
}

function emptyManifest(pass: string, policy_name: string, ts: string): Manifest {
  return {
    pass,
    policy_name,
    started_at: ts,
    ended_at: ts,
    duration_sec: 0,
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_input_tokens_cached: 0,
    total_output_tokens: 0,
    model_breakdown: {},
    phase_breakdown: {},
    module_breakdown: {},
    task_type_breakdown: {},
  };
}

export function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}
