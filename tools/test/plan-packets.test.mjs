/**
 * Phase 4's plan goes to a dispatched worker that sees only its packet. A headless brownfield run on
 * gpt-seat-plus-flash stopped there after eight plans, each with a different wrong shape; the replies are kept in
 * fixtures/plan-packets/bf5-planner-replies.json. These tests hold the shipped plan schema to OpenAI strict mode and
 * plan-packets.mjs to refusing every one of those drifts with a problem the next planner packet can carry.
 */
import "./lib/stand-ins.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPlanPacket, childSchemaProblem, driverSessionStart, judgePlan, loadPlanSchema, main, MAX_DISPATCH_FAILURES,
  MAX_INPUT_BYTES, PLAN_ATTEMPTS, PLAN_FLAGS, readRunFacts, relPath,
} from "../../plugin/scripts/plan-packets.mjs";
import { renderedSkillPath, renderSkills } from "../../plugin/codex/render.mjs";
import { strictSchemaProblems } from "../../plugin/mcp/model-dispatch/dist/adapters/strictSchema.js";
import { PHASES } from "../../plugin/mcp/model-dispatch/dist/types.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(REPO, "plugin");
const SCRIPT = join(PLUGIN, "scripts", "plan-packets.mjs");
const FIXTURES = join(REPO, "tools", "test", "fixtures", "plan-packets");
const EXAMPLE = join(PLUGIN, "examples", "brownfield-bugfix");
const RUN_ID = "bf5-20261014-154246";
const REPLIES = JSON.parse(readFileSync(join(FIXTURES, "bf5-planner-replies.json"), "utf8")).attempts;
const FILE_SCHEMA = JSON.stringify({ type: "object", properties: { content: { type: "string" } }, required: ["content"] });

// ── run folders ─────────────────────────────────────────────────────────────

const temps = [];
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * The bf5 run's project: the shipped bugfix example, a secret `.env`, and the run folder with the contract Gate 0
 * froze. `headless` records the run the way run.mjs does; otherwise as start-run.mjs does.
 */
function brownfieldRun({ contract = {}, headless = false, intent = "bugfix", brief = null } = {}) {
  const root = tempDir("plan-packets-bf-");
  cpSync(join(EXAMPLE, "src"), join(root, "src"), { recursive: true });
  cpSync(join(EXAMPLE, "package.json"), join(root, "package.json"));
  writeFileSync(join(root, ".env"), "SESSION_SECRET=do-not-send\n");
  const runDir = join(root, ".sdlc", "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const frozen = { ...JSON.parse(readFileSync(join(FIXTURES, "bf5-write-contract.frozen.json"), "utf8")), ...contract };
  writeFileSync(join(runDir, "write-contract.frozen.json"), JSON.stringify(frozen, null, 2));
  cpSync(join(FIXTURES, "bf5-requirements.md"), join(runDir, "requirements.md"));
  if (brief !== null) writeFileSync(join(runDir, "intent_brief.md"), brief);
  if (headless) {
    const start = {
      v: 1, kind: "invocation_start", run_id: RUN_ID, invocation: 1, mode: "fresh", policy: "gpt-seat-plus-flash",
      gates: "auto-approve", cwd: root, output_dir: runDir, run_mode: "brownfield", intent, code_dir: root,
      brief_path: join(root, "intent_brief.md"),
    };
    writeFileSync(join(runDir, "driver-events.jsonl"), JSON.stringify(start) + "\n");
  } else {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      schema_version: 1, run_id: RUN_ID, route: "interactive", mode: "brownfield", intent, project_root: root, code_dir: root,
      brief_path: join(runDir, "intent_brief.md"),
    }));
  }
  return { root, runDir };
}

function greenfieldRun({ codeDir = "src" } = {}) {
  const root = tempDir("plan-packets-gf-");
  const runId = "gf-20261014-1";
  const runDir = join(root, ".sdlc", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(runDir, "design.md"), "# Design\n\n## 1. Modules\n\nOne ping module.\n");
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    schema_version: 1, run_id: runId, route: "interactive", mode: "greenfield", intent: null, project_root: root,
    code_dir: join(root, codeDir), brief_path: join(root, "brief.md"),
  }));
  return { root, runDir, runId };
}

/** A dispatch result as dispatch.mjs --out writes it, holding `reply` as the planner's answer. */
function dispatchResult(reply, {
  retry = 0, pass = RUN_ID, phase = "plan_task_packets", success = true, terminal = "success", taskId = null,
  error = "codex-cli timeout after 840s",
} = {}) {
  return {
    decision: { modelId: "gpt", reason: "Needs full context to slice work cleanly", ruleIndex: 2 },
    result: { result: reply, success, terminal_reason: terminal, ...(success ? {} : { error }) },
    events: [{
      ts: new Date().toISOString(), phase, pass, task_id: taskId ?? `tp_plan_00${retry + 1}`, retry_count: retry, model: "gpt-5.6-terra",
    }],
    terminal_reason: terminal,
  };
}

const notes = `.sdlc/runs/${RUN_ID}/notes`;

/** One packet of a plan the bf5 run could have used. */
function child(over = {}) {
  return {
    phase: "codegen",
    task_type: "bug_fix_apply",
    subtype: null,
    module: "auth",
    instruction: "Validate a missing username or password in src/auth.js before the credential check.",
    inputs: [{ path: "src/auth.js", content: "", reason: "The file the fix changes." }],
    output_schema_json: FILE_SCHEMA,
    acceptance: ["A missing password raises a validation error naming the field."],
    budget: { maxInputTokens: 3000, maxOutputTokens: 3000 },
    artifact_path: "src/auth.js",
    ...over,
  };
}

function validPlan() {
  return {
    packets: [
      child({
        phase: "debug", task_type: "bug_diagnose", instruction: "Write the root cause of the 500 as a note.",
        inputs: [
          { path: "src/auth.js", content: "", reason: "Where the TypeError starts." },
          { path: "src/index.js", content: "// the slice the planner chose\n", reason: "Where every error becomes a 500." },
          { path: `.sdlc/runs/${RUN_ID}/requirements.md`, content: "", reason: "The approved scope." },
        ],
        artifact_path: `${notes}/diagnosis.md`,
      }),
      child({ inputs: [{ path: "src/auth.js", content: "", reason: "The file the fix changes." }, { path: `${notes}/diagnosis.md`, content: "", reason: "The diagnosis." }] }),
      child({
        subtype: "router_wiring", task_type: "existing_file_edit", instruction: "Map the validation error to a 400 in src/index.js.",
        inputs: [{ path: "src/index.js", content: "", reason: "The route." }, { path: "src/auth.js", content: "", reason: "The fixed auth module." }],
        artifact_path: "src/index.js",
      }),
      child({
        phase: "tests", task_type: "test_add", instruction: "Add a missing-username test to src/auth.spec.js.",
        inputs: [{ path: "src/auth.spec.js", content: "", reason: "The test file." }],
        artifact_path: "src/auth.spec.js",
      }),
    ],
  };
}

const packetsFile = (runDir) => (existsSync(join(runDir, "packets.json")) ? readFileSync(join(runDir, "packets.json"), "utf8") : null);

/** Runs the script's main in-process against `result`, written into the run folder. */
async function accept(runDir, result, name = "tp-plan-001-result.json") {
  const path = join(runDir, name);
  writeFileSync(path, JSON.stringify(result));
  const before = packetsFile(runDir);
  return { ...(await run(["--accept", path, `--run-dir=${runDir}`])), runDir, result, before };
}

async function run(argv) {
  let out = "";
  let err = "";
  const code = await main(argv, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } });
  return { code, out, err };
}

/** The numbered problems a refusal printed. */
const problemsOf = (err) => err.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ""));

/** A refusal: exit 1, the problems numbered on stderr, packets.json as it was. Checks `expected` against every problem. */
async function assertRefused(r, runDir, expected) {
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /was refused \(attempt \d+ of 3\)\. Nothing was written\./);
  assert.ok(problemsOf(r.err).length > 0);
  const problems = judgePlan(await readRunFacts(runDir), r.result).problems;
  for (const want of expected) {
    assert.ok(problems.some((p) => p.includes(want)), `expected a problem containing ${JSON.stringify(want)} among:\n${problems.join("\n")}`);
  }
  assert.equal(packetsFile(runDir), r.before, "a refused plan writes nothing");
  return problems;
}

// ── the shipped schema ──────────────────────────────────────────────────────

test("both shipped plan schemas pass OpenAI strict mode, with an object root", () => {
  for (const mode of ["greenfield", "brownfield"]) {
    const schema = loadPlanSchema(mode);
    assert.deepEqual(strictSchemaProblems(schema), [], mode);
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["packets"]);
  }
});

test("a planned packet takes only execution phases the bridge routes", () => {
  for (const mode of ["greenfield", "brownfield"]) {
    const phases = loadPlanSchema(mode).properties.packets.items.properties.phase.enum;
    assert.deepEqual(phases, ["codegen", "tests", "docs", "debug", "refactor"], mode);
    for (const p of phases) assert.ok(PHASES.includes(p), `${p} is not a bridge phase`);
  }
});

test("the brownfield schema's task types are the playbook's brownfield primitives table, row for row", () => {
  const text = readFileSync(join(PLUGIN, "skills", "pipeline", "SKILL.md"), "utf8");
  const section = text.slice(text.indexOf("### Brownfield-mode task types (v1)"), text.indexOf("**Framework-owned wiring**"));
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 12);
  assert.deepEqual(loadPlanSchema("brownfield").properties.packets.items.properties.task_type.enum, rows);
});

