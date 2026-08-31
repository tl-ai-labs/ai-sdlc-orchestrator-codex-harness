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

import { loadPolicy, loadPolicyFromPath, getModel } from "./policy.js";
import {
  pickModel,
  simulatePolicyCost,
  parseSelectOverrides,
  validateSelectOverrides,
  unreachableModelIds,
} from "./routing.js";
import { assessModels, parseAuthMode, type AuthMode } from "./preflight.js";
import { appendEvent, normalizeDirectTierEvent } from "./telemetry.js";
import { createAdapter } from "./adapters/index.js";
import {
  defaultAdcPath,
  selectGeminiBackend,
  resolveGcpProject,
  resolveGcpLocation,
} from "./adapters/geminiTransports.js";
import type { TaskPacket, TelemetryEvent, Policy, SelectOverrides } from "./types.js";
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
      `See plugin/mcp/model-dispatch/src/types.ts for the schema (or plugin/agents/orchestrator.md for the required-fields table).`,
    );
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

const SERVER_NAME = "model-dispatch";
const SERVER_VERSION = "0.1.0";

// Runtime state: loaded policies cached by name, adapters cached by model id.
const adapterCache = new Map<string, ReturnType<typeof createAdapter>>();
let activePolicy: Policy | null = null;
let activePolicyKey = "";

/** Slot choices, spelled `slot=option[,slot=option...]`. Property of the install. */
const SELECT_ENV = "MMO_SELECT";
/** MMO-D8 compat shim: pre-rename installs still export this. Warn once, keep working. */
const LEGACY_SELECT_ENV = "SDLC_SELECT";
let legacySelectWarned = false;

function ensurePolicy(policyName?: string, projectRoot?: string, policyPath?: string): Policy {
  const key = `${policyName ?? "opus-only"}|${projectRoot ?? ""}|${policyPath ?? ""}`;
  if (activePolicy && activePolicyKey === key) return activePolicy;
  const policy = policyPath
    ? loadPolicyFromPath(policyPath)
    : loadPolicy({ policyName, projectRoot });
  // Every policy load goes through here, so a bad slot choice fails at load
  // rather than partway through a paid phase.
  validateSelectOverrides(policy, selectOverrides());
  activePolicy = policy;
  activePolicyKey = key;
  log("info", "policy.load", {
    policy_name: policy.name,
    resolved_path: policyPath,
    source: policyPath ? "path" : "name",
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
  const assessment = assessModels(
    policy.models.filter((m) => !notSelected.has(m.id)),
    authMode,
    (modelId) => adapterFor(policy, modelId),
  );

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
  log("info", "preflight.result", {
    ok: assessment.ok,
    halt_reason: assessment.halt_reason,
    warnings_n: assessment.warnings.length,
    backend: (gemini as any).backend,
    project: (gemini as any).project,
    location: (gemini as any).location,
  });

  return {
    ok: assessment.ok,
    auth_mode: authMode,
    policy: { name: policy.name, version: policy.version },
    models: assessment.models,
    // Named so "you did not select it" stays distinguishable from
    // "pre-flight forgot about it".
    not_selected: [...notSelected],
    gemini,
    halt_reason: assessment.halt_reason,
    // Failures on models this run will not dispatch to — informational,
    // never blocking.
    warnings: assessment.warnings,
  };
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
        "What-if: given a list of telemetry events from a real run, recompute total cost under a different policy. No LLM calls.",
      inputSchema: {
        type: "object",
        properties: {
          events: { type: "array" },
          policy_name: { type: "string" },
          policy_path: { type: "string" },
        },
        required: ["events"],
      },
    },
    {
      name: "log_telemetry",
      description: "Append a telemetry event to the pass JSONL log.",
      inputSchema: {
        type: "object",
        properties: { telemetry_path: { type: "string" }, event: { type: "object" } },
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
        // Passed on every dispatch; completion adapters ignore it.
        const result = await adapter.execute(packet, a.cache_context, {
          project_root: a.project_root,
          work_dir: a.work_dir ?? a.project_root,
          telemetry_path: a.telemetry_path,
        });
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

        // One TelemetryEvent per attempt, all sharing the packet's task_id.
        const attempts = result.attempts ?? [
          {
            attempt_number: 1,
            ceiling_used: packet.budget.maxOutputTokens,
            hit_output_cap: false,
            tokens: result.tokens,
            cost_usd: result.cost_usd,
            latency_ms: result.latency_ms,
            success: result.success,
            error: result.error,
          },
        ];
        const modelName = getModel(policy, decision.modelId).model_name;
        const baseEvent = {
          ts: new Date().toISOString(),
          pass: packet.pass_id,
          phase: packet.phase,
          task_type: packet.task_type,
          task_id: packet.id,
          module: packet.module,
          model: modelName,
          routed_by: "orchestrator" as const,
          // Leaf id; the only field that distinguishes two leaves that share
          // a vendor model name (e.g. flash-completion vs flash-agsdk-worker).
          model_id: decision.modelId,
          routing: {
            policy_name: policy.name,
            policy_version: policy.version,
            rule_index: decision.ruleIndex,
            rule_reason: decision.reason,
            // Undefined unless the rule went through a slot; JSON.stringify
            // drops undefined keys, so unslotted policies produce identical
            // events to before slots existed.
            select: decision.selection,
          },
          retry_count: packet.retry_count ?? 0,
        };
        const events: TelemetryEvent[] = attempts.map((att) => ({
          ...baseEvent,
          input_tokens: att.tokens.input,
          input_tokens_cached: att.tokens.input_cached,
          output_tokens: att.tokens.output,
          // Already counted in output_tokens and billed at the output rate;
          // surfaced only so a reader can see how much of a delegation's
          // output was thinking. Undefined on adapters that don't report it.
          output_tokens_reasoning: att.tokens.output_reasoning,
          cost_usd: att.cost_usd,
          latency_ms: att.latency_ms,
          success: att.success,
          attempt_number: att.attempt_number,
          ceiling_used: att.ceiling_used,
          retry_reason: att.attempt_number > 1 ? "output_cap" : undefined,
          error: att.error,
        }));
        if (a.telemetry_path) {
          for (const ev of events) appendEvent(a.telemetry_path, ev);
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
        const policy = ensurePolicy(a.policy_name, undefined, a.policy_path);
        // Replay against the same slot choices the real run uses.
        const out = simulatePolicyCost(a.events, policy, selectOverrides());
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "log_telemetry": {
        const a = args as any;
        // Direct-tier caller is a model with no clock — normalize overwrites
        // its `ts` and nulls `latency_ms`.
        appendEvent(a.telemetry_path, normalizeDirectTierEvent(a.event as TelemetryEvent));
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
        return { content: [{ type: "text", text: JSON.stringify(policy, null, 2) }] };
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
