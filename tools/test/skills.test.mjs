/**
 * Guards the two ported pipeline skills.
 *
 * These carry the pipeline's actual definition — phase order, TaskPacket
 * schema, gates, the intent matrix — so the risk in porting them was silent
 * loss: a transformation that reads fine but dropped a phase or a required
 * field. These tests assert the load-bearing content survived, and that the
 * dispatch instructions match the CLI that actually exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(REPO_ROOT, "plugin", "skills");
const PIPELINE = join(SKILLS, "pipeline", "SKILL.md");
const BROWNFIELD = join(SKILLS, "brownfield-guide", "SKILL.md");

const read = (p) => readFileSync(p, "utf-8");

/** The Phase union in model-dispatch/src/types.ts — the contract these describe. */
const PHASES = [
  "requirements_analysis", "architecture_design", "plan_task_packets", "codegen",
  "tests", "docs", "debug", "senior_code_review", "security_review", "refactor",
  "final_report", "discovery", "change_plan",
];

const TASK_PACKET_REQUIRED = [
  "id", "phase", "task_type", "module", "instruction",
  "inputs", "outputSchema", "acceptance", "budget", "pass_id",
];

const INTENTS = ["docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"];

test("both skills exist with valid frontmatter and their original names", () => {
  for (const [path, name] of [[PIPELINE, "pipeline"], [BROWNFIELD, "brownfield-guide"]]) {
    assert.ok(existsSync(path), `${name} skill must ship`);
    const text = read(path);
    assert.ok(text.startsWith("---\n"), "skill must open with YAML frontmatter");
    assert.match(text, new RegExp(`^name: ${name}$`, "m"), "the skill name must not drift in the port");
    assert.match(text, /^description: .+/m, "a skill needs a description to be discoverable");
  }
});

test("the pipeline skill still names every phase in the Phase contract", () => {
  const text = read(PIPELINE);
  for (const phase of PHASES) {
    assert.match(text, new RegExp(phase), `phase '${phase}' was lost in the port`);
  }
});

test("the pipeline skill still documents every required TaskPacket field", () => {
  const text = read(PIPELINE);
  for (const field of TASK_PACKET_REQUIRED) {
    assert.match(text, new RegExp(`\\b${field}\\b`), `TaskPacket field '${field}' was lost`);
  }
});

test("all four HITL gates survived", () => {
  const text = read(PIPELINE);
  for (const n of [1, 2, 3, 4]) {
    assert.match(text, new RegExp(`GATE ${n}|Gate ${n}`), `Gate ${n} was lost`);
  }
});

test("the brownfield guide still covers all seven intents", () => {
  const text = read(BROWNFIELD) + read(PIPELINE);
  for (const intent of INTENTS) {
    assert.match(text, new RegExp(intent), `intent '${intent}' was lost`);
  }
});

test("dispatch instructions name the CLI that actually exists, not an MCP tool call", () => {
  const text = read(PIPELINE);
  assert.match(text, /dispatch\.mjs/, "the conductor must be told to shell out");
  assert.match(text, /--preflight --auth-mode=vendor/, "rule 0's exact invocation must be present");
  // The source told the orchestrator to call these as tools; on codex there
  // is no such binding (verification doc check 4).
  assert.ok(
    !/call\s+`?execute_with_model`?\s+(tool|directly)/i.test(text),
    "no instruction may tell the conductor to call the bridge as a tool",
  );
});

test("dispatch paths are single-quoted — they can contain spaces", () => {
  const text = read(PIPELINE);
  assert.match(text, /node '\{\{PLUGIN_ROOT\}\}\/codex\/dispatch\.mjs'/);
});

test("every placeholder used is one the driver's renderer actually substitutes", () => {
  // renderPrompt throws on an unrendered placeholder, so an invented name
  // here would abort a real run rather than degrade quietly.
  const SUPPORTED = new Set([
    "PLUGIN_ROOT", "PROJECT_ROOT", "OUTPUT_DIR", "CODE_DIR", "BRIEF_PATH", "POLICY", "RUN_ID",
  ]);
  for (const path of [PIPELINE, BROWNFIELD]) {
    for (const match of read(path).matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      assert.ok(SUPPORTED.has(match[1]), `${match[0]} in ${path} is not a placeholder the driver renders`);
    }
  }
});

