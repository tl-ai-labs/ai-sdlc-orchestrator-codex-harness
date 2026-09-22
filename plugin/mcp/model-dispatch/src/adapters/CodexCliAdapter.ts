/**
 * CodexCliAdapter — routes a GPT call through the local `codex exec`
 * subprocess, so a ChatGPT seat's login backs the request instead of
 * OPENAI_API_KEY. Direct analog of ClaudeCliAdapter, which does the same
 * thing for a Claude Max subscription.
 *
 * The one place the analogy breaks, and it matters: `claude -p` returns
 * `total_cost_usd` and that adapter copies it through verbatim. Codex
 * returns **no cost figure at all** — only token counts on `turn.completed`
 * (verified live; see docs/verification/p1-codex-runtime.md section 9). So
 * cost here is MODELED from those tokens at the policy's pinned rates, and
 * this adapter reports `costProvenance: "modeled"` so the telemetry and the
 * run report label it correctly rather than passing it off as metered spend.
 *
 * That is a real reduction in fidelity against the OpenAI adapter, and it is
 * the reason `gpt-plus-flash` remains the policy of record: a published cost
 * comparison should rest on vendor-metered numbers. This adapter exists so a
 * run is possible on a subscription alone, which is the difference between
 * developing against the harness and not being able to run it.
 *
 * Structured output comes from `--output-schema` (the packet's own
 * outputSchema, written to a temp file) plus `--output-last-message`, which
 * is read back from disk rather than scraped out of stdout — the headless
 * file-output rule from the port's gotcha ledger.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { log } from "../log.js";

type SpawnFn = typeof spawn;

const DEFAULT_TIMEOUT_SEC = 600;

interface CodexCliOptions {
  spawnFn?: SpawnFn;
  timeoutSec?: number;
  /** Overrides the binary — for a non-global install, or a test stub. */
  codexBin?: string;
}

/** Usage as `turn.completed` reports it. No cost field exists on this event. */
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * Pulls the last `turn.completed` usage block and any error out of a
 * `codex exec --json` stream. Tolerant of partial lines: a truncated final
 * line at a stream boundary is skipped, not thrown on.
 */
export function parseCodexStream(stdout: string): { usage: CodexUsage | null; error: string | null } {
  let usage: CodexUsage | null = null;
  let error: string | null = null;
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "turn.completed" && event.usage) usage = event.usage;
    if (event.type === "error" && typeof event.message === "string") error = event.message;
    if (event.type === "turn.failed") error = event.error?.message ?? error;
    if (event.type === "item.completed" && event.item?.type === "error") {
      error = event.item.message ?? error;
    }
  }
  return { usage, error };
}

