#!/usr/bin/env node
/**
 * One real delegation, ~2¢, to catch the agent-path failure modes that are
 * invisible to the offline verify-setup.mjs: 403 (missing entitlement),
 * 404 (region doesn't serve the model), 401 (stale credentials). All three
 * would otherwise surface at the first delegated packet, after premium
 * phases are billed.
 *
 * Loads the real policy, constructs the real adapter, runs execute() in a
 * temporary empty workspace. Cost measured 2026-08-05 against
 * gemini-3.5-flash global: 12,245/154 tokens, $0.0198.
 *
 * Usage:
 *   node probe-agent-worker.mjs [--project-root=<dir>]   # the policy a run there would use
 *   node probe-agent-worker.mjs --policy=<name>
 *   node probe-agent-worker.mjs --telemetry=<path>   # where its spend is recorded
 *
 * Exit 0: delegation completed and priced. Exit 1: cause named in words.
 */

import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pinnedSdkVersion } from "../codex/verify-setup.mjs";
import { isMain } from "./lib/is-main.mjs";

// ─── pure helpers ─────────────────────────────────────────────────────

/**
 * Match by adapter, not model id: "does the agent path work" is true or
 * false regardless of leaf naming, and stays right if the leaf is renamed.
 * (verify-setup.mjs matches by model id because it answers a different
 * question: "did this install SELECT the agent path".)
 */
export const AGENT_ADAPTER = "antigravity-worker";

/** Refuses on more than one — a wrong green light costs a whole run. */
export function agentLeafFrom(policy) {
  const leaves = (policy?.models ?? []).filter((m) => m.adapter === AGENT_ADAPTER);
  if (leaves.length === 0) {
    throw new Error(
      `Policy '${policy?.name ?? "?"}' declares no agent-worker leaf ` +
        `(no model with adapter: ${AGENT_ADAPTER}), so there is nothing here to probe. ` +
        `The shipped policies that have one are gpt-plus-flash, gpt-plus-flash-38, gpt-seat-plus-flash and flash-agsdk-only.`
    );
  }
  if (leaves.length > 1) {
    throw new Error(
      `Policy '${policy.name}' declares ${leaves.length} agent-worker leaves ` +
        `(${leaves.map((m) => m.id).join(", ")}). Probe one at a time with --model=<id>.`
    );
  }
  return leaves[0];
}

/** Same selection, narrowed by an explicit `--model=<id>`. */
export function agentLeafById(policy, modelId) {
  const leaf = (policy?.models ?? []).find((m) => m.id === modelId);
  if (!leaf) {
    throw new Error(
      `Policy '${policy?.name ?? "?"}' declares no model '${modelId}'. ` +
        `Declared: ${(policy?.models ?? []).map((m) => m.id).join(", ") || "none"}.`
    );
  }
  if (leaf.adapter !== AGENT_ADAPTER) {
    throw new Error(
      `Model '${modelId}' uses adapter '${leaf.adapter}', not '${AGENT_ADAPTER}'. ` +
        `This probe only exercises the agent path; the model path is covered by preflight_dispatch.`
    );
  }
  return leaf;
}

/**
 * Smallest real delegation. No cheap agent session exists — the SDK sends its
 * preamble every turn. The only lever is TURNS, so: one turn, one JSON reply,
 * no tool use.
 */
export function probePacket(passId = "probe") {
  return {
    id: `tp_probe_${passId}`,
    phase: "docs",
    task_type: "connectivity_probe",
    module: "cross",
    instruction:
      "Reply with exactly this JSON object and nothing else: {\"ok\": true}. " +
      "Do not read any file, do not write any file, and do not run any command. " +
      "This is a connectivity check, not a task.",
    inputs: [],
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    acceptance: ["Returns {\"ok\": true}", "Touches nothing in the working directory"],
    budget: { maxInputTokens: 4000, maxOutputTokens: 256 },
    pass_id: passId,
  };
}

/**
 * Ordered most-specific first: a missing SDK import and a credentials error
 * both mention words that appear in the broader patterns below them.
 */
