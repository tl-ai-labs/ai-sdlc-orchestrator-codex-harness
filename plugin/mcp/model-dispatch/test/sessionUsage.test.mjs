import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

import {
  RUN_SKILLS,
  RUN_SKILL_RE,
  findRolloutFile,
  parseRollout,
  measureDriverUsage,
  driverSpendForCap,
  driverPin,
  defaultDriverPriceFn,
  driverUsageInputs,
  driverUsageIsFresh,
  windowFromMarkers,
} from "../dist/sessionUsage.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { PIN, SyntheticRollout, driverEventLines, inside, marker, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "..", "..");
const POLICY = loadPolicyFromPath(join(PLUGIN, "config", "policies", "gpt-plus-flash.yaml"));
const T1 = "01a2000a-0000-7000-8000-000000000001";
const T2 = "01a2000a-0000-7000-8000-000000000002";

/** 1M fresh input as four responses, each under the 272,000 long-context threshold: $2.00 at the standard card. */
const MILLION = Array.from({ length: 4 }, () => ({ usage: u(250_000) }));
const cost = (x) => ((x.input_tokens - x.cached_input_tokens) * 2 + x.cached_input_tokens * 0.2 + x.output_tokens * 12) / 1e6;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mmo-session-"));
  const home = join(root, "home");
  const run = join(root, "run");
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  return { root, home, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

function headless(s, rollout, invocations) {
  writeJsonl(join(s.run, "driver-events.jsonl"), driverEventLines(rollout.threadId, invocations));
}

test("the pinned model comes from the driver block when a policy has one, else from its gpt entry", () => {
  assert.deepEqual(driverPin(POLICY), { model: PIN, effort: "high" });
  assert.deepEqual(driverPin({ ...POLICY, driver: { model_name: "gpt-x", reasoning: { effort: "low" } } }), { model: "gpt-x", effort: "low" });
  const { driver: _driver, ...legacy } = POLICY;
  assert.deepEqual(driverPin(legacy), { model: PIN, effort: "high" }, "a policy without a driver block falls back to its gpt entry");
  assert.equal(driverPin({ ...legacy, models: legacy.models.filter((m) => m.id !== "gpt") }), null);
});

test("the conductor is priced from the dated list on the day it spent, whatever model entries the policy has", () => {
  const flashOnly = loadPolicyFromPath(join(PLUGIN, "config", "policies", "flash-agsdk-only.yaml"));
  assert.equal(flashOnly.models.some((m) => m.model_name === PIN), false, "the fixture has no model entry for the pin");
  const card = (r) => r && { input: r.input, input_cached: r.input_cached, output: r.output };
  const at = "2026-10-13T10:00:00.000Z";
  for (const policy of [flashOnly, POLICY, { ...flashOnly, driver: { ...flashOnly.driver, pricing: undefined } }]) {
    const rate = defaultDriverPriceFn(policy)(PIN, at, { requestInputTokens: 1000 });
    assert.deepEqual(card(rate), { input: 2, input_cached: 0.2, output: 12 });
    assert.deepEqual([rate.basis, rate.tier], ["list", "standard"]);
  }
  const long = defaultDriverPriceFn(POLICY)(PIN, at, { requestInputTokens: 300_000 });
  assert.deepEqual([card(long), long.tier], [{ input: 4, input_cached: 0.4, output: 18 }, "long_context"]);
  const summed = defaultDriverPriceFn(POLICY)(PIN, at, { aggregateInputTokens: 300_000, aggregate: true });
  assert.deepEqual([card(summed), summed.tier], [{ input: 2, input_cached: 0.2, output: 12 }, "unverified"], "a sum over responses proves no tier");
  assert.equal(defaultDriverPriceFn(POLICY)(PIN, "2026-08-01T00:00:00.000Z", {}), null, "before the list's first entry nothing prices it");
  const custom = { ...POLICY, driver: { ...POLICY.driver, pricing: { input: 9, input_cached: 0.9, output: 90 }, pricing_override: true } };
  assert.deepEqual(card(defaultDriverPriceFn(custom)(PIN, at, {})), { input: 9, input_cached: 0.9, output: 90 });
});

test("the session file is found by thread id in any date folder, plain before compressed, then live before archived", () => {
  const s = sandbox();
  try {
    assert.equal(findRolloutFile(s.home, T1), null);
    const r = new SyntheticRollout({ threadId: T1 });
    r.write(s.home, { dir: "sessions/2026/10/01", compressed: true });
    assert.equal(findRolloutFile(s.home, T1).compressed, true);
    r.write(s.home, { dir: "archived_sessions/2026/09/30" });
    assert.match(findRolloutFile(s.home, T1).rel, /^archived_sessions\//, "a readable archived copy beats a compressed one");
    r.write(s.home, { dir: "sessions/2026/10/14" });
    const plain = findRolloutFile(s.home, T1);
    assert.equal(plain.compressed, false);
    assert.equal(plain.archived, false);
    assert.equal(findRolloutFile(s.home, "../../etc"), null, "a value that is not a thread id finds nothing");
  } finally {
    s.done();
  }
});

test("per-response records are booked once, repeated token_count totals are not, and a torn line is skipped", () => {
  const r = new SyntheticRollout({ threadId: T1, planType: "plus" });
  r.turn({ responses: [{ usage: u(1000, 200, 50, 10), repeat: true }, { usage: u(3000, 900, 70, 20) }] });
  const dupe = r.lines.find((l) => l.type === "token_usage_record");
  const text = r.text() + JSON.stringify(dupe) + "\n" + '{"timestamp":"2026-10-13T11:00:00.000Z","type":"token_usage_record","payload":{"usage":{"input_tok';
  const parsed = parseRollout(text);
  assert.equal(parsed.series, "token_usage_record");
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.duplicate_records, 1);
  assert.equal(parsed.token_count_repeats, 1);
  assert.equal(parsed.torn_lines, 1);
  assert.equal(parsed.plan_type, "plus");
  assert.equal(parsed.meta.originator, "codex_exec");
  assert.deepEqual(parsed.records.map((x) => x.model), [PIN, PIN]);
});

test("a compaction call is booked and flagged, though token_count leaves it out", () => {
  const r = new SyntheticRollout({ threadId: T1 });
  r.turn({ responses: [{ usage: u(1000) }, { usage: u(5000, 4000, 300), compaction: true }, { usage: u(800) }] });
  const parsed = parseRollout(r.text());
  assert.deepEqual(parsed.records.map((x) => x.compaction), [false, true, false]);
  assert.equal(parsed.token_counts.at(-1).total.input_tokens, 1800);
});

test("a file with no per-response records falls back to token_count differences", () => {
  const r = new SyntheticRollout({ threadId: T1, records: false });
  r.turn({ responses: [{ usage: u(1000, 100, 10), repeat: true }, { usage: u(2000, 500, 20) }] });
  r.turn({ responses: [{ usage: u(4000, 1000, 40) }], resetBefore: true });
  const parsed = parseRollout(r.text());
  assert.equal(parsed.series, "token_count");
  assert.deepEqual(parsed.records.map((x) => x.usage.input_tokens), [1000, 2000, 4000]);
  assert.deepEqual(parsed.records.map((x) => x.turn_id), [r.turns[0].id, r.turns[0].id, r.turns[1].id]);
  assert.equal(parsed.token_count_repeats, 1);
  assert.equal(parsed.token_count_resets, 1);
});

test("the run-skill list is the two entry points, pass, and every intent id, each a shipped skill", () => {
  const intents = JSON.parse(readFileSync(join(PLUGIN, "config", "intents.json"), "utf-8")).intents.map((i) => i.id);
  assert.deepEqual([...RUN_SKILLS].sort(), ["brownfield", "greenfield", "pass", ...intents].sort());
  const skills = readdirSync(join(PLUGIN, "skills"));
  for (const name of RUN_SKILLS) assert.ok(skills.includes(name), name);
  assert.ok(RUN_SKILL_RE.test("please run $mmo-codex:brownfield now"));
  assert.ok(!RUN_SKILL_RE.test("$mmo-codex:brownfield-guide"));
  assert.ok(!RUN_SKILL_RE.test("$mmo-codex:setup"));
});

test("interactive: the window runs from the run-skill turn through the last dispatch turn", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui", source: "vscode" });
    r.turn({ text: "what does this repo do?", responses: [{ usage: u(9000, 0, 900) }] });
    const command = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000, 100, 10) }] });
    const gate1 = r.turn({ text: "approve", responses: [{ usage: u(2000, 1500, 20) }, { usage: u(2500, 2000, 25) }] });
    const gate2 = r.turn({ text: "approve", responses: [{ usage: u(3000, 2500, 30) }] });
    r.turn({ text: "thanks", responses: [{ usage: u(7000, 0, 700) }] });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(gate1)), marker(T1, inside(gate2))]);

    const m = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home });
    assert.equal(m.ok, true);
    const rep = m.report;
    assert.equal(rep.route, "interactive");
    assert.equal(rep.source, "session-file");
    assert.deepEqual(rep.thread_ids, [T1]);
    assert.deepEqual(rep.turns.map((t) => t.turn_id), [command.id, gate1.id, gate2.id]);
    assert.equal(rep.window.start_anchor, "command_turn");
    assert.equal(rep.window.end, gate2.ended_at);
    assert.equal(rep.window.exact, true);
    const expected = cost(u(1000, 100, 10)) + cost(u(2000, 1500, 20)) + cost(u(2500, 2000, 25)) + cost(u(3000, 2500, 30));
    assert.equal(rep.cost_usd_modeled, r6(expected));
    assert.equal(rep.tokens.requests, 4);
    assert.equal(rep.cost_complete, true);
    assert.equal(rep.cross_check, null);
    assert.match(rep.cost_source, /^session file \(interactive; no exec stream to cross-check; unverified\)$/);
  } finally {
    s.done();
  }
});

