// On the seat policy a codex-cli dispatch runs a nested `codex exec`, whose
// session file lands in the same CODEX_HOME as the conductor's. The reader
// books the conductor's thread only, whichever file is newer or larger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { driverSpendForCap, measureDriverUsage, nestedDispatchThreads, recordedConductorThreads } from "../dist/sessionUsage.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { SyntheticRollout, driverEventLines, inside, marker, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = loadPolicyFromPath(join(HERE, "..", "..", "..", "config", "policies", "gpt-seat-plus-flash.yaml"));
const CONDUCTOR = "01a2000f-0000-7000-8000-0000000000c1";
const WORKER = "01a2000f-0000-7000-8000-0000000000e1";
const ELSEWHERE = "01a2000f-0000-7000-8000-0000000000f1";
const cost = (x) => ((x.input_tokens - x.cached_input_tokens) * 2 + x.cached_input_tokens * 0.2 + x.output_tokens * 12) / 1e6;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mmo-conductor-"));
  const home = join(root, "home");
  const run = join(root, "project", ".sdlc", "runs", "r1");
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  return { root, home, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A worker session started after the conductor's, on the same cwd and source, with far more tokens. */
function workerSession(s, start) {
  const w = new SyntheticRollout({ threadId: WORKER, start });
  const turn = w.turn({ responses: [{ usage: u(200_000, 0, 20_000) }] });
  w.write(s.home);
  writeJsonl(join(s.run, "telemetry.jsonl"), [{ phase: "senior_code_review", cost_usd: 0, provenance: "modeled", codex_thread_id: WORKER }]);
  return turn;
}

test("interactive: a marker in a nested worker's thread is left out, and so is one in a thread run.json never started", () => {
  const s = sandbox();
  try {
    const c = new SyntheticRollout({ threadId: CONDUCTOR, originator: "codex-tui", source: "vscode" });
    const command = c.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(10_000, 8000, 100) }] });
    const gate = c.turn({ text: "approve", responses: [{ usage: u(20_000, 18_000, 200) }] });
    c.write(s.home);
    const wTurn = workerSession(s, gate.started_at);
    const other = new SyntheticRollout({ threadId: ELSEWHERE, originator: "codex-tui" });
    const otherTurn = other.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(5000) }] });
    other.write(s.home);
    writeFileSync(join(s.run, "run.json"), JSON.stringify({ route: "interactive", starts: [{ codex_thread_id: CONDUCTOR }] }));
    writeJsonl(join(s.run, "driver-session.jsonl"), [
      marker(CONDUCTOR, inside(command)),
      marker(WORKER, inside(wTurn)),
      marker(ELSEWHERE, inside(otherTurn)),
      marker(CONDUCTOR, inside(gate)),
    ]);

    assert.deepEqual([...nestedDispatchThreads(s.run)], [WORKER]);
    assert.deepEqual([...recordedConductorThreads(s.run)], [CONDUCTOR]);
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home }).report;
    assert.deepEqual(rep.thread_ids, [CONDUCTOR]);
    assert.deepEqual(
      rep.excluded_threads.map((e) => [e.thread_id, /telemetry\.jsonl codex_thread_id/.test(e.reason), /run\.json records no start/.test(e.reason)]),
      [[WORKER, true, false], [ELSEWHERE, false, true]],
    );
    assert.equal(rep.cost_usd_modeled, r6(cost(u(10_000, 8000, 100)) + cost(u(20_000, 18_000, 200))));

    const cap = driverSpendForCap(s.run, POLICY, { codexHome: s.home });
    assert.deepEqual([cap.source, cap.usd], ["session-file", rep.cost_usd_modeled], "the cap books the same conductor, not the worker");
  } finally {
    s.done();
  }
});

test("headless: the conductor's thread comes from the exec stream, and --thread naming a worker is refused", () => {
  const s = sandbox();
  try {
    const c = new SyntheticRollout({ threadId: CONDUCTOR });
    const a = c.turn({ responses: [{ usage: u(1000, 200, 50) }] });
    c.write(s.home);
    workerSession(s, a.ended_at);
    writeJsonl(join(s.run, "driver-events.jsonl"), driverEventLines(CONDUCTOR, [{ turn: a }]));
    const rep = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home, threadIds: [WORKER] }).report;
    assert.deepEqual(rep.thread_ids, [CONDUCTOR]);
    assert.deepEqual(rep.excluded_threads.map((e) => e.thread_id), [WORKER]);
    assert.equal(rep.cross_check.verdict, "equal");
    assert.equal(rep.cost_usd_modeled, r6(cost(u(1000, 200, 50))));
  } finally {
    s.done();
  }
});

test("with only a worker thread named, nothing is measured, and the message says why", () => {
  const s = sandbox();
  try {
    const turn = workerSession(s, "2026-10-13T10:00:00.000Z");
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(WORKER, inside(turn))]);
    const m = measureDriverUsage({ runDir: s.run, policy: POLICY, codexHome: s.home });
    assert.equal(m.ok, false);
    assert.equal(m.code, "no_threads");
    assert.match(m.message, /left out as not the conductor's: 01a2000f-0000-7000-8000-0000000000e1, a codex-cli dispatch of this run ran in it/);
  } finally {
    s.done();
  }
});
