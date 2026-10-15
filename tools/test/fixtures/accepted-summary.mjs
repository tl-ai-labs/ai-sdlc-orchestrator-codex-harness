/** The SUMMARY.md Phase 9's command writes when it runs again after Gate 4, which a completed run needs. */
import { writeManifest } from "../../../plugin/scripts/write-manifest.mjs";

export function acceptedSummary(runDir, { runId = "r1", status = "accepted", policy = "gpt-plus-flash" } = {}) {
  return writeManifest({ runDir, runId, policy, status, summary: true });
}
