import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { measureDriverUsage } from "../dist/sessionUsage.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { SyntheticRollout, driverEventLines, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = loadPolicyFromPath(join(HERE, "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml"));
const T1 = "01a3000a-0000-7000-8000-000000000001";
const BUCKETS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const isZero = (x) => BUCKETS.every((b) => x[b] === 0);

/** Three invocations on one thread: 1000, 3000 and 5000 input tokens. */
function measure(build) {
  const root = mkdtempSync(join(tmpdir(), "mmo-rows-"));
  const home = join(root, "home");
  const run = join(root, "run");
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  try {
    const r = new SyntheticRollout({ threadId: T1 });
    const invocations = build(r);
    r.write(home);
    writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(T1, invocations));
    return measureDriverUsage({ runDir: run, policy: POLICY, codexHome: home }).report.cross_check;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const turns = (r, second = [{ usage: u(3000, 900, 70, 20) }]) => [
  r.turn({ responses: [{ usage: u(1000, 200, 50, 10) }] }),
  r.turn({ responses: second }),
  r.turn({ responses: [{ usage: u(5000, 2000, 90, 30) }] }),
];

/** Moves `by` input tokens onto one turn's per-response record, leaving codex's running total alone. */
function skewRecord(r, turn, by) {
  const line = r.lines.find((l) => l.type === "token_usage_record" && l.payload.turn_id === turn.id);
  line.payload.usage = { ...line.payload.usage, input_tokens: line.payload.usage.input_tokens + by };
}

const rows = (cc) => cc.invocations.map((i) => [i.invocation, i.status, i.difference?.input_tokens ?? null]);

/** Every row's status agrees with the numbers printed beside it. */
function assertRowsAgree(cc) {
  for (const i of cc.invocations) {
    if (!i.difference) continue;
    const explained = BUCKETS.map((b) => i.compaction_tokens[b] - i.carried_tokens[b]);
    const rest = BUCKETS.map((b, n) => i.difference[b] - explained[n]);
    if (i.status === "equal") assert.ok(isZero(i.difference), `invocation ${i.invocation} reads equal beside a difference`);
    else if (i.status === "equal_with_explained_gap") assert.ok(rest.every((d) => d === 0) && !isZero(i.difference), `invocation ${i.invocation}`);
    else assert.equal(i.status, "differs");
    if (i.status === "differs") assert.ok(rest.some((d) => d !== 0), `invocation ${i.invocation} reads differs beside an explained difference`);
  }
}

test("a compaction call reads as an explained gap on its own invocation row, not as equal", () => {
  const cc = measure((r) => turns(r, [{ usage: u(2500, 900, 30, 20) }, { usage: u(500, 0, 40), compaction: true }, { usage: u(500, 0, 40) }]).map((turn) => ({ turn })));
  assert.deepEqual(rows(cc), [[1, "equal", 0], [2, "equal_with_explained_gap", 500], [3, "equal", 0]]);
  const two = cc.invocations[1];
  assert.deepEqual([two.compaction_requests, two.compaction_tokens], [1, u(500, 0, 40)]);
  assert.equal(two.reason, "1 compaction call(s) only in the session file");
  assert.deepEqual([cc.verdict, cc.verified, cc.threads[0].difference], ["equal_with_explained_gap", true, u(500, 0, 40)]);
  assertRowsAgree(cc);
});

test("an exec-stream difference that cancels out in a later invocation reads differs on both rows", () => {
  const cc = measure((r) => {
    const [a, b, c] = turns(r);
    return [{ turn: a }, { turn: b, usage: { ...b.cumulative, input_tokens: b.cumulative.input_tokens - 500 } }, { turn: c }];
  });
  assert.deepEqual(rows(cc), [[1, "equal", 0], [2, "differs", 500], [3, "differs", -500]]);
  assert.equal(cc.verdict, "mismatch");
  assert.equal(cc.verified, false);
  assert.deepEqual(cc.threads[0].difference, u(0), "the thread total hides it; the rows do not");
  assertRowsAgree(cc);
});

test("an exec-stream difference that carries forward reads differs only where it starts", () => {
  const cc = measure((r) => {
    const [a, b, c] = turns(r);
    const low = (t) => ({ ...t.cumulative, input_tokens: t.cumulative.input_tokens - 500 });
    return [{ turn: a }, { turn: b, usage: low(b) }, { turn: c, usage: low(c) }];
  });
  assert.deepEqual(rows(cc), [[1, "equal", 0], [2, "differs", 500], [3, "equal", 0]]);
  assert.equal(cc.verdict, "mismatch");
  assert.deepEqual(cc.invocations[1].differing, [{ bucket: "input_tokens", exec: 2500, session: 3000, unexplained: 500 }]);
  assertRowsAgree(cc);
});

test("per-response records that are wrong but sum to the right total are a mismatch, not verified", () => {
  const cc = measure((r) => {
    const [a, b, c] = turns(r);
    skewRecord(r, b, 500);
    skewRecord(r, c, -500);
    return [{ turn: a }, { turn: b }, { turn: c }];
  });
  assert.deepEqual(rows(cc), [[1, "equal", 0], [2, "differs", 500], [3, "differs", -500]]);
  assert.deepEqual([cc.verdict, cc.verified], ["mismatch", false]);
  assert.deepEqual(cc.threads[0].difference, u(0));
  assertRowsAgree(cc);
});

test("a difference beyond a compaction call names both parts", () => {
  const cc = measure((r) => {
    const [a, b, c] = turns(r, [{ usage: u(2500, 900, 30, 20) }, { usage: u(400), compaction: true }, { usage: u(500, 0, 40) }]);
    skewRecord(r, b, 200);
    return [{ turn: a }, { turn: b }, { turn: c }];
  });
  const two = cc.invocations[1];
  assert.equal(two.status, "differs");
  assert.equal(two.difference.input_tokens, 600);
  assert.equal(two.reason, "input_tokens +200 unexplained, beyond 1 compaction call(s) only in the session file");
  assertRowsAgree(cc);
});

test("the collector prints what explains an invocation's difference on its line", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-rows-"));
  try {
    const home = join(root, "home");
    const run = join(root, "project", ".sdlc", "runs", "20261013-100000-greenfield-abc123");
    mkdirSync(home, { recursive: true });
    mkdirSync(run, { recursive: true });
    const r = new SyntheticRollout({ threadId: T1 });
    const a = r.turn({ responses: [{ usage: u(1000, 200, 50, 10) }] });
    const b = r.turn({ responses: [{ usage: u(3000, 900, 70, 20) }, { usage: u(400, 0, 30), compaction: true }] });
    r.write(home);
    writeJsonl(join(run, "driver-events.jsonl"), driverEventLines(T1, [{ turn: a }, { turn: b }]));
    const cli = join(HERE, "..", "..", "..", "scripts", "collect-driver-usage.mjs");
    const out = spawnSync(process.execPath, [cli, run, `--codex-home=${home}`], { encoding: "utf-8", env: { PATH: process.env.PATH } });
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split("\n");
    assert.equal(lines[3], `  invocation 1 (${T1}): equal; input 1000/1000 (0), cached input 200/200 (0), output 50/50 (0), reasoning 10/10 (0)`);
    assert.equal(
      lines[4],
      `  invocation 2 (${T1}): equal_with_explained_gap; input 3000/3400 (400), cached input 900/900 (0), output 70/100 (30), reasoning 20/20 (0)` +
        " — 1 compaction call(s) only in the session file",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
