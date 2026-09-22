/**
 * Pre-flight reachability assessment for the models a policy names.
 *
 * Which models this server actually dispatches to depends on the run's auth
 * mode. Under `vendor` every call goes through this server, so every adapter
 * must work. Under `estimated` the orchestrator's own tier runs inside Claude
 * Code on the user's subscription — its adapter is never constructed, so
 * failures there are informational, not blocking.
 *
 * Split from server.ts because server.ts opens a stdio transport as a
 * top-level side effect and hangs a test runner on import. `makeAdapter` is
 * injected so the decision table is testable without any credentials.
 */

/**
 * Adapter the orchestrator runs in-session under `estimated` rather than
 * dispatching. Keyed by adapter name (a transport concept), not by tier.
 * `claude-cli` is Anthropic but NOT in-session — it always spawns a
 * subprocess, so its reachability must be checked under both auth modes.
 */
export const IN_SESSION_ADAPTER = "builtin-anthropic";

export type AuthMode = "vendor" | "estimated";

export interface PreflightModel {
  id: string;
  model_name: string;
  adapter: string;
}

export interface PreflightModelResult extends PreflightModel {
  /** Whether this run will actually dispatch to this model through this server. */
  required: boolean;
  ok: boolean;
  error?: string;
  /** Present only on failures: "blocking" halts the run, "warning" does not. */
  severity?: "blocking" | "warning";
}

export interface PreflightAssessment {
  models: PreflightModelResult[];
  ok: boolean;
  halt_reason: string | null;
  warnings: string[];
}

/**
 * Validate the run's auth mode. Throws rather than defaulting: `vendor` as
 * default reinstates the false halt this module exists to remove, and
 * `estimated` as default waves through a vendor run that then dies at the
 * first dispatch. The error text matches orchestrator.md rule 6.
 */
export function parseAuthMode(value: unknown): AuthMode {
  if (value === "vendor" || value === "estimated") return value;
  throw new Error(
    "this run requires auth_mode=vendor|estimated. Pre-flight cannot tell which models " +
      "will be dispatched through this server without it: under 'vendor' every model is, " +
      "under 'estimated' the orchestrator's own tier runs in-session and its adapter is " +
      "never constructed.",
  );
}

/** Under `vendor`, yes for everything. Under `estimated`, only for non-in-session models. */
export function requiresServerDispatch(adapter: string, authMode: AuthMode): boolean {
  if (authMode === "vendor") return true;
  return adapter !== IN_SESSION_ADAPTER;
}

/**
 * Construct an adapter for every model and classify what fails. `makeAdapter`
 * is called for required and non-required models alike: warming the cache for
 * a non-required one is cheap and its failure is worth reporting.
 */
export function assessModels(
  models: PreflightModel[],
  authMode: AuthMode,
  makeAdapter: (modelId: string) => unknown,
): PreflightAssessment {
  const results: PreflightModelResult[] = models.map((m) => {
    const required = requiresServerDispatch(m.adapter, authMode);
    try {
      makeAdapter(m.id);
      return { id: m.id, model_name: m.model_name, adapter: m.adapter, required, ok: true };
    } catch (err: any) {
      return {
        id: m.id,
        model_name: m.model_name,
        adapter: m.adapter,
        required,
        ok: false,
        error: err?.message ?? String(err),
        severity: required ? "blocking" : "warning",
      };
    }
  });

  const blocking = results.filter((m) => !m.ok && m.required);
  const nonBlocking = results.filter((m) => !m.ok && !m.required);

  const halt_reason =
    blocking.length === 0
      ? null
      : `Cannot dispatch to ${blocking.length} of ${results.length} models in this policy: ` +
        blocking.map((f) => `${f.id} (${f.error})`).join("; ") +
        ". Do not start the run — every packet routed to these models would fall back to the " +
        "premium tier, producing a run that costs more than a single-model baseline. Fix " +
        "credentials first, then re-run this check.";

  const warnings = nonBlocking.map(
    (f) =>
      `${f.id} could not be constructed (${f.error}), but this run does not dispatch to it: ` +
      `auth_mode=${authMode} runs '${f.adapter}' work inside the Claude Code session instead of ` +
      `through this server. Not a blocker. It would block a vendor-mode run of the same policy.`,
  );

  return { models: results, ok: blocking.length === 0, halt_reason, warnings };
}
