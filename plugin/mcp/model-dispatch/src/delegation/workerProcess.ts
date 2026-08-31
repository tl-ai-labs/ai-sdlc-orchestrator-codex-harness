/**
 * Pure half of the Antigravity agent worker launch — decisions that don't
 * touch the filesystem, clock, or network. Interpreter resolution, argv,
 * child env, task brief, and sidecar-to-tokens mapping. The spawn, timeout
 * kill, and file reads live in AntigravityWorkerAdapter (the real-machine
 * half); everything here is unit-tested offline.
 */

import { join } from "node:path";
import type { ReasoningConfig, TaskPacket } from "../types.js";

/**
 * Worker's own asyncio deadline; matches the Python `--timeout` default so
 * the two halves agree. 9 minutes — an agent explores, runs commands, and
 * only returns at the end of the whole session. Override with policy
 * leaf's `worker_timeout_sec:`.
 */
export const DEFAULT_WORKER_TIMEOUT_SEC = 540;

/**
 * Extra seconds the adapter waits before SIGKILL. Deliberately non-zero so
 * the worker's own timeout — which exits cleanly with a diagnosable message —
 * always fires first, even on a loaded machine.
 */
export const WORKER_KILL_GRACE_SEC = 30;

/** Explicit interpreter for the worker. Escape hatch; the normal path is the built venv. */
export const WORKER_PYTHON_ENV = "GEMINI_WORKER_PYTHON";

export function workerVenvPython(workerDir: string): string {
  return join(workerDir, ".venv", "bin", "python");
}

/**
 * No `python3` fallback: on macOS that resolves to 3.9, and google-antigravity
 * needs ≥ 3.10 — the fallback would turn a setup problem into a subprocess
 * import error paid phases into a run. Refuse here instead.
 * `exists` is injected for offline testing.
 */
export function resolveWorkerPython(opts: {
  env: Record<string, string | undefined>;
  workerDir: string;
  exists: (path: string) => boolean;
}): string {
  const override = opts.env[WORKER_PYTHON_ENV];
  if (override && override.trim() !== "") {
    if (!opts.exists(override)) {
      throw new Error(
        `${WORKER_PYTHON_ENV} points at '${override}', which does not exist. ` +
          `Unset it to use the worker's own virtual environment, or point it at a ` +
          `Python >= 3.10 that has google-antigravity installed.`,
      );
    }
    return override;
  }
  const venv = workerVenvPython(opts.workerDir);
  if (opts.exists(venv)) return venv;
  throw new Error(
    `The Antigravity agent worker has no Python environment. Expected an interpreter at ` +
      `'${venv}'. Run \`npm run setup\` in the plugin root to create it, or set ` +
      `${WORKER_PYTHON_ENV} to a Python >= 3.10 that already has google-antigravity ` +
      `installed. Nothing is dispatched to this adapter until one of those is true.`,
  );
}

/**
 * Policy `reasoning:` → worker's `--thinking` flag. `NONE` = no thinking config.
 * `tier` is the same field the model adapter reads.
 */
export function workerThinkingLevel(reasoning?: ReasoningConfig): string {
  const tier = reasoning?.tier;
  if (!tier) return "NONE";
  return tier.toUpperCase();
}

export interface WorkerArgsInput {
  script: string;
  taskFile: string;
  model: string;
  region: string;
  workdir: string;
  outDir: string;
  usageFile: string;
  thinking: string;
  timeoutSec: number;
}

/**
 * `--region` is passed on every invocation. The worker has its own env
 * fallback for hand runs, but here we want the region in the manifest and
 * the region on the endpoint to match by construction.
 */
export function buildWorkerArgs(i: WorkerArgsInput): string[] {
  return [
    i.script,
    "--task-file", i.taskFile,
    "--model", i.model,
    "--region", i.region,
    "--workdir", i.workdir,
    "--out-dir", i.outDir,
    "--usage-file", i.usageFile,
    "--thinking", i.thinking,
    "--timeout", String(i.timeoutSec),
  ];
}

/**
 * API-key variables removed from the child env. The whole claim this adapter
 * makes is "reached Vertex on project P in region R". Google's libraries
 * prefer an API key in several code paths — if one took it, the sidecar
 * would still say `vertex_project: P` because the worker writes what it was
 * TOLD, not what the transport chose.
 */
export const WORKER_STRIPPED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * Child env. Starts from the parent's (child needs PATH, HOME for ADC, and
 * on macOS DYLD_LIBRARY_PATH for pyexpat), pins project + location, strips
 * API-key doors. Parent env has already been through sanitizePluginEnv.
 */
