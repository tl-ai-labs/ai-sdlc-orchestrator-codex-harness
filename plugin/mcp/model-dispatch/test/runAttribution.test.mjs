// Interactive conductor cost when several runs share one codex thread: every
// response the session file records is booked by at most one run, a thread
// whose turns the figure leaves out marks it incomplete, and the cap counts
// the headless invocation still running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { driverSpendForCap, measureDriverUsage } from "../dist/sessionUsage.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { SyntheticRollout, driverEventLines, inside, marker, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = loadPolicyFromPath(join(HERE, "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml"));
const T1 = "01a2000b-0000-7000-8000-0000000000a1";
const T2 = "01a2000b-0000-7000-8000-0000000000a2";
const cost = (x) => ((x.input_tokens - x.cached_input_tokens) * 2 + x.cached_input_tokens * 0.2 + x.output_tokens * 12) / 1e6;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function sandbox(...runIds) {
  const root = mkdtempSync(join(tmpdir(), "mmo-attrib-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const runs = runIds.map((id) => {
    const dir = join(root, "project", ".sdlc", "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { root, home, runs, done: () => rmSync(root, { recursive: true, force: true }) };
}

const measure = (s, run) => {
  const m = measureDriverUsage({ runDir: run, policy: POLICY, codexHome: s.home });
  assert.equal(m.ok, true, m.message);
  return m.report;
};
const inputOf = (rep) => rep.turns.map((t) => t.tokens.input_tokens);

test("a run resumed on a thread that hosted another run in between books only its own turns, and so does its cap", () => {
  const s = sandbox("run-a", "run-b");
  try {
    const [A, B] = s.runs;
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a1 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const a2 = r.turn({ text: "approve", responses: [{ usage: u(2000) }] });
    const b1 = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(50_000) }] });
    const b2 = r.turn({ text: "approve", responses: [{ usage: u(60_000) }] });
    r.turn({ text: "what changed?", responses: [{ usage: u(70_000) }] });
    const a3 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(3000) }] });
    const a4 = r.turn({ text: "approve", responses: [{ usage: u(4000) }] });
    r.write(s.home);
    writeJsonl(join(A, "driver-session.jsonl"), [
      marker(T1, inside(a1), "start_run"),
      marker(T1, inside(a2)),
      marker(T1, inside(a3), "start_run"),
      marker(T1, inside(a4)),
    ]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(b1), "start_run"), marker(T1, inside(b2))]);

    const a = measure(s, A);
    assert.deepEqual(inputOf(a), [1000, 2000, 3000, 4000]);
    assert.equal(a.window.start_anchor, "command_turn");
    assert.equal(a.window.exact, true);
    assert.equal(a.window.left_out_turns, 3, "B's two turns and the chat turn after it");
    assert.equal(a.cost_usd_modeled, r6(cost(u(10_000))));
    assert.equal(driverSpendForCap(A, POLICY, { codexHome: s.home }).usd, a.cost_usd_modeled, "the cap books the same turns");

    const b = measure(s, B);
    assert.deepEqual(inputOf(b), [50_000, 60_000]);
    assert.equal(b.window.left_out_turns, undefined);
  } finally {
    s.done();
  }
});