test("interactive: no run-skill turn makes a lower bound, and a running closing turn is provisional", () => {
  const r = new SyntheticRollout({ threadId: T1 });
  const a = r.turn({ text: "start the pipeline", responses: [{ usage: u(100) }] });
  const b = r.turn({ text: "go on", responses: [{ usage: u(100) }], end: null });
  const w = windowFromMarkers(parseRollout(r.text()), [{ ts: inside(a) }, { ts: inside(b) }]);
  assert.equal(w.start, a.started_at);
  assert.equal(w.start_anchor, "first_dispatch_turn");
  assert.equal(w.lower_bound, true);
  assert.equal(w.end, null);
  assert.equal(w.provisional, true);
  assert.equal(w.exact, false);
});

test("turns on a model other than the pin are listed as unpriced, never priced at the pin's rate", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a = r.turn({ text: "$mmo-codex:greenfield", model: "gpt-6.1-sol", responses: [{ usage: u(5000, 4000, 50) }] });
    const b = r.turn({ responses: [{ usage: u(1000, 0, 10) }] });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a)), marker(T1, inside(b))]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cost_usd_modeled, r6(cost(u(1000, 0, 10))));
    assert.equal(rep.cost_complete, false);
    assert.equal(rep.unpriced.length, 1);
    assert.equal(rep.unpriced[0].model, "gpt-6.1-sol");
    assert.equal(rep.unpriced[0].tokens.input_tokens, 5000);
    assert.match(rep.unpriced[0].reason, /session model gpt-6\.1-sol is not the pin gpt-5\.6-terra/);
    assert.match(rep.cost_source, /INCOMPLETE: unpriced tokens excluded/);
    assert.equal(rep.turns[0].cost_usd, null);
  } finally {
    s.done();
  }
});

