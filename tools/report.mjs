#!/usr/bin/env node
/**
 * Post-run cost report for an AI-SDLC pass.
 *
 * Reads two files, and keeps them apart on purpose:
 *
 *   telemetry.jsonl            — every dispatched model call, vendor-metered
 *                                through the bridge. Real usage, real money.
 *   driver-cost-modeled.jsonl  — the conductor's OWN token usage, derived
 *                                from `codex exec --json` turn counts at the
 *                                policy's pinned rates.
 *
 * The second is not measured spend. Codex reports no wallet figures at all
 * (verification doc, section 9), so the driver leg's cost can only ever be
 * modeled — and a driver running on a ChatGPT seat may have cost nothing in
 * actual money while still showing a modeled figure here. Merging the two
 * into one total would produce a number that is neither: not the API bill,
 * not the seat usage. So the modeled line is reported separately, labelled,
 * and excluded from the vendor total. That separation is the point (D4).
 *
 * Usage: node tools/report.mjs <path-to-run-directory> [--markdown]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

import { ACTOR, ACTOR_LEGEND, gutter } from "./logfmt.mjs";

// ─── input ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const asMarkdown = argv.includes("--markdown");
const runDir = resolve(argv.filter((a) => !a.startsWith("--"))[0] ?? "");

if (!runDir || !existsSync(runDir)) {
  console.error("Usage: node tools/report.mjs <path-to-run-directory> [--markdown]");
  console.error("Example: node tools/report.mjs ./.sdlc");
  process.exit(2);
}

const telemetryPath = join(runDir, "telemetry.jsonl");
const modeledPath = join(runDir, "driver-cost-modeled.jsonl");
const manifestPath = join(runDir, "manifest.json");
const driverManifestPath = join(runDir, "driver-manifest.json");

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

const events = readJsonl(telemetryPath);
const modeledEvents = readJsonl(modeledPath);
const manifest = readJson(manifestPath);
const driverManifest = readJson(driverManifestPath);

if (events.length === 0 && modeledEvents.length === 0) {
  console.error(`No telemetry found in ${runDir}.`);
  console.error("Expected telemetry.jsonl (dispatched calls) and/or driver-cost-modeled.jsonl (driver turns).");
  console.error("Confirm the run actually started — a run halted at preflight produces neither.");
  process.exit(2);
}

// ─── aggregation ──────────────────────────────────────────────────────

/** Phases that produce SDLC output; everything else is runner overhead. */
const SDLC_PHASES = new Set([
  "requirements_analysis", "architecture_design", "plan_task_packets",
  "codegen", "tests", "docs", "senior_code_review", "security_review", "test_run",
]);

const phaseAgg = new Map();
let sdlcCost = 0, sdlcCalls = 0;
let overheadCost = 0, overheadCalls = 0;
let totalIn = 0, totalOut = 0, totalCached = 0;
const provCount = { vendor: 0, estimated: 0, modeled: 0, unknown: 0 };
const packetAgg = new Map();

for (const e of events) {
  const phase = e.phase ?? "unknown";
  const isSdlc = SDLC_PHASES.has(phase);
  const tokIn = e.input_tokens ?? 0;
  const tokOut = e.output_tokens ?? 0;
  const cost = e.cost_usd ?? 0;
  const prov = e.provenance ?? "unknown";

  totalIn += tokIn;
  totalOut += tokOut;
  totalCached += e.input_tokens_cached ?? 0;
  if (isSdlc) { sdlcCost += cost; sdlcCalls += 1; }
  else { overheadCost += cost; overheadCalls += 1; }
  provCount[prov in provCount ? prov : "unknown"] += 1;

  const rec = phaseAgg.get(phase) ?? {
    calls: 0, tokIn: 0, tokOut: 0, cost: 0, sdlc: isSdlc,
    prov: { vendor: 0, estimated: 0, modeled: 0, unknown: 0 },
  };
  rec.calls += 1;
  rec.tokIn += tokIn;
  rec.tokOut += tokOut;
  rec.cost += cost;
  rec.prov[prov in rec.prov ? prov : "unknown"] += 1;
  phaseAgg.set(phase, rec);

  // Collapse output-cap doubling attempts into one record per packet.
  const tid = e.task_id;
  if (tid && (e.attempt_number != null || e.ceiling_used != null)) {
    const pkt = packetAgg.get(tid) ?? {
      task_id: tid, phase, model: e.model ?? "?", attempts: 0,
      finalCeiling: e.ceiling_used ?? null, totalCost: 0,
    };
    pkt.attempts += 1;
    if (e.ceiling_used != null) pkt.finalCeiling = e.ceiling_used;
    pkt.totalCost += cost;
    packetAgg.set(tid, pkt);
  }
}

const retried = [...packetAgg.values()].filter((p) => p.attempts > 1).sort((a, b) => b.attempts - a.attempts);

