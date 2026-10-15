/**
 * The report against the one-folder-per-run layout (.sdlc/runs/<run-id>/),
 * using a checked-in project fixture, plus the CLI surface integration
 * calls: run-folder selection, --json, writeReport and reportCommand.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { locateRun, main, readRun, REPORT_SCRIPT, reportCommand, summarize, writeReport } from "../../plugin/scripts/report.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = join(REPO_ROOT, "tools", "test", "fixtures", "report", "project");
const SDLC = join(PROJECT, ".sdlc");
const RUNS = join(SDLC, "runs");
const LATEST = join(RUNS, "20261013-101500-feature-3fa2c1");
const OLDER = join(RUNS, "20261012-090000-docs-0b1c2d");

function report(target, args = []) {
  const out = [], err = [];
  const status = main([target, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, "report.mjs");
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}

const dirs = [];
const scratch = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ── the fixture run ──────────────────────────────────────────────────

test("the fixture run reports every line with the figures its files hold", () => {
  const out = report(LATEST).stdout;
  assert.match(out, /Run report — 20261013-101500-feature-3fa2c1/);
  assert.match(out, /Policy:\s+gpt-seat-plus-flash/);
  assert.match(out, /Duration:\s+29m 30s/);
  assert.match(out, /Outcome:\s+interrupted \(exit 130\) — SIGINT/);
  assert.doesNotMatch(out, /Selected:/, "a run folder passed directly needs no selection note");
  for (const phase of ["discovery", "requirements_analysis", "change_plan", "plan_task_packets", "codegen", "tests", "senior_code_review", "security_review"]) {
    assert.match(out, new RegExp(`^  ${phase}\\s`, "m"), `${phase} has a row`);
  }
  assert.match(out, /SDLC total\s+8\s+\$0\.1596/);
  assert.match(out, /Runner overhead\s+1\s+\$0\.0012/);
  assert.match(out, /^ {4}debug\s/m);
  assert.match(out, /Dispatched total\s+9\s+\$0\.1608/);
  assert.match(out, /Thread\s+019a0000-0000-7000-8000-00000000f00d/);
  assert.match(out, /^ {2}Turns\s+2$/m);
  assert.match(out, /Incomplete turns\s+1/);
  assert.match(out, /Modeled cost\s+\$0\.3220/);
  assert.match(out, /Driver loop — modeled\s+at least \$0\.3220/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.4828/);
  assert.match(out, /Vendor-metered total\s+\$0\.0073/);
  assert.match(out, /Modeled \(seat\) total\s+at least \$0\.4755/);
  assert.match(out, /signed in with ChatGPT/);
  assert.match(out, /! Codex warnings during this run \(1\): Defaulting to fallback metadata/);
  assert.match(out, /Dispatched events: 3 vendor, 5 modeled, 1 none/);
  assert.doesNotMatch(out, /Policy names disagree/);
});

test("the fixture run's markdown carries the same totals", () => {
  const md = report(LATEST, ["--markdown"]).stdout;
  assert.match(md, /^# Run report — 20261013-101500-feature-3fa2c1$/m);
  assert.match(md, /\| \*\*Dispatched total\*\* \| \| 9 \| \| \*\*\$0\.1608\*\* \|/);
  assert.match(md, /\| codex exec --json turn usage \| 2 \| 1 \| 80\.0K \/ 11\.0K \| \$0\.3220 \|/);
  assert.match(md, /\| \*\*Run total = dispatched \+ driver\*\* \| \*\*at least \$0\.4828\*\* \|/);
  assert.match(md, /\| Vendor-metered total \| \$0\.0073 \|/);
  assert.match(md, /\| Modeled \(seat\) total \| at least \$0\.4755 \|/);
  assert.ok(!/┌/.test(md));
});

// ── choosing the run ─────────────────────────────────────────────────

test("given the project's .sdlc, the report picks the latest run and says so", () => {
  for (const args of [[], ["--markdown"]]) {
    const r = report(SDLC, args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Run report — 20261013-101500-feature-3fa2c1/);
    assert.match(r.stdout, /the latest of 2 runs in .*\.sdlc[\\/]runs \(pass a run folder to report another\)/);
  }
  const j = JSON.parse(report(SDLC, ["--json"]).stdout);
  assert.deepEqual(j.selected, { rule: "latest", runs_dir: RUNS, runs: 2 });
  assert.equal(j.run_dir, LATEST);
});

test("given the project root, the report looks in .sdlc/runs", () => {
  assert.equal(locateRun(PROJECT).runDir, LATEST);
  assert.match(report(PROJECT).stdout, /Run report — 20261013-101500-feature-3fa2c1/);
});

test("given .sdlc/runs itself, the report picks the latest run in it and says so", () => {
  const r = report(RUNS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Run report — 20261013-101500-feature-3fa2c1/);
  assert.match(r.stdout, /Selected:\s+the latest of 2 runs in .*\.sdlc[\\/]runs \(pass a run folder to report another\)/);
  assert.deepEqual(locateRun(RUNS).selected, { rule: "latest", runs_dir: RUNS, runs: 2 });
  const empty = scratch("report-no-runs-");
  mkdirSync(join(empty, "notes"));
  assert.deepEqual(locateRun(empty), { runDir: empty, selected: null }, "a folder of folders with no run files is not a runs folder");
});

test("the older run is reported when its folder is named", () => {
  const out = report(OLDER).stdout;
  assert.match(out, /Run report — 20261012-090000-docs-0b1c2d/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.0026/);
});

test("latest ranks a session run by run.json's start, not by when its manifest.json was last written", () => {
  const root = scratch("report-latest-session-");
  const runs = join(root, ".sdlc", "runs");
  const mk = (id, runJson, manifest) => {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, "run.json"), JSON.stringify({ route: "interactive", ...runJson }));
    writeFileSync(join(runs, id, "manifest.json"), JSON.stringify({ run_id: id, ...manifest }));
    writeFileSync(join(runs, id, "driver-usage.json"), JSON.stringify({ cost_usd_modeled: 0 }));
  };
  // A re-run of end-run rewrites a run with no dispatch's manifest.json, and its started_at is that moment.
  mk("first", { started_at: "2026-10-13T09:00:00Z", ended_at: "2026-10-13T09:20:00Z" }, { started_at: "2026-10-13T12:00:00Z" });
  mk("second", { started_at: "2026-10-13T10:00:00Z" }, { started_at: "2026-10-13T10:30:00Z" });
  assert.equal(locateRun(join(root, ".sdlc")).runDir, join(runs, "second"));
});

test("latest means latest started, with folder mtimes as the fallback", () => {
  const root = scratch("report-latest-");
  const runs = join(root, ".sdlc", "runs");
  const mk = (id, files) => {
    mkdirSync(join(runs, id), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(runs, id, name), body);
  };
  const tele = JSON.stringify({ phase: "codegen", provenance: "vendor", cost_usd: 0.01 }) + "\n";
  mk("zzz-named-last-started-first", { "telemetry.jsonl": tele, "driver-manifest.json": JSON.stringify({ run_id: "zzz", started_at: "2026-10-01T00:00:00Z" }) });
  mk("aaa-started-last", { "telemetry.jsonl": tele, "manifest.json": JSON.stringify({ run_id: "aaa", started_at: "2026-10-12T00:00:00Z" }) });
  mk("not-a-run", { "notes.md": "x" });
  mk(".hidden", { "telemetry.jsonl": tele });
  assert.equal(locateRun(join(root, ".sdlc")).runDir, join(runs, "aaa-started-last"));
  assert.equal(locateRun(join(root, ".sdlc")).selected.runs, 2);

  const byMtime = scratch("report-mtime-");
  for (const [id, sec] of [["old", 1_700_000_000], ["new", 1_800_000_000]]) {
    mkdirSync(join(byMtime, "runs", id), { recursive: true });
    const f = join(byMtime, "runs", id, "telemetry.jsonl");
    writeFileSync(f, tele);
    utimesSync(f, sec, sec);
  }
  assert.equal(locateRun(byMtime).runDir, join(byMtime, "runs", "new"));
});

/** A .sdlc from before runs/ existed: its own telemetry.jsonl, plus a copy of the fixture run under runs/. */
function legacySdlc(ts) {
  const root = scratch("report-legacy-");
  writeFileSync(join(root, "telemetry.jsonl"), JSON.stringify({ ts, pass: "legacy", phase: "codegen", provenance: "vendor", cost_usd: 0.02 }) + "\n");
  cpSync(LATEST, join(root, "runs", "20261013-101500-feature-3fa2c1"), { recursive: true });
  return root;
}

