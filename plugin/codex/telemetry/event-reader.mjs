/**
 * Telemetry event reader for `codex exec --json` output.
 *
 * Two verified facts drive this module's shape
 * (docs/verification/p1-codex-runtime.md, checks 5 and 9):
 *
 *   1. No event in the stream carries a timestamp. This reader stamps its
 *      own arrival time on every normalized event, the same way
 *      `normalizeDirectTierEvent` does for the direct tier in the bridge.
 *   2. Every executed shell command arrives wrapped as `/bin/bash -lc '…'`
 *      on this platform (Linux/WSL2) — the port track document's inherited
 *      finding named `/bin/zsh -lc '…'` from a macOS probe machine. Both
 *      wrappers are unwrapped here; which one a given machine actually uses
 *      is exactly the kind of thing Document B section 2 asks each
 *      contributor's platform to confirm for itself, not assume.
 *
 * Consumes the raw JSONL text `codex exec --json` writes to stdout. Produces
 * two things a driver script needs: a normalized trajectory (for the human-
 * readable run log) and, separately, one TelemetryEvent per turn with
 * `provenance: "modeled"` carrying the driver's own token cost — the
 * conductor never dispatches through `execute_with_model` (D1), so its cost
 * never appears in the bridge's own telemetry unless this reader adds it.
 */

import { computeCostUsd } from "../../mcp/model-dispatch/dist/pricing.js";

const SHELL_WRAP_RE = /^\/bin\/(?:ba|z)sh\s+-lc\s+(['"])([\s\S]*)\1$/;

/**
 * Strip a `/bin/bash -lc '…'` or `/bin/zsh -lc '…'` wrapper, returning the
 * inner command. A command that isn't wrapped (already bare) is returned
 * unchanged — this is a defensive unwrap, not a required transform.
 */
export function unwrapShellCommand(command) {
  if (typeof command !== "string") return command;
  const m = SHELL_WRAP_RE.exec(command);
  return m ? m[2] : command;
}

/**
 * Parse `codex exec --json`'s JSONL text into an array of normalized
 * events. Each event carries `ts` (this reader's own clock, not codex's —
 * codex supplies none) and, for `command_execution` items, an
 * `unwrapped_command` field alongside the original.
 *
 * Malformed lines are skipped, not thrown on — a driver script reading a
 * live process's stdout should not crash the whole run over one truncated
 * line at a stream boundary.
 */
export function parseEventStream(jsonlText, now = () => new Date().toISOString()) {
  const events = [];
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ts = now();
    const event = { ts, ...raw };
    if (raw.item?.type === "command_execution" && typeof raw.item.command === "string") {
      event.item = { ...raw.item, unwrapped_command: unwrapShellCommand(raw.item.command) };
    }
    events.push(event);
  }
  return events;
}

/**
 * Every `turn.completed` event's `usage` block, in stream order. `codex
 * exec --json` never echoes back which model or effort actually answered
 * (P1 check 7's caveat) — usage is keyed by turn index here, not by model,
 * because the pin is asserted separately (see fairnessPin.mjs), not read
 * back from this stream.
 */
export function extractTurnUsage(events) {
  const usages = [];
  let turnIndex = 0;
  for (const ev of events) {
    if (ev.type === "turn.started") turnIndex++;
    if (ev.type === "turn.completed" && ev.usage) {
      usages.push({ turn_index: turnIndex, usage: ev.usage });
    }
  }
  return usages;
}

/**
 * Build one `provenance: "modeled"` TelemetryEvent per turn from the parsed
 * stream's usage data, priced at the given pricing block — pass the same
 * `pricing` object the official policy's `gpt` model config carries
 * (plugin/config/policies/gpt-plus-flash.yaml), so a pricing re-verification
 * only ever happens in one place.
 *
 * `phase`/`task_type`/`module` describe driver-loop work, not a dispatched
 * packet — there is no TaskPacket behind these tokens, so the values are
 * fixed constants rather than read from one.
 */
export function modeledDriverCostEvents(events, opts) {
  const { pass, model, pricing, now = () => new Date().toISOString() } = opts;
  const usages = extractTurnUsage(events);
  return usages.map(({ turn_index, usage }) => {
    // Codex reports `input_tokens` INCLUSIVE of `cached_input_tokens`, but
    // computeCostUsd expects the two to be disjoint — it prices `input` at
    // the fresh rate and `input_cached` at the discounted one, and sums both.
    // Passing the inclusive total charges every cached token twice: once at
    // full rate, once at the cache rate. On a real run that was a 7x
    // overstatement ($12.01 reported against $1.69 actual), almost all of it
    // invented, because an agentic loop re-sends its context every step and
    // ~97% of the input was cache reads.
    const cached = usage.cached_input_tokens ?? 0;
    const tokens = {
      input: Math.max(0, (usage.input_tokens ?? 0) - cached),
      input_cached: cached,
      output: usage.output_tokens ?? 0,
    };
    return {
      ts: now(),
      pass,
      phase: "driver_loop",
      task_type: "conductor",
      task_id: `driver-turn-${turn_index}`,
      module: "driver",
      model,
      provenance: "modeled",
      routed_by: "manual",
      routing: {
        policy_name: "gpt-plus-flash",
        policy_version: 1,
        rule_index: -1,
        rule_reason: "driver loop cost — never dispatched through execute_with_model (D1); modeled from codex exec --json turn usage, not a routed call",
      },
      input_tokens: tokens.input,
      input_tokens_cached: tokens.input_cached,
      output_tokens: tokens.output,
      output_tokens_reasoning: usage.reasoning_output_tokens,
      cost_usd: computeCostUsd(tokens, pricing),
      latency_ms: null,
      success: true,
      retry_count: 0,
    };
  });
}