// Driver totals stay in their own accumulators — never folded into the
// vendor figures above.
const driverCost = modeledEvents.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
const driverIn = modeledEvents.reduce((s, e) => s + (e.input_tokens ?? 0), 0);
const driverOut = modeledEvents.reduce((s, e) => s + (e.output_tokens ?? 0), 0);

const vendorTotal = sdlcCost + overheadCost;

/** Per-phase provenance tag. */
function provTag(rec) {
  const kinds = Object.entries(rec.prov).filter(([, n]) => n > 0).map(([k]) => k);
  if (kinds.length > 1) return "~";
  return { vendor: "V", estimated: "E", modeled: "M", unknown: "?" }[kinds[0]] ?? "?";
}

// ─── formatting ───────────────────────────────────────────────────────

const fmtUSD = (n) => `$${n.toFixed(4)}`;
const fmtCompact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtDuration = (sec) => {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
};

const runId = manifest.pass ?? driverManifest.run_id ?? basename(runDir);
const policy = manifest.policy_name ?? driverManifest.policy ?? "—";
const started = manifest.started_at ?? driverManifest.started_at ?? "—";
const duration = fmtDuration(manifest.duration_sec ?? 0);
const pin = driverManifest.pin ?? {};

const out = [];
const p = (s = "") => out.push(s);

// ─── header ───────────────────────────────────────────────────────────

if (asMarkdown) {
  p(`# Run report — ${runId}`);
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| Policy | \`${policy}\` |`);
  if (pin.model) p(`| Model pin | \`${pin.model}\`, effort \`${pin.effort}\` |`);
  p(`| Started | ${started} |`);
  if (duration !== "—") p(`| Duration | ${duration} |`);
  p();
} else {
  const line = "─".repeat(66);
  p();
  p(`┌${line}┐`);
  p(`│ ${`Run report — ${runId}`.padEnd(64)} │`);
  p(`└${line}┘`);
  p();
  p(`  Policy:    ${policy}`);
  if (pin.model) p(`  Model pin: ${pin.model}  ·  effort ${pin.effort}`);
  if (pin.sandbox) p(`  Sandbox:   ${pin.sandbox}  ·  approval ${pin.approval_policy}`);
  p(`  Started:   ${started}`);
  if (duration !== "—") p(`  Duration:  ${duration}`);
  p();
}

// ─── dispatched work ──────────────────────────────────────────────────

const PREFERRED = [
  "requirements_analysis", "architecture_design", "plan_task_packets",
  "codegen", "tests", "docs", "test_run", "senior_code_review", "security_review",
];
const rows = [];
const seen = new Set();
for (const phase of PREFERRED) {
  if (phaseAgg.has(phase)) { rows.push([phase, phaseAgg.get(phase)]); seen.add(phase); }
}
for (const [phase, rec] of phaseAgg) {
  if (!seen.has(phase) && rec.sdlc) rows.push([phase, rec]);
}

if (events.length > 0) {
  if (asMarkdown) {
    p(`## Dispatched work — vendor-metered`);
    p();
    p(`| Phase | Prov | Calls | Tokens (in / out) | Cost |`);
    p(`|---|:---:|---:|---|---:|`);
    for (const [phase, rec] of rows) {
      p(`| \`${phase}\` | ${provTag(rec)} | ${rec.calls} | ${fmtCompact(rec.tokIn)} / ${fmtCompact(rec.tokOut)} | ${fmtUSD(rec.cost)} |`);
    }
    p(`| **SDLC total** | | ${sdlcCalls} | | **${fmtUSD(sdlcCost)}** |`);
    if (overheadCalls > 0) p(`| Runner overhead | | ${overheadCalls} | | ${fmtUSD(overheadCost)} |`);
    p(`| **Vendor-metered total** | | | | **${fmtUSD(vendorTotal)}** |`);
    p();
  } else {
    p(`  Dispatched work — vendor-metered`);
    p();
    p(`  ${"Phase".padEnd(24)}${"Prov".padStart(6)}${"Calls".padStart(7)}${"Tokens (in / out)".padStart(22)}${"Cost".padStart(11)}`);
    p(`  ${"─".repeat(70)}`);
    for (const [phase, rec] of rows) {
      const tok = `${fmtCompact(rec.tokIn)} / ${fmtCompact(rec.tokOut)}`;
      p(`  ${phase.padEnd(24)}${provTag(rec).padStart(6)}${String(rec.calls).padStart(7)}${tok.padStart(22)}${fmtUSD(rec.cost).padStart(11)}`);
    }
    // Column widths must match the row format above (24+6 label, 7 calls,
    // 22 tokens, 11 cost) or the totals drift out of their columns.
    p(`  ${"─".repeat(70)}`);
    p(`  ${"SDLC total".padEnd(30)}${String(sdlcCalls).padStart(7)}${"".padStart(22)}${fmtUSD(sdlcCost).padStart(11)}`);
    if (overheadCalls > 0) {
      p(`  ${"Runner overhead".padEnd(30)}${String(overheadCalls).padStart(7)}${"".padStart(22)}${fmtUSD(overheadCost).padStart(11)}`);
    }
    p(`  ${"Vendor-metered total".padEnd(59)}${fmtUSD(vendorTotal).padStart(11)}`);
    p();
  }
} else {
  p(asMarkdown ? `## Dispatched work\n\n_No dispatched calls recorded._\n` : `  No dispatched calls recorded.\n`);
}

