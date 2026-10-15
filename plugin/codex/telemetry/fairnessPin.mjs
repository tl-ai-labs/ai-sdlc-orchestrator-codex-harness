/**
 * Fairness pin (Document A section 7, Document B section 8).
 *
 * The pin is the policy's top-level `driver:` block and is read from there,
 * never duplicated as constants here. It has two halves, because a
 * successful `codex exec --json` turn never echoes which model answered
 * (docs/verification/p1-codex-runtime.md check 7):
 *
 *   1. assertPinnedInvocation, before codex runs, on the -m / effort values
 *      read back out of the built argv (argvPin).
 *   2. findPinRejection, after a run, on the parsed event stream: it can
 *      prove the CLI rejected the pin, never that the pin was honoured.
 */

const DRIVER_BLOCK_EXAMPLE = [
  "driver:",
  "  model_name: gpt-5.6-terra",
  "  reasoning: { effort: high }",
  "  pricing: { input: 2.00, input_cached: 0.20, output: 12.00 }",
].join("\n");

function stderrWarn(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * The conductor's pin, and the rates its policy block documents (the dated
 * price list in src/prices.ts is what prices it, see driverPricing.ts).
 * Prefers the `driver:` block; a policy written before it existed falls back
 * to its `gpt` model entry, with a warning.
 */
export function readDriver(policy, { warn = stderrWarn } = {}) {
  const models = Array.isArray(policy?.models) ? policy.models : [];
  if (policy?.driver) {
    const model = policy.driver.model_name;
    const effort = policy.driver.reasoning?.effort;
    if (!model || !effort) {
      throw new Error(
        `fairness pin: policy '${policy.name}''s driver block is missing model_name or reasoning.effort — nothing to assert against.`,
      );
    }
    const pricing = policy.driver.pricing ?? models.find((m) => m.model_name === model)?.pricing ?? null;
    return { pin: { model, effort }, pricing, from: "driver" };
  }
  const gpt = models.find((m) => m.id === "gpt");
  if (gpt) {
    const model = gpt.model_name;
    const effort = gpt.reasoning?.effort;
    if (!model || !effort) {
      throw new Error(
        `fairness pin: policy '${policy.name}''s 'gpt' model entry is missing model_name or reasoning.effort — nothing to assert against.`,
      );
    }
    warn(
      `fairness pin: policy '${policy.name}' has no driver: block, so the pin is read from its 'gpt' model entry. ` +
        `Add a top-level driver: block; this fallback will be removed.`,
    );
    return { pin: { model, effort }, pricing: gpt.pricing ?? null, from: "models.gpt" };
  }
  throw new Error(
    `fairness pin: policy '${policy?.name}' has no driver: block to read the pin from. Add one at the top level:\n${DRIVER_BLOCK_EXAMPLE}`,
  );
}

export function readPin(policy, opts) {
  return readDriver(policy, opts).pin;
}

/** The model and effort a built `codex exec` argv actually passes. */
export function argvPin(argv) {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  const m = flags.indexOf("-m");
  let effort = null;
  for (let i = 0; i < flags.length - 1; i++) {
    if (flags[i] !== "-c") continue;
    const match = /^model_reasoning_effort="([^"]*)"$/.exec(flags[i + 1]);
    if (match) effort = match[1];
  }
  return { model: m === -1 ? null : (flags[m + 1] ?? null), effort };
}

/**
 * Throws if the driver is about to invoke codex with a model or effort
 * that doesn't match the pin. Pass argvPin(argv) of the real argv, so a
 * drifted argv builder is caught and not only a drifted constant.
 */
export function assertPinnedInvocation(intended, policy) {
  const pin = readPin(policy, { warn: () => {} });
  if (intended.model !== pin.model) {
    throw new Error(
      `fairness pin violated: about to invoke model '${intended.model}', but the pinned model is ` +
        `'${pin.model}' (policy '${policy.name}'). Aborting rather than running an ` +
        `unpinned, uncomparable pass.`,
    );
  }
  if (intended.effort !== pin.effort) {
    throw new Error(
      `fairness pin violated: about to invoke reasoning effort '${intended.effort}', but the pinned ` +
        `effort is '${pin.effort}' (policy '${policy.name}'). Aborting rather than ` +
        `running an unpinned, uncomparable pass.`,
    );
  }
  return pin;
}

/**
 * Every shape a rejection message has been observed in, live (verified
 * 2026-08-31 against an invalid effort and an invalid model slug):
 *   - {"type":"item.completed","item":{"type":"error","message":"..."}}
 *   - {"type":"error","message":"..."} — a top-level event, message is
 *     itself a JSON-encoded string of the backend's error object.
 *   - {"type":"turn.failed","error":{"message":"..."}} — nested under
 *     `.error`, NOT a bare `.message` on the event itself.
 */
function errorMessage(ev) {
  if (ev.type === "item.completed" && ev.item?.type === "error") return ev.item.message;
  if (ev.type === "error") return ev.message;
  if (ev.type === "turn.failed") return ev.error?.message;
  return undefined;
}

const REJECTION_RE =
  /reasoning[_.]effort|invalid_enum_value|not supported when using codex|model.*not found|invalid model/i;

/** codex 0.160.1 prints this for a slug it has no bundled metadata for, then runs the turn anyway. */
const FALLBACK_METADATA_RE = /Defaulting to fallback metadata/i;
/** A dropped stream codex retries; a good turn.completed can follow it. */
const RECONNECTING_RE = /^Reconnecting\.\.\./;

function isWarningOnly(ev, message) {
  if (FALLBACK_METADATA_RE.test(message)) return true;
  return ev.type === "error" && RECONNECTING_RE.test(message.trim());
}

/** Events grouped per invocation: by their `invocation` stamp, else split at each thread.started. */
function byInvocation(events) {
  const groups = [];
  let current = null;
  let key;
  for (const ev of events) {
    const k = ev.invocation ?? null;
    const boundary = k !== null ? k !== key : ev.type === "thread.started" || current === null;
    if (boundary || current === null) {
      current = [];
      groups.push(current);
      key = k;
    }
    current.push(ev);
  }
  return groups;
}

/** A rejected pin never yields a completed turn, so an invocation whose every turn completed has none. */
function everyTurnCompleted(group) {
  let started = 0;
  let completed = 0;
  for (const ev of group) {
    if (ev.type === "turn.started") started++;
    if (ev.type === "turn.completed") completed++;
  }
  return completed > 0 && completed >= started;
}

function classify(events) {
  const rejections = [];
  const warnings = [];
  for (const group of byInvocation(events)) {
    const clean = everyTurnCompleted(group);
    for (const ev of group) {
      const message = errorMessage(ev);
      if (typeof message !== "string") continue;
      if (isWarningOnly(ev, message)) warnings.push(message);
      else if (REJECTION_RE.test(message)) (clean ? warnings : rejections).push(message);
      // codex 0.160.1 reports its non-fatal notices as item-level errors.
      else if (ev.type === "item.completed") warnings.push(message);
    }
  }
  return { rejections, warnings };
}

/**
 * The first structural rejection of the model or effort in a parsed stream,
 * or null. A null return is not proof the pin was honored; it only means the
 * CLI did not object.
 */
export function findPinRejection(events) {
  return classify(events).rejections[0] ?? null;
}

/**
 * Messages codex reported that are not a rejection: fallback metadata,
 * reconnects, item-level notices, and errors a completed turn outranked.
 * Deduplicated.
 */
export function findCodexWarnings(events) {
  return [...new Set(classify(events).warnings)];
}
