/**
 * Shared types for the multi-model orchestration layer.
 */

export type Phase =
  | "requirements_analysis"
  | "architecture_design"
  | "plan_task_packets"
  | "codegen"
  | "tests"
  | "docs"
  | "debug"
  | "senior_code_review"
  | "security_review"
  | "refactor"
  | "final_report"
  // Brownfield additions (v1). Discovery is scoped to Tier 1 repo read;
  // change_plan is the brownfield analog of architecture_design (delta doc
  // rather than full subsystem design). Both routed to premium tier by
  // default — see plugin/config/policies/*.yaml.
  | "discovery"
  | "change_plan";

export interface FileSlice {
  path: string;
  content: string;
  reason: string;
}

export interface TaskPacket {
  id: string;
  phase: Phase;
  task_type: string;
  module: string;
  instruction: string;
  inputs: FileSlice[];
  outputSchema: Record<string, any>;
  acceptance: string[];
  budget: { maxInputTokens: number; maxOutputTokens: number };
  retry_count?: number;
  pass_id: string;
  /**
   * Brownfield only. The repo-relative path this packet will write to.
   * The MCP dispatcher validates this against `.sdlc/baseline/current.json`
   * allowlist before dispatching. Undefined = packet writes nothing
   * (analysis / review packet) or greenfield mode.
   */
  artifact_path?: string;
  /**
   * Brownfield only — the job type confirmed at Gate 0 (plugin/config/intents.json).
   * Undefined on greenfield packets. Lets a policy route the same phase
   * differently per intent (e.g. Tests routes differently for `refactor`
   * than for `docs`) via a rule matching on both `phase` and `intent`.
   */
  intent?: string;
}

export interface TelemetryEvent {
  ts: string;
  pass: string;
  phase: Phase;
  task_type: string;
  task_id: string;
  module: string;
  model: string;
  /**
   * Policy leaf that ran (e.g. `flash-completion`, `flash-agsdk-worker`).
   * Distinguishes two leaves that share a vendor `model` name. Optional
   * because events written before this field existed lack it.
   */
  model_id?: string;
  routed_by: "orchestrator" | "fallback" | "manual";
  routing: {
    policy_name: string;
    policy_version: number;
    rule_index: number;      // -1 = default
    rule_reason: string;
    /**
     * Present only when the matched rule named a slot. `overridden`
     * distinguishes an explicit run choice from an inherited default.
     */
    select?: { slot: string; chosen: string; overridden: boolean };
  };
  input_tokens: number;
  input_tokens_cached: number;
  output_tokens: number;
  /** Thinking/reasoning tokens; already counted in output_tokens. */
  output_tokens_reasoning?: number;
  cost_usd: number;
  /** `null` on the direct tier — no stopwatch ever ran. `0` would mean "instant". */
  latency_ms: number | null;
  success: boolean;
  retry_count: number;
  /** Output-cap doubling attempts share a task_id. attempt_number is 1-indexed. */
  attempt_number?: number;
  ceiling_used?: number;
  retry_reason?: "output_cap" | "validation" | "escalation";
  artifact_path?: string;
  error?: string;
}

/** One attempt from the output-cap doubling loop. */
export interface AttemptRecord {
  attempt_number: number;
  ceiling_used: number;
  stop_reason?: string;
  hit_output_cap: boolean;
  tokens: {
    input: number;
    input_cached: number;
    output: number;
    output_reasoning?: number;
  };
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  error?: string;
}

export interface ModelPricing {
  input: number;          // USD per 1M tokens
  input_cached: number;   // USD per 1M cached tokens
  output: number;         // USD per 1M tokens
}

/**
 * Optional reasoning/thinking controls. Vendors disagree on vocabulary
 * (Gemini uses `thinkingLevel`; OpenAI-compat uses `reasoning_effort`);
 * adapters consume the fields they understand and ignore the rest.
 */
export interface ReasoningConfig {
  tier?: "minimal" | "low" | "medium" | "high";
  effort?: "off" | "low" | "high" | "max";
  enabled?: boolean;
}

export interface ModelConfig {
  id: string;
  adapter: string;
  model_name: string;
  display_name?: string;
  pricing: ModelPricing;
  pricing_source?: string;
  auth?: { env: string };
  endpoint?: string;
  reasoning?: ReasoningConfig;
  /** Vendor's absolute output-tokens limit; doubling loop clamps here. */
  max_output_tokens_absolute?: number;
  /**
   * Vertex region for this leaf. Unset → follows GOOGLE_CLOUD_LOCATION, else
   * `global`. Declared here because non-`global` triggers a +10% surcharge
   * on Gemini 3+, so cost is only reproducible if the region is recorded.
   */
  region?: string;
  /**
   * Deadline for an agent-worker delegation. Read only by adapters that spawn
   * a worker; ignored by completion adapters.
   */
  worker_timeout_sec?: number;
}

/**
 * Where the run is happening, distinct from what it is asking for. Completion
 * adapters ignore this; an agent worker needs a workspace and a place to
 * leave evidence.
 */
export interface RunContext {
  project_root?: string;
  /** Narrower than project_root when confining a worker to generated code. */
  work_dir?: string;
  /** Delegation evidence lands beside this path. */
  telemetry_path?: string;
}

export type RuleMatcher = {
  phase?: string | string[];
  task_type?: string | string[];
  module?: string | string[];
  /** Brownfield only (see plugin/config/intents.json). Undefined on greenfield packets. */
  intent?: string | string[];
  retry_count?: { lt?: number; lte?: number; gt?: number; gte?: number; eq?: number };
};

export type Rule =
  | { when: RuleMatcher; use: string; reason?: string }
  | { default: string; reason?: string };

/**
 * One logical slot a rule may name instead of a concrete leaf. `options`
 * enumerates the vetted answers so a typo fails at policy load rather than
 * as an unknown-model throw partway through a paid phase.
 */
export interface SelectSlot {
  /** Used when the run selects nothing. Must be one of `options`. */
  default: string;
  /** Every leaf this slot may resolve to. Non-empty; each is a real model id. */
  options: string[];
  reason?: string;
}

/** A run's answers to the policy's slots, keyed by slot name. */
export type SelectOverrides = Record<string, string>;

export interface Policy {
  version: number;
  name: string;
  models: ModelConfig[];
  rules: Rule[];
  /** Optional; absent from policies written before slots existed. */
  select?: Record<string, SelectSlot>;
}

export interface RoutingDecision {
  modelId: string;
  reason: string;
  ruleIndex: number;   // -1 if default
  /** Present only when the matched rule named a slot. */
  selection?: { slot: string; chosen: string; overridden: boolean };
}

export interface ExecutionResult {
  result: any;
  tokens: {
    input: number;
    input_cached: number;
    output: number;
    output_reasoning?: number;
  };
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
  success: boolean;
  error?: string;
  /** Populated on doubling loop; length ≥ 1. */
  attempts?: AttemptRecord[];
  /**
   * Why the doubling loop stopped. `_budget_exhausted` means "retries used but
   * model still had headroom" (raise the cap); `_at_model_absolute` means "hit
   * the vendor's ceiling" (packet too big).
   */
  terminal_reason?:
    | "success"
    | "output_cap_doubling_budget_exhausted"
    | "output_cap_at_model_absolute"
    | "vendor_error";
}