test("greenfield task types stay open, so every codegen type a shipped policy routes on can be planned", () => {
  const taskType = loadPlanSchema("greenfield").properties.packets.items.properties.task_type;
  assert.equal(taskType.enum, undefined);
  const re = new RegExp(taskType.pattern);
  for (const name of ["gpt-plus-flash", "gpt-plus-flash-38", "gpt-seat-plus-flash"]) {
    const yaml = readFileSync(join(PLUGIN, "config", "policies", `${name}.yaml`), "utf8");
    const block = yaml.slice(yaml.indexOf("phase: codegen\n      task_type:"));
    const types = [...block.slice(0, block.indexOf("use:")).matchAll(/^\s+- ([a-z_]+)$/gm)].map((m) => m[1]);
    assert.ok(types.length > 5, name);
    for (const t of types) assert.match(t, re, `${name}: ${t}`);
  }
  assert.equal(loadPlanSchema("brownfield").properties.packets.items.properties.artifact_path.type, "string");
  assert.deepEqual(loadPlanSchema("greenfield").properties.packets.items.properties.artifact_path.type, ["string", "null"]);
});

// ── a plan that passes ──────────────────────────────────────────────────────

test("a valid brownfield plan becomes canonical packets.json, ids, run id and intent filled in", async () => {
  const { root, runDir } = brownfieldRun();
  const r = await accept(runDir, dispatchResult(validPlan()));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /packets: .*packets\.json \(4 packets: debug 1, codegen 2, tests 1\)/);
  const packets = JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"));
  assert.deepEqual(packets.map((p) => p.id), ["tp_debug_001", "tp_codegen_001", "tp_codegen_002", "tp_tests_001"]);
  for (const p of packets) {
    assert.deepEqual(
      Object.keys(p).filter((k) => k !== "subtype"),
      ["id", "phase", "task_type", "module", "instruction", "inputs", "outputSchema", "acceptance", "budget", "retry_count", "pass_id", "intent", "artifact_path"],
    );
    assert.equal(p.pass_id, RUN_ID);
    assert.equal(p.intent, "bugfix");
    assert.equal(p.retry_count, 0);
    assert.deepEqual(p.outputSchema, JSON.parse(FILE_SCHEMA));
  }
  assert.equal(packets[0].subtype, undefined, "a null subtype is left out");
  assert.equal(packets[2].subtype, "router_wiring");
  const auth = readFileSync(join(root, "src", "auth.js"), "utf8");
  assert.equal(packets[0].inputs[0].content, auth, "an empty slice is read from disk");
  assert.equal(packets[0].inputs[2].content, readFileSync(join(runDir, "requirements.md"), "utf8"));
  assert.deepEqual(packets[1].inputs[1], { path: `${notes}/diagnosis.md`, content: "", reason: "The diagnosis." }, "an earlier packet's file waits for that packet");
  assert.equal(packets[2].inputs[1].content, "", "so does a source file an earlier packet fixes");
  assert.equal(packets[0].inputs[1].content, "// the slice the planner chose\n", "a slice of a file no earlier packet writes is kept");
  assert.equal(packets[3].inputs[0].content, readFileSync(join(root, "src", "auth.spec.js"), "utf8"), "the file a packet rewrites is read whole");
});

test("the id, pass_id, intent and retry_count a planner wrote are replaced from the run record", async () => {
  const { runDir } = brownfieldRun();
  const plan = { packets: [child({ id: "bf5-fix-auth", pass_id: "tp_plan_008", intent: "Implement field-specific validation.", retry_count: 1 })] };
  const r = await accept(runDir, dispatchResult(plan));
  assert.equal(r.code, 0, r.err);
  const [p] = JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"));
  assert.equal(p.id, "tp_codegen_001");
  assert.equal(p.pass_id, RUN_ID);
  assert.equal(p.intent, "bugfix");
  assert.equal(p.retry_count, 0);
});

test("a headless run's intent comes from driver-events.jsonl, and from provenance.json when the driver had none", async () => {
  const a = brownfieldRun({ headless: true, intent: "bugfix" });
  assert.equal((await accept(a.runDir, dispatchResult({ packets: [child()] }))).code, 0);
  assert.equal(JSON.parse(readFileSync(join(a.runDir, "packets.json"), "utf8"))[0].intent, "bugfix");

  const b = brownfieldRun({ headless: true, intent: null });
  writeFileSync(join(b.runDir, "provenance.json"), JSON.stringify({ schema_version: 1, run_id: RUN_ID, intent: "test" }));
  const r = await accept(b.runDir, dispatchResult({ packets: [child({ phase: "tests", task_type: "test_backfill", artifact_path: "src/auth.spec.js" })] }));
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(join(b.runDir, "packets.json"), "utf8"))[0].intent, "test");
});

test("packets carry the intent Gate 0 confirmed, from provenance.json, over the handover's", async () => {
  const { runDir } = brownfieldRun({ intent: "bugfix", contract: { allowlist: ["src/**"] } });
  writeFileSync(join(runDir, "provenance.json"), JSON.stringify({ schema_version: 1, run_id: RUN_ID, intent: "feature-extend" }));
  assert.equal((await run(writeConductorFiles(runDir, []))).code, 0);
  assert.equal(JSON.parse(readFileSync(join(runDir, "tp-plan-001.json"), "utf8")).intent, "feature-extend");
  const r = await accept(runDir, dispatchResult({ packets: [child()] }));
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"))[0].intent, "feature-extend");
});

