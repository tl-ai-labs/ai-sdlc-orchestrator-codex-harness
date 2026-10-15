import { join } from "node:path";

/** A run id names a folder under .sdlc/runs/, so it never holds a separator or starts with a dot. */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isRunId(value) {
  return typeof value === "string" && RUN_ID_RE.test(value);
}

export function runDirFor(projectRoot, runId) {
  return join(projectRoot, ".sdlc", "runs", runId);
}