export function classifyFailure(errorText) {
  const text = String(errorText ?? "");
  const has = (...needles) => needles.some((n) => text.toLowerCase().includes(n.toLowerCase()));

  if (has("No module named 'google.antigravity'", "No module named \"google.antigravity\"")) {
    return {
      id: "sdk-missing",
      headline: "The Antigravity SDK is not installed in the interpreter that ran the worker.",
      fix: "node <plugin>/codex/verify-setup.mjs --fix (builds the worker virtualenv and installs it)",
    };
  }
  if (has("DefaultCredentialsError", "could not automatically determine credentials", "default credentials were not found")) {
    return {
      id: "adc-missing",
      headline: "No Application Default Credentials reached the worker process.",
      fix: "gcloud auth application-default login   (then re-run this probe)",
    };
  }
  if (has("invalid_grant", "reauth", "credentials do not contain", "token has been expired", "invalid_rapt")) {
    return {
      id: "adc-stale",
      headline: "Application Default Credentials exist but are no longer valid.",
      fix: "gcloud auth application-default login   (re-authenticates the same account)",
    };
  }
  if (has("403", "PERMISSION_DENIED", "does not have access", "permission to access")) {
    return {
      id: "entitlement",
      headline:
        "Google refused the call (403). On this path that almost always means the billing " +
        "project lacks the Gemini Enterprise / Model Garden entitlement the Antigravity SDK " +
        "requires — the plain model path can work on a project where this one does not.",
      fix:
        "Request the entitlement for this project, or run the mechanical tier as a model " +
        "instead of an agent (unset MMO_SELECT, or set gemini-flash=flash-completion).",
    };
  }
  if (has("404", "NOT_FOUND", "was not found", "is not supported", "not available in")) {
    return {
      id: "region",
      headline:
        "Google could not find the model (404). The model is not deployed in the region this " +
        "leaf resolved to — the region, not the model name, is nearly always what is wrong.",
      fix:
        "Unset GOOGLE_CLOUD_LOCATION to use the global endpoint, or pin a region that serves " +
        "this model on the policy leaf's `region:` field.",
    };
  }
  if (has("429", "RESOURCE_EXHAUSTED", "quota")) {
    return {
      id: "quota",
      headline: "Google returned a quota error (429). The path is wired correctly; capacity is not there right now.",
      fix: "Retry later, or raise the quota for this model on the project's quotas page (still filed under Vertex AI in the console).",
    };
  }
  if (has("was killed after", "timed out", "TimeoutError")) {
    return {
      id: "timeout",
      headline:
        "The worker did not finish in time. For a one-turn probe this points at the session " +
        "never starting rather than at a slow answer — a hung credential refresh looks like this.",
      fix: "Check network egress to *.googleapis.com, then re-run this probe.",
    };
  }
  return {
    id: "unknown",
    headline: "The delegation failed for a reason this probe does not recognise.",
    fix: "Read the worker output below; the exception is on the last line.",
  };
}

/** Dollars, at the precision a sub-cent probe actually needs. */
export function formatUsd(amount) {
  const n = Number(amount) || 0;
  if (n === 0) return "$0.000000";
  return `$${n.toFixed(6)}`;
}

const perMillion = (c) => [c.input, c.input_cached, c.output].map((n) => `$${Number(n.toFixed(6))}`).join("/");

/**
 * Say whether the billed card is the price card or that card plus Google's
 * regional +10% surcharge (Gemini 3+ non-global), so a reader does not read
 * the difference as a bug. `card` is the unsurcharged card priced today.
 */
export function pricingNote(card, billed, region, basis = "list") {
  if (!card || !billed) return "not priced today by the price list (src/prices.ts), so the delegation will be refused";
  const source = basis === "custom" ? "the policy's pricing_override rates" : "the price list's rates";
  const same = card.input === billed.input && card.input_cached === billed.input_cached && card.output === billed.output;
  if (same) return `billed at ${source}, ${perMillion(card)} per million (region '${region}' carries no surcharge)`;
  return (
    `billed at ${source} plus Google's regional surcharge, because this leaf runs in ` +
    `'${region}' rather than the global endpoint: in ${perMillion(card)} → ${perMillion(billed)} ` +
    `per million (input/cached/output)`
  );
}

/** The `rates`, source and verified lines the probe prints for what a delegation today bills. */
export function priceLines(priced, leaf, region) {
  if (priced.unpriced) return [`  rates       ${pricingNote(null, null, region)}: ${priced.reason}`];
  const { price, billed } = priced;
  const lines = [`  rates       ${pricingNote(price.pricing, billed, region, price.basis)}`];
  if (price.entry) {
    lines.push(`  listed from ${price.entry.source}`);
    lines.push(`  verified    ${price.entry.verified}`);
  } else {
    if (leaf.pricing_source) lines.push(`  pinned from ${leaf.pricing_source}`);
    if (leaf.pricing_last_verified) lines.push(`  verified    ${leaf.pricing_last_verified}`);
  }
  for (const w of price.warnings ?? []) lines.push(`  note        ${w}`);
  return lines;
}