test("the bf5 run folder, resumed by a new driver, plans again from attempt 1 beside the eight packets it built by hand", async () => {
  const { runDir } = brownfieldRun({ headless: true });
  const longAgo = new Date(Date.now() - 3_600_000);
  REPLIES.forEach((a, i) => {
    const seq = String(i + 1).padStart(3, "0");
    writeFileSync(join(runDir, `tp-plan-${seq}.json`), JSON.stringify({ id: `tp_plan_${seq}`, phase: "plan_task_packets", outputSchema: { type: "array", items: { type: "object" } } }));
    writeFileSync(join(runDir, `tp-plan-${seq}-result.json`), JSON.stringify(dispatchResult(a.reply, { retry: i, taskId: `tp_plan_${seq}` })));
    for (const f of [`tp-plan-${seq}.json`, `tp-plan-${seq}-result.json`]) utimesSync(join(runDir, f), longAgo, longAgo);
  });
  const events = join(runDir, "driver-events.jsonl");
  const [first] = readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lines = [
    { ...first, at: new Date(Date.now() - 7_200_000).toISOString(), driver_pid: 40368 },
    { v: 1, kind: "run_end", invocation: 1, at: new Date(Date.now() - 5_400_000).toISOString(), outcome: "stopped", deliberate: true },
    { ...first, invocation: 2, mode: "resume", at: new Date(Date.now() - 60_000).toISOString(), driver_pid: 51234 },
  ];
  writeFileSync(events, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const built = await buildPacket(runDir);
  assert.equal(built.code, 0, built.err);
  assert.match(built.out, /tp-plan-009\.json\n.*\nattempt: 1 of 3/);
});

// ── every drift the bf5 run recorded ────────────────────────────────────────

const wrapped = (n) => ({ packets: REPLIES[n - 1].reply });

test("the bf5 replies, as they came back, are refused at the root: a plan is an object", async () => {
  const { runDir } = brownfieldRun();
  for (const a of REPLIES) {
    const r = await accept(runDir, dispatchResult(a.reply, { retry: 0 }));
    await assertRefused(r, runDir, ['The plan is a bare list. Return an object, {"packets": [...]}.']);
  }
});

test("bf5 attempt 1: a made-up task type, inputs as an object, a pseudo-type outputSchema, a number budget, a note beside the run records", async () => {
  const { runDir } = brownfieldRun();
  await assertRefused(await accept(runDir, dispatchResult(wrapped(1))), runDir, [
    'packets[0].task_type "brownfield" is not a brownfield task type. Use one of: new_file_add,',
    "packets[0].inputs is an object",
    'packets[0] has a field "outputSchema" the plan does not take: give the child\'s schema as output_schema_json',
    "packets[0] has no output_schema_json.",
    "packets[0].acceptance must be a non-empty list",
    'packets[0].budget must be {"maxInputTokens": <whole number>, "maxOutputTokens": <whole number>}, got 200.',
    `packets[0].artifact_path ".sdlc/runs/${RUN_ID}/reproduce.md" is in the run folder beside the run's own records; a note that is not shipped code goes under ${notes}/`,
    'packets[1] has a field "depends_on" the plan does not take: list the packets in dependency order instead.',
  ]);
});

test("bf5 attempt 2: task_id and title instead of the plan's fields", async () => {
  const { runDir } = brownfieldRun();
  await assertRefused(await accept(runDir, dispatchResult(wrapped(2), { retry: 1 })), runDir, [
    'packets[0] has a field "task_id" the plan does not take: the script numbers the packets itself.',
    'packets[0] has a field "title" the plan does not take',
    "packets[0] has no task_type.",
    "packets[0] has no module.",
  ]);
});

test("bf5 attempt 3: targets outside the allowlist and outside the run folder, inputs as bare strings", async () => {
  const { runDir } = brownfieldRun();
  await assertRefused(await accept(runDir, dispatchResult(wrapped(3), { retry: 2 })), runDir, [
    'packets[0].artifact_path "plan_task_packets/bugfix_plan/tp_plan_003/auth_reproduction_note.md" is not in the run\'s frozen allowlist ("src/auth.js", "src/index.js", "src/auth.spec.js")',
    'packets[0].inputs[0] is a string ("auth.js"); give {"path", "content", "reason"}',
  ]);
});

test("bf5 attempt 4: path instead of artifact_path, so no target at all", async () => {
  const { runDir } = brownfieldRun();
  await assertRefused(await accept(runDir, dispatchResult(wrapped(4))), runDir, [
    'packets[0] has a field "path" the plan does not take: the path a packet writes is artifact_path.',
    "packets[0] has no artifact_path.",
    "packets[0] has no instruction.",
  ]);
  const plan = { packets: [child({ phase: "tests", task_type: "test_backfill", artifact_path: "tests/src/auth.spec.js" })] };
  await assertRefused(await accept(runDir, dispatchResult(plan)), runDir, ['packets[0].artifact_path "tests/src/auth.spec.js" is not in the run\'s frozen allowlist']);
});

test("bf5 attempts 5 to 7: an outputSchema object, a type field, task_id", async () => {
  const { runDir } = brownfieldRun();
  await assertRefused(await accept(runDir, dispatchResult(wrapped(5))), runDir, ['packets[0] has a field "outputSchema"']);
  await assertRefused(await accept(runDir, dispatchResult(wrapped(6))), runDir, [
    'packets[0] has a field "type" the plan does not take: the work type is task_type.',
    'packets[0] has a field "task_id"',
  ]);
  await assertRefused(await accept(runDir, dispatchResult(wrapped(7))), runDir, ['packets[0] has a field "outputSchema"']);
});

test("bf5 attempt 8: phases run and src, task types reproduce and bugfix, a target under run/, string acceptance", async () => {
  const { runDir } = brownfieldRun();
  await assertRefused(await accept(runDir, dispatchResult(wrapped(8))), runDir, [
    'packets[0].phase "run" is not a phase a planned packet takes. Use one of: codegen, tests, docs, debug, refactor.',
    'packets[2].phase "src" is not a phase a planned packet takes.',
    'packets[0].task_type "reproduce" is not a brownfield task type.',
    'packets[2].task_type "bugfix" is not a brownfield task type.',
    'packets[0].artifact_path "run/reproduce.md" is not in the run\'s frozen allowlist',
    "packets[0].acceptance must be a non-empty list",
    'packets[0].inputs[0] is a string ("requirements.md")',
  ]);
  const r = await accept(runDir, dispatchResult(wrapped(8)));
  assert.equal(problemsOf(r.err).length, 31, "the printed list stops at 30 and says how many more");
  assert.match(r.err, /^31\. And \d+ more problems of the kinds above\.$/m);
});

// ── the child's own schema ──────────────────────────────────────────────────

test("output_schema_json must parse to a JSON Schema object", async () => {
  const { runDir } = brownfieldRun();
  const cases = [
    ["{artifact_path:string, reproduced:boolean}", "does not parse as JSON"],
    ['"string"', "is not a JSON Schema object"],
    ["[]", "is not a JSON Schema object"],
    ["null", "is not a JSON Schema object"],
    ['{"artifact_path":"string"}', 'names no type (it holds "artifact_path")'],
    ['{"type":"str"}', 'type "str" is not a JSON Schema type'],
    ['{"type":"object","properties":{"content":{"type":"strng"}}}', 'properties.content type "strng" is not a JSON Schema type'],
    ['{"type":"array","items":{"kind":"x"}}', "items names no type"],
  ];
  for (const [json, want] of cases) {
    await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ output_schema_json: json })] })), runDir, [`packets[0].output_schema_json ${want}`]);
  }
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ output_schema_json: { type: "string" } })] })), runDir, [
    "packets[0].output_schema_json must be a string",
  ]);
  for (const ok of ['{"type":"string"}', '{"__free_text__":true}', '{"anyOf":[{"type":"string"},{"type":"null"}]}']) {
    assert.equal(childSchemaProblem(JSON.parse(ok)), null, ok);
  }
});

test("a child schema is checked under every keyword that holds one, and a nested problem names its path with dots", async () => {
  for (const [schema, want] of [
    [{ type: "object", additionalProperties: { type: "nope" } }, 'additionalProperties type "nope" is not a JSON Schema type'],
    [{ type: "object", additionalProperties: "x" }, "additionalProperties is not a JSON Schema object"],
    [{ type: "object", not: 5 }, "not is not a JSON Schema object"],
    [{ type: "array", prefixItems: [5] }, "prefixItems[0] is not a JSON Schema object"],
    [{ type: "array", prefixItems: 5 }, "prefixItems is not a list"],
    [{ type: "object", $defs: { a: 5 }, properties: { x: { $ref: "#/$defs/a" } } }, "$defs.a is not a JSON Schema object"],
    [{ type: "object", definitions: { a: { kind: "x" } } }, "definitions.a names no type"],
    [{ type: "array", items: true }, "items is not a JSON Schema object"],
    [{ type: "object", properties: { a: { type: "object", additionalProperties: { type: "nope" } } } }, 'properties.a.additionalProperties type "nope" is not a JSON Schema type'],
    [{ type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: "string" } } } } }, "properties.files.items.properties.path is not a JSON Schema object"],
    [{ anyOf: [{ type: "string" }, { type: "object", properties: { a: {} } }] }, "anyOf[1].properties.a names no type"],
  ]) {
    const got = childSchemaProblem(schema);
    assert.ok(got?.startsWith(want), `${JSON.stringify(schema)}: ${got}`);
  }
  for (const ok of [
    { type: "object", additionalProperties: false },
    { type: "object", additionalProperties: { type: "string" } },
    { $defs: { a: { type: "string" } }, $ref: "#/$defs/a" },
    { type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
  ]) {
    assert.equal(childSchemaProblem(ok), null, JSON.stringify(ok));
  }
  const { runDir } = brownfieldRun();
  const nested = JSON.stringify({ type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: "string" } } } } });
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ output_schema_json: nested })] })), runDir, [
    "packets[0].output_schema_json properties.files.items.properties.path is not a JSON Schema object.",
  ]);
});

// ── targets ─────────────────────────────────────────────────────────────────

test("a target must be repo-relative, normalised, allowlisted or a note, and never off-limits", async () => {
  const { runDir } = brownfieldRun();
  const cases = [
    [".env", 'matches always-off-limits pattern ".env"'],
    ["package.json", 'matches off-limits pattern "package.json"'],
    ["src/../.env", 'climbs out of its folder with ".."'],
    ["../outside.js", 'climbs out of its folder with ".."'],
    ["/etc/passwd", "is absolute; write it relative to the project root"],
    ["src\\auth.js", "holds a backslash"],
    ["src//auth.js", 'is not a normalised path; write "src/auth.js"'],
    [".sdlc/local/write-contract.json", "is .sdlc/local/write-contract.json, a record the plugin keeps for the run"],
    [`.sdlc/runs/${RUN_ID}/write-contract.lock.json`, `is .sdlc/runs/${RUN_ID}/write-contract.lock.json, a record the plugin keeps for the run`],
    [`.sdlc/runs/${RUN_ID}/packets.json`, "is in the run folder beside the run's own records"],
    [`.sdlc/runs/${RUN_ID}/notes/`, "is not a normalised path"],
    [".sdlc/runs/another-run/notes/x.md", "is not in the run's frozen allowlist"],
    [".git/config", 'matches always-off-limits pattern ".git/**"'],
  ];
  for (const [target, want] of cases) {
    const r = await accept(runDir, dispatchResult({ packets: [child({ artifact_path: target })] }));
    await assertRefused(r, runDir, [`packets[0].artifact_path ${JSON.stringify(target)} ${want}`]);
  }
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ artifact_path: null })] })), runDir, [
    "packets[0].artifact_path is null; every brownfield packet names the one path it writes.",
  ]);
  const r = await accept(runDir, dispatchResult({ packets: [child({ artifact_path: "./src/auth.js" })] }));
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"))[0].artifact_path, "src/auth.js");
});

test("a target is judged with links resolved, as the write guard judges a write", async () => {
  const { root, runDir } = brownfieldRun({ contract: { allowlist: ["src/**"] } });
  const outside = tempDir("plan-packets-outside-");
  symlinkSync(outside, join(root, "src", "escape"));
  symlinkSync(join(root, ".env"), join(root, "src", "settings.txt"));
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ artifact_path: "src/escape/a.js" })] })), runDir, [
    'packets[0].artifact_path "src/escape/a.js" leads outside the project through a link',
  ]);
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ artifact_path: "src/settings.txt" })] })), runDir, [
    'packets[0].artifact_path "src/settings.txt" resolves to ".env" through a link: ".env" matches always-off-limits pattern ".env"',
  ]);
});

test("a second packet for one file must start from the first one's file, and spell it the same way", async () => {
  const { runDir } = brownfieldRun({ contract: { allowlist: ["src/**"] } });
  const plan = { packets: [child(), child({ instruction: "Second edit.", inputs: [] }), child({ artifact_path: "src/Auth.js" })] };
  await assertRefused(await accept(runDir, dispatchResult(plan)), runDir, [
    'packets[1] writes "src/auth.js" after packets[0] does; list "src/auth.js" among its inputs with content "" so it starts from the file that packet leaves, or plan one packet for the file.',
    'packets[2] writes "src/Auth.js", the file packets[0] writes as "src/auth.js". Spell one file one way.',
  ]);
});

