/**
 * Shared types for the multi-model orchestration layer.
 */

/**
 * The phase names a packet or a logged phase may carry; the bridge refuses
 * any other, because a name no policy rule matches routes to the default
 * tier and gets no row of its own in the report. `discovery` and
 * `change_plan` are brownfield's (change_plan is its delta design).
 */
export const PHASES = [
  "requirements_analysis",
  "architecture_design",
  "plan_task_packets",
  "codegen",
  "tests",
  "docs",
  "debug",
  "senior_code_review",
  "security_review",
  "refactor",
  "final_report",
  "discovery",
  "change_plan",
] as const;

export type Phase = (typeof PHASES)[number];

export function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

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
  /**
   * Where the cost figure on this event actually comes from. `vendor` —
   * real vendor-reported usage from a dispatched call. `estimated` — a
   * direct-tier call priced by the character-count heuristic because no
   * vendor usage was available. `modeled` — token counts priced at the
   * dated price list's rates, not a live vendor bill: the driver's own turns,
   * which never dispatch through this server, and a seat adapter's
   * (codex-cli) dispatches. `none` — no
   * model call was made at all: a phase the intent skipped, or one the
   * conductor completed in-session without dispatching. Its zeros are facts
   * rather than estimates, and its real token cost, where there is any,
   * accrues to the driver loop. Optional because events written before this
   * field existed lack it.
   */
  provenance?: "vendor" | "estimated" | "modeled" | "none";
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
  retry_reason?: RetryReason;
  artifact_path?: string;
  error?: string;
  /** `list` (the dated price list) or `custom` (the policy block under pricing_override). */
  price_basis?: PriceBasis;
  /** `unverified`: a tiered model whose card no vendor-reported per-request count proves (summed or estimated usage). */
  price_tier?: PriceTierLabel;
  /** The verified date of the list entry that priced this event; null for a custom price. */
  price_verified?: string | null;
  /** One request's whole prompt, cached tokens included. Set only where one event is one request. */
  prompt_tokens?: number;
  /** `false`: the tokens are a lower bound, because the call's real usage never arrived. */
  usage_complete?: false;
  /** The HTTP status a vendor answered a failed call with. */
  error_status?: number;
  /** The Node/undici code of a failed connection (ECONNRESET, ENOTFOUND, ...). */
  error_code?: string;
  /** The nested `codex exec` thread a codex-cli dispatch ran in. */
  codex_thread_id?: string;
  /**
   * The adapter's usual source, set only when it is not `vendor`. `modeled`
   * marks a seat adapter (codex-cli): its `estimated` rows are seat floors,
   * not metered spend.
   */
  adapter_provenance?: CostProvenance;
}

export type CostProvenance = "vendor" | "estimated" | "modeled";

/** `transient`: the previous attempt failed with no answer, a 408, 409, 429 or 5xx, and the same request was sent again. */
export type RetryReason = "output_cap" | "transient" | "validation" | "escalation";

export type PriceBasis = "list" | "custom";
export type PriceTierLabel = "standard" | "long_context" | "unverified";

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
  price_basis?: PriceBasis;
  price_tier?: PriceTierLabel;
  price_verified?: string | null;
  prompt_tokens?: number;
  /** Where this attempt's cost came from; unset means the adapter's usual source. */
  cost_provenance?: CostProvenance;
  usage_complete?: false;
  error_status?: number;
  error_code?: string;
  /** From a google.rpc.RetryInfo in the vendor's error body. */
  retry_after_ms?: number;
  codex_thread_id?: string;
  /** Why this attempt was made; unset on a later attempt means an output-cap doubling. */
  retry_reason?: RetryReason;
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
  /** Documentation unless `pricing_override` is true; the dated list in prices.ts is the price. */
  pricing?: ModelPricing;
  /** Bill `pricing` instead of the dated list, reported as a custom price. Needs a block. */
  pricing_override?: boolean;
  pricing_source?: string;
  pricing_last_verified?: string;
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
   * Deadline for one dispatch: an agent-worker delegation, a codex-cli call,
   * or a completion adapter's whole output-cap doubling chain. It has to stay
   * below the driver client's per-call timeout (driverClient.ts).
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
  /**
   * Called with each attempt as soon as it returns, so a dispatch the client
   * stops waiting for still has its finished, billed attempts on record.
   */
  onAttempt?: (attempt: AttemptRecord) => void;
  /** Aborted when the client stops waiting: adapters stop their requests and kill their children. */
  signal?: AbortSignal;
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
  /** Absent means no cap. Enforced per run against `telemetry_path` — see costCap.ts. */
  hard_cost_cap_usd?: number;
  /**
   * The conductor's pin: the model `codex exec` runs as. Never dispatched
   * through the bridge, so it is not a `models[]` entry (preflight would
   * otherwise demand its credential). The bridge validates it and ignores it.
   */
  driver?: DriverPin;
}

export interface DriverPin {
  model_name: string;
  reasoning: { effort: string };
  /** Documentation unless `pricing_override` is true; the conductor is priced from the dated list in prices.ts. */
  pricing?: ModelPricing;
  /** Bill `pricing` instead of the dated list, reported as a custom price. Needs a block. */
  pricing_override?: boolean;
  pricing_source?: string;
  pricing_last_verified?: string;
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
  /**
   * Summary for readers of the MCP result: `estimated` when any attempt was.
   * Telemetry is stamped from each attempt's own `cost_provenance`, and falls
   * back to this only when no attempt carries one.
   */
  cost_provenance?: CostProvenance;
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
