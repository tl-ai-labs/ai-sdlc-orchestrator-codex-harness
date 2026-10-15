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
 * cost here is MODELED from those tokens at the dated price list's rates, and
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
 * file-output rule from the port's gotcha ledger. Codex sends that schema in
 * OpenAI strict mode, which refuses the whole request over one loose object,
 * so a schema strict mode would refuse goes as STRICT_RESULT_ENVELOPE instead
 * (strictSchema.ts) and the value comes back out of its `result_json`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttemptRecord, ExecutionResult, ModelConfig, RunContext, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { log } from "../log.js";
import { DispatchPricer, priceFields, refusedResult, type Clock } from "./dispatchPricer.js";
import { dispatchTimeoutMs } from "./deadline.js";
import { envelopeInstruction, jsonOrRaw, readEnvelope, STRICT_RESULT_ENVELOPE, strictSchemaProblems } from "./strictSchema.js";

type SpawnFn = typeof spawn;

/**
 * Switches the installed plugin's write hook off for the nested exec: a read-only worker writes nothing, so the hook
 * would only start node for every tool call. The same value as plugin/codex/hook-wiring.mjs pluginHooksOffConfig();
 * tools/test/hook-wiring.test.mjs holds the two together.
 */
export const PLUGIN_HOOKS_OFF_CONFIG =
  'hooks.state={"mmo-codex@tilicho-ai-labs:hooks/hooks.json:pre_tool_use:0:0"={enabled=false}}';

interface CodexCliOptions {
  spawnFn?: SpawnFn;
  timeoutSec?: number;
  /** Overrides the binary — for a non-global install, or a test stub. */
  codexBin?: string;
  clock?: Clock;
}

/** Usage as `turn.completed` reports it. No cost field exists on this event. */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexStream {
  usage: CodexUsage | null;
  /** A `turn.completed` arrived (and no `turn.failed` after it). */
  completed: boolean;
  /** Set only when the turn failed, or when it never completed and the stream carried an error. */
  error: string | null;
  /** Top-level `error` events and `error` items: codex reconnects and warnings, in order. */
  warnings: string[];
  threadId: string | null;
}

/**
 * Reads a `codex exec --json` stream, deciding on the terminal event. Codex
 * 0.160 emits reconnects ("Reconnecting... 1/5") as top-level `error` events
 * and config or model-metadata warnings as `error` items, all while the turn
 * is still running; only `turn.failed` ends a turn in failure. A truncated
 * final line is skipped, not thrown on.
 */
export function parseCodexStream(stdout: string): CodexStream {
  let usage: CodexUsage | null = null;
  let terminal: "completed" | "failed" | null = null;
  let failedMessage: string | null = null;
  let lastError: string | null = null;
  let threadId: string | null = null;
  const warnings: string[] = [];
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
    if (event.type === "turn.completed") {
      terminal = "completed";
      if (event.usage) usage = event.usage;
    }
    if (event.type === "turn.failed") {
      terminal = "failed";
      failedMessage = event.error?.message ?? lastError ?? "turn failed";
    }
    const message =
      event.type === "error" && typeof event.message === "string"
        ? event.message
        : event.type === "item.completed" && event.item?.type === "error" && typeof event.item.message === "string"
          ? event.item.message
          : null;
    if (message !== null) {
      warnings.push(message);
      lastError = message;
    }
  }
  const completed = terminal === "completed";
  const error = terminal === "failed" ? failedMessage : completed ? null : lastError;
  return { usage, completed, error, warnings, threadId };
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // The group is gone; fall through to the child itself.
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

/** Codex reports `input_tokens` inclusive of `cached_input_tokens`; computeCostUsd needs them disjoint. */
export function tokensFromUsage(usage: CodexUsage): AttemptRecord["tokens"] {
  const cached = usage.cached_input_tokens ?? 0;
  return {
    input: Math.max(0, (usage.input_tokens ?? 0) - cached),
    input_cached: cached,
    output: usage.output_tokens ?? 0,
    output_reasoning: usage.reasoning_output_tokens,
  };
}