test("each response is priced on its own, through a price function shaped like the dated list", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(1000) }, { usage: u(300000) }] });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);
    const calls = [];
    const priceFn = (model, at, ctx) => {
      calls.push({ model, at, ctx });
      return ctx.requestInputTokens > 272000 ? { input: 4, input_cached: 0.4, output: 18 } : { input: 2, input_cached: 0.2, output: 12 };
    };
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home, priceFn }).report;
    assert.deepEqual(calls.map((c) => [c.model, c.ctx.requestInputTokens]), [[PIN, 1000], [PIN, 300000]]);
    assert.ok(calls.every((c) => typeof c.at === "string"));
    assert.equal(rep.cost_usd_modeled, r6((1000 * 2 + 300000 * 4) / 1e6));
  } finally {
    s.done();
  }
});

test("interactive: no readable session file means nothing to book", () => {
  const s = sandbox();
  try {
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, "2026-10-13T10:00:01.000Z")]);
    const m = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home });
    assert.equal(m.ok, false);
    assert.equal(m.code, "no_rollout");
    assert.match(m.message, /--codex-home/);
    const none = measureDriverUsage({ runDir: join(s.root, "empty"), policy: POLICY, codexHome: s.home });
    assert.equal(none.code, "no_threads");
  } finally {
    s.done();
  }
});

test("headless: exec + 2 resumes agree with the session file on every invocation and book the deltas once", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const t = [
      r.turn({ responses: [{ usage: u(1000, 200, 50, 10) }] }),
      r.turn({ responses: [{ usage: u(3000, 900, 70, 20) }] }),
      r.turn({ responses: [{ usage: u(5000, 2000, 90, 30) }] }),
    ];
    r.write(s.home);
    headless(s, r, t.map((turn) => ({ turn })));
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.route, "headless");
    assert.equal(rep.cross_check.verdict, "equal");
    assert.equal(rep.verified, true);
    assert.equal(rep.cost_source, "session file + exec stream (every invocation equal)");
    assert.equal(rep.tokens.input_tokens, 9000, "the running totals are differenced, not summed to 14000");
    assert.deepEqual(rep.cross_check.exec_stream_tokens, u(9000, 3100, 210, 60));
    assert.equal(rep.cost_usd_modeled, 0.01494);
    assert.equal(rep.cross_check.exec_stream_cost_usd, 0.01494);
    assert.deepEqual(rep.turns.map((x) => x.invocation), [1, 2, 3]);

    const zero = u(0);
    const inv = rep.cross_check.invocations;
    assert.deepEqual(inv.map((i) => i.exec_cumulative), [u(1000, 200, 50, 10), u(4000, 1100, 120, 30), u(9000, 3100, 210, 60)]);
    assert.deepEqual(inv.map((i) => i.session_total), inv.map((i) => i.exec_cumulative));
    assert.deepEqual(inv.map((i) => i.difference), [zero, zero, zero]);
    const perTurn = [u(1000, 200, 50, 10), u(3000, 900, 70, 20), u(5000, 2000, 90, 30)];
    assert.deepEqual(inv.map((i) => i.exec_delta), perTurn);
    assert.deepEqual(inv.map((i) => i.session_turn_tokens), perTurn);
    assert.deepEqual(inv.map((i) => i.turn_id), t.map((x) => x.id));
    assert.equal(rep.cross_check.threads.length, 1);
    const th = rep.cross_check.threads[0];
    assert.deepEqual(
      { id: th.thread_id, verdict: th.verdict, s: th.session_tokens, e: th.exec_stream_tokens, d: th.difference, gap: th.gap },
      { id: T1, verdict: "equal", s: u(9000, 3100, 210, 60), e: u(9000, 3100, 210, 60), d: zero, gap: null },
    );
  } finally {
    s.done();
  }
});