test("the discard step's collection claims no turn of the session that discarded the run", () => {
  const s = sandbox("run-old", "run-new");
  try {
    const [OLD, NEW] = s.runs;
    const old = new SyntheticRollout({ threadId: T2, originator: "codex-tui", start: "2026-10-12T09:00:00.000Z" });
    const o1 = old.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(7000) }] });
    old.write(s.home, { dir: "sessions/2026/10/12" });
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const n0 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const n1 = r.turn({ text: "discard", responses: [{ usage: u(30_000) }] });
    const n2 = r.turn({ text: "approve", responses: [{ usage: u(5000) }] });
    r.write(s.home);
    writeFileSync(join(OLD, "run.json"), JSON.stringify({ route: "interactive", starts: [{ codex_thread_id: T2 }] }));
    writeJsonl(join(OLD, "driver-session.jsonl"), [
      marker(T2, inside(o1), "start_run"),
      marker(T1, inside(n1), "collect_driver_usage"),
    ]);
    writeJsonl(join(NEW, "driver-session.jsonl"), [marker(T1, inside(n0), "start_run"), marker(T1, inside(n2))]);

    const discarded = measure(s, OLD);
    assert.deepEqual(discarded.thread_ids, [T2]);
    assert.deepEqual(inputOf(discarded), [7000]);
    assert.deepEqual(
      discarded.excluded_threads,
      [{ thread_id: T1, reason: "it holds only an end-of-run collection for this run, after another run's marker", conductor_turns_left_out: false }],
      "a collection run from another session drops none of this run's turns",
    );
    assert.equal(discarded.cost_complete, true);
    assert.deepEqual(inputOf(measure(s, NEW)), [1000, 30_000, 5000]);

    rmSync(join(OLD, "run.json"));
    writeJsonl(join(OLD, "driver-session.jsonl"), [marker(T1, inside(n1), "collect_driver_usage")]);
    const legacy = measureDriverUsage({ runDir: OLD, policy: POLICY, codexHome: s.home });
    assert.equal(legacy.ok, false, "with no run.json and only that collection, nothing is this run's");
    assert.equal(legacy.code, "no_threads");
  } finally {
    s.done();
  }
});

test("a chat used only to close the run out holds this run's turns: left out with run.json, a lower bound without it", () => {
  const s = sandbox("r1");
  try {
    const [run] = s.runs;
    const a = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a1 = a.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const a2 = a.turn({ text: "approve", responses: [{ usage: u(2000) }] });
    a.write(s.home);
    // /new without --resume: answer the last gate, then end the run from that chat.
    const b = new SyntheticRollout({ threadId: T2, originator: "codex-tui", start: "2026-10-13T11:00:00.000Z" });
    b.turn({ text: "where was run r1? approve the last gate", responses: [{ usage: u(300_000) }, { usage: u(300_000) }] });
    const b2 = b.turn({ text: "close it out", responses: [{ usage: u(200_000) }] });
    b.write(s.home);
    writeFileSync(join(run, "run.json"), JSON.stringify({ route: "interactive", starts: [{ codex_thread_id: T1 }] }));
    writeJsonl(join(run, "driver-session.jsonl"), [marker(T1, inside(a1), "start_run"), marker(T1, inside(a2)), marker(T2, inside(b2), "collect_driver_usage")]);

    const rep = measure(s, run);
    assert.deepEqual(rep.thread_ids, [T1]);
    assert.deepEqual(rep.excluded_threads, [{ thread_id: T2, reason: "run.json records no start of this run in it", conductor_turns_left_out: true }]);
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /INCOMPLETE: this run's turns in 1 conductor thread\(s\) left out/);
    const cap = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.deepEqual(cap.not_counted, ["this run's turns in 1 conductor thread(s) run.json records no start of this run in"]);

    rmSync(join(run, "run.json"));
    const legacy = measure(s, run);
    assert.deepEqual(legacy.thread_ids, [T1, T2]);
    assert.deepEqual(inputOf(legacy), [1000, 2000, 200_000], "the collection's turn is this run's");
    assert.equal(legacy.window.lower_bound, true, "the chat's turns before it may be this run's too");
    assert.match(legacy.cost_source, /LOWER BOUND/);
  } finally {
    s.done();
  }
});

