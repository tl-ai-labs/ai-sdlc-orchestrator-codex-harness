/**
 * The commands the user-facing docs print must be ones the scripts accept.
 * A doc command that run.mjs refuses (an unknown flag, the shared .sdlc
 * folder, --gates=prompt with no terminal) fails a new user on step one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUN_FLAGS } from "../../plugin/codex/run.mjs";
import { START_FLAGS } from "../../plugin/codex/start-run.mjs";
import { END_FLAGS } from "../../plugin/codex/end-run.mjs";
import { parseCollectorArgs } from "../../plugin/scripts/collect-driver-usage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function mdIn(dir, nested = false) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (nested && e.isDirectory()) return existsSync(join(abs, e.name, "README.md")) ? [join(dir, e.name, "README.md")] : [];
    return !nested && e.isFile() && e.name.endsWith(".md") ? [join(dir, e.name)] : [];
  });
}

const DOCS = [
  "README.md", "SETUP.md", "INSTALL.md", "CONTRIBUTING.md",
  ...mdIn("docs"), ...mdIn("examples", true), ...mdIn(join("plugin", "examples"), true),
].filter((p) => existsSync(join(ROOT, p)));

/** Every shell command in a fenced block, backslash continuations joined, cut at a pipe or `&&`. */
function fencedCommands(text) {
  const out = [];
  for (const m of text.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
    if (m[1].trim() === "mermaid") continue;
    for (const line of m[2].replace(/\\\n\s*/g, " ").split("\n")) out.push(...line.split(/\s(?:\||&&|;)\s/));
  }
  return out;
}

function inlineCommands(text) {
  return [...text.matchAll(/`([^`\n]*\bnode\b[^`\n]*)`/g)].map((m) => m[1]);
}

const commandsOf = (text, { fencedOnly = false } = {}) => [...fencedCommands(text), ...(fencedOnly ? [] : inlineCommands(text))];

/** The part of a command from the script's name on, or null when it does not run that script. */
function invocation(command, script) {
  const re = new RegExp(`(^|[\\s'"/])${script.replace(".", "\\.")}['"]?(\\s|$)`);
  const m = command.match(re);
  return m ? command.slice(m.index + m[0].length - m[2].length) : null;
}

const flagsOf = (args) => [...args.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]);

function scriptCalls(script, opts) {
  const calls = [];
  for (const file of DOCS) {
    for (const command of commandsOf(readFileSync(join(ROOT, file), "utf8"), opts)) {
      const args = invocation(command, script);
      if (args !== null) calls.push({ file, command: command.trim(), args });
    }
  }
  return calls;
}

const known = (flags) => new Set([...flags.value, ...flags.boolean].map((f) => `--${f}`));

test("the docs print run.mjs commands", () => {
  assert.ok(scriptCalls("run.mjs").length >= 10, "expected the docs to carry their run.mjs commands");
});