test("the bugfix cell on a repo with one test file: the reproduction and the regression test share it", async () => {
  const { root, runDir } = brownfieldRun();
  const spec = { path: "src/auth.spec.js", content: "", reason: "The test file." };
  const plan = {
    packets: [
      child({ phase: "tests", task_type: "bug_reproduce", artifact_path: "src/auth.spec.js", inputs: [spec, { path: "src/auth.js", content: "", reason: "The bug." }] }),
      child({ phase: "debug", task_type: "bug_diagnose", artifact_path: `${notes}/diagnosis.md`, inputs: [spec] }),
      child({ inputs: [{ path: "src/auth.js", content: "", reason: "The fix." }, { path: `${notes}/diagnosis.md`, content: "", reason: "Why." }] }),
      child({ phase: "tests", task_type: "test_add", artifact_path: "src/auth.spec.js", inputs: [spec] }),
    ],
  };
  const r = await accept(runDir, dispatchResult(plan));
  assert.equal(r.code, 0, r.err);
  const packets = JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"));
  assert.equal(packets[0].inputs[0].content, readFileSync(join(root, "src", "auth.spec.js"), "utf8"), "the first writer reads the file whole");
  assert.equal(packets[1].inputs[0].content, "", "a later reader waits for the reproduction");
  assert.equal(packets[3].inputs[0].content, "", "so does the second writer");
});

test("the file a packet writes, or an earlier packet writes, is never given as a slice", async () => {
  const { root, runDir } = brownfieldRun();
  const spec = readFileSync(join(root, "src", "auth.spec.js"), "utf8");
  const auth = readFileSync(join(root, "src", "auth.js"), "utf8");
  const head = spec.split("\n").slice(0, 3).join("\n");
  await assertRefused(await accept(runDir, dispatchResult({
    packets: [child({ phase: "tests", task_type: "test_add", artifact_path: "src/auth.spec.js", inputs: [{ path: "src/auth.spec.js", content: head, reason: "The test file." }] })],
  })), runDir, ['packets[0].inputs[0] gives content for "src/auth.spec.js", the file this packet writes; leave content "" so the worker gets the whole file.']);

  await assertRefused(await accept(runDir, dispatchResult({
    packets: [
      child({ phase: "debug", task_type: "bug_diagnose", artifact_path: `${notes}/diagnosis.md` }),
      child({ inputs: [{ path: "src/auth.js", content: "", reason: "r" }, { path: `${notes}/diagnosis.md`, content: "See the diagnosis written by the previous packet.", reason: "r" }] }),
      child({ task_type: "existing_file_edit", artifact_path: "src/index.js", inputs: [{ path: "src/index.js", content: "", reason: "r" }, { path: "src/auth.js", content: auth, reason: "The fixed auth module." }] }),
    ],
  })), runDir, [
    `packets[1].inputs[1] gives content for "${notes}/diagnosis.md", which packets[0] writes first; leave content "" so the worker gets the file as that packet leaves it.`,
    'packets[2].inputs[1] gives content for "src/auth.js", which packets[1] writes first;',
  ]);

  const wide = brownfieldRun({ contract: { allowlist: ["src/**"] } });
  const created = await accept(wide.runDir, dispatchResult({
    packets: [child({ phase: "tests", task_type: "test_add", artifact_path: "src/login.spec.js", inputs: [{ path: "src/login.spec.js", content: "", reason: "r" }] })],
  }));
  assert.equal(created.code, 0, created.err);
  assert.match(created.err, /^warning: packets\[0\]\.inputs\[0\]\.path "src\/login\.spec\.js" is the file this packet creates; nothing is on disk yet, so the input was left out\.$/m);
  assert.deepEqual(JSON.parse(packetsFile(wide.runDir))[0].inputs, []);

  const fresh = brownfieldRun({ contract: { allowlist: ["src/**"] } });
  await assertRefused(await accept(fresh.runDir, dispatchResult({
    packets: [child({ task_type: "existing_file_edit", artifact_path: "src/login.js", inputs: [{ path: "src/login.js", content: "", reason: "r" }] })],
  })), fresh.runDir, ['packets[0].inputs[0].path "src/login.js" is not on disk, but task_type "existing_file_edit" changes a file that already exists. Fix the path, or plan the packet as new_file_add.']);
});

test("a greenfield plan may list each new file it writes as an input; the empty input is left out", async () => {
  const { runDir, runId } = greenfieldRun();
  const own = (path, extra = []) => [{ path, content: "", reason: "This is the file to create." }, ...extra];
  const r = await accept(runDir, dispatchResult({
    packets: [
      child({ task_type: "service_method", module: "notes", artifact_path: "src/notes.js", inputs: own("src/notes.js", [{ path: `.sdlc/runs/${runId}/design.md`, content: "", reason: "The design." }]) }),
      child({ task_type: "server_app", module: "notes", artifact_path: "src/server.js", inputs: own("src/server.js", [{ path: "src/notes.js", content: "", reason: "The store it uses." }]) }),
      child({ phase: "tests", task_type: "test_unit", module: "notes", artifact_path: "src/server.test.js", inputs: own("src/server.test.js", [{ path: "src/server.js", content: "", reason: "The app under test." }]) }),
    ],
  }, { pass: runId }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err.match(/^warning: .* is the file this packet creates; nothing is on disk yet, so the input was left out\.$/gm)?.length, 3);
  const packets = JSON.parse(packetsFile(runDir));
  assert.deepEqual(packets.map((p) => p.inputs.map((s) => s.path)), [[`.sdlc/runs/${runId}/design.md`], ["src/notes.js"], ["src/server.js"]]);
  assert.equal(packets[1].inputs[0].content, "", "a file an earlier packet writes is filled at Phase 5");
});

test("a contract that is not strict lets a target outside the allowlist through, with a warning", async () => {
  const { runDir } = brownfieldRun({ contract: { strict: false } });
  const r = await accept(runDir, dispatchResult({ packets: [child({ artifact_path: "README.md" })] }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^warning: packets\[0\]\.artifact_path "README\.md" is not in the run's frozen allowlist.*Allowed because the contract is not strict\./m);
  const off = await accept(runDir, dispatchResult({ packets: [child({ artifact_path: "package.json" })] }));
  assert.equal(off.code, 1, "off-limits stays refused");
});

test("a case alias of the run folder is the run folder, under a broad allowlist, a loose contract, or a greenfield code dir at the root", async () => {
  const wide = brownfieldRun({ contract: { allowlist: ["**/*.md", "**/*.json"] } });
  for (const target of [`.SDLC/runs/${RUN_ID}/requirements.md`, `.sdlc/runs/${RUN_ID.toUpperCase()}/requirements.md`, `.sdlc/RUNS/${RUN_ID}/report.md`]) {
    await assertRefused(await accept(wide.runDir, dispatchResult({ packets: [child({ task_type: "doc_update", phase: "docs", artifact_path: target })] })), wide.runDir, [
      `packets[0].artifact_path ${JSON.stringify(target)} is in the run folder beside the run's own records; a note that is not shipped code goes under ${notes}/`,
    ]);
  }
  await assertRefused(await accept(wide.runDir, dispatchResult({ packets: [child({ phase: "debug", task_type: "bug_diagnose", artifact_path: `.sdlc/runs/${RUN_ID}/NOTES/diagnosis.md` })] })), wide.runDir, [
    `spells this run's notes folder another way; write it under ${notes}/`,
  ]);

  const loose = brownfieldRun({ contract: { strict: false } });
  const r = await accept(loose.runDir, dispatchResult({ packets: [child({ artifact_path: `.SDLC/runs/${RUN_ID}/run.json` })] }));
  await assertRefused(r, loose.runDir, ["is in the run folder beside the run's own records"]);
  assert.doesNotMatch(r.err, /Allowed because the contract is not strict/);

  const gf = greenfieldRun({ codeDir: "." });
  for (const target of [`.SDLC/runs/${gf.runId}/run.json`, `.Sdlc/runs/${gf.runId}/design.md`, ".SDLC/project.json"]) {
    await assertRefused(await accept(gf.runDir, dispatchResult({ packets: [child({ task_type: "dto", artifact_path: target, inputs: [] })] }, { pass: gf.runId })), gf.runDir, [
      `packets[0].artifact_path ${JSON.stringify(target)} is among the run records`,
    ]);
  }
});

test("a path with a control character, or space around a name, is refused as a target and as an input", async () => {
  const gf = greenfieldRun();
  for (const target of ["src/a.ts\n", "src/a.ts ", "src/\ta.ts", " src/a.ts", "src/ x/a.ts"]) {
    const want = /[\t\n]/.test(target) ? "holds a control character (a tab, a newline or a NUL); write the path on one line" : "has a space at the start or end of a name";
    await assertRefused(await accept(gf.runDir, dispatchResult({ packets: [child({ task_type: "dto", artifact_path: target, inputs: [] })] }, { pass: gf.runId })), gf.runDir, [
      `packets[0].artifact_path ${JSON.stringify(target)} ${want}`,
    ]);
  }
  const bf = brownfieldRun({ contract: { allowlist: ["src/**"] } });
  await assertRefused(await accept(bf.runDir, dispatchResult({ packets: [child({ artifact_path: "src/auth.js " })] })), bf.runDir, [
    'packets[0].artifact_path "src/auth.js " has a space at the start or end of a name; write "src/auth.js"',
  ]);
  await assertRefused(await accept(bf.runDir, dispatchResult({ packets: [child({ inputs: [{ path: "src/index.js\t", content: "", reason: "r" }] })] })), bf.runDir, [
    'packets[0].inputs[0].path "src/index.js\\t" holds a control character',
  ]);
  assert.match(relPath("src/auth.js\u0000x").problem, /holds a control character/, "a NUL is not reported as a backslash");
  assert.match(relPath("src\\auth.js").problem, /holds a backslash/);
});

test("a greenfield plan may write .env.example and .env.test, never .env", async () => {
  const { runDir, runId } = greenfieldRun();
  for (const [target, pattern] of [["src/.env", ".env"], ["src/.git/.env.example", ".git/**"], ["src/.agents/.env.test", ".agents/**"]]) {
    await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ phase: "docs", task_type: "env_docs", artifact_path: target, inputs: [] })] }, { pass: runId })), runDir, [
      `packets[0].artifact_path ${JSON.stringify(target)} matches always-off-limits pattern ${JSON.stringify(pattern)}`,
    ]);
  }
  const plan = {
    packets: [
      child({ phase: "docs", task_type: "env_docs", artifact_path: "src/.env.example", inputs: [] }),
      child({ phase: "tests", task_type: "env_test_fixture", artifact_path: "src/.env.test", inputs: [{ path: "src/.env.example", content: "", reason: "Every key it lists." }] }),
      child({ phase: "tests", task_type: "test_unit", artifact_path: "src/ping.spec.ts", inputs: [{ path: "src/.env.test", content: "", reason: "The test values." }] }),
    ],
  };
  const r = await accept(runDir, dispatchResult(plan, { pass: runId }));
  assert.equal(r.code, 0, r.err);
  const packets = JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"));
  assert.deepEqual(packets[1].inputs, [{ path: "src/.env.example", content: "", reason: "Every key it lists." }], "filled at Phase 5, once the first packet wrote it");
  assert.equal(packets[2].inputs[0].content, "");

  writeFileSync(join(dirname(dirname(dirname(runDir))), "src", ".env.example"), "API_KEY=\n");
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ task_type: "dto", artifact_path: "src/a.dto.ts", inputs: [{ path: "src/.env.example", content: "", reason: "r" }] })] }, { pass: runId })), runDir, [
    'packets[0].inputs[0].path "src/.env.example" is off-limits (pattern ".env.*")',
  ]);
});