test("a run under another .sdlc/runs on the chat's folder path is found, so neither run books the other's turns", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-attrib-"));
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const chat = join(root, "repo", "app");
    // start-run.mjs puts a brownfield run at the git toplevel and a greenfield run at the chat's folder.
    const A = join(root, "repo", ".sdlc", "runs", "run-a");
    const B = join(chat, ".sdlc", "runs", "run-b");
    mkdirSync(A, { recursive: true });
    mkdirSync(B, { recursive: true });
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui", cwd: chat });
    const a1 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const b1 = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(50_000) }] });
    const a2 = r.turn({ text: "resume run-a", responses: [{ usage: u(2000) }] });
    const b2 = r.turn({ text: "resume run-b", responses: [{ usage: u(60_000) }] });
    r.write(home);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(a1), "start_run"), marker(T1, inside(a2), "start_run")]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(b1), "start_run"), marker(T1, inside(b2), "start_run")]);

    const a = measureDriverUsage({ runDir: A, policy: POLICY, codexHome: home }).report;
    const b = measureDriverUsage({ runDir: B, policy: POLICY, codexHome: home }).report;
    assert.deepEqual(inputOf(a), [1000, 2000]);
    assert.equal(a.window.left_out_turns, 1);
    assert.deepEqual(inputOf(b), [50_000, 60_000]);
    assert.equal(b.window.left_out_turns, 1);
    assert.equal(driverSpendForCap(A, POLICY, { codexHome: home }).usd, a.cost_usd_modeled, "the cap books the same turns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn that ends one run and resumes another is split at the first run's last marker, the same before and after", () => {
  const s = sandbox("run-a", "run-n");
  try {
    const [A, N] = s.runs;
    const build = (responses) => {
      const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
      const x = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
      const y = r.turn({ text: "resume", responses, end: null });
      r.write(s.home);
      return { x, y };
    };
    const ending = { usage: u(20_000, 10_000, 100) };
    // end-run's collection runs after the turn's first response, start-run --resume after its second.
    const early = build([ending]);
    writeJsonl(join(N, "driver-session.jsonl"), [marker(T1, inside(early.x), "start_run"), marker(T1, inside(early.y, 35), "collect_driver_usage")]);
    const atEnd = measure(s, N);
    assert.deepEqual(inputOf(atEnd), [1000, 20_000]);
    assert.equal(atEnd.window.provisional, true);

    const { y } = build([ending, { usage: u(30_000, 25_000, 200) }, { usage: u(40_000, 35_000, 300) }]);
    assert.equal(y.started_at, early.y.started_at);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(y, 55), "start_run")]);
    const n = measure(s, N);
    const a = measure(s, A);
    assert.deepEqual(inputOf(n), [1000, 20_000], "the figure end-run wrote still holds");
    assert.equal(n.window.provisional, false, "the next run's marker closes this run's share of the turn");
    assert.equal(n.window.end, inside(y, 35));
    assert.deepEqual(inputOf(a), [70_000]);
    assert.deepEqual(a.turns.map((t) => t.turn_id), [y.id]);
    assert.deepEqual([a.window.start, a.window.start_anchor, a.window.provisional], [inside(y, 35), "start_run_turn", true]);
    assert.equal(a.window.lower_bound, false, "the resume's own start marker anchors it: no turn of this run comes before it");
    assert.doesNotMatch(a.cost_source, /LOWER BOUND/);
    assert.equal(n.tokens.input_tokens + a.tokens.input_tokens, y.cumulative.input_tokens, "every response of both turns, once");
    assert.equal(
      r6(n.cost_usd_modeled + a.cost_usd_modeled),
      r6(cost(u(1000)) + cost(u(20_000, 10_000, 100)) + cost(u(70_000, 60_000, 500))),
    );
  } finally {
    s.done();
  }
});

test("a run started in plain words opens at start-run's turn, and only a dispatch-first window is a lower bound", () => {
  const s = sandbox("run-a", "run-b");
  try {
    const [A, B] = s.runs;
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    r.turn({ text: "what does this repo do?", responses: [{ usage: u(9000) }] });
    const a1 = r.turn({ text: "run the brownfield pipeline here", responses: [{ usage: u(1000) }] });
    const a2 = r.turn({ text: "approve", responses: [{ usage: u(2000) }] });
    const b1 = r.turn({ text: "now the docs job", responses: [{ usage: u(3000) }] });
    r.write(s.home);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(a1), "start_run"), marker(T1, inside(a2))]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(b1))]);
    const a = measure(s, A);
    assert.deepEqual(inputOf(a), [1000, 2000]);
    assert.deepEqual([a.window.start_anchor, a.window.lower_bound, a.window.exact], ["start_run_turn", false, true]);
    const b = measure(s, B);
    assert.deepEqual([b.window.start_anchor, b.window.lower_bound], ["first_dispatch_turn", true]);
  } finally {
    s.done();
  }
});