test("no Claude-specific mechanism survived into either skill", () => {
  for (const path of [PIPELINE, BROWNFIELD]) {
    const text = read(path);
    assert.ok(!/CLAUDE_PLUGIN_ROOT/.test(text), "the Claude path variable must be gone");
    assert.ok(!/\.claude\//.test(text), "no Claude directory reference may remain");
    assert.ok(!/\bAnthropic\b/i.test(text), "D9: no Anthropic reference anywhere");
  }
});

test("the dual vendor/estimated auth split is gone — this port has one mode", () => {
  const text = read(PIPELINE);
  assert.ok(
    !/--auth=estimated|auth_mode.*estimated|estimated mode/i.test(text),
    "D9 removed the in-session estimated mode; instructions offering it would be wrong",
  );
});

test("the skill and the conductor prompt agree on phase numbering", () => {
  // Both are read by the same conductor in the same run. If they disagree,
  // "phase 7" means different things depending on which was read last —
  // the exact ambiguity that produces a packet with the wrong `phase` and
  // therefore the wrong model tier.
  const numbering = (text) => {
    const found = {};
    for (const m of text.matchAll(/^\s*(\d+)\.\s+([a-z_]+)/gm)) found[m[2]] = Number(m[1]);
    return found;
  };
  const skill = numbering(read(PIPELINE));
  const conductor = numbering(
    readFileSync(join(REPO_ROOT, "plugin", "codex", "prompts", "conductor.md"), "utf-8"),
  );

  const shared = Object.keys(conductor).filter((k) => k in skill);
  assert.ok(shared.length >= 6, "expected the two state machines to share most phase names");
  for (const phase of shared) {
    assert.equal(
      conductor[phase], skill[phase],
      `phase '${phase}' is ${conductor[phase]} in conductor.md but ${skill[phase]} in pipeline/SKILL.md`,
    );
  }
});

test("the per-stack guides ship and are non-trivial", () => {
  for (const stack of ["generic", "nest", "python"]) {
    const path = join(SKILLS, "pipeline", "stacks", `${stack}.md`);
    assert.ok(existsSync(path), `${stack} stack guide must ship`);
    assert.ok(read(path).length > 500, `${stack} stack guide looks truncated`);
  }
});

// ─── the 13 command skills ────────────────────────────────────────────
//
// These replace the Claude harness's `plugin/commands/*.md` slash commands.
// Codex's official manual deprecates custom prompts in favour of skills, and
// skills — unlike `~/.codex/prompts/` — ship inside the repo. See
// docs/verification/p1-codex-runtime.md.
//
// Codex namespaces a plugin's skills by the plugin name automatically, so
// `plugin/skills/greenfield` with `name: greenfield` is addressed as
// `$mmo-codex:greenfield`. That was measured, not assumed, and it is why the
// `name:` fields are bare.

/** Skills that open a full SDLC run and must only ever fire when asked for. */
const EXPLICIT_ONLY = [
  "pass", "bugfix", "docs", "test", "refactor", "deps", "feature-new", "feature-extend",
];
/** Entry points general enough to be worth matching implicitly. */
const IMPLICIT_OK = ["greenfield", "brownfield", "setup", "policy", "revert"];
const COMMAND_SKILLS = [...EXPLICIT_ONLY, ...IMPLICIT_OK];

test("every command skill ships with frontmatter whose name matches its directory", () => {
  // The name is the address. A prefix here would render as the redundant
  // `mmo-codex:mmo-greenfield`; a mismatch would make the skill unfindable
  // under the name its own documentation uses.
  for (const name of COMMAND_SKILLS) {
    const path = join(SKILLS, name, "SKILL.md");
    assert.ok(existsSync(path), `${name} skill must ship`);
    const text = read(path);
    assert.ok(text.startsWith("---\n"), `${name}: must open with YAML frontmatter`);
    assert.match(text, new RegExp(`^name: ${name}$`, "m"), `${name}: name must equal the directory`);
  }
});

test("no skill teaches the Claude harness's dead slash-command syntax", () => {
  // `codex exec` does not expand slash commands at all, and the interactive
  // mention syntax is `$name`. Printing `/mmo:brownfield` at a user sends
  // them somewhere that does not exist.
  for (const name of [...COMMAND_SKILLS, "pipeline", "brownfield-guide"]) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    assert.doesNotMatch(text, /\/mmo:/, `${name}: '/mmo:' is Claude Code syntax`);
    // `$mmo-greenfield` (no namespace) was a wrong intermediate guess of mine.
    assert.doesNotMatch(text, /\$mmo-(?!codex:)/, `${name}: mentions must be $mmo-codex:<name>`);
  }
});

test("descriptions are one line and short enough to survive the skill-list budget", () => {
  // Codex caps the initial skill list at 2% of the context window (8,000
  // chars when unknown) and "shortens skill descriptions first" — a
  // truncated description degrades the implicit matching it exists for.
  for (const name of COMMAND_SKILLS) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    const line = text.split("\n").find((l) => l.startsWith("description:"));
    assert.ok(line, `${name}: needs a description`);
    assert.ok(line.length < 320, `${name}: description is ${line.length} chars, too long to survive trimming`);
  }
});

