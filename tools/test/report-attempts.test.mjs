/**
 * A dispatch's later attempts in the report: an output-cap doubling lists the
 * packet under the output cap, a transient resend lists it apart, and neither
 * changes what the packet cost.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRun, render, summarize } from "../../plugin/scripts/report.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(events) {
  const dir = mkdtempSync(join(tmpdir(), "report-attempts-"));
  dirs.push(dir);
  writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return summarize(readRun(dir));
}

const attempt = (o) => ({
  ts: "2026-10-13T10:00:00Z", pass: "r1", phase: "senior_code_review", task_id: "p1", model: "gpt-5.6-terra",
  provenance: "vendor", input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.0032,
  success: true, ceiling_used: 4000, ...o,
});
// An OpenAI 429 keeps the prompt estimate: 68 tokens at $2.00/M is $0.000136.
const RATE_LIMITED = attempt({ attempt_number: 1, provenance: "estimated", error_status: 429, input_tokens: 68, output_tokens: 0, cost_usd: 0.000136, success: false });

test("a packet resent after a 429 is not listed as hitting the output cap", () => {
  const r = run([RATE_LIMITED, attempt({ attempt_number: 2, retry_reason: "transient" })]);
  assert.deepEqual(r.retried, []);
  assert.deepEqual(r.resent, [{ task_id: "p1", phase: "senior_code_review", attempts: 2, resends: 1, cost_usd: 0.003336 }]);
  assert.equal(r.totals.dispatched_usd, 0.003336, "both requests stay in the dispatched total");

  const text = render(r);
  assert.doesNotMatch(text, /output cap/i);
  assert.match(text, /Packets resent after a transient failure\n\n.*p1\s+senior_code_review\s+1 resend, 2 attempts → \$0\.0033/);
  const md = render(r, { markdown: true });
  assert.doesNotMatch(md, /output cap/i);
  assert.ok(md.includes("| `p1` | senior_code_review | 1 | 2 | $0.0033 |"), md);
});

test("a doubled ceiling still lists the packet under the output cap", () => {
  const r = run([
    attempt({ attempt_number: 1, success: false, output_tokens: 4000, cost_usd: 0.05 }),
    attempt({ attempt_number: 2, ceiling_used: 8000, retry_reason: "output_cap", cost_usd: 0.06 }),
  ]);
  assert.deepEqual(r.retried, [{ task_id: "p1", phase: "senior_code_review", attempts: 2, final_ceiling: 8000, cost_usd: 0.11 }]);
  assert.deepEqual(r.resent, []);
  assert.ok(render(r, { markdown: true }).includes("| `p1` | senior_code_review | 2 | 8000 | $0.1100 |"));
});

test("a later attempt with no retry_reason is a doubling, as telemetry before the field recorded it", () => {
  const r = run([
    attempt({ model: "gemini-3.7-flash", attempt_number: 1, ceiling_used: 2000, cost_usd: 0.01 }),
    attempt({ model: "gemini-3.7-flash", attempt_number: 2, ceiling_used: 4000, cost_usd: 0.02 }),
  ]);
  assert.equal(r.retried.length, 1);
  assert.equal(r.retried[0].final_ceiling, 4000);
  assert.deepEqual(r.resent, []);
});

test("a packet resent and then doubled is in both lists, with every attempt counted once", () => {
  const r = run([
    RATE_LIMITED,
    attempt({ attempt_number: 2, retry_reason: "transient", success: false, output_tokens: 4000, cost_usd: 0.05 }),
    attempt({ attempt_number: 3, ceiling_used: 8000, retry_reason: "output_cap", cost_usd: 0.06 }),
  ]);
  assert.deepEqual(r.retried.map((p) => [p.task_id, p.attempts, p.final_ceiling, p.cost_usd]), [["p1", 3, 8000, 0.110136]]);
  assert.deepEqual(r.resent.map((p) => [p.task_id, p.attempts, p.resends, p.cost_usd]), [["p1", 3, 1, 0.110136]]);
  assert.equal(r.totals.dispatched_usd, 0.110136);
});

test("a packet dispatched again from attempt 1 is neither capped nor resent", () => {
  const r = run([
    attempt({ attempt_number: 1, retry_count: 0, success: false }),
    attempt({ attempt_number: 1, retry_count: 1 }),
  ]);
  assert.deepEqual(r.retried, []);
  assert.deepEqual(r.resent, []);
});
