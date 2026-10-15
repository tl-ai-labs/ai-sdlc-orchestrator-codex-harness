/** manifest.json and SUMMARY.md written by plugin/scripts/write-manifest.mjs from a run's records. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../../plugin/mcp/model-dispatch/dist/telemetry.js";
import { byProvenance, main, parseArgs, writeManifest } from "../../plugin/scripts/write-manifest.mjs";
import { renderRunSummary, SUMMARY_MARKER } from "../../plugin/scripts/lib/run-summary.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "scripts", "write-manifest.mjs");

function event(over = {}) {
  return {
    ts: "2026-10-13T10:00:00.000Z",
    pass: "r1",
    phase: "requirements_analysis",
    task_type: "requirements",
    task_id: "t1",
    module: "cross",
    model: "gpt-5.6-terra",
    provenance: "vendor",
    routed_by: "orchestrator",
    routing: { policy_name: "gpt-plus-flash", policy_version: 1, rule_index: 0, rule_reason: "judgment" },
    input_tokens: 1000,
    input_tokens_cached: 200,
    output_tokens: 100,
    cost_usd: 0.1,
    latency_ms: 10,
    success: true,
    retry_count: 0,
    ...over,
  };
}

const EVENTS = [
  event(),
  event({ ts: "2026-10-13T10:01:00.000Z", phase: "codegen", task_type: "dto", task_id: "t2", model: "gemini-3.7-flash", provenance: "estimated", cost_usd: 0.02 }),
  event({ ts: "2026-10-13T10:02:30.000Z", phase: "senior_code_review", task_type: "review", task_id: "t3", provenance: "modeled", cost_usd: 0.05 }),
];

function project() {
  const root = mkdtempSync(join(tmpdir(), "write-manifest-"));
  const runDir = join(root, ".sdlc", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  const put = (name, text) => writeFileSync(join(runDir, name), text);
  const lines = (rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
  return {
    root,
    runDir,
    put,
    lines,
    telemetry: (rows) => put("telemetry.jsonl", lines(rows)),
    manifest: () => JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8")),
    summary: () => readFileSync(join(runDir, "SUMMARY.md"), "utf-8"),
    write: (opts = {}) => writeManifest({ runDir, runId: "r1", policy: "gpt-plus-flash", projectRoot: root, ...opts }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function cli(argv, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf-8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("the manifest keeps buildManifest's rollups and writes both spellings of every identity key", () => {
  const p = project();
  try {
    p.telemetry(EVENTS);
    const { manifest: m } = p.write();
    const built = buildManifest(EVENTS, { pass: "r1", policy_name: "gpt-plus-flash" });
    assert.equal(m.schema_version, 1);
    assert.equal(m.written_by, "plugin/scripts/write-manifest.mjs");
    assert.equal(m.run_id, "r1");
    assert.equal(m.pass, m.run_id);
    assert.equal(m.policy, "gpt-plus-flash");
    assert.equal(m.policy_name, m.policy);
    assert.equal(m.total_cost_usd, built.total_cost_usd);
    assert.equal(m.totals.dispatched_cost_usd, m.total_cost_usd);
    for (const k of ["started_at", "ended_at", "duration_sec", "total_input_tokens", "total_input_tokens_cached", "total_output_tokens"]) {
      assert.equal(m[k], built[k], k);
    }
    for (const k of ["model_breakdown", "phase_breakdown", "module_breakdown", "task_type_breakdown"]) assert.deepEqual(m[k], built[k], k);
    assert.equal(m.route, "interactive", "no driver-events.jsonl: not a run.mjs run");
    assert.deepEqual(p.manifest(), m, "what is returned is what is on disk");
    assert.deepEqual(readdirSync(p.runDir).filter((n) => n.endsWith(".tmp")), [], "the atomic write leaves no temp file");
  } finally {
    p.cleanup();
  }
});

test("dispatched cost splits by provenance, and the parts add up to the dispatched total", () => {
  const p = project();
  try {
    p.telemetry([
      ...EVENTS,
      event({ ts: "2026-10-13T10:03:00.000Z", provenance: "none", cost_usd: 0 }),
      event({ ts: "2026-10-13T10:04:00.000Z", provenance: undefined, cost_usd: 0.1 }),
      event({ ts: "2026-10-13T10:05:00.000Z", provenance: "guessed", cost_usd: 0.2 }),
    ]);
    const { manifest: m } = p.write();
    assert.deepEqual(m.totals.by_provenance, { vendor: 0.1, estimated: 0.02, modeled: 0.05, none: 0, unlabelled: 0.3 });
    const sum = Object.values(m.totals.by_provenance).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - m.totals.dispatched_cost_usd) < 1e-9, `${sum} vs ${m.totals.dispatched_cost_usd}`);
    assert.deepEqual(byProvenance([event({ cost_usd: 0.1 }), event({ cost_usd: 0.2 })]).vendor, 0.3);
  } finally {
    p.cleanup();
  }
});

test("the provenance split adds up to the dispatched total in micro-dollars, even for sub-micro-dollar calls", () => {
  const p = project();
  const micro = (v) => Math.round(v * 1e6);
  try {
    const tiny = Array.from({ length: 200 }, (_, i) => event({ ts: `2026-10-13T10:00:${String(i % 60).padStart(2, "0")}.000Z`, cost_usd: 0.0000004 }));
    p.telemetry(tiny);
    let m = p.write().manifest;
    assert.equal(m.totals.dispatched_cost_usd, 0.00008);
    assert.equal(m.totals.by_provenance.vendor, 0.00008, "200 calls under half a micro-dollar each still land in their bucket");

    const provs = ["vendor", "estimated", "modeled", undefined];
    const many = Array.from({ length: 600 }, (_, i) =>
      event({ ts: `2026-10-13T11:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, provenance: provs[i % 4], cost_usd: ((i * 7919) % 1000) / 7e6 + 1.234567e-7 }),
    );
    p.telemetry(many);
    m = p.write({ summary: true }).manifest;
    const parts = Object.values(m.totals.by_provenance);
    assert.equal(parts.reduce((s, v) => s + micro(v), 0), micro(m.totals.dispatched_cost_usd));
    for (const [k, raw] of [["vendor", 0], ["estimated", 1], ["modeled", 2], ["unlabelled", 3]]) {
      const sum = many.filter((_, i) => i % 4 === raw).reduce((s, e) => s + e.cost_usd, 0);
      assert.ok(Math.abs(m.totals.by_provenance[k] - sum) <= 1e-6, `${k}: ${m.totals.by_provenance[k]} vs ${sum}`);
    }
  } finally {
    p.cleanup();
  }
});

test("a truncated or malformed telemetry line is skipped with a note; no telemetry gives the empty shape", () => {
  const p = project();
  try {
    p.telemetry([EVENTS[0], "[1,2]", JSON.stringify(EVENTS[1]).slice(0, 40)]);
    let r = p.write();
    assert.equal(r.manifest.total_cost_usd, 0.1);
    assert.ok(r.notes.some((n) => /2 telemetry\.jsonl line\(s\) could not be read/.test(n)), r.notes.join("\n"));
    assert.deepEqual(r.manifest.notes, r.notes);

    p.telemetry([event({ ts: undefined }), event({ cost_usd: null }), EVENTS[0]]);
    r = p.write();
    assert.equal(r.manifest.total_cost_usd, 0.1);
    assert.ok(r.notes.some((n) => /1 telemetry event\(s\) without a ts left out/.test(n)));
    assert.ok(r.notes.some((n) => /1 telemetry event\(s\) carry no cost_usd; each is counted as \$0/.test(n)));

    rmSync(join(p.runDir, "telemetry.jsonl"));
    r = p.write();
    assert.equal(r.manifest.total_cost_usd, 0);
    assert.deepEqual(r.manifest.phase_breakdown, {});
    assert.deepEqual(r.manifest.totals.by_provenance, { vendor: 0, estimated: 0, modeled: 0, none: 0, unlabelled: 0 });
  } finally {
    p.cleanup();
  }
});

test("status: --status, then a status this script wrote for the conductor, then provisional", () => {
  const p = project();
  try {
    assert.equal(p.write().manifest.status, "provisional");
    assert.equal(p.write({ status: "accepted" }).manifest.status, "accepted");
    assert.equal(p.write().manifest.status, "accepted", "a re-render without --status keeps the acceptance");
    assert.equal(p.write({ status: "incomplete" }).manifest.status, "incomplete");
    assert.equal(p.write().manifest.status, "provisional", "a run-end status is run.mjs's, not the conductor's: a resumed Phase 9 starts again");
    p.put("manifest.json", JSON.stringify({ status: "accepted", pass: "r1" }));
    assert.equal(p.write().manifest.status, "provisional", "a model-written manifest does not donate its status");
    assert.throws(() => p.write({ status: "done" }), /not one of/);
  } finally {
    p.cleanup();
  }
});

test("gates come from gates.jsonl in either key spelling; a malformed line is skipped", () => {
  const p = project();
  try {
    p.put("gates.jsonl", p.lines([{ gate: 1, decision: "approved" }, "{not json", { gate: 4, status: "pending", run_id: "r1" }]));
    const { manifest: m, notes } = p.write({ summary: true });
    assert.deepEqual(m.gates, [{ gate: 1, decision: "approved" }, { gate: 4, status: "pending", run_id: "r1", decision: "pending" }]);
    assert.ok(notes.some((n) => /1 gates\.jsonl line\(s\) could not be read/.test(n)));
    assert.match(p.summary(), /\| 1 \| approved \|/);
    assert.match(p.summary(), /\| 4 \| pending \|/);
  } finally {
    p.cleanup();
  }
});

const DRIVER_MANIFEST = {
  run_id: "r1",
  policy: "gpt-plus-flash",
  pin: { model: "gpt-5.6-terra", effort: "high", sandbox: "workspace-write", approval_policy: "never" },
  codex_invocations: 2,
  driver_turns: 3,
  driver_turns_incomplete: 1,
  driver_cost_complete: false,
  driver_cost_usd_modeled: 0.4321,
  thread_ids: ["01a1340d-41da-7e31-84cd-b0907e9bc31f"],
  outcome: "completed",
  outcome_reason: "done",
  exit_code: 0,
  driver_auth: "chatgpt",
};

test("the driver block and the conductor's cost come from driver-manifest.json, and are null without it", () => {
  const p = project();
  try {
    let m = p.write().manifest;
    assert.equal(m.driver, null);
    assert.deepEqual(
      { cost: m.totals.driver_cost_usd_modeled, incomplete: m.totals.driver_turns_incomplete, source: m.totals.driver_cost_source },
      { cost: null, incomplete: null, source: null },
    );

    p.put("driver-manifest.json", JSON.stringify(DRIVER_MANIFEST));
    p.put("driver-events.jsonl", "");
    m = p.write().manifest;
    assert.equal(m.route, "headless");
    assert.equal(m.totals.driver_cost_usd_modeled, 0.4321);
    assert.equal(m.totals.driver_turns_incomplete, 1);
    assert.equal(m.totals.driver_cost_source, "driver-manifest.json");
    assert.deepEqual(m.driver.thread_ids, DRIVER_MANIFEST.thread_ids);
    assert.deepEqual(m.driver.pin, DRIVER_MANIFEST.pin);
    for (const k of ["codex_invocations", "driver_turns", "driver_turns_incomplete", "outcome", "outcome_reason", "exit_code", "driver_auth"]) {
      assert.equal(m.driver[k], DRIVER_MANIFEST[k], k);
    }
    assert.equal("run_total_usd" in m.totals, false, "the manifest holds no summed run total");
  } finally {
    p.cleanup();
  }
});

test("with no driver-manifest.json, the session collector's driver-usage.json supplies the conductor's cost", () => {
  const p = project();
  try {
    p.put("driver-usage.json", JSON.stringify({ schema_version: 1, cost_usd_modeled: 0.75, cost_complete: true }));
    const m = p.write({ summary: true }).manifest;
    assert.equal(m.totals.driver_cost_usd_modeled, 0.75);
    assert.equal(m.totals.driver_cost_source, "driver-usage.json");
    assert.equal(m.driver, null);
    assert.match(p.summary(), /Conductor \(driver\) cost, modeled from driver-usage\.json: \$0\.7500/);
  } finally {
    p.cleanup();
  }
});

test("driver-usage.json outranks driver-manifest.json, as in the cost report, and the manifest says how it was booked", () => {
  const p = project();
  try {
    p.put("driver-manifest.json", JSON.stringify(DRIVER_MANIFEST));
    p.put("driver-events.jsonl", "");
    const cost_source = "session file (exec stream DISAGREES on invocation 1: output_tokens 10 vs 12; unverified)";
    p.put("driver-usage.json", JSON.stringify({ cost_usd_modeled: 0.5, cost_source, verified: false, cost_complete: true, unpriced: [{ model: "gpt-4o", turns: 1 }] }));
    const m = p.write({ summary: true }).manifest;
    assert.equal(m.totals.driver_cost_usd_modeled, 0.5, "the session file is booked where the exec stream disagrees");
    assert.equal(m.totals.driver_cost_source, "driver-usage.json");
    assert.deepEqual(m.totals.driver_usage, { cost_source, verified: false, cost_complete: true, unpriced: [{ model: "gpt-4o", turns: 1 }] });
    assert.equal(m.totals.driver_turns_incomplete, null);
    assert.equal(m.driver.driver_turns, DRIVER_MANIFEST.driver_turns, "the driver block is still driver-manifest.json's");
    assert.ok(p.summary().includes(`Conductor (driver) cost, modeled from driver-usage.json: $0.5000. Booked from the ${cost_source}.`));
    assert.match(p.summary(), /\| Conductor \(driver\) loop — modeled \| \$0\.5000 \|/);

    rmSync(join(p.runDir, "driver-usage.json"));
    const back = p.write().manifest;
    assert.equal(back.totals.driver_cost_usd_modeled, DRIVER_MANIFEST.driver_cost_usd_modeled);
    assert.equal(back.totals.driver_usage, null);
  } finally {
    p.cleanup();
  }
});

test("the summary check needs nothing but node, so the interactive start and end scripts can load it", () => {
  const src = readFileSync(join(dirname(SCRIPT), "lib", "run-summary.mjs"), "utf-8");
  const froms = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((x) => x[1]);
  assert.ok(froms.length > 0);
  assert.deepEqual(froms.filter((f) => !f.startsWith("node:")), []);
});

test("SUMMARY.md is written only with --summary, and every figure in it is the manifest's", () => {
  const p = project();
  try {
    p.telemetry(EVENTS);
    p.put("requirements.md", "# r\n");
    let r = p.write();
    assert.equal(r.summaryPath, null);
    assert.ok(!existsSync(join(p.runDir, "SUMMARY.md")));

    r = p.write({ summary: true });
    const m = r.manifest;
    const text = p.summary();
    assert.equal(text.split("\n")[0], SUMMARY_MARKER);
    assert.equal(text, renderRunSummary({ ...m, summary: null }, { runDir: p.runDir }), "SUMMARY.md is the render of the manifest written beside it");
    assert.match(text, /# Run r1 — policy gpt-plus-flash/);
    assert.match(text, /Status: \*\*provisional\*\*/);
    assert.match(text, /\| Dispatched work \(calls through the dispatch bridge\) \| \$0\.1700 \|/);
    assert.match(text, /\| ↳ vendor-metered \| \$0\.1000 \|/);
    assert.match(text, /\| ↳ estimated \(no usage block returned\) \| \$0\.0200 \|/);
    assert.match(text, /\| ↳ modeled \(token counts at the dated price list's rates\) \| \$0\.0500 \|/);
    assert.doesNotMatch(text, /unlabelled/);
    for (const [phase, b] of Object.entries(m.phase_breakdown)) {
      assert.ok(text.includes(`| ${phase} | ${b.calls} | ${b.models.join(", ")} | $${b.cost_usd.toFixed(4)} |`), phase);
    }
    assert.match(text, /- \[requirements\.md\]\(requirements\.md\)/);
    assert.match(text, /- \[manifest\.json\]\(manifest\.json\)/);
    assert.equal(m.summary.path, "SUMMARY.md");
    assert.match(m.summary.sha256, /^[0-9a-f]{64}$/);
  } finally {
    p.cleanup();
  }
});

