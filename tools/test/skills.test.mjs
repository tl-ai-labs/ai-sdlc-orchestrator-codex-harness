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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RENDERED_SKILLS, renderedSkillPath } from "../../plugin/codex/render.mjs";
import { START_FLAGS } from "../../plugin/codex/start-run.mjs";
import { END_FLAGS } from "../../plugin/codex/end-run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(REPO_ROOT, "plugin", "skills");
const PIPELINE = join(SKILLS, "pipeline", "SKILL.md");
const BROWNFIELD = join(SKILLS, "brownfield-guide", "SKILL.md");

const read = (p) => readFileSync(p, "utf-8");
/** The driver itself, not start-run.mjs or end-run.mjs. */
const DRIVER = /(^|[^\w-])run\.mjs/;

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
  for (const path of RENDERED_SKILLS.map(([, rel]) => join(SKILLS, rel))) {
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
    const runLines = text.split("\n").filter((l) => DRIVER.test(l));
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

test("run.mjs flags are documented in the --name=value form", () => {
  // run.mjs accepts both forms, but the skills keep one spelling so a
  // pasted command reads the same everywhere and a value that starts with
  // `--` cannot be mistaken for the next flag.
  const valueFlags = ["--brief", "--project-root", "--output-dir", "--policy", "--gates",
    "--code-dir", "--run-id", "--mode", "--intent", "--seed", "--codex-bin", "--prompt-file"];

  for (const name of [...COMMAND_SKILLS, "pipeline", "brownfield-guide"]) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    // A run.mjs invocation may continue across backslash-continued lines.
    for (const block of text.split(/\n(?=\S)/).filter((b) => DRIVER.test(b))) {
      for (const flag of valueFlags) {
        assert.doesNotMatch(
          block, new RegExp(`\\${flag}\\s+(?!\\\\)[<\\w'"]`),
          `${name}: write '${flag}=value', the form every skill uses`,
        );
      }
    }
  }
});

// ─── the interactive route ────────────────────────────────────────────
//
// Codex hands the model a skill's SKILL.md raw. Only the rendered copies
// start-run.mjs writes into <run folder>/skills/ have real paths in them.

const RENDERED_SOURCES = new Set(RENDERED_SKILLS.map(([, rel]) => join(SKILLS, rel)));
const JOB_ALIASES = ["bugfix", "deps", "docs", "feature-extend", "feature-new", "refactor", "test"];
const RUN_ENTRY_SKILLS = ["greenfield", "brownfield", ...JOB_ALIASES, "pass"];

/** The paragraph after the frontmatter and any title: what a model sees first on opening the raw file. */
function openingParagraph(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s*# .*\n/, "");
  return body.trim().split(/\n\s*\n/)[0];
}

test("a skill holding a placeholder is a rendered playbook, hidden from the model's list, and says to stop when read raw", () => {
  const names = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(names.length >= 15, "expected the full skill set");
  const raw = [];
  for (const name of names) {
    const path = join(SKILLS, name, "SKILL.md");
    if (!existsSync(path) || !/\{\{[A-Z_]+\}\}/.test(read(path))) continue;
    raw.push(name);
    const text = read(path);
    assert.ok(RENDERED_SOURCES.has(path), `${name}/SKILL.md carries placeholders but nothing renders it`);

    const yaml = join(SKILLS, name, "agents", "openai.yaml");
    assert.ok(existsSync(yaml), `${name}: needs agents/openai.yaml so codex keeps it out of the model's skill list`);
    assert.match(read(yaml), /allow_implicit_invocation:\s*false/, `${name}: must set allow_implicit_invocation: false`);

    const guard = openingParagraph(text);
    assert.match(guard, /^\*\*Follow only the rendered copy\.\*\*/, `${name}: the guard must open the file`);
    assert.ok(guard.replace(/\s+/g, " ").includes(`ends in \`/skills/${name}/SKILL.md\``), `${name}: the guard must name the raw file's own path ending`);
    assert.doesNotMatch(guard, /\{\{/, `${name}: the guard must read the same before and after rendering`);
    assert.ok(guard.includes(`.sdlc/runs/<run-id>/skills/${name}.md`), `${name}: the guard must name the rendered copy`);
    const entries = [...guard.matchAll(/`<plugin-root>\/skills\/([a-z-]+)\/SKILL\.md`/g)].map((m) => m[1]);
    assert.ok(entries.length > 0, `${name}: the guard must say which skill to follow instead`);
    for (const entry of entries) {
      assert.ok(RUN_ENTRY_SKILLS.includes(entry), `${name}: the guard points at ${entry}, which does not start a run`);
    }

    const description = text.split("\n").find((l) => l.startsWith("description:"));
    assert.ok(description.includes(`skills/${name}.md`), `${name}: the description must name the rendered copy`);
    assert.match(description, /not runnable as is/, `${name}: the description must say the raw file does not run`);

    const copy = renderedSkillPath("/run", name);
    assert.ok(!copy.endsWith(`/skills/${name}/SKILL.md`), `${name}: the rendered copy must not match the guard's condition`);
  }
  assert.deepEqual(raw.sort(), ["brownfield-guide", "pipeline"]);
});

test("every run entry skill starts the run with the start script and reads only the rendered copies", () => {
  for (const name of RUN_ENTRY_SKILLS) {
    const text = read(join(SKILLS, name, "SKILL.md"));
    assert.match(text, /node '<plugin-root>\/codex\/start-run\.mjs' --mode=/, `${name}: must run the start script`);
    assert.ok(text.includes(`/skills/${name}/SKILL.md`), `${name}: must say how to find the plugin root from its own path`);
    assert.match(text, /<run folder>\/skills\/(pipeline|brownfield-guide)\.md/, `${name}: must point at a rendered copy`);
    assert.doesNotMatch(text, /\]\(\.\.\/(pipeline|brownfield-guide)\/SKILL\.md\)/, `${name}: links to a raw playbook`);
  }
});

test("each entry skill starts the run in its own mode, and each job alias with its own intent", () => {
  const startLine = (name) => read(join(SKILLS, name, "SKILL.md")).split("\n").find((l) => l.includes("start-run.mjs' --mode="));
  assert.match(startLine("greenfield"), /--mode=greenfield /);
  assert.doesNotMatch(startLine("brownfield"), /--intent=/, "plain brownfield asks for the job type at step 4a");
  for (const name of JOB_ALIASES) {
    assert.match(startLine(name), new RegExp(`--mode=brownfield --intent=${name}$`), name);
  }
});

test("every start-run.mjs and end-run.mjs flag a skill documents is one the script parses", () => {
  const playbooks = [...RENDERED_SOURCES].filter((p) => p.endsWith("SKILL.md"));
  const files = [...COMMAND_SKILLS.map((n) => join(SKILLS, n, "SKILL.md")), ...playbooks];
  for (const [script, flags] of [["start-run.mjs", START_FLAGS], ["end-run.mjs", END_FLAGS]]) {
    const known = new Set([...flags.value, ...flags.boolean].map((f) => `--${f}`));
    for (const path of files) {
      for (const line of read(path).split("\n").filter((l) => l.includes(`codex/${script}`))) {
        for (const flag of new Set(line.match(/--[a-z][a-z-]+/g) ?? [])) {
          assert.ok(known.has(flag), `${path}: documents ${flag} for ${script}, which it does not parse`);
        }
      }
    }
  }
});
