import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertUnderCostCap, recordedSpend, driverCapWarning, CostCapExceededError, COST_CAP_EXCEEDED } from "../dist/costCap.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { connectBridge } from "../dist/driverClient.js";
import { SyntheticRollout, driverEventLines, inside, marker, u, writeJsonl } from "./fixtures/syntheticRollout.mjs";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "gpt-plus-flash.yaml");
const THREAD = "01a2000c-0000-7000-8000-0000000000d1";
const capped = (cap) => ({ ...loadPolicyFromPath(SHIPPED), hard_cost_cap_usd: cap });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mmo-capdrv-"));
  const home = join(root, "home");
  const run = join(root, "run");
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  const telemetry = join(run, "telemetry.jsonl");
  return { root, home, run, telemetry, done: () => rmSync(root, { recursive: true, force: true }) };
}

const telemetryRows = (path, rows) => writeJsonl(path, rows.map((r, i) => ({ task_id: `t${i}`, ...r })));
const driverRows = (run, costs) =>
  writeJsonl(join(run, "driver-cost-modeled.jsonl"), costs.map((c, i) => ({ invocation: i + 1, status: "complete", cost_usd: c, provenance: "modeled" })));

/** Four responses of 250,000 fresh input each, all under the 272,000 long-context threshold. */
const MILLION_STANDARD = Array.from({ length: 4 }, () => ({ usage: u(250_000) }));

/** A conductor whose pin-model turn costs $2.00 (1M fresh input at $2/M). */
function liveConductor(s, { model } = {}) {
  const r = new SyntheticRollout({ threadId: THREAD, originator: "codex-tui" });
  const t = r.turn({ text: "$mmo-codex:greenfield", model, responses: MILLION_STANDARD, end: null });
  r.write(s.home);
  writeJsonl(join(s.run, "driver-session.jsonl"), [marker(THREAD, inside(t))]);
}

test("driver spend alone can reach the cap, and the message names both parts and which is modeled", () => {
  const s = sandbox();
  try {
    telemetryRows(s.telemetry, [{ cost_usd: 0 }]);
    driverRows(s.run, [0.6, 0.5]);
    assert.throws(
      () => assertUnderCostCap(capped(1), s.telemetry, { codexHome: s.home }),
      (err) =>
        err instanceof CostCapExceededError &&
        err.code === COST_CAP_EXCEEDED &&
        err.dispatchedUsd === 0 &&
        err.driverUsd === 1.1 &&
        err.driverSource === "driver-cost-modeled" &&
        /hard_cost_cap_usd \$1/.test(err.message) &&
        /\$0\.0000 dispatched .* \+ \$1\.1000 conductor \(modeled from driver-cost-modeled\.jsonl\)/.test(err.message),
    );
  } finally {
    s.done();
  }
});

test("dispatched and driver spend cross the cap together; under it the check returns the split", () => {
  const s = sandbox();
  try {
    telemetryRows(s.telemetry, [{ cost_usd: 0.3 }, { cost_usd: 0.2, provenance: "modeled" }]);
    driverRows(s.run, [0.4]);
    const spend = assertUnderCostCap(capped(1), s.telemetry, { codexHome: s.home });
    assert.deepEqual(
      { d: spend.dispatched_usd, m: spend.dispatched_modeled_usd, v: spend.driver_usd, t: spend.total_usd },
      { d: 0.5, m: 0.2, v: 0.4, t: 0.9 },
    );
    driverRows(s.run, [0.4, 0.1]);
    assert.throws(
      () => assertUnderCostCap(capped(1), s.telemetry, { codexHome: s.home }),
      (err) => /\$0\.5000 dispatched \(.*; \$0\.2000 of it modeled\)/.test(err.message),
    );
  } finally {
    s.done();
  }
});

test("a policy that prices its pin only in the driver block still counts the conductor", () => {
  const s = sandbox();
  try {
    liveConductor(s);
    const flashOnly = { ...loadPolicyFromPath(join(dirname(SHIPPED), "flash-agsdk-only.yaml")), hard_cost_cap_usd: 1.5 };
    assert.equal(flashOnly.models.some((m) => m.id === "gpt"), false);
    assert.throws(
      () => assertUnderCostCap(flashOnly, s.telemetry, { env: { CODEX_HOME: s.home } }),
      (err) => err instanceof CostCapExceededError && err.driverUsd === 2 && err.driverSource === "session-file",
    );
  } finally {
    s.done();
  }
});