// ── inputs ──────────────────────────────────────────────────────────────────

test("an input is never read from, or named as, an off-limits path, outside the project, or through a link out", async () => {
  const { root, runDir } = brownfieldRun();
  const outside = tempDir("plan-packets-outside-");
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  symlinkSync(outside, join(root, "src", "escape"));
  const withInput = (input) => dispatchResult({ packets: [child({ inputs: [input] })] });
  const at = "packets[0].inputs[0]";
  const cases = [
    [{ path: ".env", content: "", reason: "r" }, `${at}.path ".env" is off-limits (pattern ".env"), so it does not go to a model.`],
    [{ path: ".env", content: "SESSION_SECRET=x", reason: "r" }, `${at}.path ".env" is off-limits`],
    [{ path: "config/.env.production", content: "", reason: "r" }, `${at}.path "config/.env.production" is off-limits (pattern ".env.*")`],
    [{ path: "package.json", content: "", reason: "r" }, `${at}.path "package.json" is off-limits (pattern "package.json")`],
    [{ path: "../outside/secret.txt", content: "", reason: "r" }, `${at}.path "../outside/secret.txt" climbs out of its folder with ".."`],
    [{ path: "/etc/hosts", content: "", reason: "r" }, `${at}.path "/etc/hosts" is outside the project, the run folder and the plugin's stack guides.`],
    [{ path: join(root, ".env"), content: "", reason: "r" }, `${at}.path ".env" is off-limits (pattern ".env")`],
    [{ path: "src/escape/secret.txt", content: "", reason: "r" }, `${at}.path "src/escape/secret.txt" leads outside the project through a link`],
    [{ path: "src/missing.js", content: "", reason: "r" }, `${at}.path "src/missing.js" has no file on disk to read`],
    [{ path: "src", content: "", reason: "r" }, `${at}.path "src" is not a file`],
    [{ path: "src/auth.js", content: "", reason: "" }, `${at}.reason is empty`],
    [{ path: "src/auth.js", content: "", reason: "r", extra: 1 }, `${at} has a field "extra"`],
  ];
  for (const [input, want] of cases) {
    await assertRefused(await accept(runDir, withInput(input)), runDir, [want]);
  }
});

test("a slice read from disk is bounded and must be text", async () => {
  const { root, runDir } = brownfieldRun();
  writeFileSync(join(root, "src", "big.js"), "x".repeat(MAX_INPUT_BYTES + 1));
  writeFileSync(join(root, "src", "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ inputs: [{ path: "src/big.js", content: "", reason: "r" }] })] })), runDir, [
    `.path "src/big.js" is ${Math.ceil((MAX_INPUT_BYTES + 1) / 1024)} KB, over the ${MAX_INPUT_BYTES / 1024} KB a slice read from disk may hold`,
  ]);
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ inputs: [{ path: "src/logo.bin", content: "", reason: "r" }] })] })), runDir, [
    '.path "src/logo.bin" is not a text file',
  ]);
});

test("a slice that holds a secret-shaped string does not go to a model, whoever filled it", async () => {
  const { root, runDir } = brownfieldRun();
  const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  writeFileSync(join(root, "src", "aws.js"), `export const id = "${key}";\n`);
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ inputs: [{ path: "src/aws.js", content: "", reason: "r" }] })] })), runDir, [
    'packets[0].inputs[0].content "src/aws.js" holds what looks like a secret (aws-access-key-id, line 1), so it does not go to a model',
  ]);
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ inputs: [{ path: "src/index.js", content: `const k = "${key}";`, reason: "r" }] })] })), runDir, [
    "holds what looks like a secret (aws-access-key-id, line 1)",
  ]);
  const r = await run(writeConductorFiles(runDir, [{ path: "src/aws.js", reason: "r" }]));
  assert.equal(r.code, 2);
  assert.match(r.err, /inputs\[0\]\.content "src\/aws\.js" holds what looks like a secret/);
  assert.doesNotMatch(r.err, new RegExp(key), "the secret itself is never printed");
});

test("an input a later packet writes is a dependency-order problem", async () => {
  const { runDir } = brownfieldRun();
  const plan = {
    packets: [
      child({ inputs: [{ path: `${notes}/diagnosis.md`, content: "", reason: "The diagnosis." }] }),
      child({ phase: "debug", task_type: "bug_diagnose", artifact_path: `${notes}/diagnosis.md` }),
    ],
  };
  await assertRefused(await accept(runDir, dispatchResult(plan)), runDir, [
    `packets[0].inputs[0] reads "${notes}/diagnosis.md", which packets[1] writes later. List the packets in dependency order.`,
  ]);
});

test("a child input may name the stack guide by the absolute path the planner was given, or a project file absolutely", async () => {
  const { root, runDir } = brownfieldRun();
  const guide = join(PLUGIN, "skills", "pipeline", "stacks", "generic.md");
  const r = await run(writeConductorFiles(runDir, [{ path: guide, reason: "The stack's placement rules." }]));
  assert.equal(r.code, 0, r.err);
  const given = JSON.parse(readFileSync(join(runDir, "tp-plan-001.json"), "utf8")).inputs[0].path;
  assert.equal(given, guide);
  const plan = {
    packets: [child({
      inputs: [
        { path: join(root, "src", "auth.js"), content: "", reason: "The file the fix changes." },
        { path: given, content: "", reason: "Placement rules." },
        { path: given, content: "Keep tests beside the source.", reason: "Placement rules, the part that matters." },
      ],
    })],
  };
  const ok = await accept(runDir, dispatchResult(plan));
  assert.equal(ok.code, 0, ok.err);
  const [p] = JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"));
  assert.equal(p.inputs[0].path, "src/auth.js", "a project file is named relative to the project root");
  assert.deepEqual(p.inputs[1], { path: guide, content: readFileSync(guide, "utf8"), reason: "Placement rules." });
  assert.equal(p.inputs[2].content, "Keep tests beside the source.");
  await assertRefused(await accept(runDir, dispatchResult({ packets: [child({ inputs: [{ path: join(PLUGIN, "config", "policies", "gpt-plus-flash.yaml"), content: "x", reason: "r" }] })] })), runDir, [
    "is outside the project, the run folder and the plugin's stack guides",
  ]);
});

// ── the run ─────────────────────────────────────────────────────────────────