test("the conductor's line says what is known: not measured yet, still being counted, or the final modeled figure", () => {
  const p = project();
  try {
    p.telemetry(EVENTS);
    p.write({ summary: true });
    assert.match(p.summary(), /end-run\.mjs reads it from the conductor's codex session file when the run ends/);
    assert.match(p.summary(), /Dispatched work alone is \$0\.1700; it is not the run's cost\./);
    assert.match(p.summary(), /\| Conductor \(driver\) loop — modeled \| not measured \|/);

    p.put("driver-events.jsonl", "");
    p.write({ summary: true });
    assert.match(p.summary(), /run\.mjs models it from the codex event stream when this invocation ends/);

    p.put("driver-manifest.json", JSON.stringify({ ...DRIVER_MANIFEST, outcome: null }));
    p.write({ summary: true });
    assert.match(p.summary(), /\$0\.4321 over 3 turns, 1 incomplete: their cost is not known, so this figure is a floor\. The run is still going/);

    p.put("driver-manifest.json", JSON.stringify(DRIVER_MANIFEST));
    p.write({ summary: true });
    const text = p.summary();
    assert.match(text, /Conductor \(driver\) cost, modeled: \$0\.4321 over 3 turns, 1 incomplete/);
    assert.doesNotMatch(text, /still going/);
    assert.match(text, /a seat bills no money per token/);
    assert.match(text, /\| Conductor \(driver\) loop — modeled \| at least \$0\.4321 \|/, "an incomplete turn makes the figure a floor");
    assert.doesNotMatch(text, /Run total/, "the report owns the run total");
  } finally {
    p.cleanup();
  }
});

test("a manifest written without --summary still vouches for the code-written SUMMARY.md on disk, and only that one", () => {
  const p = project();
  try {
    p.write({ summary: true, status: "accepted" });
    const hash = p.manifest().summary.sha256;
    assert.equal(p.write({ status: "incomplete" }).manifest.summary.sha256, hash);
    writeFileSync(join(p.runDir, "SUMMARY.md"), "# typed over\n");
    assert.equal(p.write().manifest.summary, null);
  } finally {
    p.cleanup();
  }
});

test("a SUMMARY.md that cannot be written leaves a note, and the manifest stands", () => {
  const p = project();
  try {
    mkdirSync(join(p.runDir, "SUMMARY.md"));
    writeFileSync(join(p.runDir, "SUMMARY.md", "keep"), "x");
    const r = p.write({ summary: true });
    assert.equal(r.summaryPath, null);
    assert.ok(r.notes.some((n) => /^SUMMARY\.md was not written: /.test(n)), r.notes.join("\n"));
    assert.equal(p.manifest().summary, null);
    assert.equal(p.manifest().written_by, "plugin/scripts/write-manifest.mjs");
    assert.deepEqual(readdirSync(p.runDir).filter((n) => n.endsWith(".tmp")), [], "the failed write leaves no temp file");
  } finally {
    p.cleanup();
  }
});

test("greenfield counts every product file under the code folder; installed packages and lockfiles are not the product", () => {
  const p = project();
  try {
    const src = join(p.root, "app");
    mkdirSync(join(src, "lib"), { recursive: true });
    mkdirSync(join(src, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(src, "index.js"), "a\nb\n");
    writeFileSync(join(src, "lib", "x.js"), "c");
    writeFileSync(join(src, "package-lock.json"), "{}\n");
    writeFileSync(join(src, "node_modules", "dep", "i.js"), "x\n");
    const r = p.write({ codeDir: "app" });
    assert.deepEqual(r.manifest.artifacts, { files: 2, loc: 4 });
  } finally {
    p.cleanup();
  }
});

test("brownfield: a code folder that is the project counts only the files provenance.json lists, or leaves counts out with a note", () => {
  const p = project();
  try {
    mkdirSync(join(p.root, ".git"));
    mkdirSync(join(p.root, "src"));
    writeFileSync(join(p.root, "src", "a.ts"), "1\n2\n3\n");
    writeFileSync(join(p.root, "src", "b.ts"), "untouched\n");
    let r = p.write({ codeDir: p.root });
    assert.equal(r.manifest.artifacts, undefined);
    assert.ok(r.notes.some((n) => /file counts left out: the code directory .* is the project itself/.test(n)), r.notes.join("\n"));

    p.put("provenance.json", JSON.stringify({ files_touched: [{ path: "src/a.ts" }, { path: "src/gone.ts" }, { path: ".sdlc/runs/r1/x" }] }));
    r = p.write({ codeDir: p.root, summary: true });
    assert.deepEqual(r.manifest.artifacts, { files: 1, loc: 4 });
    assert.match(p.summary(), /Files: 1 · Lines: 4/);
  } finally {
    p.cleanup();
  }
});

test("the CLI takes --k v and --k=v alike, and --pass names the run id", () => {
  const p = project();
  try {
    p.telemetry(EVENTS);
    const a = cli([p.runDir, "--run-id", "r1", "--policy", "gpt-plus-flash", "--project-root", p.root, "--summary"], p.root);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /^manifest written: .*manifest\.json — dispatched \$0\.17 over 3 event\(s\), 0 gate line\(s\), status provisional$/m);
    assert.match(a.out, /^summary written: .*SUMMARY\.md$/m);
    assert.match(a.out, /^note: file counts left out: no --code-dir was given$/m);
    const first = { manifest: p.manifest(), summary: p.summary() };
    const b = cli([p.runDir, "--pass=r1", "--policy=gpt-plus-flash", `--project-root=${p.root}`, "--summary"], p.root);
    assert.equal(b.code, 0, b.err);
    const strip = (m) => ({ ...m, written_at: null, summary: { ...m.summary, written_at: null } });
    assert.deepEqual(strip(p.manifest()), strip(first.manifest));
    assert.equal(p.summary(), first.summary);
  } finally {
    p.cleanup();
  }
});

test("the CLI refuses a usage error with exit 2 and writes nothing", () => {
  const p = project();
  try {
    const cases = [
      [[p.runDir, "--policy=gpt-plus-flash"], /--run-id is missing/],
      [[p.runDir, "--run-id=r1"], /--policy is missing/],
      [["--run-id=r1", "--policy=x"], /the run folder is missing/],
      [[p.runDir, "--run-id=r1", "--policy=x", "--bogus"], /unknown flag --bogus/],
      [[p.runDir, "--run-id=r1", "--policy=x", "--status=completed"], /--status=completed is not one of provisional, accepted, auto-approved, rejected/],
      [[p.runDir, "--run-id=r1", "--policy=x", "--status=incomplete"], /--status=incomplete is not one of/],
      [[p.runDir, "--run-id=r2", "--policy=x"], /--run-id=r2 does not match the run folder/],
      [[p.runDir, "--run-id", "--policy=x"], /--run-id needs a value/],
      [[join(p.root, "nowhere"), "--run-id=r1", "--policy=x"], /does not exist/],
    ];
    for (const [argv, re] of cases) {
      const r = cli(argv, p.root);
      assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.err, re);
    }
    assert.ok(!existsSync(join(p.runDir, "manifest.json")));
    assert.deepEqual(parseArgs([p.runDir, "--pass", "r1", "--policy", "p"]).runId, "r1");
  } finally {
    p.cleanup();
  }
});

test("importing write-manifest.mjs runs nothing", () => {
  let out = "";
  const code = main(["--help"], { out: { write: (s) => (out += s) }, err: { write: (s) => (out += s) } });
  assert.equal(code, 2);
  assert.match(out, /usage: node write-manifest\.mjs <run-dir>/);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(SCRIPT)}); console.log("imported")`], { encoding: "utf-8" });
  assert.equal(r.stdout, "imported\n");
  assert.equal(r.status, 0);
});