test("headless: two threads are compared separately, each with its own buckets and difference", () => {
  const s = sandbox();
  try {
    const r1 = new SyntheticRollout({ threadId: T1 });
    const a = r1.turn({ responses: [{ usage: u(1000, 200, 50, 10) }] });
    const b = r1.turn({ responses: [{ usage: u(3000, 900, 70, 20) }, { usage: u(4000, 3000, 10), compaction: true }] });
    r1.write(s.home);
    const r2 = new SyntheticRollout({ threadId: T2, start: "2026-10-13T12:00:00.000Z" });
    const c = r2.turn({ responses: [{ usage: u(7000, 100, 30, 5) }] });
    r2.write(s.home);
    writeJsonl(join(s.run, "driver-events.jsonl"), [
      ...driverEventLines(T1, [{ turn: a }, { turn: b }]),
      ...driverEventLines(T2, [{ turn: c }]).map((l) => ({ ...l, invocation: l.invocation + 2 })),
    ]);
    const cc = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report.cross_check;
    assert.equal(cc.verdict, "equal_with_explained_gap");
    const [one, two] = cc.threads;
    assert.deepEqual([one.thread_id, one.verdict, two.thread_id, two.verdict], [T1, "equal_with_explained_gap", T2, "equal"]);
    assert.deepEqual(one.session_tokens, u(8000, 4100, 130, 30));
    assert.deepEqual(one.exec_stream_tokens, u(4000, 1100, 120, 30));
    assert.deepEqual(one.difference, u(4000, 3000, 10), "the compaction call is the whole difference");
    assert.deepEqual(one.compaction_tokens, u(4000, 3000, 10));
    assert.deepEqual(two.difference, u(0));
    assert.deepEqual(
      cc.invocations.map((i) => [i.thread_id, i.invocation, i.status]),
      [[T1, 1, "equal"], [T1, 2, "equal_with_explained_gap"], [T2, 3, "equal"]],
    );
    assert.deepEqual(cc.invocations[1].exec_delta, u(3000, 900, 70, 20));
    assert.deepEqual(cc.invocations[1].session_turn_tokens, u(7000, 3900, 80, 20));
    assert.deepEqual(cc.invocations[1].difference, u(4000, 3000, 10), "the row's difference is the compaction call");
    assert.deepEqual([cc.invocations[1].compaction_requests, cc.invocations[1].compaction_tokens], [1, u(4000, 3000, 10)]);
    assert.equal(cc.invocations[1].reason, "1 compaction call(s) only in the session file");
  } finally {
    s.done();
  }
});

test("headless: a compaction call only in the session file is explained, and booked", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(2000) }, { usage: u(6000, 5000, 400), compaction: true }, { usage: u(700) }] });
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "equal_with_explained_gap");
    assert.equal(rep.verified, true);
    assert.equal(rep.cross_check.compaction_requests, 1);
    assert.equal(rep.tokens.input_tokens, 9700);
    assert.equal(rep.cross_check.exec_stream_tokens.input_tokens, 3700);
    assert.match(rep.cost_source, /equal; 1 compaction call\(s\) and 0 incomplete turn\(s\) only in the session file/);
  } finally {
    s.done();
  }
});

test("headless: a killed last invocation is booked from the session file and named as incomplete", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(2000) }, { usage: u(2100) }, { usage: u(2200) }], end: null });
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b, incomplete: true }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "equal_with_explained_gap");
    assert.equal(rep.cross_check.incomplete_invocations, 1);
    assert.equal(rep.cross_check.incomplete_turns, 1);
    assert.equal(rep.tokens.input_tokens, 7300);
    assert.match(rep.cost_source, /0 compaction call\(s\) and 1 incomplete turn\(s\)/);
  } finally {
    s.done();
  }
});

test("headless: a failed middle invocation is priced once, inside the next running total", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(2000) }], end: "aborted" });
    const c = r.turn({ responses: [{ usage: u(3000) }] });
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b, failed: true }, { turn: c }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "equal");
    assert.equal(rep.cross_check.exec_stream_tokens.input_tokens, 6000);
    assert.equal(rep.tokens.input_tokens, 6000);
    const inv = rep.cross_check.invocations;
    assert.deepEqual(inv.map((i) => i.status), ["equal", "incomplete", "equal_with_explained_gap"]);
    assert.deepEqual([inv[2].exec_delta.input_tokens, inv[2].session_turn_tokens.input_tokens, inv[2].difference.input_tokens], [5000, 3000, -2000]);
    assert.deepEqual([inv[2].carried_invocations, inv[2].carried_tokens], [[2], u(2000)]);
    assert.equal(inv[2].reason, "the running total also counts invocation 2, which reported no usage");
    assert.equal(rep.cost_source, "session file + exec stream (equal; 1 invocation(s) also count the turns of an earlier one that reported no usage)");
  } finally {
    s.done();
  }
});

test("headless: a disagreeing bucket is reported, and the session file is booked", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
    const b = r.turn({ responses: [{ usage: u(3000, 900, 70) }] });
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b, usage: { ...b.cumulative, output_tokens: 999 } }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "mismatch");
    assert.equal(rep.verified, false);
    assert.equal(rep.cost_source, "session file (exec stream DISAGREES on invocation 2: output_tokens 949 vs 70; unverified)");
    assert.equal(rep.source, "session-file");
    const bad = rep.cross_check.invocations[1];
    assert.equal(bad.status, "differs");
    assert.deepEqual(bad.difference, { ...u(0), output_tokens: 70 - 949 }, "the invocation's own spend, as its row prints it");
    assert.deepEqual(bad.differing, [{ bucket: "output_tokens", exec: 949, session: 70, unexplained: 70 - 949 }]);
    assert.equal(rep.cross_check.threads[0].verdict, "mismatch");
    assert.equal(rep.cost_usd_modeled, r6(cost(u(1000, 200, 50)) + cost(u(3000, 900, 70))));
  } finally {
    s.done();
  }
});

test("headless: a token_count total that drops inside the window is called out", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(500) }], resetBefore: true });
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "reset");
    assert.equal(rep.tokens.input_tokens, 1500, "booked from the per-response records");
    assert.match(rep.cost_source, /token_count total dropped/);
  } finally {
    s.done();
  }
});