test("with no driver rows yet, the conductor's session file is read live, including the turn still running", () => {
  const s = sandbox();
  try {
    liveConductor(s);
    const spend = recordedSpend(capped(5), s.telemetry, { env: { CODEX_HOME: s.home } });
    assert.equal(spend.driver_source, "session-file");
    assert.equal(spend.driver_usd, 2);
    assert.throws(() => assertUnderCostCap(capped(1.5), s.telemetry, { env: { CODEX_HOME: s.home } }), /modeled from the codex session file/);
  } finally {
    s.done();
  }
});

test("the live session file is priced from the dated list response by response, so one long request bills the long-context card", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: THREAD, originator: "codex-tui" });
    const t = r.turn({ text: "$mmo-codex:greenfield", responses: [{ usage: u(300_000) }, { usage: u(100_000) }], end: null });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(THREAD, inside(t))]);
    const spend = recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    // 300,000 input at $4.00/M (over 272,000) plus 100,000 at $2.00/M.
    assert.equal(spend.driver_usd, 1.4);
    assert.equal(spend.driver_source, "session-file");
  } finally {
    s.done();
  }
});

test("one driver source only: driver rows win over the session file, never summed with it", () => {
  const s = sandbox();
  try {
    liveConductor(s);
    driverRows(s.run, [0.25]);
    const spend = recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    assert.equal(spend.driver_source, "driver-cost-modeled");
    assert.equal(spend.total_usd, 0.25);
  } finally {
    s.done();
  }
});

test("a conductor off the pin counts nothing toward the cap, and the message says it is not priced", () => {
  const s = sandbox();
  try {
    liveConductor(s, { model: "gpt-6.1-sol" });
    telemetryRows(s.telemetry, [{ cost_usd: 1.2 }]);
    const spend = recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    assert.equal(spend.driver_source, "unpriced");
    assert.equal(spend.total_usd, 1.2);
    assert.throws(() => assertUnderCostCap(capped(1), s.telemetry, { codexHome: s.home }), /conductor not priced: session model gpt-6\.1-sol/);
  } finally {
    s.done();
  }
});

test("a policy with no driver pin caps dispatched work only", () => {
  const s = sandbox();
  try {
    liveConductor(s);
    const { driver: _driver, ...unpinned } = capped(5);
    const policy = { ...unpinned, models: unpinned.models.filter((m) => m.id !== "gpt") };
    const spend = recordedSpend(policy, s.telemetry, { codexHome: s.home });
    assert.equal(spend.driver_source, "unpriced");
    assert.equal(spend.driver_usd, 0);
  } finally {
    s.done();
  }
});

test("a torn last driver row is skipped, not counted and not fatal", () => {
  const s = sandbox();
  try {
    driverRows(s.run, [0.3]);
    writeFileSync(join(s.run, "driver-cost-modeled.jsonl"), readFileSync(join(s.run, "driver-cost-modeled.jsonl"), "utf-8") + '{"status":"complete","cost_us');
    assert.equal(recordedSpend(capped(5), s.telemetry, { codexHome: s.home }).driver_usd, 0.3);
  } finally {
    s.done();
  }
});

test("a refusal with the conductor unmeasured names why in the cap's own words, not the collector's flags", () => {
  const s = sandbox();
  try {
    telemetryRows(s.telemetry, [{ cost_usd: 2 }]);
    const refusal = () => {
      try {
        assertUnderCostCap(capped(1), s.telemetry, { codexHome: s.home });
      } catch (err) {
        return err.message;
      }
      assert.fail("expected a refusal");
    };
    const noThread = refusal();
    assert.match(noThread, /conductor not measured: no conductor thread recorded in this run folder\. No further dispatch/);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(THREAD, "2026-10-13T10:00:01.000Z")]);
    const noFile = refusal();
    assert.ok(noFile.includes(`conductor not measured: the conductor's session file was not found under ${s.home}. No further dispatch`), noFile);
    for (const msg of [noThread, noFile]) {
      assert.doesNotMatch(msg, /--thread|--codex-home|\.\./);
    }
  } finally {
    s.done();
  }
});

