/**
 * What runs once a run stops, whatever the outcome and the route: the driver
 * files (run.mjs only), the conductor's cost from its session file, the
 * brownfield write contract's end with its provenance record, manifest.json
 * and report.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { modeledDriverCostRows } from "./telemetry/event-reader.mjs";
import { buildDriverManifest, gate4Acceptance, gateDecision, writeFileAtomic } from "./run-record.mjs";
import { readRunRecords } from "./run-folder.mjs";
import { observedSessionModels } from "./session-model.mjs";
import { ACCEPTED_STATUSES, codeWrittenSummary, writeManifest } from "../scripts/write-manifest.mjs";
import { abandonCommand, endRun } from "../scripts/write-contract.mjs";
import { collectDriverUsage } from "../scripts/collect-driver-usage.mjs";
import { readRun, summarize, writeReport } from "../scripts/report.mjs";
import { fixedDriverPriceFn, listDriverPriceFn } from "../mcp/model-dispatch/dist/driverPricing.js";
import { defaultCodexHome, execSessionFacts } from "../mcp/model-dispatch/dist/sessionUsage.js";

/**
 * How the conductor's turns are priced: the dated price list for the run's
 * policy, with each turn's per-response sizes from the session file when
 * `codexHome` holds it. `driver.pricing` alone is a fixed card, labelled
 * custom. `baselines` are the session file's running totals for threads this
 * folder first sees in a resume.
 */
export function driverTurnPricing(driver, { records = [], codexHome = null } = {}) {
  const priceFn =
    driver.priceFn ??
    (driver.policy ? listDriverPriceFn(driver.policy) : driver.pricing ? fixedDriverPriceFn(driver.pricing) : listDriverPriceFn(null));
  let requests = null;
  let baselines = {};
  if (codexHome) {
    try {
      ({ requests, baselines } = execSessionFacts(records, codexHome));
    } catch {
      requests = null;
      baselines = {};
    }
  }
  return {
    pricing: {
      model: driver.model,
      priceFn,
      ...(requests?.size ? { requestsFor: (turn) => requests.get(turn.invocation) ?? null } : {}),
    },
    baselines,
  };
}

/**
 * Rewrites driver-cost-modeled.jsonl and driver-manifest.json from
 * driver-events.jsonl, so both are exact and carry the incomplete turns the
 * live append cannot know about yet.
 */