test("headless: a resumed thread from another run books only this run's turns", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    r.turn({ responses: [{ usage: u(4000, 1000, 40) }] });
    r.turn({ responses: [{ usage: u(6000, 3000, 60) }] });
    const c = r.turn({ responses: [{ usage: u(8000, 7000, 80) }] });
    const d = r.turn({ responses: [{ usage: u(9000, 8000, 90) }] });
    r.write(s.home);
    headless(s, r, [{ turn: c, mode: "resume" }, { turn: d }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.tokens.input_tokens, 17000);
    assert.equal(rep.cross_check.verdict, "equal");
    assert.deepEqual(rep.cross_check.exec_stream_baseline, { [T1]: "session-file" });
    assert.equal(rep.cross_check.exec_stream_tokens.input_tokens, 17000);
  } finally {
    s.done();
  }
});

test("headless: no session file falls back to the exec stream, labelled, and an unknown resume baseline is an upper bound", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    r.turn({ responses: [{ usage: u(4000, 1000, 40) }] });
    const b = r.turn({ responses: [{ usage: u(6000, 3000, 60) }] });
    const c = r.turn({ responses: [{ usage: u(1000, 500, 10) }] });
    headless(s, r, [{ turn: b, mode: "resume" }, { turn: c }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.source, "exec-stream");
    assert.equal(rep.cross_check.verdict, "no_session_file");
    assert.equal(rep.verified, false);
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /^exec stream \(no readable session file for the thread; unverified; upper bound/);
    assert.equal(rep.tokens.input_tokens, 11000, "the first resume delta is the whole running total");
    assert.deepEqual(rep.turns.map((t) => t.usage_source), ["exec-stream", "exec-stream"]);
  } finally {
    s.done();
  }
});

test("headless: each thread is booked from its own best source", () => {
  const s = sandbox();
  try {
    const r1 = new SyntheticRollout({ threadId: T1 });
    const a = r1.turn({ responses: [{ usage: u(1000) }] });
    r1.write(s.home);
    const r2 = new SyntheticRollout({ threadId: T2, start: "2026-10-13T12:00:00.000Z" });
    const b = r2.turn({ responses: [{ usage: u(2000) }] });
    writeJsonl(join(s.run, "driver-events.jsonl"), [...driverEventLines(T1, [{ turn: a }]), ...driverEventLines(T2, [{ turn: b }]).map((l) => ({ ...l, invocation: l.invocation + 1 }))]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.source, "mixed");
    assert.deepEqual(rep.threads.map((t) => t.booked_from), ["session-file", "exec-stream"]);
    assert.equal(rep.tokens.input_tokens, 3000);
    assert.equal(rep.cross_check.verdict, "no_session_file");
    assert.equal(
      rep.cost_source,
      `session file + exec stream (1 of 2 thread(s) had no readable session file and were booked from the exec stream: ${T2}; unverified)`,
    );
  } finally {
    s.done();
  }
});

test("headless: a marker naming another thread does not add it; only the exec stream names the conductor", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    r.write(s.home);
    headless(s, r, [{ turn: a }]);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T2, inside(a))]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(rep.thread_ids, [T1]);
  } finally {
    s.done();
  }
});

test("the cap books driver-usage.json while nothing was recorded after it, then complete driver rows, then the session file live", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: MILLION, end: null });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);

    const live = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([live.source, live.usd], ["session-file", 2]);

    writeJsonl(join(s.run, "driver-cost-modeled.jsonl"), [
      { status: "complete", cost_usd: 0.25 },
      { status: "incomplete", cost_usd: null },
      { status: "complete", cost_usd: 0.5 },
    ]);
    const rows = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([rows.source, rows.usd], ["driver-cost-modeled", 0.75]);

    const usagePath = join(s.run, "driver-usage.json");
    writeFileSync(usagePath, JSON.stringify({ cost_usd_modeled: 1.5, cost_source: "session file (x)", inputs: driverUsageInputs(s.run) }));
    const usage = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([usage.source, usage.usd], ["driver-usage", 1.5], "the collector's booked figure, as the report books it");

    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a)), marker(T1, inside(a, 2))]);
    assert.equal(driverUsageIsFresh(s.run, JSON.parse(readFileSync(usagePath, "utf-8"))), false);
    const stale = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([stale.source, stale.usd], ["driver-cost-modeled", 0.75], "a run that went on after the collection is counted from its live rows");
  } finally {
    s.done();
  }
});

test("the cap counts nothing for an unpriced conductor, and says why", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ text: "$mmo-codex:greenfield", model: "gpt-6.1-sol", responses: [{ usage: u(1000) }] });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);
    const off = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.equal(off.source, "unpriced");
    assert.equal(off.usd, 0);
    assert.match(off.note, /gpt-6\.1-sol/);
    const { driver: _driver, ...unpinned } = POLICY;
    const noPin = driverSpendForCap(s.run, { ...unpinned, models: unpinned.models.filter((m) => m.id !== "gpt") }, { codexHome: s.home });
    assert.equal(noPin.source, "unpriced");
    assert.match(noPin.note, /names no driver pin/);
    const nothing = driverSpendForCap(join(s.root, "elsewhere"), POLICY, { codexHome: s.home });
    assert.equal(nothing.source, "none");
  } finally {
    s.done();
  }
});

test("hosted web search calls are counted per turn and flagged as unpriced", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(1000) }], webSearches: 2 });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.turns[0].web_search_calls, 2);
    assert.equal(rep.tokens.web_search_calls, 2);
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /INCOMPLETE: 2 hosted web search call\(s\), billed per call, not priced/);
    assert.equal(rep.cost_usd_modeled, r6(cost(u(1000))));
  } finally {
    s.done();
  }
});