/**
 * Where the probe's spend is recorded: `--telemetry=<path>`, else the
 * project's pre-check telemetry when `cwd` (the project root) holds a
 * `.sdlc/`, else beside the probe's own evidence. Never creates a `.sdlc/`
 * that is not there.
 */
export function probeTelemetryPath({ flag, cwd, evidenceDir, exists = existsSync }) {
  if (flag) return resolve(cwd, flag);
  if (exists(join(cwd, ".sdlc"))) return join(cwd, ".sdlc", "pre-check", "telemetry.jsonl");
  return join(evidenceDir, "telemetry.jsonl");
}

/** The probe's telemetry lines: the bridge's own event shape, marked as a manual call. */
export function probeSpendEvents({ attemptEvents, policy, leaf, adapterProvenance, packet, result, ts }) {
  const identity = {
    packet,
    decision: { modelId: leaf.id, reason: "agent-worker connectivity probe", ruleIndex: -1 },
    policy,
    modelName: leaf.model_name,
    adapterProvenance,
  };
  return attemptEvents(identity, result, ts).map((ev) => ({ ...ev, routed_by: "manual" }));
}

/**
 * How the delegation's input was read, from the SDK version its sidecar
 * recorded. `--fix` rebuilds only the plugin's own .venv, so with
 * GEMINI_WORKER_PYTHON set the fix names that interpreter instead.
 */
export function sdkLines(sidecar, usageSemantics, { pythonOverride, pin } = {}) {
  if (!sidecar) return ["  sdk         no usage sidecar was written"];
  const semantics = usageSemantics(sidecar);
  const lines = [`  sdk         ${sidecar.sdk ?? "google-antigravity"} ${sidecar.sdk_version ?? "unknown"} (input read as ${semantics})`];
  if (semantics === "unverified") {
    const fix = pythonOverride
      ? `install the pin where GEMINI_WORKER_PYTHON points (${pythonOverride} -m pip install ` +
        `google-antigravity==${pin ?? "<the version requirements.txt pins>"}), or unset GEMINI_WORKER_PYTHON ` +
        "and run verify-setup.mjs --fix"
      : "rebuild the worker from requirements.txt (verify-setup.mjs --fix)";
    lines.push(
      `  warning     this SDK version is not in AGY_USAGE_SEMANTICS, so its input was billed on the larger reading; ${fix}`,
    );
  }
  return lines;
}

/** `--flag=value` out of an argv, so the parsing is testable without a process. */
export function readFlag(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

// ─── live probe (network + disk) ───────────────────────────────────────

/**
 * Dynamic import behind existsSync — unbuilt plugin is the commonest state,
 * and a raw ERR_MODULE_NOT_FOUND stack says nothing about the fix.
 */
async function loadServerModules(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "model-dispatch");
  const distPolicy = join(serverDir, "dist", "policy.js");
  const distAdapters = join(serverDir, "dist", "adapters", "index.js");
  const distEvents = join(serverDir, "dist", "dispatchEvents.js");
  const distWorker = join(serverDir, "dist", "delegation", "workerProcess.js");
  if (![distPolicy, distAdapters, distEvents, distWorker].every((p) => existsSync(p))) {
    throw new Error(
      `The bundled server is not built, so there is no adapter to probe with. ` +
        `Run: node ${join(pluginRoot, "codex", "verify-setup.mjs")} --fix`
    );
  }
  const [{ loadPolicy }, { createAdapter }, { attemptEvents }, { evidenceStem, sidecarUsageSemantics }] = await Promise.all([
    import(`file://${distPolicy}`),
    import(`file://${distAdapters}`),
    import(`file://${distEvents}`),
    import(`file://${distWorker}`),
  ]);
  return { loadPolicy, createAdapter, attemptEvents, evidenceStem, sidecarUsageSemantics };
}

/**
 * Empty temp workspace, evidence in a sibling (not child) so the workspace
 * stays genuinely empty and any file-change report is unambiguous.
 */
function makeProbeDirs() {
  const root = mkdtempSync(join(tmpdir(), "sdlc-agent-probe-"));
  const workspace = join(root, "workspace");
  const evidence = join(root, "evidence");
  mkdirSync(workspace);
  mkdirSync(evidence);
  return { root, workspace, evidence };
}

