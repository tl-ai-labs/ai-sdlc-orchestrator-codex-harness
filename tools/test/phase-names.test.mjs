/**
 * The phase names the conductor is told to put on a packet are the bridge's
 * own, the shipped policies route only those names, and a refined codegen,
 * tests, docs or debug packet escalates to the judgment tier at the retry
 * the playbook names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASES } from "../../plugin/mcp/model-dispatch/dist/types.js";
import { loadPolicyFromPath } from "../../plugin/mcp/model-dispatch/dist/policy.js";
import { pickModel } from "../../plugin/mcp/model-dispatch/dist/routing.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf-8");
const POLICIES = join(REPO, "plugin", "config", "policies");

test("the Phase union in types.ts is the runtime list the bridge checks", () => {
  const src = read("plugin/mcp/model-dispatch/src/types.ts");
  const list = /export const PHASES = \[([\s\S]*?)\] as const;/.exec(src)?.[1];
  assert.ok(list, "types.ts declares PHASES");
  assert.deepEqual([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]), [...PHASES]);
  assert.match(src, /export type Phase = \(typeof PHASES\)\[number\];/);
});

test("the conductor's packet table lists exactly the bridge's phases and has a retry_count row", () => {
  const conductor = read("plugin/codex/prompts/conductor.md");
  const row = conductor.split("\n").find((l) => l.startsWith("| `phase` |"));
  assert.ok(row, "conductor.md has a phase row");
  const before = row.indexOf("Never a state-machine step name");
  assert.ok(before > 0, "the row says a step name is not a phase");
  const named = [...row.slice(0, before).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => n !== "phase");
  assert.deepEqual([...named].sort(), [...PHASES].sort());
  assert.ok(conductor.split("\n").some((l) => l.startsWith("| `retry_count` | number |")));
});

test("the playbook's TaskPacket schema names exactly the bridge's phases", () => {
  const pipeline = read("plugin/skills/pipeline/SKILL.md");
  const schema = /## TaskPacket schema \(canonical\)\n\n```ts\n([\s\S]*?)```/.exec(pipeline)?.[1];
  assert.ok(schema);
  const phaseField = /phase: ([\s\S]*?),\s*\/\//.exec(schema)?.[1];
  assert.deepEqual([...phaseField.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort(), [...PHASES].sort());
});

test("every phase a playbook, role or prompt puts on a packet or a log line is one the bridge routes", () => {
  const files = [
    "plugin/codex/prompts/conductor.md",
    "plugin/skills/pipeline/SKILL.md",
    "plugin/skills/brownfield-guide/SKILL.md",
    "plugin/skills/brownfield-guide/discovery.md",
    ...readdirSync(join(REPO, "plugin/skills/pipeline/roles")).map((f) => `plugin/skills/pipeline/roles/${f}`),
    ...readdirSync(join(REPO, "plugin/skills/pipeline/stacks")).map((f) => `plugin/skills/pipeline/stacks/${f}`),
  ];
  const patterns = [/"phase": "([a-z_]+)"/g, /\bphase: "([a-z_]+)"/g, /--log-phase=([a-z_]+)/g, /`phase: ([a-z_]+)`/g];
  let seen = 0;
  for (const rel of files) {
    const text = read(rel);
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        seen++;
        assert.ok(PHASES.includes(m[1]), `${rel}: '${m[1]}' is not a bridge phase`);
      }
    }
    assert.doesNotMatch(text, /--log-phase=<state>|"phase": "<state>"/, `${rel} names a state, not a phase`);
  }
  assert.ok(seen > 5, "the scan found the playbook's packet examples");
});

const shipped = () =>
  readdirSync(POLICIES)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => ({ file: f, policy: loadPolicyFromPath(join(POLICIES, f)) }));

test("no shipped policy routes a phase name the bridge would refuse", () => {
  for (const { file, policy } of shipped()) {
    for (const rule of policy.rules) {
      if (!rule.when || rule.when.phase === undefined) continue;
      for (const phase of [rule.when.phase].flat()) assert.ok(PHASES.includes(phase), `${file}: rule on '${phase}'`);
    }
  }
});

test("on every GPT policy a refined codegen, tests, docs or debug packet reaches GPT at retry_count 2", () => {
  const gptPolicies = shipped().filter(({ policy }) => policy.models.some((m) => m.id === "gpt") && policy.name.startsWith("gpt-"));
  assert.deepEqual(gptPolicies.map((p) => p.policy.name).sort(), ["gpt-plus-flash", "gpt-plus-flash-38", "gpt-seat-plus-flash"]);
  const packets = [
    { phase: "codegen", task_type: "controller_handler" },
    { phase: "tests", task_type: "test_unit" },
    { phase: "docs", task_type: "readme_section" },
    { phase: "debug", task_type: "debug" },
  ];
  for (const { policy } of gptPolicies) {
    for (const p of packets) {
      const at = (retry_count) => pickModel({ ...p, module: "auth", retry_count }, policy).modelId;
      assert.notEqual(at(0), "gpt", `${policy.name} ${p.phase} first attempt stays mechanical`);
      assert.notEqual(at(1), "gpt", `${policy.name} ${p.phase} first retry stays mechanical`);
      assert.equal(at(2), "gpt", `${policy.name} ${p.phase} retry_count 2 escalates`);
      assert.equal(at(5), "gpt", `${policy.name} ${p.phase} stays escalated`);
    }
  }
});