test("a greenfield run plans without a write contract, inside its code directory", async () => {
  const { runDir, runId } = greenfieldRun();
  const plan = {
    packets: [
      child({ task_type: "controller_handler", artifact_path: "src/ping.controller.ts", inputs: [{ path: `.sdlc/runs/${runId}/design.md`, content: "", reason: "The design." }] }),
      child({ phase: "docs", task_type: "env_docs", artifact_path: "src/.env.example", inputs: [] }),
      child({ phase: "debug", task_type: "smoke_note", artifact_path: null, inputs: [] }),
      child({ phase: "debug", task_type: "repro_note", artifact_path: `.sdlc/runs/${runId}/notes/repro.md`, inputs: [] }),
    ],
  };
  const r = await accept(runDir, dispatchResult(plan, { pass: runId }));
  assert.equal(r.code, 0, r.err);
  const packets = JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8"));
  assert.equal(packets.length, 4);
  for (const p of packets) {
    assert.equal(p.pass_id, runId);
    assert.equal("intent" in p, false, "greenfield packets carry no intent");
  }
  assert.equal("artifact_path" in packets[2], false, "a null target is left out");
  assert.match(packets[0].inputs[0].content, /One ping module/);

  for (const [over, want] of [
    [{ artifact_path: "lib/x.ts" }, 'packets[0].artifact_path "lib/x.ts" is outside the code directory src/'],
    [{ artifact_path: ".git/config" }, 'matches always-off-limits pattern ".git/**"'],
    [{ artifact_path: `.sdlc/runs/${runId}/design.md` }, "is among the run records"],
    [{ task_type: "ControllerHandler" }, 'packets[0].task_type "ControllerHandler" is not a snake_case work type'],
    [{ inputs: [{ path: ".env", content: "x", reason: "r" }] }, 'packets[0].inputs[0].path ".env" is off-limits'],
  ]) {
    await assertRefused(await accept(runDir, dispatchResult({ packets: [child(over)] }, { pass: runId })), runDir, [want]);
  }
});

test("the intent brief's task type binds every packet of a docs run", async () => {
  const { runDir } = brownfieldRun({
    intent: "docs",
    contract: { allowlist: ["README.md", "docs/**"] },
    brief: "# Intent Brief — docs — login\n\n## Context\n\nx\n\n## Task type\n\n`doc_update`\n\n## Files in scope\n\n- README.md\n",
  });
  const doc = (over) => child({ phase: "docs", task_type: "doc_update", artifact_path: "README.md", inputs: [], ...over });
  await assertRefused(await accept(runDir, dispatchResult({ packets: [doc({ task_type: "doc_addition", artifact_path: "docs/login.md" })] })), runDir, [
    'packets[0].task_type "doc_addition" differs from the intent brief\'s task type; every packet in this run is "doc_update".',
  ]);
  assert.equal((await accept(runDir, dispatchResult({ packets: [doc()] }))).code, 0);
});

test("a run folder the script cannot read a run from is a usage error, not a refusal", async () => {
  const empty = tempDir("plan-packets-empty-");
  const r = await accept(empty, dispatchResult({ packets: [child()] }));
  assert.equal(r.code, 2);
  assert.match(r.err, /holds no run record \(run\.json or driver-events\.jsonl\)/);

  const { runDir } = brownfieldRun();
  rmSync(join(runDir, "write-contract.frozen.json"));
  const noContract = await accept(runDir, dispatchResult({ packets: [child()] }));
  assert.equal(noContract.code, 2);
  assert.match(noContract.err, /no frozen write contract at .*: a brownfield plan comes after Gate 0 froze it\./);
});

test("a result from another phase or run, or a dispatch that failed, is not taken for a plan", async () => {
  const { runDir } = brownfieldRun();
  const other = await accept(runDir, dispatchResult(validPlan(), { phase: "requirements_analysis" }));
  assert.equal(other.code, 2);
  assert.match(other.err, /that result is a requirements_analysis dispatch, not a plan\./);
  const run2 = await accept(runDir, dispatchResult(validPlan(), { pass: "another-run" }));
  assert.equal(run2.code, 2);
  assert.match(run2.err, /that result is from run another-run/);

  await assertRefused(await accept(runDir, dispatchResult({ raw: '{"packets": [', _truncated: true }, { success: false, terminal: "output_cap_at_model_absolute" })), runDir, [
    "The reply was cut off at its output ceiling",
  ]);
  await assertRefused(await accept(runDir, dispatchResult({ raw: "Here is the plan:" })), runDir, ["The reply is not JSON."]);
  await assertRefused(await accept(runDir, dispatchResult({ packets: [], notes: "x" })), runDir, [
    'The plan has a field "notes"; its only field is "packets".',
    '"packets" must be a non-empty list of packets.',
  ]);
});

test("a refused plan leaves an earlier packets.json as it was", async () => {
  const { runDir } = brownfieldRun();
  writeFileSync(join(runDir, "packets.json"), "[]\n");
  const r = await accept(runDir, dispatchResult(wrapped(8)));
  assert.equal(r.code, 1);
  assert.equal(readFileSync(join(runDir, "packets.json"), "utf8"), "[]\n");
});

// ── the planner packet ──────────────────────────────────────────────────────

function writeConductorFiles(runDir, inputs) {
  writeFileSync(join(runDir, "plan-instruction.md"), "Plan the /login fix: src/auth.js, src/index.js, and a regression test in src/auth.spec.js.\n");
  writeFileSync(join(runDir, "plan-inputs.json"), JSON.stringify(inputs));
  return ["--build", `--run-dir=${runDir}`, `--instruction=${join(runDir, "plan-instruction.md")}`, `--inputs=${join(runDir, "plan-inputs.json")}`];
}

test("--build writes the planner's packet with the shipped schema, the run's id and intent, and the plan rules", async () => {
  const { root, runDir } = brownfieldRun();
  const argv = writeConductorFiles(runDir, [
    { path: `.sdlc/runs/${RUN_ID}/requirements.md`, reason: "Approved requirements." },
    { path: join(root, "src", "auth.js"), reason: "The bug." },
  ]);
  const r = await run(argv);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `packet: ${join(runDir, "tp-plan-001.json")}\nresult: ${join(runDir, "tp-plan-001-result.json")}\nattempt: 1 of 3\n`);
  const p = JSON.parse(readFileSync(join(runDir, "tp-plan-001.json"), "utf8"));
  assert.equal(p.id, "tp_plan_001");
  assert.equal(p.phase, "plan_task_packets");
  assert.equal(p.pass_id, RUN_ID);
  assert.equal(p.intent, "bugfix");
  assert.equal(p.retry_count, 0);
  assert.equal(p.artifact_path, `.sdlc/runs/${RUN_ID}/packets.json`);
  assert.deepEqual(p.outputSchema, loadPlanSchema("brownfield"), "the shipped schema, never one the conductor wrote");
  assert.deepEqual(strictSchemaProblems(p.outputSchema), []);
  assert.equal(p.budget.maxOutputTokens, 8000);
  assert.ok(p.budget.maxInputTokens >= 2000 && Number.isInteger(p.budget.maxInputTokens));
  assert.match(p.instruction, /^Plan the \/login fix/);
  assert.match(p.instruction, /## Plan rules/);
  assert.ok(p.instruction.includes("`src/auth.js`, `src/index.js`, `src/auth.spec.js`"), "the frozen allowlist is in the rules");
  assert.ok(p.instruction.includes(`${notes}/`));
  assert.deepEqual(p.inputs.map((i) => i.path), [`.sdlc/runs/${RUN_ID}/requirements.md`, "src/auth.js"], "an absolute path inside the project is made relative");
  assert.equal(p.inputs[1].content, readFileSync(join(root, "src", "auth.js"), "utf8"));
  for (const k of ["id", "phase", "task_type", "module", "instruction", "inputs", "outputSchema", "acceptance", "budget", "pass_id"]) {
    assert.ok(p[k] !== undefined, `the bridge refuses a packet with no ${k}`);
  }

  writeFileSync(join(runDir, "tp-plan-002-result.json"), "{}");
  const again = await run(argv);
  assert.match(again.out, /tp-plan-003\.json/, "each build takes a packet id no packet or result holds");
});