test("every run.mjs, start-run.mjs and end-run.mjs flag a doc prints is one the script parses", () => {
  const bad = [];
  for (const [script, flags] of [["run.mjs", RUN_FLAGS], ["start-run.mjs", START_FLAGS], ["end-run.mjs", END_FLAGS]]) {
    const ok = known(flags);
    for (const { file, command, args } of scriptCalls(script)) {
      for (const flag of flagsOf(args)) if (!ok.has(flag)) bad.push(`${file}: ${flag} in ${command}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("no doc points run.mjs at the shared .sdlc folder", () => {
  const shared = /--output-dir[= ]["']?(\.\/)?(\$\(pwd\)\/|\$PWD\/)?\.sdlc\/?["']?(\s|$)/;
  const bad = scriptCalls("run.mjs").filter(({ args }) => shared.test(args)).map(({ file, command }) => `${file}: ${command}`);
  assert.deepEqual(bad, []);
});

test("a doc's run.mjs command that spends names its gate mode", () => {
  const bad = scriptCalls("run.mjs", { fencedOnly: true })
    .filter(({ args }) => !/--dry-run|--resume/.test(args) && !/--gates=(prompt|auto-approve|auto-abort)\b/.test(args))
    .map(({ file, command }) => `${file}: ${command}`);
  assert.deepEqual(bad, [], "without --gates, run.mjs asks at the terminal and refuses to start without one");
});

/** `node plugin/codex/run.mjs` resolves only from the clone root, and so do the relative paths it is given. */
const fromCloneRoot = (command) => /(^|\s)node\s+plugin\/codex\/run\.mjs(\s|$)/.test(command);
const valueOf = (args, flag) => new RegExp(`(?:^|\\s)--${flag}=(\\S+)`).exec(args)?.[1]?.replace(/^['"]|['"]$/g, "");

test("a doc's run.mjs command run from the clone root does not make the clone its project", () => {
  const cwd = /^(\.\/?|\$\(pwd\)|\$PWD)$/;
  const bad = scriptCalls("run.mjs")
    .filter(({ command, args }) => fromCloneRoot(command) && flagsOf(args).length > 0 && !/--dry-run/.test(args))
    .filter(({ args }) => valueOf(args, "project-root") === undefined || cwd.test(valueOf(args, "project-root")))
    .map(({ file, command }) => `${file}: ${command}`);
  assert.deepEqual(bad, [], "the run would write its code and record into the harness clone");
});

test("a doc's run.mjs command run from the clone root names a brief the clone ships", () => {
  const bad = [];
  for (const { file, command, args } of scriptCalls("run.mjs")) {
    const brief = valueOf(args, "brief");
    if (!fromCloneRoot(command) || !brief || /^(path\/to\/|<|\/|~|\$)/.test(brief)) continue;
    if (!existsSync(join(ROOT, brief))) bad.push(`${file}: ${command}`);
  }
  assert.deepEqual(bad, [], "run.mjs refuses a --brief that does not exist, before it does anything");
});

test("run.mjs value flags in the docs use the --name=value form", () => {
  const bad = [];
  for (const { file, command, args } of scriptCalls("run.mjs")) {
    for (const flag of RUN_FLAGS.value) {
      if (new RegExp(`--${flag}\\s+[^-\\s]`).test(args)) bad.push(`${file}: --${flag} in ${command}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every collect-driver-usage.mjs and report.mjs flag a doc prints is one the script parses", () => {
  const bad = [];
  for (const { file, command, args } of scriptCalls("collect-driver-usage.mjs")) {
    for (const flag of flagsOf(args)) {
      const unknown = [[flag], [`${flag}=x`]].every((extra) => {
        try {
          parseCollectorArgs(["run-dir", ...extra]);
          return false;
        } catch (err) {
          return /unknown flag/.test(err.message);
        }
      });
      if (unknown) bad.push(`${file}: ${flag} in ${command}`);
    }
  }
  for (const { file, command, args } of scriptCalls("report.mjs")) {
    for (const flag of flagsOf(args)) if (!["--markdown", "--json"].includes(flag)) bad.push(`${file}: ${flag} in ${command}`);
  }
  assert.deepEqual(bad, []);
});

test("no doc describes driver behaviour run.mjs no longer has", () => {
  const stale = [/output directory is overwritten/i, /pauses forever/i, /accepts unknown flags/i, /tools\/report\.mjs/];
  const bad = [];
  for (const file of DOCS) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const re of stale) if (re.test(text)) bad.push(`${file}: ${re}`);
  }
  assert.deepEqual(bad, []);
});

test("the headless cost check is linked from the pages a new user reads", () => {
  for (const file of ["README.md", join("docs", "README.md"), join("docs", "running.md"), join("docs", "tutorial-first-run.md")]) {
    assert.match(readFileSync(join(ROOT, file), "utf8"), /headless-runs\.md/, `${relative(ROOT, join(ROOT, file))} should link docs/headless-runs.md`);
  }
});

test("every codex launch on the driver pin that a doc prints has the sandbox dispatch needs", () => {
  const bad = [];
  for (const file of DOCS) {
    const launches = readFileSync(join(ROOT, file), "utf8").matchAll(/\bcodex\s+(?!exec\b)[^`\n|]*?-m\s+gpt-5\.6-terra[^`\n|]*/g);
    for (const [launch] of launches) if (!/(^|\s)-s\s+danger-full-access(\s|$)/.test(launch)) bad.push(`${file}: ${launch.trim()}`);
  }
  assert.deepEqual(bad, [], "under the default or workspace-write sandbox the first dispatch fails with MCP error -32000");
});
