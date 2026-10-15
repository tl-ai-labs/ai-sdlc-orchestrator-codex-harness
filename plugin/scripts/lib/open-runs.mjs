/**
 * The runs of a project that have not recorded their end, read from their own folders under `.sdlc/runs/`:
 * `state.json` (the gate a run is waiting on), `run.json` (a session run's record) and `driver-events.jsonl`
 * (run.mjs's). A live write-contract lock makes a run open whatever its folder says: it binds every session.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readLock, readRegular, readRegularTail } from "./contract-lock.mjs";
import { isRunId, runDirFor } from "./run-id.mjs";

const TERMINAL_STATUSES = new Set(["complete", "completed", "aborted", "failed"]);
const RECORD_MAX_BYTES = 4 * 1024 * 1024;

function readObject(path) {
  const bytes = readRegular(path, RECORD_MAX_BYTES);
  if (!bytes) return null;
  try {
    const v = JSON.parse(bytes.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** run.mjs writes run_end last, so a driver record whose last line is not one has no end. */
function driverEnded(runDir) {
  const tail = readRegularTail(join(runDir, "driver-events.jsonl"), 64 * 1024)?.toString("utf8");
  if (tail === undefined) return null;
  const last = tail.split("\n").filter((l) => l.trim()).at(-1);
  try {
    return JSON.parse(last)?.kind === "run_end";
  } catch {
    return false;
  }
}

const iso = (v) => (typeof v === "string" && v ? v : null);

/**
 * Open runs, newest first, leaving out `exclude` (the run asking). Each is
 * {run_id, route, mode, phase, checkpoint, status, gate_pending, write_contract, at}: `write_contract` is "live" for
 * a run whose lock binds, else null; `gate_pending` says its state.json names a gate it never got past.
 */
export function openRuns(projectRoot, { exclude = null } = {}) {
  let names;
  try {
    names = readdirSync(join(projectRoot, ".sdlc", "runs"));
  } catch {
    return [];
  }
  const runs = [];
  for (const id of names.filter(isRunId).sort()) {
    if (id === exclude) continue;
    const dir = runDirFor(projectRoot, id);
    const lock = readLock(projectRoot, id);
    const state = readObject(join(dir, "state.json"));
    const session = readObject(join(dir, "run.json"));
    const ended = driverEnded(dir);
    const gatePending = !!state && typeof state.status === "string" && !TERMINAL_STATUSES.has(state.status);
    const live = !!lock && !lock.ended_at;
    let open;
    if (lock) open = live;
    else if (session) open = session.outcome === null || session.outcome === undefined;
    else open = gatePending && ended !== true;
    if (!open) continue;
    runs.push({
      run_id: id,
      route: session?.route ?? (ended === null ? null : "headless"),
      mode: session?.mode ?? null,
      phase: state?.phase ?? null,
      checkpoint: state?.checkpoint ?? state?.next_packet_index ?? null,
      status: live ? "live" : gatePending ? state.status : "interrupted",
      gate_pending: gatePending,
      write_contract: live ? "live" : null,
      at: iso(state?.at) ?? iso(state?.timestamp) ?? iso(state?.updated_at) ?? iso(session?.starts?.at?.(-1)?.at) ??
        iso(session?.started_at) ?? iso(lock?.frozen_at),
    });
  }
  return runs.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || b.run_id.localeCompare(a.run_id));
}