test("full-run entry points cannot fire implicitly; the interactive ones can", () => {
  // A skill that kicks off a multi-phase, billable SDLC run must never
  // trigger because the user happened to say "test" or "docs".
  for (const name of EXPLICIT_ONLY) {
    const path = join(SKILLS, name, "agents", "openai.yaml");
    assert.ok(existsSync(path), `${name}: needs agents/openai.yaml to suppress implicit invocation`);
    assert.match(
      read(path), /allow_implicit_invocation:\s*false/,
      `${name}: must set allow_implicit_invocation: false`,
    );
  }
  for (const name of IMPLICIT_OK) {
    assert.ok(
      !existsSync(join(SKILLS, name, "agents", "openai.yaml")),
      `${name}: is a deliberate entry point and should keep implicit matching`,
    );
  }
});

test("every repo file a command skill points at actually exists", () => {
  // The failure this catches is a skill confidently naming a script that was
  // never ported — the model would follow it and fail mid-run.
  const referenced = /(?:tools|plugin)\/[A-Za-z0-9_./-]+\.(?:mjs|js|md|yaml|json)/g;
  for (const name of COMMAND_SKILLS) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    for (const ref of new Set(text.match(referenced) ?? [])) {
      assert.ok(existsSync(join(REPO_ROOT, ref)), `${name}: references ${ref}, which does not exist`);
    }
  }
});

test("every run.mjs flag a command skill documents is one run.mjs parses", () => {
  // The source's pass.md documented eight flags this driver does not have.
  // Naming a flag that silently does nothing is worse than omitting it.
  const driver = read(join(REPO_ROOT, "plugin", "codex", "run.mjs"));
  // The two reference skills document the flag surface too — the brownfield
  // guide carries the headless invocation, and shipped six flags that never
  // existed until it was checked against the driver.
  for (const name of [...COMMAND_SKILLS, "pipeline", "brownfield-guide"]) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    const runLines = text.split("\n").filter((l) => l.includes("run.mjs"));
    for (const line of runLines) {
      for (const flag of new Set(line.match(/--[a-z][a-z-]+/g) ?? [])) {
        assert.ok(driver.includes(flag), `${name}: documents ${flag}, which run.mjs does not parse`);
      }
    }
  }
});

test("the greenfield skill's inline brief sections match docs/brief-template.md", () => {
  // docs/ is not copied on install, so the greenfield skill carries its own
  // copy of the section set. docs/brief-template.md tells the reader a
  // heading changed in one must be changed in the other; this is what makes
  // that promise true. The requirements and architecture phases parse these
  // headings, so a silent drift misreads every brief written from the doc.
  const headings = (text) =>
    (text.match(/^## .+$/gm) ?? [])
      .map((h) => h.replace(/\s{2,}.*$/, "").trim())        // strip inline notes
      .filter((h) => h !== "## Section set");

  const template = headings(read(join(REPO_ROOT, "docs", "brief-template.md")));
  const inSkill = headings(read(join(SKILLS, "greenfield", "SKILL.md")));

  assert.ok(template.length >= 8, "the template should carry the full section set");
  for (const heading of template) {
    assert.ok(inSkill.includes(heading), `greenfield skill is missing brief section '${heading}'`);
  }
});

test("run.mjs flags are documented in the --name=value form it actually parses", () => {
  // run.mjs's parseArgs splits on the first '=' and nothing else, so a
  // documented `--intent bugfix` sets `intent: true` and drops the value —
  // no error, flag silently ignored. The brownfield guide shipped exactly
  // that until it was checked.
  //
  // Scoped to run.mjs on purpose: verify-setup.mjs and setup-policy.mjs
  // deliberately accept BOTH forms (setup-policy carries a comment about a
  // prompt that used the space form and silently got null), so the same
  // spelling is correct there and wrong here.
  const valueFlags = ["--brief", "--project-root", "--output-dir", "--policy", "--gates",
    "--code-dir", "--run-id", "--mode", "--intent", "--seed", "--codex-bin", "--prompt-file"];

  for (const name of [...COMMAND_SKILLS, "pipeline", "brownfield-guide"]) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    // A run.mjs invocation may continue across backslash-continued lines.
    for (const block of text.split(/\n(?=\S)/).filter((b) => b.includes("run.mjs"))) {
      for (const flag of valueFlags) {
        assert.doesNotMatch(
          block, new RegExp(`\\${flag}\\s+(?!\\\\)[<\\w'"]`),
          `${name}: '${flag} value' is not parsed by run.mjs — write '${flag}=value'`,
        );
      }
    }
  }
});
