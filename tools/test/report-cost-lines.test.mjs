/**
 * The report lines the cost wiring added: the run window, the driver's price
 * record, cached input per phase, the overhead note, and which driver figure
 * is booked once a resumed run has spent past driver-usage.json.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRun, render, summarize } from "../../plugin/scripts/report.mjs";
import { writeManifest } from "../../plugin/scripts/write-manifest.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "report-cost-"));
  dirs.push(dir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), Array.isArray(value) ? jsonl(value) : JSON.stringify(value));
  }
  return dir;
}

const PRICE = {
  model: "gpt-5.6-terra", basis: "list", priced_on: "2026-10-13",
  rates: { input: 2, input_cached: 0.2, output: 12 },
  tiers: [{ above_input_tokens: 272000, input: 4, input_cached: 0.4, output: 18 }],
  source: "https://platform.openai.com/docs/pricing", verified: "2026-10-13", entry_from: "2026-08-09", entry_to: null,
  unpriced_reason: null, warnings: [],
};
const MANIFEST = {
  run_id: "r1", policy: "gpt-plus-flash", started_at: "2026-10-13T10:00:00.000Z", ended_at: "2026-10-13T10:30:00.000Z",
  driver_auth: "api_key", driver_price: PRICE, price_list_verified: "2026-10-13",
};
const ROW = { phase: "driver_loop", status: "complete", provenance: "modeled", thread_id: "t1", input_tokens: 800, input_tokens_cached: 200, output_tokens: 50, cost_usd: 0.00224, price_tier: "standard" };
const EVENTS = [
  { phase: "codegen", provenance: "vendor", input_tokens: 1000, input_tokens_cached: 4000, output_tokens: 100, cost_usd: 0.01 },
  { phase: "debug", provenance: "vendor", input_tokens: 500, input_tokens_cached: 0, output_tokens: 10, cost_usd: 0.002 },
];

test("the header gives the run window, and an API-key driver is pointed at the OpenAI usage dashboard for it", () => {
  const dir = folder({ "driver-manifest.json": MANIFEST, "driver-cost-modeled.jsonl": [ROW], "telemetry.jsonl": EVENTS });
  const r = summarize(readRun(dir));
  assert.deepEqual(r.identity.run_window, { start: MANIFEST.started_at, end: MANIFEST.ended_at, source: "driver-manifest.json" });
  const text = render(r);
  assert.match(text, /Window:\s+2026-10-13T10:00:00\.000Z → 2026-10-13T10:30:00\.000Z \(UTC, from driver-manifest\.json\)/);
  assert.match(text, /Check:\s+The driver signed in with an OpenAI API key: compare its tokens with the OpenAI usage dashboard for this window\./);
  const md = render(r, { markdown: true });
  assert.match(md, /\| Price list \| verified 2026-10-13 \|/);
  assert.match(md, /- Price: gpt-5\.6-terra 2\.00 \/ 0\.20 \/ 12\.00 per 1M input \/ cached \/ output \(price list, verified 2026-10-13\); over 272,000 input tokens 4\.00 \/ 0\.40 \/ 18\.00/);
});

test("an interactive run's window comes from run.json, and a seat driver gets no dashboard line", () => {
  const dir = folder({
    "run.json": { route: "interactive", started_at: "2026-10-13T09:00:00.000Z", ended_at: "2026-10-13T09:20:00.000Z" },
    "driver-usage.json": { cost_usd_modeled: 0.01, source: "session-file", cost_source: "session file (interactive; no exec stream to cross-check; unverified)", tokens: { input_tokens: 1000, output_tokens: 10 } },
  });
  const r = summarize(readRun(dir));
  assert.equal(r.identity.run_window.source, "run.json");
  assert.equal(r.identity.started_at, "2026-10-13T09:00:00.000Z");
  assert.doesNotMatch(render(r), /usage dashboard/);
});

test("an interactive run's Started and Duration rows come from run.json, not from manifest.json's first dispatch or write time", () => {
  const started = "2026-10-13T09:00:00.000Z";
  const dir = folder({ "run.json": { route: "interactive", started_at: started, ended_at: "2026-10-13T09:20:00.000Z" } });
  for (const telemetry of [null, [{ ts: "2026-10-13T09:05:00.000Z", ...EVENTS[0] }, { ts: "2026-10-13T09:06:00.000Z", ...EVENTS[1] }]]) {
    if (telemetry) writeFileSync(join(dir, "telemetry.jsonl"), jsonl(telemetry));
    const m = writeManifest({ runDir: dir, runId: "r1", policy: "gpt-plus-flash", projectRoot: dir, status: "provisional" }).manifest;
    assert.notEqual(m.started_at, started, "the manifest's own start is not the run's");
    const r = summarize(readRun(dir));
    assert.equal(r.identity.started_at, started);
    assert.equal(r.identity.duration_sec, 1200);
    const md = render(r, { markdown: true });
    assert.match(md, /\| Started \| 2026-10-13T09:00:00\.000Z \|\n\| Duration \| 20m 00s \|/);
    assert.match(render(r), /Started:\s+2026-10-13T09:00:00\.000Z\n\s+Duration:\s+20m 00s/);
  }
});

test("phase rows show cached input, and runner overhead says what it holds", () => {
  const dir = folder({ "telemetry.jsonl": EVENTS });
  const r = summarize(readRun(dir));
  assert.equal(r.dispatched.phases[0].cached_input_tokens, 4000);
  const text = render(r);
  assert.match(text, /Calls  Tokens in \/ cached \/ out\s+Cost$/m);
  assert.match(text, /^ {2}codegen\s+V\s+1\s+1\.0K \/ 4\.0K \/ 100\s+\$0\.0100$/m);
  assert.match(text, /Runner overhead is dispatched work outside the SDLC phases: debug retries, refactor passes, the final report/);
  const md = render(r, { markdown: true });
  assert.match(md, /\| `codegen` \| V \| 1 \| 1\.0K \/ 4\.0K \/ 100 \| \$0\.0100 \|/);
});

test("a driver-usage.json a resumed run spent past is passed over for the live rows, with a note", () => {
  const events = [{ v: 1, kind: "invocation_start", invocation: 1, at: "2026-10-13T10:00:00.000Z" }];
  // driver-manifest.json as run.mjs rebuilds it at each invocation end: the exec stream's figure.
  const dir = folder({ "driver-events.jsonl": events, "driver-cost-modeled.jsonl": [ROW, { ...ROW, cost_usd: 0.003 }], "driver-manifest.json": { ...MANIFEST, driver_cost_usd_modeled: 0.00524 } });
  const inputs = { "driver-events.jsonl": statSync(join(dir, "driver-events.jsonl")).size, "driver-session.jsonl": 0 };
  writeFileSync(join(dir, "driver-usage.json"), JSON.stringify({ cost_usd_modeled: 0.00224, source: "session-file", cost_source: "session file + exec stream (every invocation equal)", verified: true, inputs }));
  let r = summarize(readRun(dir));
  assert.deepEqual([r.driver.booked_from, r.totals.driver_usd], ["driver-usage.json", 0.00224], "fresh: the collector's figure");

  appendFileSync(join(dir, "driver-events.jsonl"), JSON.stringify({ v: 1, kind: "invocation_start", invocation: 2, at: "2026-10-13T11:00:00.000Z" }) + "\n");
  r = summarize(readRun(dir));
  assert.deepEqual([r.driver.booked_from, r.totals.driver_usd], ["driver-cost-modeled.jsonl", 0.00524]);
  assert.equal(r.driver.stale_collection, true);
  assert.match(r.totals.floor_reasons.join(" "), /driver-usage\.json predates the run's last invocation/);

  const m = writeManifest({ runDir: dir, runId: "r1", policy: "gpt-plus-flash", projectRoot: dir, status: "provisional" }).manifest;
  assert.deepEqual([m.totals.driver_cost_source, m.totals.driver_cost_usd_modeled], ["driver-manifest.json", 0.00524], "the manifest passes over it too");
});