test("a conductor partly off the pin counts the pin part, and the refusal says what it left out", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: THREAD, originator: "codex-tui" });
    const a = r.turn({ text: "$mmo-codex:greenfield", responses: MILLION_STANDARD });
    const b = r.turn({ model: "gpt-6.1-sol", responses: [{ usage: u(1_000_000) }], end: null });
    r.write(s.home);
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(THREAD, inside(a)), marker(THREAD, inside(b))]);
    const spend = recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    assert.deepEqual(
      [spend.driver_source, spend.driver_usd, spend.driver_not_counted],
      ["session-file", 2, ["tokens on gpt-6.1-sol"]],
    );
    assert.throws(
      () => assertUnderCostCap(capped(1), s.telemetry, { codexHome: s.home }),
      /\+ \$2\.0000 conductor \(modeled from the codex session file; not counted: tokens on gpt-6\.1-sol\)\. No further dispatch/,
    );
  } finally {
    s.done();
  }
});

test("incomplete driver rows are named as left out of the conductor figure", () => {
  const s = sandbox();
  try {
    writeJsonl(join(s.run, "driver-cost-modeled.jsonl"), [
      { invocation: 1, status: "complete", cost_usd: 0.6, provenance: "modeled" },
      { invocation: 2, status: "incomplete", cost_usd: null, provenance: "modeled" },
    ]);
    assert.throws(
      () => assertUnderCostCap(capped(0.5), s.telemetry, { codexHome: s.home }),
      /\$0\.6000 conductor \(modeled from driver-cost-modeled\.jsonl; not counted: 1 incomplete driver turn\(s\)\)/,
    );
  } finally {
    s.done();
  }
});

test("an incomplete row a later running total covers is in the conductor figure, so the message does not name it", () => {
  const s = sandbox();
  try {
    const rows = [
      { invocation: 1, status: "complete", cost_usd: 0.2, provenance: "modeled" },
      { invocation: 2, status: "incomplete", cost_usd: null, covered_by: "driver-i3-t1", provenance: "modeled" },
      { invocation: 3, status: "complete", cost_usd: 0.4, provenance: "modeled" },
    ];
    writeJsonl(join(s.run, "driver-cost-modeled.jsonl"), rows);
    const spend = recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    assert.deepEqual([spend.driver_usd, spend.driver_not_counted], [0.6, []]);
    assert.throws(
      () => assertUnderCostCap(capped(0.5), s.telemetry, { codexHome: s.home }),
      (err) => /\$0\.6000 conductor \(modeled from driver-cost-modeled\.jsonl\)\./.test(err.message) && !/not counted/.test(err.message),
    );

    writeJsonl(join(s.run, "driver-cost-modeled.jsonl"), [...rows, { invocation: 4, status: "incomplete", cost_usd: null, provenance: "modeled" }]);
    assert.deepEqual(recordedSpend(capped(5), s.telemetry, { codexHome: s.home }).driver_not_counted, ["1 incomplete driver turn(s)"]);
  } finally {
    s.done();
  }
});

test("with no session file, the cap prices the exec stream's running totals once: exec + 2 resumes is 9000 input, not 14000", () => {
  const s = sandbox();
  try {
    const r = new SyntheticRollout({ threadId: THREAD });
    const turns = [
      r.turn({ responses: [{ usage: u(1000, 200, 50) }] }),
      r.turn({ responses: [{ usage: u(3000, 900, 70) }] }),
      r.turn({ responses: [{ usage: u(5000, 2000, 90) }] }),
    ];
    writeJsonl(join(s.run, "driver-events.jsonl"), driverEventLines(THREAD, turns.map((turn) => ({ turn }))));
    const spend = recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    const expected = ((9000 - 3100) * 2 + 3100 * 0.2 + 210 * 12) / 1e6;
    assert.deepEqual(
      [spend.driver_source, spend.driver_usd, spend.driver_unmeasured],
      ["exec-stream", Math.round(expected * 1e6) / 1e6, false],
    );
    assert.throws(
      () => assertUnderCostCap(capped(0.01), s.telemetry, { codexHome: s.home }),
      (err) => err.driverSource === "exec-stream" && /\$0\.0149 conductor \(modeled from the codex exec stream\)/.test(err.message),
    );
    assert.doesNotThrow(() => assertUnderCostCap(capped(0.02), s.telemetry, { codexHome: s.home }));
  } finally {
    s.done();
  }
});

