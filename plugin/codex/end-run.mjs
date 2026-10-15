#!/usr/bin/env node
/**
 * Records how a run started by start-run.mjs ended: updates run.json, logs
 * run.end to the run's orchestrator.log, then runs the run-end steps
 * (finalizeRun with route 'interactive'): the conductor's cost read from its
 * codex session file into driver-usage.json, a brownfield run's write
 * contract ended with this outcome unless its close-out already did,
 * manifest.json and report.md.
 *
 * Usage:
 *   node end-run.mjs --run-dir=<path> --outcome=<outcome> [--reason=<one line>]
 *
 * Outcomes: completed (needs an accepted Gate 4 line and the SUMMARY.md that
 * Phase 9's command wrote when it ran again with --status=accepted), aborted,
 * halted, refused, cost_cap, stopped, failed. Every outcome but completed
 * needs --reason.
 *
 * Exit codes: 0 recorded, 1 recorded but a run-end step failed (re-run the
 * same command: an end already recorded with that outcome is kept, and only
 * the run-end steps run again), 2 usage error or refused (nothing written).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCompleted,
  INTERACTIVE_OUTCOMES,
  parseFlags,
  PLUGIN_ROOT,
  readRunJson,
  ROUTE,
  RUN_JSON,
  runLogOutcome,
  shellQuote,
  UsageError,
  writeRunJson,
} from "./interactive-run.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { finalEndRefusal } from "../scripts/write-contract.mjs";
import { configureSinks, log } from "../scripts/lib/log.mjs";
import { exitAfterFlush } from "../scripts/lib/exit.mjs";

export const END_FLAGS = Object.freeze({ value: ["run-dir", "outcome", "reason"], boolean: [] });

export function parseEndArgs(argv) {
  return parseFlags(argv, { ...END_FLAGS, script: "end-run.mjs" });
}

/** The cost report script: inside the plugin once it moves there, else beside it in a clone. */
export function reportScript(pluginRoot = PLUGIN_ROOT) {
  for (const p of [join(pluginRoot, "scripts", "report.mjs"), resolve(pluginRoot, "..", "tools", "report.mjs")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Validates and writes the end record. Returns what main prints; throws UsageError with nothing written. */
export function recordEnd(args, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ? new Date(deps.now()) : new Date();
  if (!args["run-dir"]) throw new UsageError("--run-dir=<path> is required: the run folder start-run.mjs printed.");
  const outcome = args.outcome;
  if (!outcome || !(outcome in INTERACTIVE_OUTCOMES)) {
    throw new UsageError(`--outcome=${outcome ?? ""} is not one of ${Object.keys(INTERACTIVE_OUTCOMES).join(", ")}.`);
  }
  const reason = args.reason?.trim() || null;
  if (outcome !== "completed" && !reason) throw new UsageError(`--outcome=${outcome} needs --reason='<one line>'.`);

  const runDir = resolve(cwd, args["run-dir"]);
  const run = readRunJson(runDir);
  if (!run || run.route !== ROUTE) {
    const how = existsSync(join(runDir, "driver-events.jsonl"))
      ? "it was started by run.mjs, which records how its run ends itself"
      : "start-run.mjs writes one when a run starts in a session";
    throw new UsageError(`no interactive ${RUN_JSON} in ${runDir}: ${how}.`);
  }
  if (run.outcome === "completed" && outcome !== "completed") {
    throw new UsageError(`run ${run.run_id} already completed; it cannot end again as ${outcome}.`);
  }
  if (run.outcome === outcome) return { run, runDir, repeated: true };
  if (outcome === "completed") {
    const evidence = checkCompleted(runDir);
    if (!evidence.ok) {
      throw new UsageError(
        `run ${run.run_id} has not completed: it needs ${evidence.missing.join(" and ")}. ` +
          "Finish Phase 9 and Gate 4 first, or record how it stopped (for example --outcome=stopped --reason='<why>').",
      );
    }
  }

  const deliberate = INTERACTIVE_OUTCOMES[outcome].deliberate;
  const ended = { ...run, ended_at: now.toISOString(), outcome, deliberate, reason };
  writeRunJson(runDir, ended);
  configureSinks({ runLogPath: join(runDir, "orchestrator.log") });
  log(outcome === "completed" ? "info" : "warn", "run.end", {
    run_id: run.run_id,
    route: ROUTE,
    outcome: runLogOutcome(outcome),
    driver_outcome: outcome,
    reason: reason ?? undefined,
  });
  return { run: ended, runDir, repeated: false };
}

export async function main(argv = [], deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const pluginRoot = deps.pluginRoot ?? PLUGIN_ROOT;
  let recorded;
  try {
    recorded = recordEnd(parseEndArgs(argv), deps);
  } catch (err) {
    stderr.write(`end-run: ${err?.message ?? err}\n`);
    return err?.name === "UsageError" ? 2 : 1;
  }
  const { run, runDir, repeated } = recorded;
  let code = 0;
  let notes = [];
  let contractLines = [];
  let out = null;
  try {
    const { finalizeRun } = await (deps.loadFinalize ?? (() => import("./run-finalize.mjs")))();
    out = await finalizeRun({
      route: ROUTE,
      projectRoot: run.project_root,
      runDir,
      runId: run.run_id,
      mode: run.mode,
      outcome: run.outcome,
      deliberate: run.deliberate,
      reason: run.reason,
      policyName: run.policy,
      codeDir: run.code_dir,
      env: deps.env ?? process.env,
    });
    notes = Array.isArray(out?.notes) ? out.notes : [];
    contractLines = Array.isArray(out?.contractLines) ? out.contractLines : [];
    if (out?.cost) {
      configureSinks({ runLogPath: join(runDir, "orchestrator.log") });
      log("info", "run.cost", { run_id: run.run_id, route: ROUTE, ...out.cost, driver_provenance: "modeled" });
    }
  } catch (err) {
    stderr.write(
      `end-run: the run's end is recorded, but a run-end step failed: ${err?.message ?? err}. Fix it and re-run the same command.\n`,
    );
    code = 1;
  }
  stdout.write(`run ${run.run_id}: ${run.outcome}${run.reason ? ` — ${run.reason}` : ""}\n`);
  if (repeated) stdout.write(`  already recorded at ${run.ended_at}; the record is kept and the run-end steps ran again\n`);
  for (const n of notes) stderr.write(`  ${n}\n`);
  for (const line of contractLines) stdout.write(`  ${line}\n`);
  const usage = out?.driverUsage;
  if (usage) stdout.write(`  driver cost (modeled): $${usage.cost_usd_modeled.toFixed(4)}, ${usage.cost_source}\n`);
  if (out?.cost?.run_total_usd != null) {
    const bound = { floor: "at least ", ceiling: "at most ", mixed: "about " }[out.cost.run_total_bound] ?? "";
    stdout.write(`  run total (dispatched + driver): ${bound}$${out.cost.run_total_usd.toFixed(4)}\n`);
  }
  stdout.write(`  run folder:  ${runDir}\n`);
  if (out?.reportPath) stdout.write(`  report:      ${out.reportPath}\n`);
  const report = reportScript(pluginRoot);
  if (report) stdout.write(`  Cost report: node ${shellQuote(report)} ${shellQuote(runDir)} --markdown\n`);
  else stdout.write(`  Cost report: none in this install; the run's telemetry is ${join(runDir, "telemetry.jsonl")}\n`);
  if (run.outcome !== "completed") {
    const start = join(dirname(fileURLToPath(import.meta.url)), "start-run.mjs");
    const final = run.mode === "greenfield" ? null : finalEndRefusal({ projectRoot: run.project_root, runId: run.run_id });
    const next = final ? `none: ${final}` : `node ${shellQuote(start)} --resume=${run.run_id} --project-root=${shellQuote(run.project_root)}`;
    stdout.write(`  Continue:    ${next}\n`);
  }
  return code;
}

if (isMain(import.meta.url)) {
  exitAfterFlush(await main(process.argv.slice(2)));
}
