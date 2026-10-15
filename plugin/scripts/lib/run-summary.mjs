/**
 * SUMMARY.md, rendered from the manifest write-manifest.mjs has just built.
 * Every figure is the manifest's, so the summary cannot disagree with the
 * run's record.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_WRITER = "plugin/scripts/write-manifest.mjs";

/** First line of every code-written SUMMARY.md. */
export const SUMMARY_MARKER = "<!-- written by plugin/scripts/write-manifest.mjs from manifest.json; do not edit -->";

/** The statuses that mean Gate 4 accepted the run. */
export const ACCEPTED_STATUSES = ["accepted", "auto-approved"];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const isCodeWritten = (m) => m?.written_by === MANIFEST_WRITER;

/**
 * Whether SUMMARY.md is the one write-manifest.mjs last wrote: manifest.json
 * is code-written and records the summary's sha256. `{ok, reason, status}`,
 * where status is the manifest's. Kept free of the built bridge, so the
 * interactive start and end scripts can check it.
 */
export function codeWrittenSummary(runDir) {
  const path = join(runDir, "SUMMARY.md");
  if (!existsSync(path)) return { ok: false, reason: "there is no SUMMARY.md" };
  let m = null;
  try {
    const v = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8"));
    m = v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    m = null;
  }
  if (!isCodeWritten(m)) {
    return { ok: false, reason: `SUMMARY.md was not written by ${MANIFEST_WRITER}: manifest.json ${m ? "is not that script's" : "is missing"}` };
  }
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    return { ok: false, reason: `SUMMARY.md cannot be read: ${e?.code ?? e?.message ?? e}` };
  }
  if (!m.summary?.sha256 || m.summary.sha256 !== sha256(text)) {
    return { ok: false, reason: `SUMMARY.md is not the one ${MANIFEST_WRITER} wrote (it was hand-written or edited)`, status: m.status };
  }
  return { ok: true, reason: null, status: m.status };
}

/** Run files the summary links to when they exist, in this order. */
const LINKED = [
  "requirements.md", "discovery.md", "intent_brief.md", "design.md", "change_plan.md", "packets.json",
  /^review.*\.json$/, "security_review.md", "gates.jsonl", "telemetry.jsonl", "manifest.json",
  "driver-manifest.json", "provenance.json",
];

const usd = (n) => `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function linkedFiles(runDir) {
  let names = [];
  try {
    names = readdirSync(runDir).sort();
  } catch {
    return [];
  }
  // manifest.json is written right after the summary that links to it.
  const present = (n) => n === "manifest.json" || (names.includes(n) && isFile(join(runDir, n)));
  const out = [];
  for (const want of LINKED) {
    const hits = typeof want === "string" ? [want] : names.filter((n) => want.test(n));
    for (const n of hits) if (!out.includes(n) && present(n)) out.push(n);
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The word the cost report puts before the same driver figure: "at least ", "at most ", "about " or "". */
export function driverBound(m) {
  const t = m.totals ?? {};
  const collected = t.driver_cost_source === "driver-usage.json";
  const source = collected ? (t.driver_usage?.cost_source ?? "") : "";
  const ceiling = /\bupper bound\b/i.test(source) || /\bWHOLE THREAD\b/.test(source);
  const incomplete = collected ? t.driver_usage?.cost_complete === false : m.driver?.driver_cost_complete === false;
  const floor =
    /\b(INCOMPLETE|LOWER BOUND|PROVISIONAL|TIER UNVERIFIED)\b/.test(source) ||
    Number(t.driver_turns_incomplete) > 0 ||
    (incomplete && !ceiling);
  if (floor && ceiling) return "about ";
  return ceiling ? "at most " : floor ? "at least " : "";
}

/** The conductor's line: a modeled figure, a figure still being counted, or the plain statement that nobody measured it. */
export function driverLine(m) {
  const t = m.totals ?? {};
  const d = m.driver;
  const cost = t.driver_cost_usd_modeled;
  const dispatched = usd(t.dispatched_cost_usd ?? m.total_cost_usd);
  const seat = d?.driver_auth === "chatgpt" ? " The conductor signed in with ChatGPT, and a seat bills no money per token." : "";
  if (Number.isFinite(cost) && t.driver_cost_source === "driver-usage.json") {
    const basis = t.driver_usage?.cost_source ? ` Booked from the ${t.driver_usage.cost_source}.` : "";
    return `Conductor (driver) cost, modeled from driver-usage.json: ${usd(cost)}.${basis} Modeled means token counts at the dated price list's rates, not a bill.${seat}`;
  }
  if (d && Number.isFinite(cost)) {
    const incomplete = Math.max(0, (Number(d.driver_turns_incomplete) || 0) - (Number(d.driver_turns_incomplete_covered) || 0));
    const floor = incomplete ? `, ${incomplete} incomplete: their cost is not known, so this figure is a floor` : "";
    const head = `Conductor (driver) cost, modeled: ${usd(cost)} over ${plural(Number(d.driver_turns) || 0, "turn")}${floor}.`;
    const tail = " Modeled means token counts at the dated price list's rates, not a bill." + seat;
    if (d.outcome) return head + tail;
    return `${head} The run is still going: run.mjs re-renders this summary with the final figure when it completes.${tail}`;
  }
  if (Number.isFinite(cost) && t.driver_cost_source) {
    return `Conductor (driver) cost, modeled from ${t.driver_cost_source}: ${usd(cost)}. Modeled means token counts at the dated price list's rates, not a bill.`;
  }
  if (m.route === "headless") {
    return "Conductor (driver) cost: run.mjs models it from the codex event stream when this invocation ends, and re-renders this summary with it when the run completes.";
  }
  return (
    "Conductor (driver) cost: end-run.mjs reads it from the conductor's codex session file when the run ends, " +
    `and re-renders this summary with it when the run completes. Dispatched work alone is ${dispatched}; it is not the run's cost.`
  );
}