test("the bridge's warning names an unmeasured conductor, but not a run with no conductor thread", () => {
  const s = sandbox();
  try {
    const spend = () => recordedSpend(capped(5), s.telemetry, { codexHome: s.home });
    assert.equal(driverCapWarning(spend()), null, "no thread recorded: nothing to warn about");
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(THREAD, "2026-10-13T10:00:01.000Z")]);
    const missing = driverCapWarning(spend());
    assert.equal(missing.event, "cost_cap.driver_unmeasured");
    assert.match(missing.reason, /session file was not found under/);
    liveConductor(s, { model: "gpt-6.1-sol" });
    assert.equal(driverCapWarning(spend()).event, "cost_cap.driver_unpriced");
    liveConductor(s);
    assert.equal(driverCapWarning(spend()), null);
  } finally {
    s.done();
  }
});

function cappedPolicyFile(dir, cap) {
  const yaml = readFileSync(SHIPPED, "utf-8").replace(/^hard_cost_cap_usd: .*$/m, `hard_cost_cap_usd: ${cap}`);
  const path = join(dir, "capped.yaml");
  writeFileSync(path, yaml);
  return path;
}

const PACKET = {
  id: "tp_cap_drv_001",
  phase: "requirements_analysis",
  task_type: "analysis",
  module: "all",
  instruction: "unused",
  inputs: [],
  outputSchema: {},
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
  pass_id: "cap-test",
};

test("the real bridge logs an unmeasured conductor beside its refusal", async () => {
  const s = sandbox();
  const bridge = await connectBridge({ env: { CODEX_HOME: s.home } });
  try {
    writeJsonl(join(s.run, "driver-session.jsonl"), [marker(THREAD, "2026-10-13T10:00:01.000Z")]);
    telemetryRows(s.telemetry, [{ cost_usd: 0.02 }]);
    await assert.rejects(
      bridge.callTool("execute_with_model", { policy_path: cappedPolicyFile(s.root, "0.01"), telemetry_path: s.telemetry, packet: PACKET }),
      /conductor not measured: the conductor's session file was not found under/,
    );
    const logged = readFileSync(join(s.run, "orchestrator.log"), "utf-8");
    assert.match(logged, /cost_cap\.driver_unmeasured.*packet_id=tp_cap_drv_001/);
    assert.match(logged, /cost_cap\.refused/);
  } finally {
    await bridge.close();
    s.done();
  }
});

// No OPENAI_API_KEY reaches the bridge, so a dispatch that got past the cap
// would fail on adapter construction instead; the error text tells them apart.
for (const [name, setup] of [
  ["driver rows", (s) => driverRows(s.run, [0.02])],
  ["the live session file", (s) => liveConductor(s)],
]) {
  test(`the real bridge refuses execute_with_model when ${name} alone exceed a $0.01 cap`, async () => {
    const s = sandbox();
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const bridge = await connectBridge({ env: { CODEX_HOME: s.home } });
    try {
      setup(s);
      telemetryRows(s.telemetry, [{ cost_usd: 0 }]);
      const before = readFileSync(s.telemetry, "utf-8");
      await assert.rejects(
        bridge.callTool("execute_with_model", { policy_path: cappedPolicyFile(s.root, "0.01"), telemetry_path: s.telemetry, packet: PACKET }),
        new RegExp(`${COST_CAP_EXCEEDED}.*conductor \\(modeled from`),
      );
      assert.equal(readFileSync(s.telemetry, "utf-8"), before);
    } finally {
      await bridge.close();
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
      s.done();
    }
  });
}
