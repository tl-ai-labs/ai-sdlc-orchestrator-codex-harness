/**
 * The policy a headless run uses, resolved by the bridge's own resolver
 * (dist/policy.js), so run.mjs's pin and cost cap come from the same file
 * its dispatches route by, and the conductor's price from the same dated
 * list (dist/driverPricing.js).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readDriver } from "./telemetry/fairnessPin.mjs";
import { POLICY_PATH_ENV } from "./dispatch.mjs";

export { POLICY_PATH_ENV };

const DIST_POLICY = new URL("../mcp/model-dispatch/dist/policy.js", import.meta.url);
const DIST_DRIVER_PRICING = new URL("../mcp/model-dispatch/dist/driverPricing.js", import.meta.url);

let bridge = null;
let bridgeLoadError = null;
try {
  bridge = { ...(await import(DIST_POLICY.href)), ...(await import(DIST_DRIVER_PRICING.href)) };
} catch (err) {
  bridgeLoadError = err;
}

function bridgePolicy() {
  if (bridge?.resolvePolicy && bridge?.anthropicAdapters && bridge?.isGptModel && bridge?.driverPriceRecord) return bridge;
  const why = bridgeLoadError?.message ?? "it has no resolvePolicy export, so it was built from an older checkout";
  throw new RunRefusal(
    `run: cannot load the policy resolver from ${fileURLToPath(DIST_POLICY)} (${why}). ` +
      `Rebuild the bridge: cd plugin/mcp/model-dispatch && npm run build`,
  );
}

/** A refusal before anything is spent. run.mjs exits 2 for it. */
export class RunRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "RunRefusal";
    this.exitCode = 2;
  }
}

function stderrWarn(message) {
  process.stderr.write(`${message}\n`);
}

function refuseWith(err) {
  if (err instanceof RunRefusal) return err;
  const message = String(err?.message ?? err);
  return new RunRefusal(message.startsWith("run:") ? message : `run: ${message}`);
}

function notRunnableAdvice(resolved, projectRoot, presets, edit) {
  const runnable = `Runnable presets: ${presets.join(", ")}.`;
  if (resolved.source === "project-override") {
    return (
      `It comes from ${resolved.path}, which every run in this project uses whatever --policy names: ` +
      `${edit}, or move it aside. ${runnable}`
    );
  }
  if (resolved.source === "project-default") {
    return (
      `It is the default_policy in ${join(projectRoot, ".sdlc", "project.json")}: pass --policy=<preset> ` +
      `for this run, or rerun $mmo-codex:policy to change the default. ${runnable}`
    );
  }
  return `Pass --policy=<preset> with a runnable one. ${runnable}`;
}

/**
 * Resolves the run's policy (routing-policy.yaml, then --policy, then the
 * project.json default, then the built-in default) and reads its driver pin
 * and the price list entry for it on `now`. Refuses a policy with an
 * Anthropic adapter, a conductor pin that is not a GPT model, a conductor
 * model nothing prices, and a name the dispatch command line cannot carry
 * unquoted.
 */
export function resolveRunPolicy({ projectRoot, policyArg = null, warn = stderrWarn, now = new Date() } = {}) {
  const { resolvePolicy, anthropicAdapters, isGptModel, shippedPresetNames, POLICY_NAME_RE, driverPriceRecord } = bridgePolicy();
  const requested = typeof policyArg === "string" && policyArg.length > 0 ? policyArg : null;
  let resolved;
  try {
    resolved = resolvePolicy({ policyName: requested ?? undefined, projectRoot });
  } catch (err) {
    throw refuseWith(err);
  }
  const { policy } = resolved;
  const anthropic = anthropicAdapters(policy);
  if (anthropic.length > 0) {
    const advice = notRunnableAdvice(resolved, projectRoot, shippedPresetNames(), "edit it to route through GPT and Gemini adapters");
    throw new RunRefusal(
      `run: policy '${policy.name}' (${resolved.path}) names an Anthropic adapter (${anthropic.join(", ")}), ` +
        `and this harness runs no Anthropic model. ${advice}`,
    );
  }
  if (!POLICY_NAME_RE.test(policy.name)) {
    throw new RunRefusal(
      `run: policy name '${policy.name}' in ${resolved.path} cannot go on a dispatch command line. ` +
        `Rename it using letters, digits, '.', '_' and '-' only.`,
    );
  }
  let driver;
  try {
    driver = readDriver(policy, { warn });
  } catch (err) {
    throw refuseWith(err);
  }
  if (!isGptModel(driver.pin.model)) {
    const advice = notRunnableAdvice(resolved, projectRoot, shippedPresetNames(), "set its driver: model_name to gpt-5.6-terra");
    throw new RunRefusal(
      `run: policy '${policy.name}' (${resolved.path}) pins the conductor to '${driver.pin.model}', which is not a GPT model: ` +
        `this harness runs its conductor in codex on a GPT model only. ${advice}`,
    );
  }
  const price = driverPriceRecord(policy, driver.pin.model, now);
  if (price.unpriced_reason) {
    throw new RunRefusal(
      `run: the conductor's model cannot be priced, so its cost could not be modeled or capped: ${price.unpriced_reason}.`,
    );
  }
  for (const w of price.warnings) warn(`run: ${w}`);
  const notice =
    requested && resolved.source === "project-override"
      ? `run: ${resolved.path} (policy '${policy.name}') is used instead of --policy=${requested}; ` +
        `a project's routing-policy.yaml always wins, for the driver and the bridge alike.`
      : null;
  return {
    policy,
    name: policy.name,
    version: policy.version,
    source: resolved.source,
    path: resolved.path,
    sha256: resolved.sha256,
    requested,
    driver: { ...driver, price },
    notice,
  };
}