export function renderRunSummary(manifest, { runDir } = {}) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  const t = m.totals ?? {};
  const prov = t.by_provenance ?? {};
  const L = [SUMMARY_MARKER];
  L.push(`# Run ${m.run_id ?? m.pass ?? "(no run id)"} — policy ${m.policy ?? m.policy_name ?? "(none recorded)"}`, "");
  L.push(`Status: **${m.status ?? "provisional"}**`, "");
  L.push("Written by code from this run's records; every figure is manifest.json's. Phase 9's write-manifest command rewrites it.", "");

  L.push("## Cost", "", "| Line | Amount |", "|---|---:|");
  L.push(`| Dispatched work (calls through the dispatch bridge) | ${usd(t.dispatched_cost_usd ?? m.total_cost_usd)} |`);
  L.push(`| ↳ vendor-metered | ${usd(prov.vendor)} |`);
  if (prov.estimated > 0) L.push(`| ↳ estimated (no usage block returned) | ${usd(prov.estimated)} |`);
  if (prov.modeled > 0) L.push(`| ↳ modeled (token counts at the dated price list's rates) | ${usd(prov.modeled)} |`);
  if (prov.unlabelled > 0) L.push(`| ↳ unlabelled provenance | ${usd(prov.unlabelled)} |`);
  const driverCost = Number.isFinite(t.driver_cost_usd_modeled) ? `${driverBound(m)}${usd(t.driver_cost_usd_modeled)}` : "not measured";
  L.push(`| Conductor (driver) loop — modeled | ${driverCost} |`, "");
  L.push(driverLine(m), "");
  L.push("This summary does not add the two lines; the cost report (`scripts/report.mjs` in the plugin) prints the run total.", "");

  const phases = Object.entries(m.phase_breakdown ?? {});
  L.push("## By phase", "");
  if (phases.length) {
    L.push("| Phase | Calls | Models | Cost |", "|---|---:|---|---:|");
    for (const [phase, p] of phases) L.push(`| ${cell(phase)} | ${p?.calls ?? "—"} | ${cell((p?.models ?? []).join(", ") || "—")} | ${usd(p?.cost_usd)} |`);
  } else {
    L.push("No dispatched call was recorded in telemetry.jsonl.");
  }
  L.push("");

  const models = Object.entries(m.model_breakdown ?? {});
  if (models.length) {
    L.push("## By model", "", "| Model | Calls | Input tokens | Output tokens | Cost |", "|---|---:|---:|---:|---:|");
    for (const [model, b] of models) L.push(`| ${cell(model)} | ${b?.calls ?? "—"} | ${b?.input_tokens ?? "—"} | ${b?.output_tokens ?? "—"} | ${usd(b?.cost_usd)} |`);
    L.push("");
  }

  const gates = Array.isArray(m.gates) ? m.gates : [];
  L.push("## Gates", "");
  if (gates.length) {
    L.push("| Gate | Decision | Note |", "|---|---|---|");
    for (const g of gates) L.push(`| ${cell(g.gate ?? "?")} | ${cell(g.decision ?? g.status ?? "—")} | ${cell(g.note ?? "")} |`);
  } else {
    L.push("No gate decision is recorded in gates.jsonl.");
  }
  L.push("");

  L.push("## Artifacts", "");
  if (m.artifacts && Number.isFinite(m.artifacts.files)) L.push(`Files: ${m.artifacts.files} · Lines: ${m.artifacts.loc ?? "—"}`);
  else L.push("File counts left out (see the notes in manifest.json).");
  L.push("");

  const files = runDir ? linkedFiles(runDir) : [];
  L.push("## Files", "");
  if (files.length) for (const f of files) L.push(`- [${f}](${f})`);
  else L.push("No run file was found beside this summary.");
  L.push("");
  return L.join("\n");
}