test("runs interleaved on one thread never book the same response twice", () => {
  const s = sandbox("run-a", "run-b", "run-c");
  try {
    const [A, B, C] = s.runs;
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const three = [{ usage: u(100) }, { usage: u(200) }, { usage: u(400) }];
    const t = [
      r.turn({ text: "$mmo-codex:greenfield", responses: three }),
      r.turn({ text: "go", responses: three }),
      r.turn({ text: "$mmo-codex:docs", responses: three }),
      r.turn({ text: "go", responses: three }),
      r.turn({ text: "go", responses: three, end: null }),
    ];
    r.write(s.home);
    writeJsonl(join(A, "driver-session.jsonl"), [marker(T1, inside(t[0])), marker(T1, inside(t[1], 35)), marker(T1, inside(t[3], 75))]);
    writeJsonl(join(B, "driver-session.jsonl"), [marker(T1, inside(t[1], 55)), marker(T1, inside(t[2], 45))]);
    writeJsonl(join(C, "driver-session.jsonl"), [marker(T1, inside(t[2], 65)), marker(T1, inside(t[4]))]);
    const reps = [A, B, C].map((run) => measure(s, run));
    const booked = new Map();
    for (const rep of reps) {
      for (const turn of rep.turns) booked.set(turn.turn_id, (booked.get(turn.turn_id) ?? 0) + turn.tokens.input_tokens);
    }
    for (const turn of t) assert.ok((booked.get(turn.id) ?? 0) <= 700, `${turn.id} booked ${booked.get(turn.id)} of 700`);
    assert.equal(reps.reduce((n, rep) => n + rep.tokens.input_tokens, 0), 3500, "every response of the five turns, once");
  } finally {
    s.done();
  }
});

test("conductor turns in a thread run.json never started are left out, and the figure and the cap say so", () => {
  const s = sandbox("r1");
  try {
    const [run] = s.runs;
    const a = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a1 = a.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    a.write(s.home);
    const b = new SyntheticRollout({ threadId: T2, originator: "codex-tui", start: "2026-10-13T11:00:00.000Z" });
    const b1 = b.turn({ text: "carry on with the run", responses: [{ usage: u(400_000) }] });
    b.write(s.home);
    writeFileSync(join(run, "run.json"), JSON.stringify({ route: "interactive", starts: [{ codex_thread_id: T1 }] }));
    writeJsonl(join(run, "driver-session.jsonl"), [marker(T1, inside(a1), "start_run"), marker(T2, inside(b1))]);

    const rep = measure(s, run);
    assert.deepEqual(rep.thread_ids, [T1]);
    assert.deepEqual(rep.excluded_threads, [{ thread_id: T2, reason: "run.json records no start of this run in it", conductor_turns_left_out: true }]);
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /INCOMPLETE: this run's turns in 1 conductor thread\(s\) left out, as run\.json records no start of this run there/);
    const cap = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.equal(cap.usd, r6(cost(u(1000))));
    assert.deepEqual(cap.not_counted, ["this run's turns in 1 conductor thread(s) run.json records no start of this run in"]);

    const named = measureDriverUsage({ runDir: run, policy: POLICY, codexHome: s.home, threadIds: [T2] }).report;
    assert.deepEqual(named.thread_ids, [T1, T2], "--thread counts it");
    assert.deepEqual([named.excluded_threads, named.cost_complete], [[], true]);

    writeJsonl(join(run, "driver-session.jsonl"), [marker(T2, inside(b1))]);
    const only = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.deepEqual([only.source, only.unmeasured], ["none", true], "with nothing else to book, the cap reports the conductor unmeasured");
    assert.match(only.note, /run\.json records no start of this run in/);
  } finally {
    s.done();
  }
});

