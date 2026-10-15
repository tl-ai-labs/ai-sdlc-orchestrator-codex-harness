/** A temp CODEX_HOME whose sessions/ holds one rollout per thread, each ending on the given model and effort. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sessionHome(threads, { model = "gpt-5.6-terra", effort = "high" } = {}) {
  const codexHome = mkdtempSync(join(tmpdir(), "session-home-"));
  const dir = join(codexHome, "sessions", "2026", "10", "13");
  mkdirSync(dir, { recursive: true });
  for (const thread of threads) {
    const payload = { turn_id: "t1", model, ...(effort ? { effort } : {}) };
    const line = JSON.stringify({ timestamp: "2026-10-13T10:00:00.000Z", type: "turn_context", payload });
    writeFileSync(join(dir, `rollout-2026-10-13T10-00-00-${thread}.jsonl`), `${line}\n`);
  }
  return codexHome;
}
