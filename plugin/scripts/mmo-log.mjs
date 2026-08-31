#!/usr/bin/env node
/**
 * CLI wrapper around plugin/scripts/lib/log.mjs for taxonomy A (run
 * lifecycle) and B (subagent delegation) — the orchestrator is a prompt, not
 * a module, and cannot call log.mjs directly.
 *
 * Usage:
 *   node mmo-log.mjs --event=phase.start --level=info \
 *     --run-id=20260818-110000-bugfix-a7f3 --phase=codegen --form=intent-specific
 *
 * --event, --level, --project-root are reserved (control, never become log
 * fields). Everything else, including --run-id, becomes a field in argv
 * order — --run-id is additionally used to resolve where the run log lives.
 *
 * Fail-open, like write-provenance.mjs: any error warns to stderr and exits
 * 0, because a logging failure must never stop a run.
 */
import { join } from "node:path";
import { log, configureSinks } from "./lib/log.mjs";
import { resolveProjectRoot } from "./lib/env.mjs";

const RESERVED = new Set(["event", "level", "project-root"]);

function parseArgs(argv) {
  const out = { event: null, level: "info", projectRoot: null, fields: [] };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) continue; // this wrapper only accepts --key=value, unlike the scripts it logs
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === "event") out.event = value;
    else if (key === "level") out.level = value;
    else if (key === "project-root") out.projectRoot = value;
    else if (!RESERVED.has(key)) out.fields.push([key.replace(/-/g, "_"), value]);
  }
  return out;
}

function warn(msg) {
  process.stderr.write(`mmo-log: ${msg}\n`);
}

try {
  const { event, level, projectRoot, fields } = parseArgs(process.argv.slice(2));
  if (!event) {
    warn("--event is required, nothing logged");
    process.exit(0);
  }

  const fieldObj = Object.fromEntries(fields);
  const root = resolveProjectRoot(projectRoot);
  const runId = fieldObj.run_id;

  configureSinks({
    runLogPath: runId ? join(root, ".sdlc", "runs", runId, "orchestrator.log") : undefined,
    projectRoot: root,
  });

  log(level, event, fieldObj);
} catch (e) {
  warn(`failed: ${e?.message ?? e}`);
  process.exit(0);
}
