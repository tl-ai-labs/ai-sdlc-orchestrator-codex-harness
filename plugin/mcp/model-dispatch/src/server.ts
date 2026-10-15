#!/usr/bin/env node
/**
 * MCP server entrypoint. Tools:
 *   execute_with_model   — run a TaskPacket against the model chosen by policy
 *   simulate_policy      — recompute cost from telemetry against another policy
 *   log_telemetry        — append a direct-tier event to disk
 *   preflight_dispatch   — construct every adapter this run will use (no API call)
 *   load_policy          — return the active policy (debug)
 */

// MUST stay the first import — strips `${NAME}` placeholder env vars before
// any SDK reads process.env. See envBootstrap.ts.
import "./envBootstrap.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { existsSync } from "node:fs";

import { resolvePolicy, getModel, type ResolvedPolicy } from "./policy.js";
import {
  pickModel,
  simulatePolicyCost,
  parseSelectOverrides,
  validateSelectOverrides,
  unreachableModelIds,
} from "./routing.js";
import { assessModels, assessPricing, parseAuthMode, type AuthMode } from "./preflight.js";
import { effectivePricing, withEffectivePrices, type RateCard } from "./prices.js";
import { appendEvent, normalizeDirectTierEvent } from "./telemetry.js";
import { DispatchRecorder, type PlaceholderPricer } from "./dispatchRecorder.js";
import { computeCostUsd } from "./pricing.js";
import { priceFields } from "./adapters/dispatchPricer.js";
import { assertUnderCostCap, CostCapExceededError, driverCapWarning, type RecordedSpend } from "./costCap.js";
import { createAdapter } from "./adapters/index.js";
import {
  applyVertexSurcharge,
  defaultAdcPath,
  dispatchEndpoint,
  selectGeminiBackend,
  resolveGcpProject,
  resolveGcpLocation,
} from "./adapters/geminiTransports.js";
import type { ExecutionResult, TaskPacket, TelemetryEvent, Policy, SelectOverrides, ModelConfig } from "./types.js";
import { isPhase, PHASES } from "./types.js";
import { log, setLevel, configureSinks, type Level } from "./log.js";

/**
 * Cheap up-front schema validation for TaskPacket inputs to execute_with_model.
 * Purpose: give the orchestrator a clean "missing field X" error instead of the
 * downstream "Cannot read properties of undefined (reading 'map')" that fires
 * when adapters try to iterate `packet.inputs` or read `packet.budget.maxOutputTokens`.
 * Failure mode observed in real run — see PR #21 self-review notes.
 */
