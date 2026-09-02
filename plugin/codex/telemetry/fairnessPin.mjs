/**
 * Fairness-pin assertion (Document A section 7, Document B section 8).
 *
 * The pin lives in exactly one place — the official policy's `gpt` model
 * entry (plugin/config/policies/gpt-plus-flash.yaml: model_name,
 * reasoning.effort) — and is read from there, never duplicated as a second
 * set of constants here. A pricing or pin change only ever needs editing
 * in the policy YAML.
 *
 * Enforceability is real but limited, per docs/verification/p1-codex-runtime.md
 * check 7: a successful `codex exec --json` turn never echoes back which
 * model or effort actually answered, so this cannot prove the correct pin
 * was used. What IS verified live: the CLI structurally rejects an
 * unrecognized model slug or an invalid `model_reasoning_effort` value with
 * a `turn.failed`/`error` item naming the problem. So the assertion has two
 * halves:
 *
 *   1. assertPinnedInvocation — called by the driver BEFORE invoking codex,
 *      on the exact model/effort strings it is about to pass as -m / -c
 *      flags. Catches a drifted driver script itself.
 *   2. findPinRejection — called AFTER a run, on the parsed event stream
 *      (see event-reader.mjs), to detect a structural rejection the CLI
 *      itself raised. It cannot prove success; it can prove a failure.
 */

/** Reads the pin straight off the policy's `gpt` model entry. */
export function readPin(policy) {
  const gpt = policy.models.find((m) => m.id === "gpt");
  if (!gpt) {
    throw new Error(
      `fairness pin: policy '${policy.name}' has no model with id 'gpt' to read the pin from.`,
    );
  }
  const model = gpt.model_name;
  const effort = gpt.reasoning?.effort;
  if (!model || !effort) {
    throw new Error(
      `fairness pin: policy '${policy.name}''s 'gpt' model entry is missing model_name or reasoning.effort — nothing to assert against.`,
    );
  }
  return { model, effort };
}

/**
 * Throws if the driver is about to invoke codex with a model or effort
 * that doesn't match the pin. Call this immediately before constructing
 * the `codex exec` argv — it is the only point where enforcement is
 * actually reliable (see module docstring).
 */
export function assertPinnedInvocation(intended, policy) {
  const pin = readPin(policy);
  if (intended.model !== pin.model) {
    throw new Error(
      `fairness pin violated: about to invoke model '${intended.model}', but the pinned model is ` +
        `'${pin.model}' (plugin/config/policies/${policy.name}.yaml). Aborting rather than running an ` +
        `unpinned, uncomparable pass.`,
    );
  }
  if (intended.effort !== pin.effort) {
    throw new Error(
      `fairness pin violated: about to invoke reasoning effort '${intended.effort}', but the pinned ` +
        `effort is '${pin.effort}' (plugin/config/policies/${policy.name}.yaml). Aborting rather than ` +
        `running an unpinned, uncomparable pass.`,
    );
  }
  return pin;
}

/**
 * Every shape a rejection message has been observed in, live (verified
 * 2026-08-31 against an invalid effort and an invalid model slug, both
 * captured raw rather than reconstructed from memory):
 *   - {"type":"item.completed","item":{"type":"error","message":"..."}}
 *     — e.g. "Model metadata for `X` not found."
 *   - {"type":"error","message":"..."} — a top-level event, message is
 *     itself a JSON-encoded string of the backend's error object.
 *   - {"type":"turn.failed","error":{"message":"..."}} — nested under
 *     `.error`, NOT a bare `.message` on the event itself.
 * All three can appear for the same rejection in one stream; this returns
 * the first one found.
 */
function rejectionMessage(ev) {
  if (ev.type === "item.completed" && ev.item?.type === "error") return ev.item.message;
  if (ev.type === "error") return ev.message;
  if (ev.type === "turn.failed") return ev.error?.message;
  return undefined;
}

/**
 * Scans a parsed event stream (event-reader.mjs's parseEventStream output)
 * for a structural rejection of the model or effort — the one thing the
 * stream CAN prove, per check 7. Returns the rejection message, or null if
 * none is found. A null return is not proof the pin was honored; it only
 * means the CLI didn't structurally object.
 */
export function findPinRejection(events) {
  for (const ev of events) {
    const message = rejectionMessage(ev);
    if (typeof message !== "string") continue;
    if (
      /reasoning[_.]effort|invalid_enum_value|model metadata for|not supported when using codex|model.*not found|invalid model/i.test(
        message,
      )
    ) {
      return message;
    }
  }
  return null;
}
