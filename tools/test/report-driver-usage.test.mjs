/**
 * The report against driver-usage.json as the session-file collector
 * writes it (sessionUsage.ts DriverUsageReport). The run folders under
 * fixtures/report/driver-usage/ are written by measureDriverUsage over
 * synthetic rollouts, one folder per case (fixtures/report/driver-usage-gen.mjs).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main, readRun, summarize } from "../../plugin/scripts/report.mjs";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "report", "driver-usage");
const at = (name) => join(FIXTURES, name);

function report(dir, args = []) {
  const out = [], err = [];
  const status = main([dir, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, "report.mjs");
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}
const sum = (name) => summarize(readRun(at(name)));
const ALL = ["headless-equal", "headless-killed-last", "headless-mismatch", "headless-compaction", "headless-skew-cancels",
  "headless-skew-carries", "headless-no-session-killed", "headless-no-session-resume", "interactive-lower-bound-unread",
  "interactive-unpriced"];

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("every fixture is in the DriverUsageReport shape", () => {
  for (const name of ALL) {
    const u = JSON.parse(readFileSync(join(at(name), "driver-usage.json"), "utf8"));
    for (const key of ["source", "cost_source", "verified", "threads", "window", "turns", "tokens", "cost_usd_modeled", "cost_complete", "unpriced", "cross_check"]) {
      assert.ok(key in u, `${name} has ${key}`);
    }
    assert.ok(Array.isArray(u.turns), `${name} turns is an array`);
    assert.equal(report(at(name)).status, 0, name);
  }
});

test("a verified headless run gets an exact total, fresh input, and cached input on its own line", () => {
  const out = report(at("headless-equal")).stdout;
  assert.match(out, /Source\s+codex session file/);
  assert.match(out, /Cost source\s+session file \+ exec stream \(every invocation equal\)/);
  assert.match(out, /Verification\s+verified$/m);
  assert.match(out, /^ {2}Turns\s+2$/m);
  assert.match(out, /Tokens \(in \/ out\)\s+20\.0K \/ 5\.0K/, "input is fresh input: 100K less 80K cached");
  assert.match(out, /Cached input\s+80\.0K/);
  assert.match(out, /Modeled cost\s+\$0\.1160/);
  assert.match(out, /Cross-check\s+verified: every invocation's exec-stream total equals the session file \(exec stream \$0\.1160\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.1660/);
  assert.doesNotMatch(out, /at least|at most|about \$|UNVERIFIED/);
  const r = sum("headless-equal");
  assert.equal(r.driver.input_tokens, 20000);
  assert.equal(r.driver.cached_input_tokens, 80000);
  assert.equal(r.totals.run_total_bound, "exact");
});

test("a killed turn the session file priced does not make the total a floor", () => {
  const out = report(at("headless-killed-last")).stdout;
  assert.match(out, /Incomplete turns\s+1\s+\(no exec-stream usage; priced from the session file\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+\$0\.1900/);
  assert.doesNotMatch(out, /reported no usage/);
  assert.doesNotMatch(out, /at least/);
  const r = sum("headless-killed-last");
  assert.equal(r.driver.turns_incomplete, 1);
  assert.equal(r.driver.turns_incomplete_unpriced, 0);
  const md = report(at("headless-killed-last"), ["--markdown"]).stdout;
  assert.match(md, /- Incomplete turns: no exec-stream usage; priced from the session file/);
  assert.match(md, /\| \*\*Run total = dispatched \+ driver\*\* \| \*\*\$0\.1900\*\* \|/);
});

test("a cross-check mismatch is labelled UNVERIFIED in the driver section and under the run total", () => {
  for (const args of [[], ["--markdown"]]) {
    const out = report(at("headless-mismatch"), args).stdout;
    assert.match(out, /Verification\W+UNVERIFIED/);
    assert.match(out, /Cross-check\W+UNVERIFIED: the exec stream disagrees on invocation 2: output_tokens 2000 vs 3000 in the session file \(exec stream \$0\.1040\)/);
    assert.match(out, /The driver figure is UNVERIFIED: the exec stream disagrees on invocation 2/);
  }
  assert.equal(sum("headless-mismatch").driver.verification.verified, false);
});

test("an exec-stream turn with no usage and no session file makes the total a floor", () => {
  const out = report(at("headless-no-session-killed")).stdout;
  assert.match(out, /^ {2}Turns\s+1$/m, "the null-cost turn is not counted as priced");
  assert.match(out, /Incomplete turns\s+1\s+\(no usage reported; the cost is a floor\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.1000/);
  assert.match(out, /1 driver turn reported no usage, so the run cost is at least this\./);
  assert.match(out, /Cross-check\s+UNVERIFIED: no session file to compare against/);
});

test("a resumed thread with no session file and no baseline is a ceiling, not an exact figure", () => {
  const out = report(at("headless-no-session-resume")).stdout;
  assert.match(out, /Verification\s+UNVERIFIED · UPPER BOUND/);
  assert.match(out, /Driver loop — modeled\s+at most \$0\.1330/);
  assert.match(out, /Run total = dispatched \+ driver\s+at most \$0\.1830/);
  assert.match(out, /includes turns from before this run, so the run cost is at most this\./);
  assert.doesNotMatch(out, /at least/);
  assert.equal(sum("headless-no-session-resume").totals.run_total_bound, "ceiling");
  const md = report(at("headless-no-session-resume"), ["--markdown"]).stdout;
  assert.match(md, /\| \*\*Run total = dispatched \+ driver\*\* \| \*\*at most \$0\.1830\*\* \|/);
});

test("an interactive lower-bound window and an unread thread make the total a floor and say why", () => {
  const out = report(at("interactive-lower-bound-unread")).stdout;
  assert.match(out, /Verification\s+UNVERIFIED · LOWER BOUND · INCOMPLETE/);
  assert.match(out, /Threads\s+019a0000-0000-7000-8000-0000000000a1, 019a0000-0000-7000-8000-0000000000a2/);
  assert.match(out, /Tokens \(in \/ out\)\s+50\.0K \/ 3\.0K/);
  assert.match(out, /Cached input\s+50\.0K/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.1960/);
  assert.match(out, /1 conductor thread had no readable session file \(019a0000-0000-7000-8000-0000000000a2\), so the run cost is at least this\./);
  assert.match(out, /The driver window opens at the first dispatch turn and leaves out the conductor turns before it/);
  assert.doesNotMatch(out, /The driver figure is UNVERIFIED/, "no cross-check ran on the interactive route");
});

test("a turn on a model other than the pin is unpriced and not counted as a turn", () => {
  const out = report(at("interactive-unpriced")).stdout;
  assert.match(out, /^ {2}Turns\s+1$/m);
  assert.match(out, /Unpriced\s+gpt-6\.1-sol \(1 turn; session model gpt-6\.1-sol is not the pin gpt-5\.6-terra\)/);
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.0840/);
});

test("cost_complete false with nothing else to explain it still makes the total a floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-a5-"));
  dirs.push(dir);
  cpSync(at("headless-equal"), dir, { recursive: true });
  const u = JSON.parse(readFileSync(join(dir, "driver-usage.json"), "utf8"));
  writeFileSync(join(dir, "driver-usage.json"), JSON.stringify({ ...u, cost_complete: false }));
  const out = report(dir).stdout;
  assert.match(out, /Run total = dispatched \+ driver\s+at least \$0\.1660/);
  assert.match(out, /The driver cost is marked incomplete/);
});

test("a ceiling driver figure with a partial dispatched call makes the run total approximate", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-a5-"));
  dirs.push(dir);
  cpSync(at("headless-no-session-resume"), dir, { recursive: true });
  const partial = { ts: "2026-10-13T10:00:40.000Z", pass: "x", phase: "tests", provenance: "estimated", usage_complete: false, cost_usd: 0.01 };
  writeFileSync(join(dir, "telemetry.jsonl"), readFileSync(join(dir, "telemetry.jsonl"), "utf8") + JSON.stringify(partial) + "\n");
  const out = report(dir).stdout;
  assert.match(out, /Run total = dispatched \+ driver\s+about \$0\.1930/);
  assert.match(out, /Those pull in opposite directions/);
  assert.match(out, /Driver loop — modeled\s+at most \$0\.1330/, "the driver line keeps its own bound");
});

/** A fixture copy with its cross_check reshaped, for shapes the collector writes in other cases or wrote before. */
function withCrossCheck(name, reshape, top = {}) {
  const dir = mkdtempSync(join(tmpdir(), "report-a5-"));
  dirs.push(dir);
  cpSync(at(name), dir, { recursive: true });
  const u = JSON.parse(readFileSync(join(dir, "driver-usage.json"), "utf8"));
  writeFileSync(join(dir, "driver-usage.json"), JSON.stringify({ ...u, ...top, cross_check: reshape(u.cross_check) }));
  return dir;
}