export function regenerateDriverFiles({ runDir, runId, records = readRunRecords(runDir), driver }) {
  const { model, policyName, policyVersion = 1, policyRecord, pin, sandbox, approvalPolicy, auth, policy } = driver;
  const { pricing, baselines } = driverTurnPricing(driver, { records, codexHome: driver.codexHome ?? null });
  const rows = modeledDriverCostRows(records, { runId, model, policyName, policyVersion, baselines, ...pricing });
  writeFileAtomic(
    join(runDir, "driver-cost-modeled.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
  const built = buildDriverManifest(records, {
    runId,
    policyName,
    policyRecord,
    policy,
    pin,
    sandbox,
    approvalPolicy,
    turnPricing: pricing,
    baselines,
    driverAuth: auth,
  });
  // Without a codex home to read, nothing is observed: a caller that names none never reads the person's own.
  const observed = driver.codexHome
    ? observedSessionModels(built.thread_ids ?? [], { codexHome: driver.codexHome, pin, policyName })
    : null;
  const manifest = { ...built, driver_model_observed: observed };
  writeFileAtomic(join(runDir, "driver-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { rows, manifest };
}

/** The collector's booked figure, copied into driver-manifest.json beside the exec stream's own. */
export function bookCollectedUsage(runDir, driverManifest, report) {
  const cc = report.cross_check;
  const merged = {
    ...driverManifest,
    driver_cost_usd_exec_stream: driverManifest.driver_cost_usd_modeled,
    driver_cost_usd_modeled: report.cost_usd_modeled,
    driver_cost_source: report.cost_source,
    driver_verified: report.verified,
    driver_cost_complete: report.cost_complete,
    driver_cross_check: cc
      ? { verdict: cc.verdict, verified: cc.verified, exec_stream_cost_usd: cc.exec_stream_cost_usd, missing_invocations: cc.missing_invocations }
      : null,
  };
  writeFileAtomic(join(runDir, "driver-manifest.json"), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

/**
 * Collects the conductor's cost into driver-usage.json. Never throws, and a
 * figure it cannot collect is a note: the run's outcome stands either way.
 */
function collectConductorUsage(ctx, { route, codexHome, env, notes }) {
  const warn = (m) => notes.push(`driver usage: ${String(m).replace(/^collect-driver-usage: /, "")}`);
  // In the conductor's own shell the closing turn gets a marker; elsewhere the window closes at the last one.
  const fromConductor = route === "interactive" && Boolean(env.CODEX_THREAD_ID);
  if (route === "interactive" && !fromConductor) {
    notes.push("driver usage: end-run.mjs ran outside the codex session, so the turns after the last dispatch are not in the conductor's figure");
  }
  let result;
  try {
    result = collectDriverUsage(ctx.runDir, {
      env,
      codexHome,
      route,
      policy: ctx.driver?.policy,
      projectRoot: ctx.projectRoot,
      fromConductor,
      warn,
    });
  } catch (err) {
    result = { ok: false, message: err?.message ?? String(err) };
  }
  if (!result.ok) notes.push(`driver usage: not collected (${String(result.message).replace(/; pass --thread=<id>$/, "")})`);
  return result;
}

/** The run's cost as the report books it, for the run.cost log line and the console. */
export function runCost(runDir) {
  const { totals: t, driver } = summarize(readRun(runDir));
  return {
    dispatched_usd: t.dispatched_usd,
    driver_usd_modeled: t.driver_usd,
    driver_bound: t.driver_bound,
    run_total_usd: t.run_total_usd,
    run_total_bound: t.run_total_bound,
    vendor_metered_usd: t.vendor_metered_usd,
    modeled_usd: t.modeled_usd,
    driver_turns_incomplete: driver.turns_incomplete,
    driver_turns_incomplete_unpriced: driver.turns_incomplete_unpriced,
    driver_turns_incomplete_covered: driver.turns_incomplete_covered,
  };
}

const STATUS_FOR_OUTCOME = { max_turns: "incomplete", codex_failed: "failed" };

/**
 * manifest.json's status for a run that ended with `outcome`. A completed run
 * keeps the status the conductor's Gate 4 re-run gave it, which says whether
 * a person or the gate mode accepted it; the Gate 4 line's wording is only
 * the fallback.
 */
export function manifestStatus(outcome, runDir) {
  if (outcome === "completed") {
    const { ok, status } = codeWrittenSummary(runDir);
    if (ok && ACCEPTED_STATUSES.includes(status)) return status;
    return /^auto-approved$/i.test(gateDecision(gate4Acceptance(runDir))) ? "auto-approved" : "accepted";
  }
  return STATUS_FOR_OUTCOME[outcome] ?? outcome;
}

function filesTouched(runDir) {
  const path = join(runDir, "provenance.json");
  if (!existsSync(path)) return null;
  try {
    const list = JSON.parse(readFileSync(path, "utf-8"))?.files_touched;
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

/**
 * Ends a brownfield run's write contract with the run's outcome: the lock's
 * end record, the provenance record closed, the contract switched off. A run
 * that never froze one, or whose close-out already ended it, is left as it
 * is. Returns {contract, notes, lines}: notes are warnings, lines say what
 * the end did.
 */
export function endWriteContract({ projectRoot, runDir, runId, mode, outcome, reason }) {
  const notes = [];
  const lines = [];
  if (mode === "greenfield") return { contract: null, notes, lines };
  let contract = null;
  try {
    contract = endRun({ projectRoot, runId, outcome, reason: reason ?? null });
  } catch (err) {
    notes.push(`write contract: not ended (${err?.message ?? err}). End it with: ${abandonCommand(runId, projectRoot)}`);
    return { contract, notes, lines };
  }
  if (contract.ended) {
    lines.push(`write contract: ended (${outcome})${contract.switched_off ? ", switched off" : ""}`);
  }
  if (contract.provenance?.error) notes.push(`provenance.json was not closed: ${contract.provenance.error}`);
  const touched = contract.found ? filesTouched(runDir) : null;
  if (touched) lines.push(`Undo:        $mmo-codex:revert ${runId} (${touched} file(s) in provenance.json)`);
  return { contract, notes, lines };
}

/**
 * ctx: {route, projectRoot, runDir, runId, mode, outcome, deliberate, reason,
 * policyName, codeDir, records, driver, env, codexHome}. `route` is
 * 'headless' (run.mjs, the default) or 'interactive' (end-run.mjs). `driver`
 * carries what pricing the conductor needs: {policy, model, policyName,
 * policyVersion, policyRecord, pin, sandbox, approvalPolicy, auth}; an
 * interactive run has no driver-events.jsonl, so it has neither `driver` nor
 * driver files to regenerate. Returns {driverManifest, driverUsage, manifest,
 * contract, notes, contractLines, reportPath, cost}; a step that fails is a
 * note, never a failed run end.
 */
export async function finalizeRun(ctx) {
  const env = ctx.env ?? process.env;
  const codexHome = ctx.codexHome ?? ctx.driver?.codexHome ?? defaultCodexHome(env);
  const notes = [];
  let driverManifest = null;
  const route = ctx.route === "interactive" ? "interactive" : "headless";
  if (route === "headless") {
    try {
      const records = ctx.records ?? readRunRecords(ctx.runDir);
      ({ manifest: driverManifest } = regenerateDriverFiles({
        runDir: ctx.runDir,
        runId: ctx.runId,
        records,
        driver: { policyName: ctx.policyName, codexHome, ...ctx.driver },
      }));
    } catch (err) {
      notes.push(`driver-cost-modeled.jsonl and driver-manifest.json were not rewritten: ${err?.message ?? err}`);
    }
  }
  // Before the manifest and the report, which book the figure it writes.
  const collected = collectConductorUsage(ctx, { route, codexHome, env, notes });
  if (collected.ok && driverManifest) {
    try {
      driverManifest = bookCollectedUsage(ctx.runDir, driverManifest, collected.report);
    } catch (err) {
      notes.push(`driver-manifest.json: the collected figure was not copied in (${err?.message ?? err})`);
    }
  }
  // Before the manifest: its brownfield file count reads the provenance record this closes.
  const ended = endWriteContract(ctx);
  notes.push(...ended.notes);
  let manifest = null;
  try {
    // The completed run's SUMMARY.md is rendered again, now with the conductor's final figure.
    const r = writeManifest({
      runDir: ctx.runDir,
      runId: ctx.runId,
      policy: ctx.policyName,
      projectRoot: ctx.projectRoot,
      codeDir: ctx.codeDir,
      status: manifestStatus(ctx.outcome, ctx.runDir),
      summary: ctx.outcome === "completed",
    });
    manifest = r.manifest;
    notes.push(...r.notes.map((n) => `manifest.json: ${n}`));
  } catch (err) {
    notes.push(`manifest.json was not written: ${err?.message ?? err}`);
  }
  let reportPath = null;
  let cost = null;
  try {
    reportPath = writeReport(ctx.runDir);
    cost = runCost(ctx.runDir);
  } catch (err) {
    notes.push(`report.md was not written: ${err?.message ?? err}`);
  }
  return {
    driverManifest,
    driverUsage: collected.ok ? collected.report : null,
    manifest,
    contract: ended.contract,
    notes,
    contractLines: ended.lines,
    reportPath,
    cost,
  };
}