export function buildWorkerEnv(
  parent: Record<string, string | undefined>,
  pins: { project: string; location: string },
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    child[key] = value;
  }
  for (const key of WORKER_STRIPPED_ENV) delete child[key];
  child.GOOGLE_CLOUD_PROJECT = pins.project;
  child.GOOGLE_CLOUD_LOCATION = pins.location;
  // Unbuffered so a killed process's last stderr line — often the timeout
  // diagnostic — isn't lost.
  child.PYTHONUNBUFFERED = "1";
  return child;
}

/**
 * Filesystem-safe stem. Substitution is defensive: an id is a string from a
 * model-authored plan, and a `/` would write the sidecar into a different
 * directory. Leading/trailing dots go so evidence is never hidden.
 */
export function evidenceStem(packet: TaskPacket): string {
  const raw = packet.id || `${packet.phase}-untitled`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "packet";
}

/**
 * Brief the worker reads as its opening message. Different from a completion
 * prompt: file slices are EXCERPTS with real paths, and the worker is told
 * it may open the originals. The output contract is restated at the end
 * because an agent that has run tools is more likely to narrate.
 */
export function workerTaskMarkdown(
  packet: TaskPacket,
  opts: { workdir: string; header?: string },
): string {
  const wantsJson = !!packet.outputSchema && !(packet.outputSchema as any).__free_text__;
  const excerpts = packet.inputs
    .map((s) => `#### ${s.path}\n_Included because: ${s.reason}_\n\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    opts.header ? `## Project context\n\n${opts.header}\n` : "",
    `## Task ${packet.id} — ${packet.phase} / ${packet.task_type}`,
    ``,
    `Module: ${packet.module}`,
    ``,
    `### Working directory`,
    ``,
    `You are running as an agent inside \`${opts.workdir}\`. You may list, read,`,
    `edit and create files there, and run commands there. That directory is the`,
    `only place you can act; nothing outside it is reachable.`,
    ``,
    `### Instruction`,
    ``,
    packet.instruction,
    ``,
    `### Provided excerpts`,
    ``,
    excerpts
      ? `These are extracts, not whole files. The paths are real — open them in the\nworking directory when you need more than the excerpt shows.\n\n${excerpts}`
      : `_None supplied. Explore the working directory to find what you need._`,
    ``,
    `### Acceptance criteria`,
    ``,
    ...(packet.acceptance.length ? packet.acceptance.map((a) => `- ${a}`) : ["- _(none stated)_"]),
    ``,
    `### Your final message`,
    ``,
    wantsJson
      ? [
          `Your final message must be a single JSON object and nothing else — no`,
          `prose before it, no summary after it, no \`\`\` fence around it. It must`,
          `conform to this schema:`,
          ``,
          "```json",
          JSON.stringify(packet.outputSchema, null, 2),
          "```",
        ].join("\n")
      : [
          `Return the deliverable itself as your final message — the file content or`,
          `the document that was asked for, not a report about producing it.`,
        ].join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Map worker-sidecar tokens onto the orchestrator's disjoint convention.
 * TWO TRAPS:
 *  1. Sidecar keys are snake_case (Python SDK), not camelCase.
 *  2. `prompt_token_count` INCLUDES the cached portion — subtract before
 *     handing to computeCostUsd, which needs disjoint counts.
 * Thoughts fold into `output` for costing and duplicate to `output_reasoning`
 * for reporting only (computeCostUsd never reads that field).
 */
export function mapSidecarTokens(sidecar: any): {
  input: number;
  input_cached: number;
  output: number;
  output_reasoning: number;
} {
  const usage = (sidecar && sidecar.usage) || {};
  const prompt = Number(usage.prompt_token_count ?? 0);
  const cached = Number(usage.cached_content_token_count ?? 0);
  const candidates = Number(usage.candidates_token_count ?? 0);
  const thoughts = Number(usage.thoughts_token_count ?? 0);
  return {
    input: Math.max(0, prompt - cached),
    input_cached: cached,
    output: candidates + thoughts,
    output_reasoning: thoughts,
  };
}

/**
 * True tool-call count, not the sampled list length. `tool_call_count` is
 * the honest number; `tool_calls_truncated` says when the list is bounded.
 */
export function sidecarToolCallCount(sidecar: any): number {
  const n = Number(sidecar?.tool_call_count ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