test("a legacy .sdlc reports its own run files only when they are newer than every run under runs/", () => {
  const out = report(legacySdlc("2026-10-14T08:00:00Z")).stdout;
  assert.match(out, /Run report — legacy/);
  assert.match(out, /Selected:\s+this folder's own run files, newer than the 1 run folder in /);
});

test("a legacy .sdlc whose own run files are older reports the latest run and says the old files are not shown", () => {
  const root = legacySdlc("2026-10-01T08:00:00Z");
  for (const args of [[], ["--markdown"]]) {
    const out = report(root, args).stdout;
    assert.match(out, /Run report — 20261013-101500-feature-3fa2c1/);
    assert.match(out, /the latest of 1 run in .*runs \(pass a run folder to report another; the older run files kept directly in .*report-legacy-[^ ]+ are not shown\)/);
  }
  assert.equal(locateRun(root).selected.older_folder_files, true);
});

test("a project root with a runs/ folder of its own still reports the latest run under .sdlc/runs", () => {
  const root = scratch("report-root-runs-");
  mkdirSync(join(root, "runs", "data"), { recursive: true });
  writeFileSync(join(root, "runs", "data", "notes.md"), "not a run\n");
  cpSync(LATEST, join(root, ".sdlc", "runs", "20261013-101500-feature-3fa2c1"), { recursive: true });
  const r = report(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Run report — 20261013-101500-feature-3fa2c1/);
  assert.equal(locateRun(root).selected.runs_dir, join(root, ".sdlc", "runs"));
});

test("a project root and its .sdlc pick the same run, legacy files included", () => {
  for (const [ts, expected] of [["2026-10-01T08:00:00Z", /Run report — 20261013-101500-feature-3fa2c1/], ["2026-10-14T08:00:00Z", /Run report — legacy/]]) {
    const root = scratch("report-root-legacy-");
    const sdlc = legacySdlc(ts);
    cpSync(sdlc, join(root, ".sdlc"), { recursive: true });
    assert.match(report(root).stdout, expected, ts);
    assert.match(report(join(root, ".sdlc")).stdout, expected, ts);
  }
  const root = scratch("report-root-legacy-");
  cpSync(legacySdlc("2026-10-01T08:00:00Z"), join(root, ".sdlc"), { recursive: true });
  const sdlc = join(root, ".sdlc").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(report(root).stdout, new RegExp(`older run files kept directly in ${sdlc} are not shown`), "names the .sdlc, not the root that was passed");
});

test("a project root whose .sdlc holds only legacy run files reports them and says where they are", () => {
  const root = scratch("report-root-only-legacy-");
  mkdirSync(join(root, ".sdlc"));
  writeFileSync(join(root, ".sdlc", "telemetry.jsonl"), JSON.stringify({ pass: "legacy", phase: "codegen", provenance: "vendor", cost_usd: 0.02 }) + "\n");
  const r = report(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Run report — legacy/);
  assert.match(r.stdout, /Selected:\s+the run files in .*\.sdlc, the project's \.sdlc folder/);
});

test("a run folder with no manifest is dated by its first recorded event, not by file times", () => {
  const root = scratch("report-first-event-");
  const runs = join(root, "runs");
  const mk = (id, ts, mtime) => {
    mkdirSync(join(runs, id), { recursive: true });
    const f = join(runs, id, "telemetry.jsonl");
    writeFileSync(f, JSON.stringify({ ts, phase: "codegen", provenance: "vendor", cost_usd: 0.01 }) + "\n");
    utimesSync(f, mtime, mtime);
  };
  mk("started-later-touched-earlier", "2026-10-13T09:00:00Z", 1_700_000_000);
  mk("started-earlier-touched-later", "2026-10-12T09:00:00Z", 1_800_000_000);
  assert.equal(locateRun(root).runDir, join(runs, "started-later-touched-earlier"));
});

test("a latest run with nothing to report exits 2 and names it", () => {
  const root = scratch("report-empty-run-");
  mkdirSync(join(root, "runs", "r1"), { recursive: true });
  writeFileSync(join(root, "runs", "r1", "telemetry.jsonl"), "\n");
  const r = report(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No telemetry found in .*r1 \(the latest run in .*runs\)/);
});

// ── CLI surface ──────────────────────────────────────────────────────

test("--markdown with --json, an unknown flag, or two folders is a usage error", () => {
  for (const args of [[LATEST, "--json", "--markdown"], [LATEST, "--verbose"], [LATEST, OLDER], []]) {
    const out = [], err = [];
    const status = main(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, "report.mjs");
    assert.equal(status, 2, args.join(" "));
    assert.match(err.join("\n"), /Usage: node 'report\.mjs'/);
    assert.equal(out.length, 0);
  }
});

test("--help prints the usage and exits 0", () => {
  const out = [];
  assert.equal(main(["--help"], { out: (s) => out.push(s), err: () => {} }, "report.mjs"), 0);
  assert.match(out.join("\n"), /--markdown \| --json/);
});

test("writeReport writes report.md as the markdown rendering, and skips an empty folder", () => {
  const run = scratch("report-write-");
  cpSync(LATEST, run, { recursive: true });
  const path = writeReport(run);
  assert.equal(path, join(run, "report.md"));
  assert.equal(readFileSync(path, "utf8"), report(run, ["--markdown"]).stdout + "\n");
  assert.equal(writeReport(scratch("report-write-empty-")), null);
});

test("reportCommand names this script by absolute path and quotes the folder", () => {
  const cmd = reportCommand("/x y/it's out");
  assert.equal(cmd, `node '${REPORT_SCRIPT}' '/x y/it'\\''s out'`);
  assert.ok(existsSync(REPORT_SCRIPT));
  assert.ok(REPORT_SCRIPT.endsWith(join("plugin", "scripts", "report.mjs")));
  assert.match(reportCommand("/r", { markdown: true }), / --markdown$/);
  const run = spawnSync("/bin/sh", ["-c", reportCommand(LATEST)], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Run report — 20261013-101500-feature-3fa2c1/);
});

test("summarize reads the fixture's new driver-manifest keys", () => {
  const r = summarize(readRun(LATEST));
  assert.equal(r.identity.outcome, "interrupted");
  assert.equal(r.identity.exit_code, 130);
  assert.equal(r.identity.driver_auth, "chatgpt");
  assert.deepEqual(r.driver.thread_ids, ["019a0000-0000-7000-8000-00000000f00d"]);
  assert.equal(r.driver.turns_incomplete, 1);
  assert.equal(r.driver.booked_from, "driver-cost-modeled.jsonl");
  assert.equal(r.totals.run_total_is_floor, true);
});