test("--build reads the plugin's stack guide for the planner, and nothing else of the plugin", async () => {
  const { runDir } = brownfieldRun();
  const guide = join(PLUGIN, "skills", "pipeline", "stacks", "generic.md");
  const r = await run(writeConductorFiles(runDir, [{ path: guide, reason: "The stack's placement rules." }]));
  assert.equal(r.code, 0, r.err);
  const p = JSON.parse(readFileSync(join(runDir, "tp-plan-001.json"), "utf8"));
  assert.deepEqual(p.inputs, [{ path: guide, content: readFileSync(guide, "utf8"), reason: "The stack's placement rules." }]);
  const other = await run(writeConductorFiles(runDir, [{ path: join(PLUGIN, "config", "policies", "gpt-plus-flash.yaml"), reason: "r" }]));
  assert.equal(other.code, 2);
  assert.match(other.err, /is outside the project, the run folder and the plugin's stack guides/);
});

test("--build refuses conductor inputs that name an off-limits or outside file, and writes nothing", async () => {
  const { runDir } = brownfieldRun();
  for (const [inputs, want] of [
    [[{ path: ".env", reason: "r" }], 'inputs[0].path ".env" is off-limits'],
    [[{ path: "/etc/hosts", reason: "r" }], 'inputs[0].path "/etc/hosts" is outside the project, the run folder and the plugin\'s stack guides'],
    [[{ path: "src/auth.js" }], 'inputs[0] must be {"path": string, "reason": string}'],
  ]) {
    const r = await run(writeConductorFiles(runDir, inputs));
    assert.equal(r.code, 2, r.err);
    assert.ok(r.err.includes(want), r.err);
    assert.equal(existsSync(join(runDir, "tp-plan-001.json")), false);
  }
});

/** --build as Phase 4 step 3 runs it; `packet` and `result` are the paths it printed. */
async function buildPacket(runDir, previous = null) {
  const argv = writeConductorFiles(runDir, []);
  const r = await run(previous ? [...argv, `--previous=${previous}`] : argv);
  const packet = /^packet: (.*)$/m.exec(r.out)?.[1] ?? null;
  return { ...r, packet, result: /^result: (.*)$/m.exec(r.out)?.[1] ?? null };
}

/** The dispatch of a built packet, its result where --build said, then --accept on it. */
async function answer(built, reply, over = {}) {
  const packet = JSON.parse(readFileSync(built.packet, "utf8"));
  writeFileSync(built.result, JSON.stringify(dispatchResult(reply, { retry: packet.retry_count, taskId: packet.id, ...over })));
  return run(["--accept", built.result, `--run-dir=${dirname(built.packet)}`]);
}

const stopOf = (err) => JSON.parse(err.split("\n").find((l) => l.startsWith("{")));

test("--previous carries the refusal and the refused plan into the next packet, and counts the attempt", async () => {
  const { runDir } = brownfieldRun();
  const first = await buildPacket(runDir);
  assert.match(first.out, /attempt: 1 of 3/);
  const refused = await answer(first, wrapped(8));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /refused \(attempt 1 of 3\)/);
  assert.ok(refused.err.includes(`Next: run the --build command again with --previous='${first.result}' added`));

  const second = await buildPacket(runDir, first.result);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /tp-plan-002\.json\n.*tp-plan-002-result\.json\nattempt: 2 of 3/);
  const p = JSON.parse(readFileSync(second.packet, "utf8"));
  assert.equal(p.id, "tp_plan_002");
  assert.equal(p.retry_count, 1);
  assert.match(p.instruction, /## Your previous plan was refused\n.*\n1\. packets\[0\] has a field "outputSchema"/);
  assert.ok(p.instruction.includes('packets[0].phase "run" is not a phase a planned packet takes.'));
  const plan = p.inputs.find((i) => i.path === `.sdlc/runs/${RUN_ID}/tp-plan-001-result.json`);
  assert.deepEqual(JSON.parse(plan.content), wrapped(8));

  assert.equal((await answer(second, { packets: [child()] })).code, 0);
  const passing = await buildPacket(runDir, second.result);
  assert.equal(passing.code, 2);
  assert.match(passing.err, /holds a plan that passes: run --accept on it/);
});

test("once a plan is refused, the next --build must carry it: no --previous, or an older one, is a usage error", async () => {
  const { runDir } = brownfieldRun();
  const first = await buildPacket(runDir);
  await answer(first, wrapped(3));
  const bare = await buildPacket(runDir);
  assert.equal(bare.code, 2);
  assert.ok(bare.err.includes(`the planner's last plan, ${first.result}, was refused: add --previous='${first.result}'`), bare.err);
  const second = await buildPacket(runDir, first.result);
  await answer(second, wrapped(8));
  const older = await buildPacket(runDir, first.result);
  assert.equal(older.code, 2);
  assert.ok(older.err.includes(`this session's last refused plan is ${second.result}`), older.err);
  assert.deepEqual(readdirSync(runDir).filter((f) => /^tp-plan-\d+\.json$/.test(f)), ["tp-plan-001.json", "tp-plan-002.json"], "neither wrote a packet");
});

test(`a session builds ${PLAN_ATTEMPTS} planner packets at most, however --build is called, then the run stops`, async () => {
  const { runDir } = brownfieldRun();
  let previous = null;
  for (let n = 1; n <= PLAN_ATTEMPTS; n++) {
    const b = await buildPacket(runDir, previous);
    assert.match(b.out, new RegExp(`attempt: ${n} of 3`), b.err);
    const a = await answer(b, wrapped(8));
    assert.match(a.err, new RegExp(`refused \\(attempt ${n} of 3\\)`));
    previous = b.result;
  }
  const last = await run(["--accept", previous, `--run-dir=${runDir}`]);
  assert.equal(last.code, 1);
  assert.match(last.err, /the planner has had its 3 attempts in this session and no plan passed\. Do not dispatch another plan\./);

  for (const r of [await buildPacket(runDir, previous), await buildPacket(runDir)]) {
    assert.equal(r.code, 1, r.err);
    assert.ok(r.err.includes(join(runDir, "stop.json")));
    const stop = stopOf(r.err);
    assert.match(stop.reason, /no plan that passes plan-packets\.mjs in 3 attempts/);
    assert.ok(stop.needs.includes(`--accept='${previous}'`), "it names the refusal to read");
    assert.ok(stop.needs.includes(`edit ${join(runDir, "plan-instruction.md")}`), "it names what the person can change");
    assert.match(stop.needs, /then resume the run: Phase 4 plans again from that file, with 3 new attempts\. A file the job needs outside the frozen allowlist takes a new run/);
  }
  assert.equal(readdirSync(runDir).filter((f) => /^tp-plan-\d+\.json$/.test(f)).length, PLAN_ATTEMPTS, "no fourth packet is built");
  assert.equal(existsSync(join(runDir, "stop.json")), false, "the conductor writes stop.json, not the script");
});

test("a resumed run is a new session: packets an earlier session built do not count, and --previous may carry its last refusal", async () => {
  const { runDir } = brownfieldRun();
  let previous = null;
  for (let n = 1; n <= PLAN_ATTEMPTS; n++) {
    const b = await buildPacket(runDir, previous);
    await answer(b, wrapped(8));
    previous = b.result;
  }
  assert.equal((await buildPacket(runDir, previous)).code, 1);
  const before = new Date(Date.now() - 60_000);
  for (const f of readdirSync(runDir)) utimesSync(join(runDir, f), before, before);
  const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...record, starts: [{ at: new Date(Date.now() - 120_000).toISOString() }, { at: new Date(Date.now() - 30_000).toISOString(), resume: true }] }));

  const fresh = await buildPacket(runDir, previous);
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /tp-plan-004\.json\n.*\nattempt: 1 of 3/);
  assert.match(JSON.parse(readFileSync(fresh.packet, "utf8")).instruction, /## Your previous plan was refused/);
  assert.equal((await answer(fresh, { packets: [child()] })).code, 0);
});

test("the headless session is the latest driver process: a run_end, or another driver pid, starts a new one", () => {
  const start = (at, pid = 7) => ({ v: 1, kind: "invocation_start", at, driver_pid: pid });
  const end = { v: 1, kind: "run_end", at: "2026-10-14T10:38:26.689Z" };
  assert.equal(driverSessionStart([]), 0);
  assert.equal(driverSessionStart([start("2026-10-14T10:12:56.677Z"), start("2026-10-14T10:20:00.000Z")]), Date.parse("2026-10-14T10:12:56.677Z"), "a gate answer or a context re-spawn is the same driver");
  assert.equal(driverSessionStart([start("2026-10-14T10:12:56.677Z"), end]), Date.parse("2026-10-14T10:12:56.677Z"), "an ended driver is still the latest session");
  assert.equal(driverSessionStart([start("2026-10-14T10:12:56.677Z"), end, start("2026-10-14T11:00:00.000Z", 8)]), Date.parse("2026-10-14T11:00:00.000Z"));
  assert.equal(driverSessionStart([start("2026-10-14T10:12:56.677Z", 7), start("2026-10-14T11:00:00.000Z", 9)]), Date.parse("2026-10-14T11:00:00.000Z"), "a driver killed before its run_end");
});