// ─── modeled driver cost — deliberately its own section ───────────────

if (asMarkdown) {
  p(`## Driver loop — modeled, not measured`);
  p();
  if (modeledEvents.length === 0) {
    p(`_No driver turns recorded._`);
  } else {
    p(`| Turns | Tokens (in / out) | Modeled cost |`);
    p(`|---:|---|---:|`);
    p(`| ${modeledEvents.length} | ${fmtCompact(driverIn)} / ${fmtCompact(driverOut)} | ${fmtUSD(driverCost)} |`);
    p();
    p(`> Codex reports no wallet or usage figures, so this is derived from turn token`);
    p(`> counts at the policy's pinned rates. It is **not** an amount anyone was billed —`);
    p(`> a driver running on a ChatGPT seat may have cost nothing in money at all. It is`);
    p(`> reported separately, and excluded from the vendor total above, for that reason.`);
  }
  p();
} else {
  p(`  Driver loop — modeled, not measured`);
  p();
  if (modeledEvents.length === 0) {
    p(`  No driver turns recorded.`);
  } else {
    p(`  ${"Turns".padEnd(24)}${String(modeledEvents.length).padStart(13)}`);
    p(`  ${"Tokens (in / out)".padEnd(24)}${`${fmtCompact(driverIn)} / ${fmtCompact(driverOut)}`.padStart(13)}`);
    p(`  ${"Modeled cost".padEnd(24)}${fmtUSD(driverCost).padStart(13)}`);
    p();
    p(`  Codex reports no wallet figures, so this is derived from turn token counts`);
    p(`  at the pinned rates. It is NOT an amount anyone was billed — a driver on a`);
    p(`  ChatGPT seat may have cost nothing in money. Kept out of the vendor total.`);
  }
  p();
}

// ─── retries ──────────────────────────────────────────────────────────

if (retried.length > 0) {
  if (asMarkdown) {
    p(`## Packets that hit the output cap`);
    p();
    p(`| Packet | Phase | Attempts | Final ceiling | Cost |`);
    p(`|---|---|---:|---:|---:|`);
    for (const pkt of retried) {
      p(`| \`${pkt.task_id}\` | ${pkt.phase} | ${pkt.attempts} | ${pkt.finalCeiling ?? "—"} | ${fmtUSD(pkt.totalCost)} |`);
    }
    p();
  } else {
    p(`  Packets that hit the output cap`);
    p();
    for (const pkt of retried) {
      p(`  ${gutter(ACTOR.handoff)}${pkt.task_id.padEnd(22)} ${pkt.phase.padEnd(20)} ${String(pkt.attempts) + " attempts"} → ${fmtUSD(pkt.totalCost)}`);
    }
    p();
  }
}

// ─── delegation receipts ──────────────────────────────────────────────

const delegationDir = join(runDir, "delegation");
const receipts = existsSync(delegationDir)
  ? readdirSync(delegationDir)
      .filter((n) => n.startsWith("worker-delegation-") && n.endsWith(".json"))
      .sort()
      .map((n) => readJson(join(delegationDir, n)))
      .filter((r) => Object.keys(r).length > 0)
  : [];

if (receipts.length > 0) {
  if (asMarkdown) {
    p(`## Delegated to an agent worker`);
    p();
    p(`${receipts.length} packet(s) ran as agent sessions rather than single completion calls.`);
    p();
  } else {
    p(`  Delegated to an agent worker`);
    p();
    p(`  ${receipts.length} packet(s) ran as agent sessions rather than single completion calls.`);
    p();
    for (const [tag, meaning] of ACTOR_LEGEND) p(`  ${tag}  ${meaning}`);
    p();
  }
}

// ─── provenance summary ───────────────────────────────────────────────

const provLine = Object.entries(provCount)
  .filter(([, n]) => n > 0)
  .map(([k, n]) => `${n} ${k}`)
  .join(", ");

if (asMarkdown) {
  p(`---`);
  p();
  p(`_Provenance key: V = vendor-metered, E = estimated, M = modeled, ~ = mixed within phase, ? = unlabelled._`);
  if (provLine) p(`_Dispatched events: ${provLine}._`);
  if (driverManifest.pin_rejection) {
    p();
    p(`> **Pin rejected during this run:** ${driverManifest.pin_rejection}`);
  }
} else {
  p(`  Provenance key: V vendor-metered · E estimated · M modeled · ~ mixed · ? unlabelled`);
  if (provLine) p(`  Dispatched events: ${provLine}`);
  if (driverManifest.pin_rejection) {
    p();
    p(`  ! Pin rejected during this run: ${driverManifest.pin_rejection}`);
  }
  p();
}

console.log(out.join("\n"));