interface FailureOptions {
  /** The turn completed and reported usage, but no answer came back. */
  usage?: CodexUsage | null;
  threadId?: string | null;
  /** codex never started, so nothing was sent. */
  neverStarted?: boolean;
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
  private readonly pricer: DispatchPricer;

  constructor(config: ModelConfig, options: CodexCliOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.pricer = new DispatchPricer(config, options.clock);
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = options.timeoutSec !== undefined ? options.timeoutSec * 1000 : dispatchTimeoutMs(config);
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
      "-c",
      PLUGIN_HOOKS_OFF_CONFIG,
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

  async execute(packet: TaskPacket, _cacheContext?: string, runContext?: RunContext): Promise<ExecutionResult> {
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);
    // The stable block has nowhere to go as a cached system message here —
    // codex exec takes one prompt — so it is prepended. That loses the
    // prompt-caching discount the API adapters get, which is part of why
    // this path is the fallback and not the default.
    const packetPrompt = stableBlock ? `${stableBlock}\n\n${userPrompt}` : userPrompt;
    const packetSchema = packet.outputSchema ?? { type: "object" };
    const schemaProblems = strictSchemaProblems(packetSchema);
    const enveloped = schemaProblems.length > 0;
    const prompt = enveloped ? `${packetPrompt}\n\n${envelopeInstruction(packetSchema)}` : packetPrompt;

    const dispatchDate = this.pricer.now();
    const listed = this.pricer.price(dispatchDate);
    if (listed.unpriced) {
      return refusedResult(this.modelConfig, dispatchDate, listed.reason, packet.budget.maxOutputTokens);
    }

    const workDir = mkdtempSync(join(tmpdir(), "codex-dispatch-"));
    const schemaPath = join(workDir, "schema.json");
    const lastMessagePath = join(workDir, "last-message.txt");
    const started = Date.now();

    try {
      writeFileSync(schemaPath, JSON.stringify(enveloped ? STRICT_RESULT_ENVELOPE : packetSchema), "utf-8");
      const args = this.buildArgs(schemaPath, lastMessagePath, prompt);

      log("debug", "api.codex_cli.request", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        reasoning_effort: this.modelConfig.reasoning?.effort,
        prompt_bytes: Buffer.byteLength(prompt),
        output_schema: enveloped ? "envelope" : "packet",
        schema_problem: schemaProblems[0],
      });

      const run = await this.spawnAndCollect(args, runContext?.signal);

      if (run.spawnError) {
        return this.failure(packet, prompt, started, dispatchDate, `codex-cli could not start: ${run.stderr}`, {
          neverStarted: true,
        });
      }

      const stream = parseCodexStream(run.stdout);
      const { usage, threadId } = stream;
      if (stream.warnings.length > 0) {
        log("warn", "api.codex_cli.stream_warning", {
          packet_id: packet.id,
          count: stream.warnings.length,
          completed: stream.completed,
          first: stream.warnings[0].slice(0, 200),
        });
      }

      if (runContext?.signal?.aborted) {
        return this.failure(packet, prompt, started, dispatchDate, "codex-cli stopped: the dispatch was abandoned", {
          usage: stream.completed ? usage : null,
          threadId,
        });
      }
      if (run.timedOut) {
        return this.failure(packet, prompt, started, dispatchDate, `codex-cli timeout after ${this.timeoutMs / 1000}s`, {
          usage: stream.completed ? usage : null,
          threadId,
        });
      }
      if (stream.error) {
        return this.failure(packet, prompt, started, dispatchDate, stream.error, { threadId });
      }
      if (!stream.completed && run.status !== 0) {
        return this.failure(packet, prompt, started, dispatchDate, `codex-cli exited ${run.status} without completing a turn`, {
          threadId,
        });
      }
      if (stream.completed && run.status !== 0) {
        log("warn", "api.codex_cli.exit_after_turn", { packet_id: packet.id, exit_code: run.status });
      }

      let raw = "";
      try {
        raw = readFileSync(lastMessagePath, "utf-8").trim();
      } catch {
        return this.failure(packet, prompt, started, dispatchDate, "codex-cli wrote no final message", { usage, threadId });
      }
      if (!raw) {
        return this.failure(packet, prompt, started, dispatchDate, "codex-cli produced an empty final message", {
          usage,
          threadId,
        });
      }

      const tokens = usage ? tokensFromUsage(usage) : { input: estimateTokens(prompt), input_cached: 0, output: 0 };
      const estimated = usage?.output_tokens === undefined;
      if (estimated) tokens.output = estimateTokens(raw);

      log("debug", "api.codex_cli.response", {
        packet_id: packet.id,
        model_name: this.modelConfig.model_name,
        exit_code: run.status,
        usage: JSON.stringify(usage ?? {}),
      });

      const parsed = enveloped ? readEnvelope(raw) : jsonOrRaw(raw);

      // A turn's usage sums every request in it, so it can prove the whole
      // turn stayed under a tier but never that one request crossed it.
      const price = this.pricer.require(
        dispatchDate,
        typeof usage?.input_tokens === "number"
          ? { aggregateInputTokens: usage.input_tokens }
          : { aggregateInputTokens: tokens.input + tokens.input_cached, estimated: true },
      );
      const attempt: AttemptRecord = {
        attempt_number: 1,
        ceiling_used: packet.budget.maxOutputTokens,
        hit_output_cap: false,
        tokens,
        cost_usd: computeCostUsd(tokens, price.pricing),
        latency_ms: Date.now() - started,
        success: true,
        ...priceFields(price),
        ...(estimated ? { cost_provenance: "estimated" as const } : {}),
        ...(threadId ? { codex_thread_id: threadId } : {}),
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
        ...(estimated ? { cost_provenance: "estimated" as const } : {}),
      };
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  /**
   * stdin is never attached — `codex exec` reads it when present and a phase can hang.
   * `detached` gives codex its own process group: the npm `codex` is a Node wrapper that
   * forwards SIGINT, SIGTERM and SIGHUP to the native binary but cannot forward SIGKILL,
   * so killing the wrapper alone leaves the native codex running its turn.
   */
  private spawnAndCollect(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; status: number | null; timedOut: boolean; spawnError?: boolean }> {
    return new Promise((resolvePromise) => {
      const child: ChildProcess = this.spawnFn(this.codexBin, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killGroup(child);
        resolvePromise({ stdout, stderr, status: null, timedOut: true });
      }, this.timeoutMs);
      // Abandoned by the client: kill now, or the nested codex keeps spending after the bridge exits.
      const onAbort = () => killGroup(child);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", onAbort));

      child.stdout?.on("data", (c) => (stdout += c.toString()));
      child.stderr?.on("data", (c) => (stderr += c.toString()));
      child.on("error", (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr: String(err?.message ?? err), status: null, timedOut: false, spawnError: true });
      });
      child.on("close", (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, status, timedOut: false });
      });
    });
  }

  /**
   * Bills turn usage when the turn reported it, $0 when codex never started,
   * and otherwise the prompt as an estimated lower bound: turn.failed carries
   * no usage, and a killed turn may have made many requests.
   */
  private failure(
    packet: TaskPacket,
    prompt: string,
    started: number,
    dispatchDate: Date,
    error: string,
    opts: FailureOptions = {},
  ): ExecutionResult {
    const measured = opts.usage ? tokensFromUsage(opts.usage) : null;
    const estimated = !measured && !opts.neverStarted;
    const tokens = measured ?? { input: opts.neverStarted ? 0 : estimateTokens(prompt), input_cached: 0, output: 0 };
    const price = this.pricer.require(
      dispatchDate,
      typeof opts.usage?.input_tokens === "number"
        ? { aggregateInputTokens: opts.usage.input_tokens }
        : { aggregateInputTokens: tokens.input + tokens.input_cached, estimated: true },
    );
    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      hit_output_cap: false,
      tokens,
      cost_usd: computeCostUsd(tokens, price.pricing),
      latency_ms: Date.now() - started,
      success: false,
      error,
      ...priceFields(price),
      ...(estimated ? { cost_provenance: "estimated" as const, usage_complete: false as const } : {}),
      ...(opts.threadId ? { codex_thread_id: opts.threadId } : {}),
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
      ...(estimated ? { cost_provenance: "estimated" as const } : {}),
    };
  }
}
