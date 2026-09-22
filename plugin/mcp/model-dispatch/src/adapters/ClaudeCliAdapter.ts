/**
 * ClaudeCliAdapter — routes an Anthropic call through the local `claude -p`
 * subprocess, so a Claude Max subscription's OAuth session backs the request
 * instead of ANTHROPIC_API_KEY. `total_cost_usd` comes back from the CLI
 * verbatim; the mapping copies it into `cost_usd` rather than re-deriving.
 *
 * Every call spawns a fresh `claude` process, which loads roughly 17k tokens
 * of session context before the packet's prompt runs. `usage.cache_creation`
 * captures that overhead; it is billed at the reduced cache-write rate under
 * the Max subscription but still visible in the telemetry.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";

import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";

type SpawnFn = typeof spawn;
type VersionProbe = () => void;

const DEFAULT_TIMEOUT_SEC = 300;

interface ClaudeCliOptions {
  spawnFn?: SpawnFn;
  probeBinary?: VersionProbe;
  timeoutSec?: number;
}

interface ClaudeCliResponse {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  stop_reason?: string;
  terminal_reason?: string;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
    service_tier?: string;
  };
  [key: string]: unknown;
}

export class ClaudeCliAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private cachedSystem = "";
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;

  /**
   * Constructor verifies the `claude` binary is reachable rather than probing
   * for OAuth state — the CLI surfaces its own auth errors far more clearly
   * than a filesystem check on `~/.claude/` could.
   */
  constructor(config: ModelConfig, options: ClaudeCliOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = (options.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;

    const probe =
      options.probeBinary ??
      (() => {
        execFileSync("claude", ["--version"], { stdio: "pipe" });
      });
    try {
      probe();
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(
          `ClaudeCliAdapter needs the \`claude\` binary on PATH for model '${config.id}'. ` +
            `Install Claude Code (https://docs.claude.com/en/docs/claude-code) or add it to PATH.`,
        );
      }
      throw new Error(
        `ClaudeCliAdapter could not probe \`claude --version\` for model '${config.id}': ` +
          `${err?.message ?? err}`,
      );
    }
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);
    const prompt = stableBlock ? `${stableBlock}\n\n${userPrompt}` : userPrompt;

    const started = Date.now();
    const run = await this.runClaudeCli(prompt);

    if (!run.ok) {
      const tokens = { input: estimateTokens(prompt), input_cached: 0, output: 0 };
      const attempt: AttemptRecord = {
        attempt_number: 1,
        ceiling_used: packet.budget.maxOutputTokens,
        hit_output_cap: false,
        tokens,
        cost_usd: 0,
        latency_ms: Date.now() - started,
        success: false,
        error: run.error,
      };
      return {
        result: null,
        tokens,
        cost_usd: 0,
        latency_ms: attempt.latency_ms,
        cache_hit: false,
        success: false,
        error: run.error,
        attempts: [attempt],
        terminal_reason: "vendor_error",
      };
    }

    const response = run.response;
    const isError = response.is_error === true || response.terminal_reason !== "completed";
    const usage = response.usage ?? {};
    const attemptTokens = {
      input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      input_cached: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? estimateTokens(response.result ?? ""),
    };
    const latency = response.duration_api_ms ?? response.duration_ms ?? Date.now() - started;
    const cost = response.total_cost_usd ?? 0;
    const stopReason = response.stop_reason;
    const hitOutputCap = stopReason === "max_tokens";

    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      stop_reason: stopReason,
      hit_output_cap: hitOutputCap,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      success: !isError,
      error: isError ? response.result ?? response.terminal_reason ?? "claude-cli error" : undefined,
    };

    if (isError) {
      return {
        result: null,
        tokens: attemptTokens,
        cost_usd: cost,
        latency_ms: latency,
        cache_hit: attemptTokens.input_cached > 0,
        success: false,
        error: attempt.error,
        attempts: [attempt],
        terminal_reason: "vendor_error",
      };
    }

    const text = (response.result ?? "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    return {
      result: parsed,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      cache_hit: attemptTokens.input_cached > 0,
      success: true,
      attempts: [attempt],
      terminal_reason: "success",
    };
  }

  private runClaudeCli(
    prompt: string,
  ): Promise<{ ok: true; response: ClaudeCliResponse } | { ok: false; error: string }> {
    return new Promise((resolveRun) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(
          "claude",
          ["-p", "--model", this.modelConfig.model_name, "--output-format", "json"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (err: any) {
        resolveRun({ ok: false, error: `claude-cli spawn failed: ${err?.message ?? err}` });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: Awaited<ReturnType<typeof this.runClaudeCli>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish({ ok: false, error: `claude-cli timeout after ${this.timeoutMs / 1000}s` });
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (err) => {
        finish({ ok: false, error: `claude-cli process error: ${err.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0 && !stdout.trim()) {
          finish({
            ok: false,
            error: `claude-cli exited ${code}. ${stderr.trim() || "no stderr"}`,
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as ClaudeCliResponse;
          finish({ ok: true, response: parsed });
        } catch (err: any) {
          finish({
            ok: false,
            error: `claude-cli JSON parse failed: ${err?.message ?? err}. stdout head: ${stdout.slice(0, 200)}`,
          });
        }
      });

      try {
        child.stdin?.end(prompt);
      } catch (err: any) {
        finish({ ok: false, error: `claude-cli stdin write failed: ${err?.message ?? err}` });
      }
    });
  }
}