test(`a failed plan dispatch is not an attempt and goes to no planner; failure ${MAX_DISPATCH_FAILURES} stops the run, naming it`, async () => {
  const { runDir } = brownfieldRun();
  const first = await buildPacket(runDir);
  await answer(first, wrapped(8));
  const second = await buildPacket(runDir, first.result);
  const quota = "codex-cli: You've hit your usage limit. Try again later.";
  const failed = await answer(second, null, { success: false, terminal: "vendor_error", error: quota });
  assert.equal(failed.code, 1);
  assert.ok(failed.err.includes(`the plan dispatch in ${second.result} failed (terminal_reason vendor_error): codex-cli: You've hit your usage limit. Try again later. Nothing was written.`), failed.err);
  assert.doesNotMatch(failed.err, /\.\./, "one full stop");
  assert.doesNotMatch(failed.err, /was refused/);
  assert.ok(failed.err.includes(`Next: run the --build command again with --previous='${first.result}'`), "the refusal still goes to the next packet");

  const third = await buildPacket(runDir, first.result);
  assert.match(third.out, /attempt: 2 of 3/, "the failed dispatch did not count");
  assert.doesNotMatch(JSON.parse(readFileSync(third.packet, "utf8")).instruction, /usage limit/, "a vendor error is not the planner's to fix");
  const usedAsPrevious = await buildPacket(runDir, second.result);
  assert.equal(usedAsPrevious.code, 2);
  assert.match(usedAsPrevious.err, /is a dispatch that failed, with no plan in it for the planner to correct/);

  const again = await answer(third, null, { success: false, terminal: "vendor_error", error: quota });
  assert.equal(again.code, 1);
  const stop = stopOf(again.err);
  assert.match(stop.reason, /^Phase 4: the plan dispatch failed 2 times \(terminal_reason vendor_error\): codex-cli: You've hit your usage limit/);
  assert.match(stop.needs, /The planner's model sent no reply: codex-cli: You've hit your usage limit\. Try again later\. Fix what that names/);
  assert.doesNotMatch(stop.needs, /plan-instruction/, "the instruction is not the cause");
  const blocked = await buildPacket(runDir, first.result);
  assert.equal(blocked.code, 1);
  assert.match(stopOf(blocked.err).reason, /the plan dispatch failed 2 times/);
});

test("readRunFacts and buildPlanPacket agree with the CLI for a greenfield run", async () => {
  const { runDir, runId } = greenfieldRun();
  const facts = await readRunFacts(runDir);
  assert.equal(facts.mode, "greenfield");
  assert.equal(facts.contract, null);
  const { packet } = buildPlanPacket(facts, { instruction: "Plan the ping service." });
  assert.equal(packet.pass_id, runId);
  assert.equal("intent" in packet, false);
  assert.equal("artifact_path" in packet, false);
  assert.deepEqual(packet.outputSchema, loadPlanSchema("greenfield"));
  assert.match(packet.instruction, /Generated code goes under `src\/`/);
  assert.deepEqual(judgePlan(facts, dispatchResult({ packets: [child({ task_type: "dto", artifact_path: "src/a.dto.ts", inputs: [] })] }, { pass: runId })).problems, []);
});

// ── the command and the playbook ────────────────────────────────────────────

test("the CLI exits 0, 1 and 2 as a process, with the problems numbered on stderr", () => {
  const { runDir } = brownfieldRun();
  const node = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const good = join(runDir, "good.json");
  const bad = join(runDir, "bad.json");
  writeFileSync(good, JSON.stringify(dispatchResult(validPlan())));
  writeFileSync(bad, JSON.stringify(dispatchResult(wrapped(3))));
  const refused = node([`--accept=${bad}`, `--run-dir=${runDir}`]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^1\. packets\[0\]/m);
  assert.equal(existsSync(join(runDir, "packets.json")), false);
  const ok = node([`--accept=${good}`, `--run-dir=${runDir}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(join(runDir, "packets.json"), "utf8")).length, 4);
  assert.equal(node(["--build", `--accept=${good}`, `--run-dir=${runDir}`]).status, 2);
  assert.equal(node(["--accept", good]).status, 2);
  assert.match(node(["--bogus"]).stderr, /unknown flag --bogus/);
});

/** Phase 4 of the playbook source, up to the next phase. */
function phase4(text) {
  const at = text.indexOf("### Phase 4 — plan_task_packets");
  return text.slice(at, text.indexOf("### Phase 5", at));
}

test("Phase 4 uses only placeholders both start routes render, and only flags the script parses", () => {
  const section = phase4(readFileSync(join(PLUGIN, "skills", "pipeline", "SKILL.md"), "utf8"));
  // The keys start-run.mjs renders the playbooks with; run.mjs renders the same keys and two prompt-only ones.
  const rendered = new Set(["PLUGIN_ROOT", "PROJECT_ROOT", "OUTPUT_DIR", "CODE_DIR", "BRIEF_PATH", "POLICY", "RUN_ID"]);
  const used = [...section.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
  assert.ok(used.includes("OUTPUT_DIR") && used.includes("PLUGIN_ROOT"));
  for (const key of used) assert.ok(rendered.has(key), `{{${key}}} in Phase 4 is not rendered on both routes`);

  const known = new Set([...PLAN_FLAGS.value, ...PLAN_FLAGS.boolean].map((f) => `--${f}`));
  const lines = section.replace(/\\\n\s*/g, " ").split("\n").filter((l) => l.includes("plan-packets.mjs"));
  assert.ok(lines.some((l) => l.includes("--build")) && lines.some((l) => l.includes("--accept=")));
  for (const line of lines) {
    for (const flag of line.match(/--[a-z][a-z-]+/g) ?? []) assert.ok(known.has(flag), `Phase 4 documents ${flag}`);
  }
  assert.match(section, /`--previous='<the result: path>'`/);
  assert.match(section, /\*\*Three attempts at most\.\*\*/);
  assert.equal(PLAN_ATTEMPTS, 3);
  assert.match(section, /`stop\.json`/);
  assert.doesNotMatch(section, /"type":\s*"array"|Run metadata is yours/, "no guidance left that has the conductor write the plan's shape");
});

test("Phase 4 says what a resumed run does, names the run records by the run folder, and scopes the ban to the plan", () => {
  const section = phase4(readFileSync(join(PLUGIN, "skills", "pipeline", "SKILL.md"), "utf8")).replace(/\s+/g, " ");
  const step2 = section.slice(section.indexOf("2. **What the planner reads.**"), section.indexOf("3. **Build the planner's packet.**"));
  for (const record of ["requirements.md", "design.md", "change_plan.md"]) assert.ok(step2.includes(`\`{{OUTPUT_DIR}}/${record}\``), record);
  assert.doesNotMatch(step2, /\.sdlc\/runs\/\{\{RUN_ID\}\}/, "a greenfield --output-dir run keeps its records elsewhere");
  assert.match(section, /On a resumed run that stopped in Phase 4 the file is already there: keep it as it is/);
  assert.match(section, /A resumed run is a new session with three new attempts: start at step 3, adding `--previous='<the last refused result>'`/);
  assert.match(section, /\*\*Exit 1, the dispatch failed\.\*\* The planner sent no reply/);
  assert.match(section, /Phase 5's work on the plan stays yours: copying a packet out of `packets\.json` into its own file/);

  const conductor = readFileSync(join(PLUGIN, "codex", "prompts", "conductor.md"), "utf8").replace(/\s+/g, " ");
  assert.doesNotMatch(conductor, /a child packet or `packets\.json` yourself/, "Phase 5 writes child packets");
  assert.match(conductor, /Copying a packet out of `packets\.json` into its own file to dispatch it, filling its empty inputs, and building a refined packet in Phase 5 stay yours\./);
  assert.doesNotMatch(conductor, /brownfield only — the repo-relative path/, "greenfield packets carry artifact_path too");
});

test("step 2's run records resolve for a greenfield run whose --output-dir is not under .sdlc/runs", async () => {
  const root = tempDir("plan-packets-gf-out-");
  const runId = "gf-20261014-000000";
  const outDir = join(root, "out dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outDir);
  writeFileSync(join(outDir, "design.md"), "# Design\n");
  writeFileSync(join(outDir, "requirements.md"), "# Requirements\n");
  writeFileSync(join(outDir, "run.json"), JSON.stringify({
    schema_version: 1, run_id: runId, route: "interactive", mode: "greenfield", intent: null, project_root: root,
    code_dir: join(root, "src"), brief_path: join(root, "brief.md"),
  }));
  const rendered = tempDir("plan-packets-render-gf-");
  renderSkills(rendered, {
    PLUGIN_ROOT: PLUGIN, PROJECT_ROOT: root, OUTPUT_DIR: outDir, CODE_DIR: join(root, "src"), BRIEF_PATH: join(root, "brief.md"),
    POLICY: "gpt-seat-plus-flash", RUN_ID: runId,
  }, PLUGIN);
  const text = phase4(readFileSync(renderedSkillPath(rendered, "pipeline"), "utf8"));
  const step2 = text.slice(text.indexOf("2. **What the planner reads.**"), text.indexOf("3. **Build the planner's packet.**"));
  const named = [...step2.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1]).filter((p) => p.startsWith(outDir) && existsSync(p));
  assert.deepEqual(named.sort(), [join(outDir, "design.md"), join(outDir, "requirements.md")]);
  writeFileSync(join(outDir, "plan-instruction.md"), "Plan the ping service.\n");
  writeFileSync(join(outDir, "plan-inputs.json"), JSON.stringify(named.map((path) => ({ path, reason: "The run's records." }))));
  const r = await run(["--build", `--run-dir=${outDir}`, `--instruction=${join(outDir, "plan-instruction.md")}`, `--inputs=${join(outDir, "plan-inputs.json")}`]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, "tp-plan-001.json"), "utf8")).inputs.map((i) => i.path).sort(), ["out dir/design.md", "out dir/requirements.md"]);
});

test("the rendered Phase 4 build command builds the planner's packet", () => {
  const { runDir } = brownfieldRun();
  writeFileSync(join(runDir, "plan-instruction.md"), "Plan the /login fix.\n");
  writeFileSync(join(runDir, "plan-inputs.json"), JSON.stringify([{ path: "src/auth.js", reason: "The bug." }]));
  const out = tempDir("plan-packets-render-");
  renderSkills(out, {
    PLUGIN_ROOT: PLUGIN, PROJECT_ROOT: dirname(dirname(dirname(runDir))), OUTPUT_DIR: runDir, CODE_DIR: "/p", BRIEF_PATH: "/p/brief.md",
    POLICY: "gpt-seat-plus-flash", RUN_ID,
  }, PLUGIN);
  const text = phase4(readFileSync(renderedSkillPath(out, "pipeline"), "utf8"));
  const block = /```bash\n\s*(node '[^\n]*plan-packets\.mjs' --build[\s\S]*?)\n\s*```/.exec(text)[1];
  const r = spawnSync("/bin/sh", ["-c", block], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^packet: .*tp-plan-001\.json$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, "tp-plan-001.json"), "utf8")).outputSchema, loadPlanSchema("brownfield"));
});
