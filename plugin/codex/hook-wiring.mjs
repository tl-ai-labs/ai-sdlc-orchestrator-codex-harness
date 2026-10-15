/**
 * The write hook's two wirings from one source, plugin/hooks/hooks.json: the plugin's own (interactive sessions, after
 * the person trusts it) and run.mjs's session flags (headless runs, from a clone or an install). With the plugin
 * installed, both would fire on every call, so hookArgs() switches the plugin's copy off for the run.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIRED_BY_RUN_FLAG } from "../scripts/lib/write-guard.mjs";

export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** `<plugin.json name>@<marketplace name>`: the prefix of every trust key Codex saves for this plugin's hooks. */
export const PLUGIN_ID = "mmo-codex@tilicho-ai-labs";
export const PLUGIN_HOOKS_FILE = "hooks/hooks.json";
const PLACEHOLDER = "${PLUGIN_ROOT}";

/** The `hooks` object of hooks.json. Any event but PreToolUse throws: run.mjs wires PreToolUse only. */
export function pluginHooks(pluginRoot = PLUGIN_ROOT) {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, PLUGIN_HOOKS_FILE), "utf8"))?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error(`hook-wiring: ${PLUGIN_HOOKS_FILE} has no hooks object`);
  const other = Object.keys(hooks).filter((e) => e !== "PreToolUse");
  if (other.length) {
    throw new Error(`hook-wiring: ${PLUGIN_HOOKS_FILE} declares ${other.join(", ")}, which run.mjs's session wiring does not carry`);
  }
  return hooks;
}

const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Codex's trust key for each handler: `<plugin id>:hooks/hooks.json:<event_snake>:<group>:<handler>`. */
export function pluginHookKeys(hooks = pluginHooks(), pluginId = PLUGIN_ID) {
  const keys = [];
  for (const [event, groups] of Object.entries(hooks)) {
    (groups ?? []).forEach((g, gi) => (g?.hooks ?? []).forEach((_, hi) => keys.push(`${pluginId}:${PLUGIN_HOOKS_FILE}:${snake(event)}:${gi}:${hi}`)));
  }
  return keys;
}

// The placeholder sits inside a double-quoted shell word, so the root is escaped for that context.
const shellDoubleQuoted = (s) => String(s).replace(/[\\"$`]/g, "\\$&");

/** Each PreToolUse group's matcher and commands with the plugin root filled in, marked as wired by run.mjs. */
export function sessionHookCommands(hooks = pluginHooks(), pluginRoot = PLUGIN_ROOT) {
  return (hooks.PreToolUse ?? []).map((g) => ({
    matcher: g.matcher,
    commands: (g.hooks ?? []).map((h) => `${h.command.replaceAll(PLACEHOLDER, shellDoubleQuoted(pluginRoot))} ${WIRED_BY_RUN_FLAG}`),
  }));
}

/** The `-c` value that registers the hooks for one `codex exec` call. Codex fills no placeholder in session hooks. */
export function sessionHookConfig(hooks = pluginHooks(), pluginRoot = PLUGIN_ROOT) {
  const groups = sessionHookCommands(hooks, pluginRoot).map(({ matcher, commands }) =>
    `{matcher=${JSON.stringify(matcher)},hooks=[${commands.map((c) => `{type="command",command=${JSON.stringify(c)}}`).join(",")}]}`);
  return `hooks.PreToolUse=[${groups.join(",")}]`;
}

/**
 * The `-c` value that switches the installed plugin's copy off for one call. An inline table: `-c` splits a dotted key
 * on every dot, the ones inside a quoted segment included, so `hooks.state."<key>".enabled=false` does nothing.
 */
export function pluginHooksOffConfig(keys = pluginHookKeys()) {
  return `hooks.state={${keys.map((k) => `${JSON.stringify(k)}={enabled=false}`).join(",")}}`;
}

/**
 * The argv fragment a headless `codex exec` (and `exec resume`) needs: hooks on even where the person's config turns
 * them off, the session wiring, and the plugin's copy off. run.mjs still passes `--dangerously-bypass-hook-trust`:
 * session hooks are untrusted by default and are otherwise skipped without a word.
 */
export function hookArgs(pluginRoot = PLUGIN_ROOT) {
  const hooks = pluginHooks(pluginRoot);
  return [
    "-c", "features.hooks=true",
    "-c", sessionHookConfig(hooks, pluginRoot),
    "-c", pluginHooksOffConfig(pluginHookKeys(hooks)),
  ];
}