/** Two run folders under one project, as DECISIONS 2.2 lays them out. */
function projectRuns(s, ...ids) {
  return ids.map((id) => {
    const dir = join(s.root, "project", ".sdlc", "runs", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
}

test("interactive: a second run in the same thread does not open at the first run's command turn", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a1 = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(100000) }] });
    const a2 = r.turn({ text: "approve", responses: [{ usage: u(100000) }] });
    const b1 = r.turn({ text: "now run the brownfield pipeline on the other repo", responses: [{ usage: u(1000) }] });
    r.write(s.home);
    const [runA, runB] = projectRuns(s, "20261013-100000-greenfield-aaaaaa", "20261013-110000-brownfield-bbbbbb");
    writeJsonl(join(runA, "driver-session.jsonl"), [marker(T1, inside(a1)), marker(T1, inside(a2))]);
    writeJsonl(join(runB, "driver-session.jsonl"), [marker(T1, inside(b1))]);

    const b = measureDriverUsage({ runDir: runB, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(b.turns.map((t) => t.turn_id), [b1.id]);
    assert.equal(b.tokens.input_tokens, 1000);
    assert.equal(b.window.start_anchor, "first_dispatch_turn");
    assert.equal(b.window.lower_bound, true);
    assert.equal(b.window.exact, false);
    assert.match(b.cost_source, /LOWER BOUND/);
    assert.equal(driverSpendForCap(runB, POLICY, { codexHome: s.home }).usd, r6(cost(u(1000))), "the cap reads the same window");

    const a = measureDriverUsage({ runDir: runA, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(a.turns.map((t) => t.turn_id), [a1.id, a2.id]);
    assert.equal(a.window.start_anchor, "command_turn");
  } finally {
    s.done();
  }
});

test("interactive: a second run started with its own run-skill turn opens there, exact", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a1 = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(100000) }] });
    const b0 = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(500) }] });
    const b1 = r.turn({ text: "approve", responses: [{ usage: u(1000) }] });
    r.write(s.home);
    const [runA, runB] = projectRuns(s, "run-a", "run-b");
    writeJsonl(join(runA, "driver-session.jsonl"), [marker(T1, inside(a1))]);
    writeJsonl(join(runB, "driver-session.jsonl"), [marker(T1, inside(b1))]);
    const b = measureDriverUsage({ runDir: runB, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(b.turns.map((t) => t.turn_id), [b0.id, b1.id]);
    assert.equal(b.window.start_anchor, "command_turn");
    assert.equal(b.window.exact, true);
  } finally {
    s.done();
  }
});

test("headless: a killed invocation with no end record keeps only its own turn, not the thread's later ones", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(2000) }], end: null });
    r.turn({ text: "resumed later, elsewhere", responses: [{ usage: u(50000) }] });
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b, incomplete: true, open: true }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(rep.turns.map((t) => t.tokens.input_tokens), [1000, 2000]);
    assert.deepEqual(rep.turns.map((t) => t.invocation), [1, 2]);
    assert.equal(rep.cross_check.verdict, "equal_with_explained_gap");
    assert.equal(rep.cross_check.incomplete_turns, 1);
    assert.deepEqual(rep.cross_check.incomplete_tokens, u(2000));
    assert.deepEqual(rep.cross_check.invocations[1].session_turn_tokens, u(2000));
    assert.equal(driverSpendForCap(s.run, POLICY, { codexHome: s.home }).usd, r6(cost(u(3000))));
  } finally {
    s.done();
  }
});

test("headless: the next invocation's start closes a killed one, so a resume in the same run is its own", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }], end: null });
    const b = r.turn({ responses: [{ usage: u(2000) }] });
    r.write(s.home);
    headless(s, r, [{ turn: a, incomplete: true, open: true }, { turn: b }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(rep.turns.map((t) => t.invocation), [1, 2]);
    assert.deepEqual(rep.cross_check.invocations.map((i) => [i.status, i.turn_id]), [["incomplete", a.id], ["equal_with_explained_gap", b.id]]);
    assert.deepEqual(rep.cross_check.invocations[1].carried_tokens, u(1000));
    assert.equal(rep.cross_check.verdict, "equal");
  } finally {
    s.done();
  }
});

test("headless: a record the exec stream never counted, in a completed invocation, is a mismatch on that invocation", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    r.push({ type: "token_usage_record", payload: { thread_id: T1, turn_id: a.id, response_id: "resp_late", usage: u(700) } });
    r.write(s.home);
    headless(s, r, [{ turn: a }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "mismatch");
    assert.equal(rep.verified, false);
    assert.deepEqual(rep.cross_check.invocations[0].differing, [{ bucket: "input_tokens", exec: 1000, session: 1700, unexplained: 700 }]);
    assert.deepEqual(rep.cross_check.threads[0].gap, { thread_id: T1, bucket: "input_tokens", difference: 700 });
    assert.equal(rep.tokens.input_tokens, 1700, "still booked from the session file");
  } finally {
    s.done();
  }
});