test("the explained-gap wording reads incomplete_turns, and the older trailing_turns name too", () => {
  const wording = /Cross-check\s+verified: equal; the session file also holds 0 compaction calls and 1 incomplete turn the exec stream never reported/;
  assert.match(report(at("headless-killed-last")).stdout, wording);
  const older = withCrossCheck("headless-killed-last", ({ incomplete_turns, incomplete_tokens, threads, unchecked_threads, unreported_invocations, ...cc }) => ({
    ...cc, trailing_turns: incomplete_turns, trailing_tokens: incomplete_tokens,
  }));
  assert.match(report(older).stdout, wording);
});

test("an unchecked cross-check says which threads had nothing to compare and is UNVERIFIED", () => {
  const dir = withCrossCheck(
    "headless-equal",
    (cc) => ({ ...cc, verdict: "unchecked", verified: false, unchecked_threads: ["019a0000-0000-7000-8000-0000000000b1"] }),
    { verified: false },
  );
  for (const args of [[], ["--markdown"]]) {
    const out = report(dir, args).stdout;
    assert.match(out, /Cross-check\W+UNVERIFIED: 1 thread was booked from the session file with no exec-stream invocation to compare/);
    assert.match(out, /The driver figure is UNVERIFIED: 1 thread was booked from the session file/);
    assert.doesNotMatch(out, /UNVERIFIED: unchecked/);
  }
  const two = withCrossCheck("headless-equal", (cc) => ({ ...cc, verdict: "unchecked", verified: false, unchecked_threads: ["a", "b"] }));
  assert.match(report(two).stdout, /UNVERIFIED: 2 threads were booked from the session file/);
});

