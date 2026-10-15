/**
 * The record a run started from a `$mmo-codex:*` skill keeps in its folder:
 * `run.json` (route, settings, each start, how it ended), the outcomes it may
 * end with, and the evidence a completed run needs. No dependency outside
 * node, like render.mjs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCEPTED_STATUSES, codeWrittenSummary } from "../scripts/lib/run-summary.mjs";
import { GATE4_ACCEPTED, gateDecision, latestGateLine, readGateLines } from "../scripts/lib/gate-record.mjs";

export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RUN_JSON = "run.json";
export const RUN_JSON_VERSION = 1;
export const ROUTE = "interactive";

/** How a run in a session may end. `deliberate` matches run-record.mjs's OUTCOMES. */
export const INTERACTIVE_OUTCOMES = {
  completed: { deliberate: null, when: "Gate 4 is recorded as accepted and Phase 9's command ran again with --status=accepted" },
  aborted: { deliberate: true, when: "a gate was answered abort, or the user stopped the run" },
  halted: { deliberate: true, when: "preflight returned ok: false, or a pre-check step failed" },
  refused: { deliberate: true, when: "the write guard refused a write and the run stopped" },
  cost_cap: { deliberate: true, when: "a dispatch failed with COST_CAP_EXCEEDED" },
  stopped: { deliberate: true, when: "any other deliberate stop" },
  failed: { deliberate: false, when: "an error the run could not get past" },
};

/** What the model does at a gate in a session, per --gates. */
export const INTERACTIVE_GATE_MODES = {
  prompt:
    "The user is in this session. At each gate, print the gate block and wait for their reply; " +
    "never answer a gate for them.",
  "auto-approve":
    "Unattended replay. At each gate, print the gate block, record the decision as auto-approved, " +
    "and continue without waiting. If an artifact looks wrong enough that a reviewer would reject " +
    "it, say so in the gate record.",
  "auto-abort":
    "At the first gate, print the gate block, record the decision as aborted, and end the run there " +
    "(outcome aborted).",
};

export const GATE_RECORD =
  'Record every gate decision as a new line in gates.jsonl in the run folder: {"gate": N, ' +
  '"artifact": "<file>", "decision": "<approved|revise|aborted|accepted|rejected|auto-approved>", ' +
  '"note": "<one line>", "ts": "<ISO 8601 time>"}. The answer goes under "decision", never "status".';

/** The run-log vocabulary orchestrator.log speaks (Claude parity): completed, aborted or failed. */
export function runLogOutcome(outcome) {
  if (outcome === "completed") return "completed";
  if (outcome === "failed") return "failed";
  return "aborted";
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/** `--k=v` and `--k v`; an unknown flag, a stray word or a missing value is a UsageError. */
export function parseFlags(argv, { value = [], boolean = [], script, hints = {} }) {
  const args = {};
  const known = () => [...value, ...boolean].map((f) => `--${f}`).join(", ");
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    if (!raw.startsWith("--") || raw === "--") {
      throw new UsageError(`unexpected argument '${raw}': every ${script} option is a --flag. Known flags: ${known()}.`);
    }
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (Object.prototype.hasOwnProperty.call(args, name)) throw new UsageError(`--${name} is given more than once.`);
    if (boolean.includes(name)) {
      const v = eq === -1 ? "true" : raw.slice(eq + 1);
      if (v !== "true" && v !== "false") throw new UsageError(`--${name} takes no value (or =true / =false).`);
      args[name] = v === "true";
    } else if (value.includes(name)) {
      let v = eq === -1 ? argv[i + 1] : raw.slice(eq + 1);
      if (eq === -1) {
        if (v === undefined || String(v).startsWith("--")) throw new UsageError(`--${name} needs a value (--${name}=<value>).`);
        i += 1;
      }
      if (String(v) === "") throw new UsageError(`--${name} needs a value (--${name}=<value>).`);
      args[name] = String(v);
    } else {
      throw new UsageError(hints[name] ?? `unknown flag --${name}. Known flags: ${known()}.`);
    }
  }
  return args;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function readRunJson(runDir) {
  const path = join(runDir, RUN_JSON);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRunJson(runDir, record) {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, RUN_JSON);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** Every gates.jsonl line that parses, in order. */
export const gateLines = readGateLines;

/**
 * What a completed session run needs: the SUMMARY.md write-manifest.mjs wrote
 * when Phase 9's command ran again with an accepted status, and the latest
 * Gate 4 line accepting it (a later reject sends the run back for changes).
 */
export function checkCompleted(runDir) {
  const exists = existsSync(join(runDir, "SUMMARY.md"));
  const byCode = exists ? codeWrittenSummary(runDir) : null;
  const summary = byCode?.ok === true && ACCEPTED_STATUSES.includes(byCode.status);
  const gate4 = latestGateLine(readGateLines(runDir), 4);
  const gate4Decision = gate4 ? gateDecision(gate4) : null;
  const missing = [];
  if (!exists) missing.push("SUMMARY.md in the run folder (Phase 9)");
  else if (!byCode.ok) missing.push(`a SUMMARY.md written by Phase 9's command (${byCode.reason})`);
  else if (!summary) {
    missing.push(`Phase 9's command run again with --status=accepted after Gate 4 (manifest.json's status is ${byCode.status})`);
  }
  if (!gate4) missing.push("a Gate 4 line in gates.jsonl");
  else if (!GATE4_ACCEPTED.includes(gate4Decision)) missing.push(`Gate 4 accepted (the latest Gate 4 line says '${gate4Decision}')`);
  return { summary, gate4Decision, ok: missing.length === 0, missing };
}

export function pluginVersion(pluginRoot = PLUGIN_ROOT) {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf-8")).version ?? null;
  } catch {
    return null;
  }
}

/** Job types from plugin/config/intents.json. */
export function intentIds(pluginRoot = PLUGIN_ROOT) {
  const raw = JSON.parse(readFileSync(join(pluginRoot, "config", "intents.json"), "utf-8"));
  return (Array.isArray(raw) ? raw : (raw.intents ?? [])).map((i) => i.id);
}