export class CodexCliAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  /** Cost is derived, never reported by the CLI. See the module docstring. */
  readonly costProvenance = "modeled" as const;
  private cachedSystem = "";
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly codexBin: string;

  constructor(config: ModelConfig, options: CodexCliOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = (options.timeoutSec ?? config.worker_timeout_sec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    this.codexBin = options.codexBin ?? process.env.CODEX_BIN ?? "codex";
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  /**
   * The argv for one dispatch. Split out so the flags are assertable in a
   * test — several are load-bearing in ways a reading would not catch:
   * `--sandbox read-only` because a judgment call has no business writing
   * files, `--skip-git-repo-check` because dispatch may run outside a repo,
   * and the bare `--` because a prompt starting with `---` is otherwise
   * parsed as flags.
   */
  buildArgs(schemaPath: string, lastMessagePath: string, prompt: string): string[] {
    const args = [
      "exec",
      "--json",
      "-m",
      this.modelConfig.model_name,
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
    ];
    const effort = this.modelConfig.reasoning?.effort;
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("--", prompt);
    return args;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);
    // The stable block has nowhere to go as a cached system message here —
    // codex exec takes one prompt — so it is prepended. That loses the
    // prompt-caching discount the API adapters get, which is part of why
    // this path is the fallback and not the default.
    const prompt = stableBlock ? `${stableBlock}\n\n${userPrompt}` : userPrompt;

    const workDir = mkdtempSync(join(tmpdir(), "codex-dispatch-"));
    const schemaPath = join(workDir, "schema.json");
    const lastMessagePath = join(workDir, "last-message.txt");
    const started = Date.now();

    try {
      writeFileSync(schemaPath, JSON.stringify(packet.outputSchema ?? { type: "object" }), "utf-8");
      const args = this.buildArgs(schemaPath, lastMessagePath, prompt);

      log("debug", "api.codex_cli.request", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        reasoning_effort: this.modelConfig.reasoning?.effort,
        prompt_bytes: Buffer.byteLength(prompt),
      });

      const run = await this.spawnAndCollect(args);

      if (run.timedOut) {
        return this.failure(packet, prompt, started, `codex-cli timeout after ${this.timeoutMs / 1000}s`);
      }

      const { usage, error } = parseCodexStream(run.stdout);
      if (error) {
        return this.failure(packet, prompt, started, error);
      }

      let raw = "";
      try {
        raw = readFileSync(lastMessagePath, "utf-8").trim();
      } catch {
        return this.failure(packet, prompt, started, "codex-cli wrote no final message");
      }
      if (!raw) {
        return this.failure(packet, prompt, started, "codex-cli produced an empty final message");
      }

      // Codex reports `input_tokens` INCLUSIVE of `cached_input_tokens`;
      // computeCostUsd prices the two as disjoint buckets and sums them, so
      // the inclusive total would bill every cached token twice.
      const cachedInput = usage?.cached_input_tokens ?? 0;
      const tokens = {
        input: usage ? Math.max(0, (usage.input_tokens ?? 0) - cachedInput) : estimateTokens(prompt),
        input_cached: cachedInput,
        output: usage?.output_tokens ?? estimateTokens(raw),
        output_reasoning: usage?.reasoning_output_tokens,
      };

      log("debug", "api.codex_cli.response", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        exit_code: run.status,
        usage: JSON.stringify(usage ?? {}),
      });

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }

      const attempt: AttemptRecord = {
        attempt_number: 1,
        ceiling_used: packet.budget.maxOutputTokens,
        hit_output_cap: false,
        tokens,
        // Modeled, not billed. The policy's own pricing block is the source
        // of the rates, same as everywhere else in this harness.
        cost_usd: computeCostUsd(tokens, this.modelConfig.pricing),
        latency_ms: Date.now() - started,
        success: true,
      };

      return {
        result: parsed,
        tokens,
        cost_usd: attempt.cost_usd,
        latency_ms: attempt.latency_ms,
        cache_hit: tokens.input_cached > 0,
        success: true,
        attempts: [attempt],
        terminal_reason: "success",
      };
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  /** stdin is never attached — `codex exec` reads it when present and a phase can hang. */
  private spawnAndCollect(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null; timedOut: boolean }> {
    return new Promise((resolvePromise) => {
      const child: ChildProcess = this.spawnFn(this.codexBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolvePromise({ stdout, stderr, status: null, timedOut: true });
      }, this.timeoutMs);

      child.stdout?.on("data", (c) => (stdout += c.toString()));
      child.stderr?.on("data", (c) => (stderr += c.toString()));
      child.on("error", (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr: String(err?.message ?? err), status: null, timedOut: false });
      });
      child.on("close", (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, status, timedOut: false });
      });
    });
  }

  private failure(packet: TaskPacket, prompt: string, started: number, error: string): ExecutionResult {
    const tokens = { input: estimateTokens(prompt), input_cached: 0, output: 0 };
    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      hit_output_cap: false,
      tokens,
      cost_usd: computeCostUsd(tokens, this.modelConfig.pricing),
      latency_ms: Date.now() - started,
      success: false,
      error,
    };
    return {
      result: null,
      tokens,
      cost_usd: attempt.cost_usd,
      latency_ms: attempt.latency_ms,
      cache_hit: false,
      success: false,
      error,
      attempts: [attempt],
      terminal_reason: "vendor_error",
    };
  }
}
