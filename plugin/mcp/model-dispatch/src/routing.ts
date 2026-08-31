/**
 * Pure routing: given a task context and a policy, return the model decision.
 *
 * A rule may name a logical slot from `policy.select` instead of a concrete
 * model id; `pickModel` resolves it against the run's chosen options at
 * dispatch time. The resolved `modelId` is always concrete — adapters,
 * pricing, and telemetry never see a slot name.
 */

import type {
  Policy,
  Rule,
  RoutingDecision,
  RuleMatcher,
  SelectOverrides,
} from "./types.js";

export interface TaskContext {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
  /** Brownfield only. Undefined on greenfield packets — never matched against a rule that omits it. */
  intent?: string;
}

/**
 * Parse `slot=option[,slot=option...]`. Empty/whitespace → no choices.
 * (An unset variable and one set to "" must behave identically.)
 */
export function parseSelectOverrides(spec: string | undefined): SelectOverrides {
  const out: SelectOverrides = {};
  if (!spec || !spec.trim()) return out;
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      throw new Error(
        `Invalid select spec '${piece}'. Expected 'slot=option', ` +
          `comma-separated for more than one (e.g. 'gemini-flash=flash-agsdk-worker').`
      );
    }
    out[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Check slot choices against the policy at load, before the run starts.
 * Without this, a bad choice would first throw from `pickModel` partway
 * through a paid phase.
 */
export function validateSelectOverrides(policy: Policy, overrides: SelectOverrides): void {
  for (const [slot, chosen] of Object.entries(overrides)) {
    const declared = policy.select?.[slot];
    if (!declared) {
      const known = Object.keys(policy.select ?? {});
      throw new Error(
        `select '${slot}': policy '${policy.name}' has no such slot. ` +
          (known.length ? `Known slots: ${known.join(", ")}` : "This policy declares no slots.")
      );
    }
    if (!declared.options.includes(chosen)) {
      throw new Error(
        `select ${slot}=${chosen}: '${chosen}' is not one of that slot's options ` +
          `(${declared.options.join(", ")}). The options are the vetted set — ` +
          `add it to the policy first.`
      );
    }
  }
}

/**
 * Turn a rule's `use` target into a concrete model id. Model ids pass through
 * unchanged (with no selection trace), so unslotted policies resolve exactly
 * as before slots existed.
 */
export function resolveNamed(
  policy: Policy,
  named: string,
  overrides: SelectOverrides = {}
): { modelId: string; selection?: RoutingDecision["selection"] } {
  const slot = policy.select?.[named];
  if (!slot) return { modelId: named };

  const override = overrides[named];
  if (override !== undefined && !slot.options.includes(override)) {
    // Reachable only when the caller skipped validateSelectOverrides.
    // Refuse rather than fall back — numbers would be labelled wrong.
    throw new Error(
      `select ${named}=${override}: not one of that slot's options (${slot.options.join(", ")})`
    );
  }

  const chosen = override ?? slot.default;
  return {
    modelId: chosen,
    selection: { slot: named, chosen, overridden: override !== undefined },
  };
}

/**
 * Model ids this run has ruled out by choosing a different option in their
 * slot. Narrow on purpose: an option only counts as unreachable if it lost
 * its slot's selection AND no rule names it directly. Unslotted policies
 * return the empty set.
 */
export function unreachableModelIds(
  policy: Policy,
  overrides: SelectOverrides = {}
): Set<string> {
  const unreachable = new Set<string>();
  if (!policy.select) return unreachable;

  for (const [name, slot] of Object.entries(policy.select)) {
    const { modelId: chosen } = resolveNamed(policy, name, overrides);
    for (const option of slot.options) {
      if (option !== chosen) unreachable.add(option);
    }
  }

  // An id a rule names directly is reachable, and an id one slot chose is
  // reachable even if another slot rejected it.
  for (const rule of policy.rules) {
    const named = "use" in rule ? rule.use : rule.default;
    if (policy.select?.[named]) {
      unreachable.delete(resolveNamed(policy, named, overrides).modelId);
    } else {
      unreachable.delete(named);
    }
  }

  return unreachable;
}

export function pickModel(
  ctx: TaskContext,
  policy: Policy,
  overrides: SelectOverrides = {}
): RoutingDecision {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) continue; // defaults handled last
    if (matches(rule.when, ctx)) {
      const resolved = resolveNamed(policy, rule.use, overrides);
      return {
        modelId: resolved.modelId,
        reason: rule.reason ?? `matched rule ${i} (${describeMatcher(rule.when)})`,
        ruleIndex: i,
        ...(resolved.selection ? { selection: resolved.selection } : {}),
      };
    }
  }
  // Fall through to default
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) {
      const resolved = resolveNamed(policy, rule.default, overrides);
      return {
        modelId: resolved.modelId,
        reason: rule.reason ?? "fell through to policy default",
        ruleIndex: -1,
        ...(resolved.selection ? { selection: resolved.selection } : {}),
      };
    }
  }
  throw new Error(
    `Policy '${policy.name}' has no rule matching ${JSON.stringify(ctx)} and no default rule.`
  );
}