test("headless: the cap adds the running invocation's session-file turns to the driver rows, and stops once its row lands", () => {
  const s = sandbox("r1");
  try {
    const [run] = s.runs;
    const r = new SyntheticRollout({ threadId: T1 });
    const t1 = r.turn({ responses: [{ usage: u(100_000) }] });
    const t2 = r.turn({ responses: Array.from({ length: 4 }, () => ({ usage: u(250_000) })), end: null });
    r.write(s.home);
    const events = (invs) => writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(T1, invs));
    events([{ turn: t1 }, { turn: t2, incomplete: true, open: true }]);
    const row = (invocation, usd, extra = {}) => ({ invocation, thread_id: T1, status: "complete", cost_usd: usd, provenance: "modeled", ...extra });
    writeJsonl(join(run, "driver-cost-modeled.jsonl"), [row(1, 0.2)]);

    const live = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.equal(live.source, "driver-cost-modeled");
    assert.equal(live.usd, 2.2, "$0.20 reported plus 1M fresh input still running");
    assert.match(live.note, /plus the session file's turns of 1 invocation\(s\) not yet reported \(2\)/);
    assert.deepEqual(live.not_counted, []);

    events([{ turn: t1 }, { turn: t2 }]);
    writeJsonl(join(run, "driver-cost-modeled.jsonl"), [row(1, 0.2), row(2, 2)]);
    const reported = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.equal(reported.usd, 2.2, "never both the row and the session file");
    assert.equal(reported.note, "2 complete driver turn(s)");
  } finally {
    s.done();
  }
});

test("headless: a killed invocation before the running one is counted from the session file, not named as left out", () => {
  const s = sandbox("r1");
  try {
    const [run] = s.runs;
    const r = new SyntheticRollout({ threadId: T1 });
    const t1 = r.turn({ responses: [{ usage: u(100_000) }] });
    const t2 = r.turn({ responses: [{ usage: u(200_000) }], end: "aborted" });
    const t3 = r.turn({ responses: [{ usage: u(150_000) }], end: null });
    r.write(s.home);
    writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(T1, [{ turn: t1 }, { turn: t2, incomplete: true }, { turn: t3, incomplete: true, open: true }]));
    writeJsonl(join(run, "driver-cost-modeled.jsonl"), [
      { invocation: 1, thread_id: T1, status: "complete", cost_usd: 0.2 },
      { invocation: 2, thread_id: T1, status: "incomplete", cost_usd: null },
    ]);
    const spend = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.equal(spend.usd, r6(0.2 + cost(u(350_000))));
    assert.deepEqual(spend.not_counted, []);

    writeJsonl(join(run, "driver-cost-modeled.jsonl"), [
      { invocation: 1, thread_id: T1, status: "complete", cost_usd: 0.2 },
      { invocation: 2, thread_id: T1, status: "incomplete", cost_usd: null },
      { invocation: 3, thread_id: T1, status: "complete", cost_usd: r6(cost(u(350_000))) },
    ]);
    const after = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.equal(after.usd, r6(0.2 + cost(u(350_000))));
    assert.deepEqual(after.not_counted, [], "the later running total holds the killed turn's tokens");
  } finally {
    s.done();
  }
});

test("headless: a running invocation with no readable session file is named as not counted", () => {
  const s = sandbox("r1");
  try {
    const [run] = s.runs;
    const r = new SyntheticRollout({ threadId: T1 });
    const t1 = r.turn({ responses: [{ usage: u(100_000) }] });
    const t2 = r.turn({ responses: [{ usage: u(50_000) }], end: null });
    writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(T1, [{ turn: t1 }, { turn: t2, incomplete: true, open: true }]));
    writeJsonl(join(run, "driver-cost-modeled.jsonl"), [{ invocation: 1, thread_id: T1, status: "complete", cost_usd: 0.2 }]);
    const spend = driverSpendForCap(run, POLICY, { codexHome: s.home });
    assert.equal(spend.usd, 0.2);
    assert.deepEqual(spend.not_counted, ["invocation(s) 2 not yet reported (no readable session file)"]);
  } finally {
    s.done();
  }
});
