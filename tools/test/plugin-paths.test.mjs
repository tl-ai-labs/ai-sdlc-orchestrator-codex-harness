/**
 * The Codex plugin cache holds a copy of ./plugin and nothing else, so an
 * instruction that reaches outside it works from a clone and fails on every
 * installed machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(REPO_ROOT, "plugin");

function filesUnder(dir, ext) {
  const acc = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) acc.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return acc;
}

const INSTRUCTIONS = [
  ...filesUnder(join(PLUGIN, "skills"), ".md"),
  ...filesUnder(join(PLUGIN, "codex", "prompts"), ".md"),
];
// Hook commands run from the plugin cache too, so they get the same check.
const HOOK_CONFIGS = filesUnder(join(PLUGIN, "hooks"), ".json");

// The setup skill names the clone-route wizard on purpose: it is the path for
// a machine with no Codex session yet, which is always a clone.
const ALLOWED_REPO_SCRIPTS = new Set(["plugin/skills/setup/SKILL.md tools/setup.mjs"]);

/** Every way a file under plugin/ can name something outside it. */
function outsideRefs(rel, text) {
  const offenders = [];
  for (const m of new Set(text.match(/(?:\$\{?PLUGIN_ROOT\}?|\{\{PLUGIN_ROOT\}\}|<plugin-root>)\/\.\./g) ?? [])) {
    offenders.push(`${rel}: climbs out of ${m.slice(0, -3)}`);
  }
  for (const m of new Set(text.match(/(?:\.\.\/)+tools\/[\w./-]*/g) ?? [])) {
    offenders.push(`${rel}: names ${m}, outside the plugin`);
  }
  for (const ref of new Set(text.match(/(?<![\w/.-])tools\/[\w./-]+\.mjs/g) ?? [])) {
    if (!ALLOWED_REPO_SCRIPTS.has(`${rel} ${ref}`)) offenders.push(`${rel}: names ${ref}, which an installed plugin does not have`);
  }
  return offenders;
}

test("the outside-the-plugin check catches every spelling of a climb out", () => {
  for (const text of [
    "node tools/report.mjs .sdlc",
    "node ../tools/report.mjs .sdlc",
    "node ../../tools/report.mjs",
    "node '{{PLUGIN_ROOT}}/../tools/report.mjs'",
    "node \"${PLUGIN_ROOT}/../tools/report.mjs\"",
    "node $PLUGIN_ROOT/../scripts/x.mjs",
    "node '<plugin-root>/../tools/report.mjs'",
  ]) {
    assert.notDeepEqual(outsideRefs("x.md", text), [], text);
  }
  for (const text of [
    "node '{{PLUGIN_ROOT}}/scripts/report.mjs' .sdlc",
    "node '<plugin-root>/scripts/report.mjs' '<output_dir>'",
    "node \"${PLUGIN_ROOT}/codex/hooks/write-contract-check.mjs\"",
    "plugin/scripts/lib/actors.mjs",
  ]) {
    assert.deepEqual(outsideRefs("x.md", text), [], text);
  }
});

/** The command strings of a hook config; its `_comment` notes may name repo files. */
function hookCommands(file) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "command" && typeof x === "string") out.push(x);
        else walk(x);
      }
    }
  };
  walk(JSON.parse(readFileSync(file, "utf8")));
  return out;
}

test("no skill, prompt or hook command points at a file outside the plugin", () => {
  const offenders = [];
  for (const file of INSTRUCTIONS) {
    offenders.push(...outsideRefs(relative(REPO_ROOT, file), readFileSync(file, "utf8")));
  }
  let commands = 0;
  for (const file of HOOK_CONFIGS) {
    for (const command of hookCommands(file)) {
      commands++;
      offenders.push(...outsideRefs(relative(REPO_ROOT, file), command));
    }
  }
  assert.ok(commands >= 1, "expected at least one hook command under plugin/hooks");
  assert.deepEqual(offenders, []);
});

test("every {{PLUGIN_ROOT}}/<path> a skill or prompt names exists in the plugin", () => {
  const refs = [];
  for (const file of INSTRUCTIONS) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\{\{PLUGIN_ROOT\}\}\/([^\s'"`)>]+)/g)) refs.push([relative(REPO_ROOT, file), m[1]]);
  }
  // A floor, so a change to the pattern cannot make this pass by matching nothing.
  assert.ok(refs.length >= 30, `expected at least 30 {{PLUGIN_ROOT}} references, found ${refs.length}`);
  const missing = [];
  for (const [rel, ref] of refs) {
    // `config/policies/<resolved-name>.yaml` names a folder of choices; check the folder.
    const segments = ref.replace(/[.,:;]+$/, "").split("/");
    const cut = segments.findIndex((s) => /[<*{]/.test(s));
    const path = join(PLUGIN, ...(cut === -1 ? segments : segments.slice(0, cut)));
    if (!existsSync(path)) missing.push(`${rel}: {{PLUGIN_ROOT}}/${ref}`);
  }
  assert.deepEqual(missing, []);
});

test("every <plugin-root>/<path> a skill or prompt names exists in the plugin", () => {
  const missing = [];
  let count = 0;
  for (const file of INSTRUCTIONS) {
    for (const m of readFileSync(file, "utf8").matchAll(/<plugin-root>\/([^\s'"`)>]+)/g)) {
      count++;
      const segments = m[1].replace(/[.,:;]+$/, "").split("/");
      const cut = segments.findIndex((s) => /[<*{]/.test(s));
      if (!existsSync(join(PLUGIN, ...(cut === -1 ? segments : segments.slice(0, cut))))) {
        missing.push(`${relative(REPO_ROOT, file)}: <plugin-root>/${m[1]}`);
      }
    }
  }
  assert.ok(count >= 2, `expected <plugin-root> references, found ${count}`);
  assert.deepEqual(missing, []);
});

// Codex reads these two skills raw, so they name the plugin folder as
// <plugin-root>; a {{PLUGIN_ROOT}} there would reach the model unrendered.
test("the report the skills name is the one in the plugin", () => {
  assert.ok(existsSync(join(PLUGIN, "scripts", "report.mjs")));
  for (const skill of ["greenfield", "pass"]) {
    const text = readFileSync(join(PLUGIN, "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, /node '<plugin-root>\/scripts\/report\.mjs'/, `${skill}: runs the report from the plugin`);
  }
});