function matches(matcher: RuleMatcher, ctx: TaskContext): boolean {
  if (matcher.phase !== undefined && !inSet(matcher.phase, ctx.phase)) return false;
  if (matcher.task_type !== undefined && !inSet(matcher.task_type, ctx.task_type)) return false;
  if (matcher.module !== undefined && !inSet(matcher.module, ctx.module)) return false;
  // A rule scoped to an intent never matches a packet with no intent (greenfield).
  if (matcher.intent !== undefined && (ctx.intent === undefined || !inSet(matcher.intent, ctx.intent))) return false;
  if (matcher.retry_count !== undefined) {
    const r = ctx.retry_count;
    const m = matcher.retry_count;
    if (m.lt !== undefined && !(r < m.lt)) return false;
    if (m.lte !== undefined && !(r <= m.lte)) return false;
    if (m.gt !== undefined && !(r > m.gt)) return false;
    if (m.gte !== undefined && !(r >= m.gte)) return false;
    if (m.eq !== undefined && !(r === m.eq)) return false;
  }
  return true;
}

function inSet(set: string | string[], value: string): boolean {
  return Array.isArray(set) ? set.includes(value) : set === value;
}

function describeMatcher(m: RuleMatcher): string {
  const parts: string[] = [];
  for (const k of ["phase", "task_type", "module", "intent"] as const) {
    if (m[k] !== undefined) parts.push(`${k}=${JSON.stringify(m[k])}`);
  }
  if (m.retry_count) parts.push(`retry_count=${JSON.stringify(m.retry_count)}`);
  return parts.join(", ") || "wildcard";
}

/** What-if replay: recompute cost of a real run's events under another policy. */
export interface ReplayEvent {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
  input_tokens: number;
  input_tokens_cached: number;
  output_tokens: number;
}

export function simulatePolicyCost(
  events: ReplayEvent[],
  policy: Policy,
  // Defaulting to no overrides prices the policy's defaults — the right
  // answer when the caller has not said otherwise.
  overrides: SelectOverrides = {}
): { total_cost_usd: number; per_model: Record<string, number> } {
  const perModel: Record<string, number> = {};
  let total = 0;
  for (const ev of events) {
    const decision = pickModel(ev, policy, overrides);
    const model = policy.models.find((m) => m.id === decision.modelId);
    if (!model) continue;
    const inputFresh = ev.input_tokens - ev.input_tokens_cached;
    const cost =
      (inputFresh / 1_000_000) * model.pricing.input +
      (ev.input_tokens_cached / 1_000_000) * model.pricing.input_cached +
      (ev.output_tokens / 1_000_000) * model.pricing.output;
    perModel[model.id] = (perModel[model.id] ?? 0) + cost;
    total += cost;
  }
  return { total_cost_usd: total, per_model: perModel };
}
