/**
 * The telemetry events one execute_with_model dispatch writes: one per
 * attempt, all sharing the packet's task_id. Pure, so tests can pin the
 * event shape without starting the stdio server.
 */

import type {
  AttemptRecord,
  CostProvenance,
  ExecutionResult,
  Policy,
  RoutingDecision,
  TaskPacket,
  TelemetryEvent,
} from "./types.js";

export interface DispatchIdentity {
  packet: TaskPacket;
  decision: RoutingDecision;
  policy: Pick<Policy, "name" | "version">;
  modelName: string;
  /** The adapter's usual source (codex-cli declares `modeled`); unset means `vendor`. */
  adapterProvenance?: CostProvenance;
}

/**
 * An attempt's own label wins. A result-level label applies only when no
 * attempt carries one, for adapters that label the whole result.
 */
export function attemptProvenance(
  att: AttemptRecord,
  id: Pick<DispatchIdentity, "adapterProvenance">,
  result?: Pick<ExecutionResult, "cost_provenance" | "attempts">,
): CostProvenance {
  if (att.cost_provenance) return att.cost_provenance;
  const anyLabelled = (result?.attempts ?? []).some((a) => a.cost_provenance);
  return (anyLabelled ? undefined : result?.cost_provenance) ?? id.adapterProvenance ?? "vendor";
}

export function attemptEvent(
  id: DispatchIdentity,
  att: AttemptRecord,
  opts: { ts: string; result?: Pick<ExecutionResult, "cost_provenance" | "attempts"> },
): TelemetryEvent {
  const { packet, decision, policy } = id;
  return {
    ts: opts.ts,
    pass: packet.pass_id,
    phase: packet.phase,
    task_type: packet.task_type,
    task_id: packet.id,
    module: packet.module,
    model: id.modelName,
    provenance: attemptProvenance(att, id, opts.result),
    routed_by: "orchestrator",
    // Leaf id; the only field that tells two leaves sharing a vendor model name apart.
    model_id: decision.modelId,
    routing: {
      policy_name: policy.name,
      policy_version: policy.version,
      rule_index: decision.ruleIndex,
      rule_reason: decision.reason,
      select: decision.selection,
    },
    retry_count: packet.retry_count ?? 0,
    input_tokens: att.tokens.input,
    input_tokens_cached: att.tokens.input_cached,
    output_tokens: att.tokens.output,
    // Already inside output_tokens; reported, never billed twice.
    output_tokens_reasoning: att.tokens.output_reasoning,
    cost_usd: att.cost_usd,
    latency_ms: att.latency_ms,
    success: att.success,
    attempt_number: att.attempt_number,
    ceiling_used: att.ceiling_used,
    retry_reason: att.retry_reason ?? (att.attempt_number > 1 ? "output_cap" : undefined),
    error: att.error,
    price_basis: att.price_basis,
    price_tier: att.price_tier,
    price_verified: att.price_verified,
    prompt_tokens: att.prompt_tokens,
    usage_complete: att.usage_complete,
    error_status: att.error_status,
    error_code: att.error_code,
    codex_thread_id: att.codex_thread_id,
    adapter_provenance: id.adapterProvenance && id.adapterProvenance !== "vendor" ? id.adapterProvenance : undefined,
  };
}

/** A result with no attempts[] stands for one attempt carrying the result's own figures. */
export function resultAttempts(result: ExecutionResult, ceiling: number): AttemptRecord[] {
  if (result.attempts?.length) return result.attempts;
  return [
    {
      attempt_number: 1,
      ceiling_used: ceiling,
      hit_output_cap: false,
      tokens: result.tokens,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      success: result.success,
      error: result.error,
      ...(result.cost_provenance ? { cost_provenance: result.cost_provenance } : {}),
    },
  ];
}

export function attemptEvents(
  id: DispatchIdentity,
  result: ExecutionResult,
  ts: string,
): TelemetryEvent[] {
  return resultAttempts(result, id.packet.budget.maxOutputTokens).map((att) =>
    attemptEvent(id, att, { ts, result }),
  );
}