test("headless, no session file: an invocation killed after the last reported total makes the figure incomplete", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(110000) }], end: null });
    headless(s, r, [{ turn: a }, { turn: b, incomplete: true }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.source, "exec-stream");
    assert.equal(rep.tokens.input_tokens, 1000);
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /INCOMPLETE: 1 invocation\(s\) reported no usage/);
    assert.deepEqual(rep.cross_check.invocations.map((i) => [i.status, i.exec_delta?.input_tokens ?? null]), [["no_session_file", 1000], ["no_session_file", null]]);
    assert.equal(rep.cross_check.threads[0].unreported_invocations, 1);
    assert.equal(rep.cross_check.threads[0].session_tokens, null);
  } finally {
    s.done();
  }
});

test("headless, no session file: a failed invocation followed by a completed one is still complete", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000) }] });
    const b = r.turn({ responses: [{ usage: u(2000) }], end: "aborted" });
    const c = r.turn({ responses: [{ usage: u(3000) }] });
    headless(s, r, [{ turn: a }, { turn: b, failed: true }, { turn: c }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.tokens.input_tokens, 6000);
    assert.equal(rep.cost_complete, true);
    assert.doesNotMatch(rep.cost_source, /reported no usage/);
  } finally {
    s.done();
  }
});

test("headless: a --thread with no invocation of this run is booked but leaves the run unverified", () => {
  const s = sandbox();
  try {
    const r1 = new SyntheticRollout({ threadId: T1 });
    const a = r1.turn({ responses: [{ usage: u(1000) }] });
    r1.write(s.home);
    const r2 = new SyntheticRollout({ threadId: T2, start: "2026-10-13T12:00:00.000Z" });
    r2.turn({ responses: [{ usage: u(4000) }] });
    r2.write(s.home);
    headless(s, r1, [{ turn: a }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home, threadIds: [T2] }).report;
    assert.deepEqual(rep.thread_ids, [T1, T2]);
    assert.equal(rep.tokens.input_tokens, 5000);
    assert.equal(rep.cross_check.verdict, "unchecked");
    assert.equal(rep.verified, false);
    assert.deepEqual(rep.cross_check.unchecked_threads, [T2]);
    assert.deepEqual(rep.cross_check.threads.map((t) => t.verdict), ["equal", "unchecked"]);
    assert.match(rep.cost_source, /^session file \(1 thread\(s\) booked with no exec-stream invocation to compare; unverified\)/);
    assert.match(rep.cost_source, /WHOLE THREAD/);
  } finally {
    s.done();
  }
});

/** What run.mjs on this branch writes: every invocation's bare `codex exec --json` stdout, concatenated. */
function legacyStream(threadId, invocations) {
  return driverEventLines(threadId, invocations).filter((l) => l.kind === "codex").map((l) => l.event);
}

test("legacy driver-events (bare codex stdout): invocations split at thread.started and map to turns by order", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const t = [
      r.turn({ responses: [{ usage: u(1000, 200, 50, 10) }] }),
      r.turn({ responses: [{ usage: u(3000, 900, 70, 20) }] }),
      r.turn({ responses: [{ usage: u(5000, 2000, 90, 30) }] }),
    ];
    r.write(s.home);
    writeJsonl(join(s.run, "driver-events.jsonl"), legacyStream(T1, t.map((turn) => ({ turn }))));
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.route, "headless");
    assert.equal(rep.cross_check.mapping, "order");
    assert.equal(rep.cross_check.verdict, "equal");
    assert.deepEqual(rep.cross_check.invocations.map((i) => [i.invocation, i.turn_id]), t.map((x, k) => [k + 1, x.id]));
    assert.deepEqual(rep.cross_check.exec_stream_baseline, { [T1]: "session-file" }, "a legacy stream says nothing of fresh or resume");
    assert.equal(rep.tokens.input_tokens, 9000);
    assert.equal(rep.cost_source, "session file + exec stream (every invocation equal); WHOLE THREAD: no marker scopes the window");
    assert.deepEqual(rep.turns.map((x) => x.invocation), [null, null, null]);
  } finally {
    s.done();
  }
});

test("the cap ignores legacy driver-events lines and reads the conductor through its markers", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: MILLION, end: null });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);
    const other = new SyntheticRollout({ threadId: T2 });
    const big = other.turn({ responses: [{ usage: u(9_000_000) }] });
    writeJsonl(join(s.run, "driver-events.jsonl"), legacyStream(T2, [{ turn: big }]));
    assert.equal(measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report.route, "headless");
    const spend = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([spend.source, spend.usd], ["session-file", 2]);
  } finally {
    s.done();
  }
});

test("a compressed session file is read when this Node has zstd, and an unreadable one is reported, not booked as $0", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(1000) }] });
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);
    const path = r.write(s.home, { compressed: true });
    if (typeof zlib.zstdCompressSync === "function") {
      writeFileSync(path, zlib.zstdCompressSync(Buffer.from(r.text())));
      const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
      assert.equal(rep.threads[0].rollout, "found");
      assert.equal(rep.tokens.input_tokens, 1000);
      writeFileSync(path, "not zstd");
    }
    const m = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home });
    assert.equal(m.ok, false);
    assert.equal(m.code, "no_rollout");
    assert.match(m.unreadable[0], /\.jsonl\.zst (could not be read|is compressed)/);
    const cap = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.equal(cap.source, "none");
    assert.match(cap.note, /^the conductor's session file could not be used \(/);
    assert.equal(cap.unmeasured, true);
  } finally {
    s.done();
  }
});

const isUsageLine = (l) => l.type === "token_usage_record" || l.payload?.type === "token_count";
const later = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