function validateTaskPacket(raw: unknown): TaskPacket {
  if (raw == null || typeof raw !== "object") {
    throw new Error("execute_with_model: `packet` argument is missing or not an object.");
  }
  const packet = raw as Record<string, unknown>;
  const required = [
    "id", "phase", "task_type", "module", "instruction",
    "inputs", "outputSchema", "acceptance", "budget", "pass_id",
  ];
  const missing = required.filter((k) => packet[k] === undefined);
  if (missing.length > 0) {
    log("warn", "packet.validate.fail", {
      packet_id: typeof packet.id === "string" ? packet.id : undefined,
      missing_fields: missing.join(","),
    });
    throw new Error(
      `execute_with_model: TaskPacket is missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
      `See plugin/mcp/model-dispatch/src/types.ts for the schema (or plugin/skills/pipeline/SKILL.md for the required-fields table).`,
    );
  }
  if (!isPhase(packet.phase)) {
    log("warn", "packet.validate.fail", { packet_id: packet.id as string, missing_fields: "phase" });
    throw new Error(unknownPhaseMessage("execute_with_model: TaskPacket.phase", packet.phase));
  }
  if (!Array.isArray(packet.inputs)) {
    log("warn", "packet.validate.fail", { packet_id: packet.id as string, missing_fields: "inputs" });
    throw new Error(
      `execute_with_model: TaskPacket.inputs must be a FileSlice[] array — pass [] for packets that read no files. Got: ${typeof packet.inputs}`,
    );
  }
  const budget = packet.budget as { maxOutputTokens?: unknown; maxInputTokens?: unknown } | undefined;
  if (!budget || typeof budget.maxOutputTokens !== "number" || typeof budget.maxInputTokens !== "number") {
    log("warn", "packet.validate.fail", { packet_id: packet.id as string, missing_fields: "budget" });
    throw new Error(
      `execute_with_model: TaskPacket.budget must be { maxInputTokens: number, maxOutputTokens: number }.`,
    );
  }
  return packet as unknown as TaskPacket;
}

function unknownPhaseMessage(field: string, value: unknown): string {
  return (
    `${field} '${String(value)}' is not a phase the bridge routes. Use one of: ${PHASES.join(", ")}. ` +
    "The state-machine step names (execute_packets, test_run, ...) are not phase names."
  );
}

const SERVER_NAME = "model-dispatch";
const SERVER_VERSION = "0.1.0";

// Runtime state: loaded policies cached by name, adapters cached by model id.
const adapterCache = new Map<string, ReturnType<typeof createAdapter>>();
let activePolicy: Policy | null = null;
let activeResolution: ResolvedPolicy | null = null;
let activePolicyKey = "";

/** Slot choices, spelled `slot=option[,slot=option...]`. Property of the install. */
const SELECT_ENV = "MMO_SELECT";
/** MMO-D8 compat shim: pre-rename installs still export this. Warn once, keep working. */
const LEGACY_SELECT_ENV = "SDLC_SELECT";
let legacySelectWarned = false;

function ensurePolicy(policyName?: string, projectRoot?: string, policyPath?: string): Policy {
  const key = `${policyName ?? ""}|${projectRoot ?? ""}|${policyPath ?? ""}`;
  if (activePolicy && activePolicyKey === key) return activePolicy;
  const resolved = resolvePolicy({ policyName, projectRoot, policyPath });
  const policy = resolved.policy;
  // Every policy load goes through here, so a bad slot choice fails at load
  // rather than partway through a paid phase.
  validateSelectOverrides(policy, selectOverrides());
  activePolicy = policy;
  activeResolution = resolved;
  activePolicyKey = key;
  log("info", "policy.load", {
    policy_name: policy.name,
    resolved_path: resolved.path,
    source: resolved.source,
    requested: resolved.requestedName ?? undefined,
    sha256: resolved.sha256,
    version: policy.version,
    model_count: policy.models.length,
    rule_count: policy.rules.length,
  });
  return activePolicy;
}

/** Re-read on every call — a test can set the variable without restarting. */
function selectOverrides(): SelectOverrides {
  const value = process.env[SELECT_ENV] ?? legacySelectValue();
  return parseSelectOverrides(value);
}

function legacySelectValue(): string | undefined {
  const value = process.env[LEGACY_SELECT_ENV];
  if (value === undefined) return undefined;
  if (!legacySelectWarned) {
    legacySelectWarned = true;
    log("warn", "env.legacy_name", { names: LEGACY_SELECT_ENV, canonical: SELECT_ENV });
  }
  return value;
}

function adapterFor(policy: Policy, modelId: string) {
  const cacheHit = adapterCache.has(modelId);
  if (cacheHit) {
    const cached = adapterCache.get(modelId)!;
    log("debug", "adapter.construct", { model_id: modelId, adapter: getModel(policy, modelId).adapter, cache_hit: true });
    return cached;
  }
  const model = getModel(policy, modelId);
  const adapter = createAdapter(model);
  adapterCache.set(modelId, adapter);
  log("debug", "adapter.construct", { model_id: modelId, adapter: model.adapter, cache_hit: false });
  return adapter;
}

/**
 * Construct every adapter the loaded policy names, before the run spends
 * anything. Adapters are otherwise built lazily on first dispatch, where a
 * credential problem would surface after premium-tier phases had already been
 * billed. No API call — construction is where credential discovery happens.
 * Adapters land in the shared cache, so the first real dispatch reuses them.
 *
 * Takes authMode because only models this run actually dispatches to matter:
 * under `estimated` the orchestrator runs its own tier in-session and never
 * constructs `builtin-anthropic`, so an unset ANTHROPIC_API_KEY is inert.
 * Classification lives in preflight.ts.
 */
function preflightDispatch(policy: Policy, authMode: AuthMode) {
  // Losing options of `select:` slots are excluded: their prerequisites
  // (Python venv, worker script) are not this run's problem.
  const notSelected = unreachableModelIds(policy, selectOverrides());
  const reachable = policy.models.filter((m) => !notSelected.has(m.id));
  const assessment = assessModels(reachable, authMode, (modelId) => adapterFor(policy, modelId));
  const pricing = assessPricing(reachable, new Date());
  for (const u of pricing.unpriced) {
    log("warn", "preflight.unpriced", { model_id: u.id, model_name: u.model_name, message: u.reason });
  }

  // Resolved Gemini configuration — the project and region the run will bill.
  const adcPath = defaultAdcPath();
  const adcFileExists = existsSync(adcPath);
  let gemini: Record<string, unknown>;
  try {
    const keyEnvName =
      policy.models.find(
        (m) => m.adapter === "mcp:model-dispatch" || m.adapter === "mcp:gemini-flash-server"
      )?.auth?.env ?? "GEMINI_API_KEY";
    const choice = selectGeminiBackend({ env: process.env, keyEnvName, adcFileExists });
    gemini = {
      backend: choice.backend,
      reason: choice.reason,
      adc_file: adcFileExists ? adcPath : null,
      ...(choice.backend === "vertex-adc"
        ? {
            project: resolveGcpProject(process.env, adcPath),
            location: resolveGcpLocation(process.env),
          }
        : {}),
    };
  } catch (err: any) {
    gemini = { backend: null, error: err?.message ?? String(err), adc_file: adcFileExists ? adcPath : null };
  }

  for (const m of assessment.models) {
    log("info", "preflight.model", {
      model_id: m.id,
      adapter: m.adapter,
      ok: m.ok,
      error_class: m.ok ? undefined : "PreflightFailed",
      classification: m.ok ? undefined : (m.severity ?? "warning"),
    });
  }
  for (const id of notSelected) {
    log("info", "preflight.model", { model_id: id, ok: true, classification: "not_selected" });
  }
  const ok = assessment.ok && pricing.ok;
  const haltReason = [assessment.halt_reason, pricing.halt_reason].filter(Boolean).join(" ") || null;
  log("info", "preflight.result", {
    ok,
    halt_reason: haltReason,
    warnings_n: assessment.warnings.length,
    backend: (gemini as any).backend,
    project: (gemini as any).project,
    location: (gemini as any).location,
  });

  return {
    ok,
    auth_mode: authMode,
    policy: {
      name: policy.name,
      version: policy.version,
      source: activeResolution?.source,
      path: activeResolution?.path,
    },
    models: assessment.models,
    priced_on: pricing.priced_on,
    unpriced: pricing.unpriced,
    price_warnings: pricing.price_warnings,
    // Named so "you did not select it" stays distinguishable from
    // "pre-flight forgot about it".
    not_selected: [...notSelected],
    gemini,
    halt_reason: haltReason,
    // Failures on models this run will not dispatch to — informational,
    // never blocking.
    warnings: assessment.warnings,
  };
}

/** The Vertex regional surcharge, per leaf, for the endpoint this environment dispatches to. */
function endpointRates(): (model: ModelConfig, rates: RateCard) => RateCard {
  const adcFileExists = existsSync(defaultAdcPath());
  const endpoints = new Map<string, ReturnType<typeof dispatchEndpoint>>();
  return (model, rates) => {
    if (!endpoints.has(model.id)) endpoints.set(model.id, dispatchEndpoint(model, process.env, adcFileExists));
    const endpoint = endpoints.get(model.id);
    return endpoint ? applyVertexSurcharge(rates, { ...endpoint, modelName: model.model_name }) : rates;
  };
}

/** The abandoned attempt's prompt estimate, at the dated price and endpoint it would have billed. */
function placeholderPricer(model: ModelConfig): PlaceholderPricer {
  return (inputTokens) => {
    const priced = effectivePricing(model, new Date(), { requestInputTokens: inputTokens, estimated: true });
    if (priced.unpriced) return { cost_usd: 0 };
    const card = endpointRates()(model, priced.pricing);
    return { cost_usd: computeCostUsd({ input: inputTokens, input_cached: 0, output: 0 }, card), ...priceFields(priced) };
  };
}

// Dispatches still running. The client can stop waiting (a cancelled call,
// stdin closed by dispatch.mjs, then SIGTERM two seconds later), and each of
// these records what it can and stops its adapter before the process goes.
const inFlight = new Set<(reason: string) => void>();

function abandonInFlight(reason: string): void {
  for (const abandon of [...inFlight]) abandon(reason);
}

process.stdin.once("end", () => abandonInFlight("the client closed the connection"));
for (const [signal, signo] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]] as const) {
  process.once(signal, () => {
    abandonInFlight(`the server received ${signal}`);
    process.exit(128 + signo);
  });
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_with_model",
      description:
        "Execute a TaskPacket. Routes to the model chosen by the policy. " +
        "Returns structured result + tokens + cost_usd + latency.",
      inputSchema: {
        type: "object",
        properties: {
          packet: { type: "object", description: "TaskPacket (see types.ts)" },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
          work_dir: {
            type: "string",
            description:
              "Directory a delegated agent worker may read, edit and run commands in — " +
              "normally the run's code_dir. Ignored by models that are called as models; " +
              "required by policy leaves that delegate to an agent (adapter: " +
              "antigravity-worker), which have no way to act without one. Defaults to " +
              "project_root.",
          },
          cache_context: { type: "string", description: "Key for explicit context cache (e.g. 'pass2:workforce-ops')" },
          telemetry_path: { type: "string", description: "JSONL file to append telemetry to" },
          log_level: {
            type: "string",
            enum: ["error", "warn", "info", "debug", "trace"],
            description: "Per-call MMO: log verbosity override — the only way a --verbose on one run reaches a server process that started when the session did.",
          },
          verbose: { type: "boolean", description: "Shorthand for log_level: debug." },
        },
        required: ["packet"],
      },
    },
    {
      name: "simulate_policy",
      description:
        "What-if: given a list of telemetry events from a real run, recompute total cost under a different policy. No LLM calls. " +
        "Each event is priced from the dated price list on the UTC day of its `ts` (today when absent), at the endpoint this " +
        "environment dispatches to; events nothing prices are listed in `unpriced` and left out of the total.",
      inputSchema: {
        type: "object",
        properties: {
          events: { type: "array" },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
        required: ["events"],
      },
    },
    {
      name: "log_telemetry",
      description:
        "Append a telemetry event to the pass JSONL log. Given policy_name, policy_path or project_root, the event's " +
        "routing names the policy those resolve to, the one execute_with_model would route by.",
      inputSchema: {
        type: "object",
        properties: {
          telemetry_path: { type: "string" },
          event: { type: "object" },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
        required: ["telemetry_path", "event"],
      },
    },
    {
      name: "preflight_dispatch",
      description:
        "Prove every model this run will dispatch to can be reached, BEFORE the run spends " +
        "anything. Constructs each adapter (where credential discovery happens and fails) and " +
        "reports the resolved Gemini backend, project and region. Makes no API call and costs " +
        "nothing. Call this once at the start of every run and halt on ok:false — otherwise a " +
        "credential problem only surfaces at the first mechanical packet, after the premium " +
        "phases are billed. Requires auth_mode: under 'vendor' every model is dispatched through " +
        "this server and so every adapter must work, while under 'estimated' the orchestrator's " +
        "own tier runs in-session and its adapter is never constructed — failures there are " +
        "reported in `warnings` and do not halt.",
      inputSchema: {
        type: "object",
        properties: {
          auth_mode: {
            type: "string",
            enum: ["vendor", "estimated"],
            description: "The run's auth mode. Decides which models are actually dispatched here.",
          },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
          log_level: {
            type: "string",
            enum: ["error", "warn", "info", "debug", "trace"],
            description: "Per-call MMO: log verbosity override.",
          },
          verbose: { type: "boolean", description: "Shorthand for log_level: debug." },
        },
        required: ["auth_mode"],
      },
    },
    {
      name: "load_policy",
      description: "Return the policy that would be active for the given args (debug).",
      inputSchema: {
        type: "object",
        properties: {
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  const a0 = args as any;

  // Per-call override outranks every env var — the only way a --verbose on
  // one run reaches a server process that started when the session did.
  if (a0?.log_level) setLevel(a0.log_level as Level);
  else if (a0?.verbose) setLevel("debug");

  if (a0?.telemetry_path) configureSinks({ telemetryPath: a0.telemetry_path });
  else if (a0?.project_root) configureSinks({ projectRoot: a0.project_root });

  const toolStarted = Date.now();
  let toolCallErrorClass: string | undefined;
  log("debug", "tool.call.start", { tool: name, arg_keys: Object.keys(a0 ?? {}).join(",") });

  try {
    switch (name) {
      case "execute_with_model": {
        const a = args as any;
        const packet = validateTaskPacket(a.packet);
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        const decision = pickModel(
          {
            phase: packet.phase,
            task_type: packet.task_type,
            module: packet.module,
            retry_count: packet.retry_count ?? 0,
            intent: packet.intent,
          },
          policy,
          selectOverrides()
        );
        log("info", "route.decide", {
          packet_id: packet.id,
          phase: packet.phase,
          intent: packet.intent,
          task_type: packet.task_type,
          module: packet.module,
          rule_index: decision.ruleIndex,
          rule_reason: decision.reason,
          model_id: decision.modelId,
          select_slot: decision.selection?.slot,
          select_chosen: decision.selection?.chosen,
          select_overridden: decision.selection?.overridden,
        });

        const warnDriver = (spend: RecordedSpend | null | undefined) => {
          const w = spend ? driverCapWarning(spend) : null;
          if (w) log("warn", w.event, { packet_id: packet.id, reason: w.reason });
        };
        try {
          warnDriver(assertUnderCostCap(policy, a.telemetry_path, { env: process.env }));
        } catch (err) {
          if (err instanceof CostCapExceededError) {
            warnDriver(err.spend);
            log("warn", "cost_cap.refused", {
              packet_id: packet.id,
              recorded_usd: err.recordedUsd,
              dispatched_usd: err.dispatchedUsd,
              driver_usd: err.driverUsd,
              driver_source: err.driverSource,
              cap_usd: err.capUsd,
              policy_name: err.policyName,
            });
          }
          throw err;
        }

        const adapter = adapterFor(policy, decision.modelId);
        const dispatchStarted = Date.now();
        log("info", "dispatch.start", {
          packet_id: packet.id,
          model_id: decision.modelId,
          max_out: packet.budget?.maxOutputTokens,
          max_in: packet.budget?.maxInputTokens,
          cache_context: a.cache_context,
          work_dir: a.work_dir ?? a.project_root,
        });
        if (!a.telemetry_path) {
          // Not refused: a hand-run MCP call may have no run. Its spend reaches no report and no cost cap.
          log("warn", "telemetry.missing", { packet_id: packet.id, model_id: decision.modelId });
        }
        const model = getModel(policy, decision.modelId);
        const recorder = new DispatchRecorder(
          {
            packet,
            decision,
            policy,
            modelName: model.model_name,
            adapterProvenance: adapter.costProvenance,
          },
          a.telemetry_path,
          dispatchStarted,
          placeholderPricer(model),
        );
        const stop = new AbortController();
        const abandon = (reason: string) => {
          inFlight.delete(abandon);
          const ev = recorder.abandon(reason);
          if (ev) {
            log("warn", "dispatch.abandoned", {
              packet_id: packet.id,
              model_id: decision.modelId,
              reason,
              attempt_number: ev.attempt_number,
              booked_usd: ev.cost_usd,
            });
          }
          stop.abort();
        };
        const onCancel = () => abandon("the client cancelled the call");
        inFlight.add(abandon);
        extra.signal.addEventListener("abort", onCancel, { once: true });

        let result: ExecutionResult;
        try {
          // Passed on every dispatch; completion adapters ignore the paths.
          result = await adapter.execute(packet, a.cache_context, {
            project_root: a.project_root,
            work_dir: a.work_dir ?? a.project_root,
            telemetry_path: a.telemetry_path,
            onAttempt: (att) => recorder.record(att),
            signal: stop.signal,
          });
        } finally {
          inFlight.delete(abandon);
          extra.signal.removeEventListener("abort", onCancel);
        }
        for (const att of result.attempts ?? []) {
          log("debug", "dispatch.attempt", {
            packet_id: packet.id,
            attempt_number: att.attempt_number,
            ceiling_used: att.ceiling_used,
            hit_output_cap: att.hit_output_cap,
            stop_reason: att.stop_reason,
          });
        }
        if (result.success) {
          log("info", "dispatch.end", {
            packet_id: packet.id,
            model_id: decision.modelId,
            ok: true,
            terminal_reason: result.terminal_reason,
            tokens_in: result.tokens.input,
            tokens_out: result.tokens.output,
            tokens_cached: result.tokens.input_cached,
            cost_usd: result.cost_usd,
            latency_ms: Date.now() - dispatchStarted,
            attempts: result.attempts?.length ?? 1,
          });
        } else {
          log("error", "dispatch.error", {
            packet_id: packet.id,
            model_id: decision.modelId,
            error_class: "DispatchFailed",
            message: result.error,
          });
        }

        recorder.finish(result);
        const events = recorder.events;
        if (a.telemetry_path) {
          log("debug", "telemetry.append", { telemetry_path: a.telemetry_path, events_written: events.length });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { decision, result, events, terminal_reason: result.terminal_reason },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "simulate_policy": {
        const a = args as any;
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        // Replay against the same slot choices the real run uses, at the
        // endpoints this environment would dispatch to.
        const out = simulatePolicyCost(a.events, policy, selectOverrides(), { billedRates: endpointRates() });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "log_telemetry": {
        const a = args as any;
        if (!isPhase(a.event?.phase)) throw new Error(unknownPhaseMessage("log_telemetry: event.phase", a.event?.phase));
        // Direct-tier caller is a model with no clock — normalize overwrites
        // its `ts` and nulls `latency_ms`.
        let event = normalizeDirectTierEvent(a.event as TelemetryEvent);
        if (a.policy_name !== undefined || a.policy_path !== undefined || a.project_root !== undefined) {
          const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
          event = { ...event, routing: { ...event.routing, policy_name: policy.name, policy_version: policy.version } };
        }
        appendEvent(a.telemetry_path, event);
        log("debug", "telemetry.append", { telemetry_path: a.telemetry_path, events_written: 1 });
        return { content: [{ type: "text", text: "ok" }] };
      }
      case "preflight_dispatch": {
        const a = args as any;
        // Parse before the policy loads so a missing mode fails on the mode.
        const authMode = parseAuthMode(a.auth_mode);
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        const out = preflightDispatch(policy, authMode);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "load_policy": {
        const a = args as any;
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        return { content: [{ type: "text", text: JSON.stringify(withEffectivePrices(policy, new Date()), null, 2) }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    toolCallErrorClass = err?.name ?? "Error";
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  } finally {
    log("debug", "tool.call.end", {
      tool: name,
      duration_ms: Date.now() - toolStarted,
      ok: toolCallErrorClass === undefined,
      error_class: toolCallErrorClass,
    });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