/** The token cross-check table's rows as {scope, status, bucket, exec, session, difference}. */
function checkRows(md) {
  const at = md.indexOf("### Token cross-check");
  if (at < 0) return [];
  return md.slice(at).split("\n").filter((l) => /^\| (thread|invocation) /.test(l)).map((l) => {
    const [scope, status, bucket, exec, session, difference] = l.split("|").slice(1, -1).map((c) => c.trim());
    return { scope, status, bucket, exec, session, difference };
  });
}

test("no invocation row of the token cross-check reads equal beside a difference, or differs beside zeros", () => {
  for (const name of ALL) {
    const byScope = new Map();
    for (const r of checkRows(report(at(name), ["--markdown"]).stdout)) {
      if (r.scope.startsWith("invocation")) byScope.set(r.scope, [...(byScope.get(r.scope) ?? []), r]);
    }
    for (const [scope, rows] of byScope) {
      const zero = rows.every((r) => r.difference === "0" || r.difference === "?");
      if (rows[0].status === "equal") assert.ok(zero, `${name}: ${scope} reads equal beside ${rows.map((r) => r.difference)}`);
      if (rows[0].status === "differs" || rows[0].status === "equal_with_explained_gap") {
        assert.ok(!zero, `${name}: ${scope} reads ${rows[0].status} beside all zeros`);
      }
    }
  }
});

test("a compaction call is an explained gap on its own invocation row, named under the table", () => {
  const md = report(at("headless-compaction"), ["--markdown"]).stdout;
  assert.ok(md.includes("| invocation 1 | equal | input | 40000 | 40000 | 0 |"), md);
  assert.ok(md.includes("| invocation 2 | equal_with_explained_gap | input | 60000 | 68000 | +8000 |"), md);
  assert.ok(md.includes("| invocation 2 | equal_with_explained_gap | output | 3000 | 3600 | +600 |"), md);
  assert.ok(md.includes("- Invocation 2 (equal_with_explained_gap): 1 compaction call(s) only in the session file."), md);
  const out = report(at("headless-compaction")).stdout;
  assert.match(out, /invocation 2 — equal_with_explained_gap: input 60000\/68000 \(\+8000\) .* — 1 compaction call\(s\) only in the session file/);
  assert.match(out, /Verification\s+verified$/m);
});

test("a difference that cancels out in a later invocation is a mismatch on both rows, though the thread total agrees", () => {
  const md = report(at("headless-skew-cancels"), ["--markdown"]).stdout;
  assert.ok(md.includes("| invocation 2 | differs | input | 2500 | 3000 | +500 |"), md);
  assert.ok(md.includes("| invocation 3 | differs | input | 5500 | 5000 | -500 |"), md);
  assert.ok(md.includes("| thread `019a0000-0000-7000-8000-0000000000a1` | mismatch | input | 9000 | 9000 | 0 |"), md);
  assert.match(md, /Cross-check: UNVERIFIED: the exec stream disagrees on invocation 2: input_tokens 2500 vs 3000 in the session file/);
  assert.match(md, /its status also counts the invocation rows under it/);
  assert.equal(sum("headless-skew-cancels").driver.verification.verified, false);
});

test("a difference that carries forward differs only on the invocation where it starts", () => {
  const md = report(at("headless-skew-carries"), ["--markdown"]).stdout;
  assert.ok(md.includes("| invocation 2 | differs | input | 2500 | 3000 | +500 |"), md);
  assert.ok(md.includes("| invocation 3 | equal | input | 5000 | 5000 | 0 |"), md);
  assert.ok(md.includes("| thread `019a0000-0000-7000-8000-0000000000a1` | mismatch | input | 8500 | 9000 | +500 |"), md);
});

test("an equal thread whose invocation also counts an earlier unreported one says so, and names it on the row", () => {
  const note = "the running total also counts invocation 1, which reported no usage";
  const dir = withCrossCheck("headless-equal", (cc) => ({
    ...cc,
    invocations: cc.invocations.map((i, k) => (k === 1 ? { ...i, status: "equal_with_explained_gap", reason: note } : i)),
  }));
  const out = report(dir).stdout;
  assert.match(out, /Cross-check\s+verified: equal; 1 invocation also counts the turns of an earlier one that reported no usage/);
  assert.ok(out.includes(`— ${note}`), out);
  assert.ok(report(dir, ["--markdown"]).stdout.includes(`- Invocation 2 (equal_with_explained_gap): ${note}.`));
});