test("interactive: completed turns with no usage line of either kind are refused, not booked as $0", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(500_000, 100_000, 2000) }] });
    const b = r.turn({ text: "approve", responses: [{ usage: u(800_000, 700_000, 3000) }] });
    r.lines = r.lines.filter((l) => !isUsageLine(l));
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a)), marker(T1, inside(b))]);
    const m = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home });
    assert.equal(m.ok, false);
    assert.equal(m.code, "no_rollout");
    assert.match(m.unreadable[0], /has 2 completed turn\(s\) but no token_usage_record or token_count line$/);
    assert.match(m.message, /no token_usage_record or token_count line/);
    const cap = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([cap.source, cap.usd, cap.unmeasured], ["none", 0, true]);
    assert.match(cap.note, /^the conductor's session file could not be used \(.*no token_usage_record or token_count line\)$/);
  } finally {
    s.done();
  }
});

test("interactive: a window whose completed turns have no usage line leaves that thread unread, though earlier turns have some", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    r.turn({ text: "what does this repo do?", responses: [{ usage: u(9000) }] });
    const a = r.turn({ text: "$mmo-codex:brownfield", responses: [{ usage: u(1000) }] });
    const b = r.turn({ text: "approve", responses: [{ usage: u(2000) }] });
    r.lines = r.lines.filter((l) => !(isUsageLine(l) && l.timestamp >= a.started_at));
    r.write(s.home);
    const other = new SyntheticRollout({ threadId: T2, originator: "codex-tui", start: "2026-10-13T12:00:00.000Z" });
    const c = other.turn({ text: "$mmo-codex:brownfield", responses: MILLION });
    other.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a)), marker(T1, inside(b)), marker(T2, inside(c))]);

    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    const t1 = rep.threads.find((t) => t.thread_id === T1);
    assert.deepEqual([t1.rollout, t1.booked_from], ["unreadable", null]);
    assert.match(t1.reason, /no token_usage_record or token_count line in the window's 2 completed turn\(s\)$/);
    assert.equal(rep.cost_usd_modeled, 2);
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /INCOMPLETE: no readable session file for 1 thread\(s\)/);

    const cap = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([cap.source, cap.usd, cap.not_counted], ["session-file", 2, ["1 thread(s) with no readable session file"]]);
  } finally {
    s.done();
  }
});

test("interactive: a turn still running before its first response is booked as $0 provisional, not refused", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1, originator: "codex-tui" });
    const a = r.turn({ text: "$mmo-codex:greenfield", end: null });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(T1, inside(a))]);
    const m = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home });
    assert.equal(m.ok, true);
    assert.equal(m.report.threads[0].rollout, "found");
    assert.equal(m.report.cost_usd_modeled, 0);
    assert.equal(m.report.window.provisional, true);
    const cap = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([cap.source, cap.usd, cap.unmeasured], ["session-file", 0, false]);
  } finally {
    s.done();
  }
});

test("headless: a session file with no usage lines falls back to the exec stream, which is booked", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
    const b = r.turn({ responses: [{ usage: u(3000, 900, 70) }] });
    r.lines = r.lines.filter((l) => !isUsageLine(l));
    r.write(s.home);
    headless(s, r, [{ turn: a }, { turn: b }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.source, "exec-stream");
    assert.deepEqual([rep.threads[0].rollout, rep.threads[0].booked_from], ["unreadable", "exec-stream"]);
    assert.match(rep.threads[0].reason, /has 2 completed turn\(s\) but no token_usage_record or token_count line/);
    assert.equal(rep.cost_usd_modeled, r6(cost(u(4000, 1100, 120))));
    assert.equal(rep.cross_check.verdict, "no_session_file");
    assert.match(rep.cost_source, /^exec stream \(no readable session file for the thread; unverified\)/);
  } finally {
    s.done();
  }
});

test("headless: an invocation the session file has no turn for leaves the booked figure incomplete", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
    const b = r.turn({ responses: [{ usage: u(3000, 900, 70) }] });
    r.write(s.home);
    const c = { started_at: later(b.ended_at, 5000), ended_at: later(b.ended_at, 6000), cumulative: u(9000, 3100, 210) };
    headless(s, r, [{ turn: a }, { turn: b }, { turn: c }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.cross_check.verdict, "mismatch");
    assert.deepEqual(rep.cross_check.invocations.map((i) => [i.status, i.turn_id]), [["equal", a.id], ["equal", b.id], ["unmatched", null]]);
    assert.equal(rep.cross_check.missing_invocations, 1);
    assert.equal(rep.cost_usd_modeled, r6(cost(u(4000, 1100, 120))), "still booked from the session file");
    assert.equal(rep.cost_complete, false);
    assert.match(rep.cost_source, /; INCOMPLETE: 1 invocation\(s\) missing from the session file/);

    writeFileSync(join(s.run, "driver-usage.json"), JSON.stringify(rep));
    const cap = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([cap.source, cap.not_counted], ["driver-usage", ["1 invocation(s) missing from the session file"]]);
  } finally {
    s.done();
  }
});

test("headless: a session file with no token_count total but per-response records is booked, not counted as missing", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50) }] });
    r.lines = r.lines.filter((l) => l.payload?.type !== "token_count");
    r.write(s.home);
    headless(s, r, [{ turn: a }]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.equal(rep.source, "session-file");
    assert.equal(rep.cross_check.invocations[0].status, "unmatched");
    assert.equal(rep.cross_check.missing_invocations, 0);
    assert.equal(rep.cost_usd_modeled, r6(cost(u(1000, 200, 50))));
    assert.equal(rep.cost_complete, true);
  } finally {
    s.done();
  }
});
