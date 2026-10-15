import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_ID, PLUGIN_ROOT, hookArgs, pluginHookKeys, pluginHooks, pluginHooksOffConfig, sessionHookCommands, sessionHookConfig,
} from "../../plugin/codex/hook-wiring.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_KEY = "mmo-codex@tilicho-ai-labs:hooks/hooks.json:pre_tool_use:0:0";

function fixturePlugin(hooks) {
  const dir = mkdtempSync(join(tmpdir(), "hook-wiring-"));
  mkdirSync(join(dir, "hooks"));
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }));
  return dir;
}

test("PLUGIN_ID is the plugin's name at the marketplace's name", () => {
  const name = JSON.parse(readFileSync(join(REPO_ROOT, "plugin", ".codex-plugin", "plugin.json"), "utf8")).name;
  const market = JSON.parse(readFileSync(join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), "utf8")).name;
  assert.equal(PLUGIN_ID, `${name}@${market}`);
  assert.equal(PLUGIN_ROOT, join(REPO_ROOT, "plugin"));
});

test("the shipped hooks have one trust key", () => {
  assert.deepEqual(pluginHookKeys(pluginHooks()), [SHIPPED_KEY]);
});

test("trust keys count groups and handlers from zero", () => {
  const cmd = { type: "command", command: "node x" };
  const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [cmd] }, { matcher: "apply_patch", hooks: [cmd, cmd] }] };
  assert.deepEqual(pluginHookKeys(hooks, "p@m"), [
    "p@m:hooks/hooks.json:pre_tool_use:0:0", "p@m:hooks/hooks.json:pre_tool_use:1:0", "p@m:hooks/hooks.json:pre_tool_use:1:1",
  ]);
});

test("a hooks.json event run.mjs does not wire is refused", () => {
  const dir = fixturePlugin({ PreToolUse: [], PostToolUse: [{ matcher: "Bash", hooks: [] }] });
  try {
    assert.throws(() => pluginHooks(dir), /PostToolUse/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the session wiring fills the plugin root, quoted, and marks the hook as wired by run.mjs", () => {
  const config = sessionHookConfig(pluginHooks(), "/a b/plugin");
  assert.equal(
    config,
    'hooks.PreToolUse=[{matcher="apply_patch|Bash",hooks=[{type="command",command="node \\"/a b/plugin/codex/hooks/write-contract-check.mjs\\" --wired-by=run"}]}]',
  );
});

test("a plugin root with shell-special characters stays one literal word", () => {
  const [{ commands }] = sessionHookCommands(pluginHooks(), '/x/$HOME/`id`/"q"');
  assert.equal(commands[0], 'node "/x/\\$HOME/\\`id\\`/\\"q\\"/codex/hooks/write-contract-check.mjs" --wired-by=run');
});

test("the plugin's copy is switched off with an inline table, never a dotted quoted key", () => {
  assert.equal(pluginHooksOffConfig(), `hooks.state={"${SHIPPED_KEY}"={enabled=false}}`);
  assert.ok(!pluginHooksOffConfig().includes('hooks.state."'));
});

test("hookArgs is the argv fragment for exec and exec resume", () => {
  const args = hookArgs(PLUGIN_ROOT);
  assert.deepEqual(args, [
    "-c", "features.hooks=true",
    "-c", sessionHookConfig(pluginHooks(), PLUGIN_ROOT),
    "-c", `hooks.state={"${SHIPPED_KEY}"={enabled=false}}`,
  ]);
  assert.equal(args.length % 2, 0);
  for (let i = 0; i < args.length; i += 2) assert.equal(args[i], "-c");
});

test("the bridge's nested codex exec switches off the same hook entry run.mjs does", async () => {
  const dist = join(REPO_ROOT, "plugin", "mcp", "model-dispatch", "dist", "adapters", "CodexCliAdapter.js");
  const { PLUGIN_HOOKS_OFF_CONFIG } = await import(dist);
  assert.equal(PLUGIN_HOOKS_OFF_CONFIG, pluginHooksOffConfig(), "a changed hooks.json entry needs the bridge's copy changed too");
});