/** The keys a run records about its policy (dry-run JSON and driver-manifest.json). */
export function policyRecord(run) {
  return {
    policy: run.name,
    policy_version: run.version,
    policy_source: run.source,
    policy_path: run.path,
    policy_sha256: run.sha256,
    policy_requested: run.requested,
  };
}

/** The environment codex runs in, so every dispatch.mjs it starts loads exactly this policy file. */
export function codexEnv(run, base = process.env) {
  return { ...base, [POLICY_PATH_ENV]: run.path };
}

function recordFrom(value) {
  if (!value || typeof value !== "object") return null;
  const name = typeof value.policy === "string" ? value.policy : (value.policy?.name ?? null);
  const path = value.policy_path ?? null;
  if (!name && !path) return null;
  const pin = value.pin?.model ? { model: value.pin.model, effort: value.pin.effort ?? null } : null;
  const runId = typeof value.run_id === "string" ? value.run_id : null;
  return { name, path, sha256: value.policy_sha256 ?? null, pin, runId };
}

function otherRun(record, runId) {
  return Boolean(runId && record?.runId && record.runId !== runId);
}

function firstInvocationStart(text, runId) {
  for (const line of text.split("\n")) {
    if (!line.includes('"invocation_start"')) continue;
    try {
      const row = JSON.parse(line);
      if (row?.kind === "invocation_start" && !otherRun({ runId: row.run_id }, runId)) return row;
    } catch { /* a torn line is skipped */ }
  }
  return null;
}

function readManifestRecord(runDir, runId, warn) {
  const manifest = join(runDir, "driver-manifest.json");
  if (!existsSync(manifest)) return null;
  let record;
  try {
    record = recordFrom(JSON.parse(readFileSync(manifest, "utf-8")));
  } catch {
    return null;
  }
  if (otherRun(record, runId)) {
    warn(`run: --resume: ${manifest} was written by run '${record.runId}', not '${runId}'; its policy record is ignored.`);
    return null;
  }
  return record;
}

function withSource({ runId, ...record }, from) {
  return { ...record, from };
}

/**
 * The policy a run folder's first invocation recorded. Name and pin come
 * from the first `invocation_start` row of driver-events.jsonl; the file
 * and its sha256 come from that row when it carries them, else from
 * driver-manifest.json (the v1 row has no `policy_path`). With `runId`,
 * a record another run wrote is skipped. Null when the folder records
 * neither.
 */
export function readRecordedPolicy(runDir, { runId = null, warn = stderrWarn } = {}) {
  const eventsPath = join(runDir, "driver-events.jsonl");
  const events = existsSync(eventsPath)
    ? recordFrom(firstInvocationStart(readFileSync(eventsPath, "utf-8"), runId))
    : null;
  const manifest = readManifestRecord(runDir, runId, warn);
  if (!events) return manifest && withSource(manifest, "driver-manifest.json");
  if (events.path || !manifest) return withSource(events, "driver-events.jsonl");
  // A manifest naming another policy describes a different run; its file is not this run's.
  if (events.name && manifest.name && manifest.name !== events.name) return withSource(events, "driver-events.jsonl");
  return {
    name: events.name ?? manifest.name,
    path: manifest.path,
    sha256: manifest.sha256,
    pin: events.pin ?? manifest.pin,
    from: "driver-events.jsonl+driver-manifest.json",
  };
}

/**
 * A resumed run keeps the policy it started on. Refuses a different name,
 * a different file (one that moved and changed), or a different driver pin;
 * warns when the same file's bytes changed or the same bytes moved.
 */
export function assertResumePolicy({ recorded, run, runDir, warn = stderrWarn }) {
  if (!recorded) {
    warn(
      `run: --resume: ${runDir ?? "the run folder"} records no policy, so this invocation cannot confirm ` +
        `it uses the policy the run started on. Continuing with '${run.name}' (${run.path}).`,
    );
    return;
  }
  const started = `'${recorded.name ?? "?"}' (${recorded.path ?? "path not recorded"})`;
  const now = `'${run.name}' (${run.path}, from ${run.source})`;
  const manifestHint = String(recorded.from ?? "").includes("driver-manifest.json")
    ? ` The record comes from ${join(runDir ?? ".", "driver-manifest.json")}, which the last run to finish in ` +
      `this folder wrote; if that was another run, pass this run's --run-id so the file is ignored, or move it aside.`
    : "";
  const refuse = (what) =>
    new RunRefusal(
      `run: --resume refused: ${what}. The run started on policy ${started}; this invocation resolves ${now}. ` +
        `Resume with the same --policy and the same routing-policy.yaml, or start a new run.${manifestHint}`,
    );
  if (recorded.name && recorded.name !== run.name) throw refuse("the policy name differs");
  // A plugin update or a second checkout moves the file, so only a move that also changed its
  // bytes is a different policy.
  const moved = recorded.path && recorded.path !== run.path;
  if (moved && !(recorded.sha256 && recorded.sha256 === run.sha256)) throw refuse("the policy file differs");
  if (moved) {
    warn(`run: --resume: the policy file moved (${recorded.path} then, ${run.path} now) with the same contents.`);
  }
  const pin = run.driver.pin;
  if (recorded.pin && (recorded.pin.model !== pin.model || (recorded.pin.effort && recorded.pin.effort !== pin.effort))) {
    throw refuse(
      `the driver pin differs (${recorded.pin.model}/${recorded.pin.effort ?? "?"} then, ${pin.model}/${pin.effort} now)`,
    );
  }
  if (recorded.sha256 && recorded.sha256 !== run.sha256) {
    warn(`run: --resume: ${run.path} changed since the run started; this invocation uses its current contents.`);
  }
}
