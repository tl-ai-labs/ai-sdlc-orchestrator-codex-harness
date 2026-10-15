import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One reading of a run's gates.jsonl for every reader: the stop check, both
 * completion checks, the brownfield close-out and the manifest. The prompts
 * ask for {gate, artifact, decision, note, ts}; conductors have also written
 * the answer under `status` and the gate as "gate-4", so both are read.
 */
export const GATES_FILE = "gates.jsonl";

const ALIASES = {
  accept: "accepted",
  approve: "approved",
  abort: "aborted",
  reject: "rejected",
  "auto-approve": "auto-approved",
};

/** Gate 4 answers that finish a run. */
export const GATE4_ACCEPTED = Object.freeze(["accepted", "approved", "auto-approved"]);

export function gateNumber(line) {
  const g = line?.gate;
  if (typeof g === "number") return Number.isInteger(g) ? g : null;
  const m = /(\d+)/.exec(String(g ?? ""));
  return m ? Number(m[1]) : null;
}

/** The answer, trimmed and lowercased, with the reply words the gate prompts offer mapped to their recorded form. */
export function gateDecision(line) {
  const raw = String(line?.decision ?? line?.status ?? "").trim().toLowerCase();
  return ALIASES[raw] ?? raw;
}

export function isAbortDecision(decision) {
  return /^abort/.test(String(decision ?? ""));
}

export function parseGateLines(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && !Array.isArray(rec)) out.push(rec);
    } catch { /* a torn or hand-edited line is skipped */ }
  }
  return out;
}

export function readGateLines(runDir) {
  const path = join(runDir, GATES_FILE);
  if (!existsSync(path)) return [];
  try {
    return parseGateLines(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

export function latestGateLine(lines, gate) {
  for (let i = lines.length - 1; i >= 0; i--) if (gateNumber(lines[i]) === gate) return lines[i];
  return null;
}

/** The latest Gate 4 line when it accepts the run, else null: a later rejection sends the run back. */
export function gate4Accepted(lines) {
  const last = latestGateLine(lines, 4);
  return last && GATE4_ACCEPTED.includes(gateDecision(last)) ? last : null;
}

/** completed, aborted, or null while neither is recorded. Any abort ends the run. */
export function gatesOutcome(lines) {
  if (lines.some((l) => isAbortDecision(gateDecision(l)))) return "aborted";
  return gate4Accepted(lines) ? "completed" : null;
}

/** A gates.jsonl line in the shape the prompts ask for, for the lines code writes itself. */
export function gateLine({ gate, artifact = null, decision, note = null, ...extra }, now = new Date()) {
  return { gate, artifact, decision, note, ts: now.toISOString(), ...extra };
}
