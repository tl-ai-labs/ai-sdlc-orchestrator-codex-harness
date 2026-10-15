import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const SESSION_MARKERS_FILE = "driver-session.jsonl";

/**
 * Appends `{ts, thread_id, tool, policy, pid}` to `<runDir>/driver-session.jsonl`
 * when codex runs this process (it exports CODEX_THREAD_ID into its shells), so
 * the conductor's session file can be found and windowed later. Fails open: a
 * missing marker costs a figure, a thrown one would cost the dispatch.
 */
export function appendSessionMarker(
  runDir,
  { tool, policy = null },
  { env = process.env, now = () => new Date().toISOString(), warn = (m) => console.error(m) } = {},
) {
  const threadId = typeof env.CODEX_THREAD_ID === "string" ? env.CODEX_THREAD_ID.trim() : "";
  if (!runDir || !threadId) return null;
  const marker = { ts: now(), thread_id: threadId, tool, policy, pid: process.pid };
  const path = join(runDir, SESSION_MARKERS_FILE);
  try {
    mkdirSync(runDir, { recursive: true });
    appendFileSync(path, JSON.stringify(marker) + "\n", "utf-8");
    return marker;
  } catch (err) {
    warn(`session marker: could not append to ${path} (${err?.message ?? err}); the conductor's cost for this run may go uncollected.`);
    return null;
  }
}