async function main() {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const argv = process.argv.slice(2);
  const policyName = readFlag(argv, "policy");
  const projectRoot = readFlag(argv, "project-root") ?? process.cwd();
  const modelId = readFlag(argv, "model");
  const log = (m = "") => console.log(m);

  log("\nAI-SDLC orchestrator — agent-worker probe");
  log("  One trivial delegation, in an empty temporary workspace, at real cost.\n");

  const { loadPolicy, createAdapter, attemptEvents, evidenceStem, sidecarUsageSemantics } = await loadServerModules(pluginRoot);
  const policy = loadPolicy({ policyName, projectRoot });
  const leaf = modelId ? agentLeafById(policy, modelId) : agentLeafFrom(policy);

  // Constructor is itself a gate — resolves project, worker script, and
  // interpreter, and throws on any of them before a subprocess exists.
  const adapter = createAdapter(leaf);

  log(`  policy      ${policy.name}`);
  log(`  model leaf  ${leaf.id} → ${leaf.model_name}`);
  log(`  project     ${adapter.project}`);
  log(`  region      ${adapter.location}`);
  log(`  interpreter ${adapter.python}`);
  for (const line of priceLines(adapter.pricingOn(), leaf, adapter.location)) log(line);

  const dirs = makeProbeDirs();
  log(`\n  workspace   ${dirs.workspace}  (empty, temporary)`);
  log(`  evidence    ${dirs.evidence}`);
  log("\n  Delegating…");

  const packet = probePacket();
  const result = await adapter.execute(packet, undefined, {
    work_dir: dirs.workspace,
    telemetry_path: join(dirs.evidence, "telemetry.jsonl"),
  });

  const { input, input_cached, output } = result.tokens;
  log(
    `\n  tokens      ${input} input, ${input_cached} cached, ${output} output ` +
      `(in ${(result.latency_ms / 1000).toFixed(1)}s)`
  );
  log(`  cost        ${formatUsd(result.cost_usd)}`);
  const sidecarPath = join(dirs.evidence, "delegation", `worker-usage-${evidenceStem(packet)}.json`);
  let sidecar = null;
  try { sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")); } catch { /* none written */ }
  let pin = null;
  try { pin = pinnedSdkVersion(readFileSync(join(pluginRoot, "mcp", "model-dispatch", "worker", "requirements.txt"), "utf8")); } catch { /* unreadable */ }
  for (const line of sdkLines(sidecar, sidecarUsageSemantics, { pythonOverride: process.env.GEMINI_WORKER_PYTHON, pin })) log(line);

  // A paid call, so it is recorded like a dispatch.
  const telemetryFlag = readFlag(argv, "telemetry");
  const spendPath = probeTelemetryPath({
    flag: telemetryFlag && resolve(telemetryFlag),
    cwd: resolve(projectRoot),
    evidenceDir: dirs.evidence,
  });
  try {
    mkdirSync(dirname(spendPath), { recursive: true });
    const events = probeSpendEvents({
      attemptEvents,
      policy,
      leaf,
      adapterProvenance: adapter.costProvenance,
      packet,
      result,
      ts: new Date().toISOString(),
    });
    appendFileSync(spendPath, events.map((ev) => JSON.stringify(ev) + "\n").join(""), "utf8");
    log(`  recorded    ${spendPath}`);
    if (dirname(spendPath) === dirs.evidence) {
      log("              (no report or cost cap reads it here: run from the project root, or pass --telemetry=<path>)");
    }
  } catch (err) {
    log(`  recorded    nowhere: could not write ${spendPath} (${err?.message ?? err})`);
  }

  if (result.success) {
    log("\n  ✓ The agent path works. A run selecting this leaf will dispatch, bill and be priced.");
    log(`    Answer: ${JSON.stringify(result.result)}`);
    log(`\n  Delete the probe directory when you are done with it: ${dirs.root}\n`);
    return 0;
  }

  const verdict = classifyFailure(result.error);
  log(`\n  ✗ ${verdict.headline}`);
  log(`    fix: ${verdict.fix}`);
  // Printed with the classification so a reader can second-guess it.
  log(`\n  Worker output:\n    ${String(result.error ?? "").split("\n").join("\n    ")}`);
  log(`\n  Evidence kept at: ${dirs.evidence}\n`);
  return 1;
}

// Direct-execution gate so the test suite can import the pure helpers.
if (isMain(import.meta.url, process.argv[1])) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\n  ✗ ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
