/**
 * Guards the codex plugin manifest (plugin/.codex-plugin/plugin.json).
 *
 * The schema here is codex's own, verified against the spec shipped in
 * codex's `plugin-creator` system skill and against that skill's validator
 * — NOT assumed to mirror Claude Code's `.claude-plugin/plugin.json`, which
 * it does not (different top-level fields; `mcpServers` may be a path OR an
 * inline object; there is an `interface` block Claude's has no analog for).
 *
 * The path-existence test below exists because codex's own validator passes
 * a manifest whose `skills` / `hooks` / `mcpServers` paths point at nothing
 * — a manifest can be "valid" and still reference a directory that was
 * never shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugin");
const MANIFEST_PATH = join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");

function manifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

test("the codex plugin manifest exists and parses", () => {
  assert.ok(existsSync(MANIFEST_PATH), "plugin/.codex-plugin/plugin.json must ship");
  assert.doesNotThrow(() => manifest());
});

test("manifest carries the required identity fields", () => {
  const m = manifest();
  assert.match(m.name, /^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case per the codex spec");
  assert.match(m.version, /^\d+\.\d+\.\d+/, "version must be semver");
  assert.ok(m.description?.length > 0);
  assert.ok(m.license);
});

test("manifest declares the bundled MCP server with a relative command path", () => {
  const server = manifest().mcpServers?.["model-dispatch"];
  assert.ok(server, "the bundled bridge must be declared");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./mcp/model-dispatch/dist/server.js"]);
});

test("every relative path the manifest references actually exists in the shipped tree", () => {
  // The bug this catches, caught for real during the port: a manifest
  // declaring "skills": "./skills/" while plugin/skills/ had not been
  // ported yet. Codex's own validator passes that manifest happily.
  const m = manifest();
  const referenced = [];
  for (const key of ["skills", "hooks", "apps"]) {
    if (typeof m[key] === "string") referenced.push([key, m[key]]);
  }
  if (typeof m.mcpServers === "string") referenced.push(["mcpServers", m.mcpServers]);
  for (const [name, server] of Object.entries(m.mcpServers ?? {})) {
    if (typeof server === "object" && Array.isArray(server.args)) {
      for (const arg of server.args) {
        if (typeof arg === "string" && arg.startsWith("./")) referenced.push([`mcpServers.${name}.args`, arg]);
      }
    }
  }

  const missing = referenced
    .filter(([, rel]) => !existsSync(join(PLUGIN_ROOT, rel)))
    .map(([key, rel]) => `${key} → ${rel}`);

  // dist/server.js is a build artifact — absent on a fresh clone before
  // `npm run build`, and that is legitimate, so it is exempted here rather
  // than making this test depend on build state.
  const realMissing = missing.filter((entry) => !entry.includes("dist/server.js"));
  assert.deepEqual(realMissing, [], "manifest references paths that do not exist in the shipped tree");
});

test("manifest declares no Anthropic credential (D9)", () => {
  const raw = readFileSync(MANIFEST_PATH, "utf-8");
  assert.ok(!/ANTHROPIC/i.test(raw), "no Anthropic credential may appear anywhere in codex setup");
});

test("manifest's interface block has at most 3 default prompts, per the codex spec", () => {
  const prompts = manifest().interface?.defaultPrompt ?? [];
  assert.ok(prompts.length <= 3, "entries after the first 3 are silently ignored by codex");
  for (const p of prompts) {
    assert.ok(p.length <= 128, `default prompt over the 128-char cap will be truncated: ${p}`);
  }
});

test("manifest brandColor is a valid hex colour if present", () => {
  const color = manifest().interface?.brandColor;
  if (color) assert.match(color, /^#[0-9A-F]{6}$/i);
});

// ── the marketplace entry ────────────────────────────────────────────
//
// `plugin/.codex-plugin/plugin.json` describes the plugin; it does not make
// it installable. `codex plugin add` resolves plugins through a marketplace,
// and without a marketplace file `codex plugin marketplace add <this repo>`
// fails with "marketplace root does not contain a supported manifest" — so
// the only way to use the harness would be to work inside a clone of it.
// Verified live: with this file present, the plugin installs and all 15
// skills resolve from an unrelated repository.

test("the repo ships a marketplace manifest so it can be installed as a plugin", () => {
  const path = join(REPO_ROOT, ".agents", "plugins", "marketplace.json");
  assert.ok(existsSync(path), "codex plugin add needs a marketplace to resolve through");
  const mkt = JSON.parse(readFileSync(path, "utf-8"));
  assert.ok(mkt.name, "the marketplace needs a name — it is half of PLUGIN@MARKETPLACE");
  assert.ok(Array.isArray(mkt.plugins) && mkt.plugins.length > 0);
});

test("the marketplace entry points at the real plugin directory and agrees with its manifest", () => {
  const mkt = JSON.parse(
    readFileSync(join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), "utf-8"),
  );
  const pluginName = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")).name;
  const entry = mkt.plugins.find((p) => p.name === pluginName);
  assert.ok(entry, `marketplace must list '${pluginName}', the name in plugin.json`);

  // A path that does not resolve installs an empty plugin with no error.
  const rel = typeof entry.source === "string" ? entry.source : entry.source.path;
  assert.ok(rel.startsWith("./"), "source.path must be relative to the marketplace root");
  assert.ok(
    existsSync(join(REPO_ROOT, rel, ".codex-plugin", "plugin.json")),
    `${rel} must contain the plugin manifest`,
  );
});

test("the marketplace file is not swept up by the .agents/ gitignore", () => {
  // .agents/skills/ is generated and ignored; this sibling is a source file.
  // Ignoring all of .agents/ would leave a clone with no way to install.
  const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8");
  assert.doesNotMatch(
    ignore, /^\/?\.agents\/\s*$/m,
    "ignoring all of .agents/ would drop the committed marketplace manifest",
  );
  assert.match(ignore, /\.agents\/skills\//, "the generated skills links should still be ignored");
});
