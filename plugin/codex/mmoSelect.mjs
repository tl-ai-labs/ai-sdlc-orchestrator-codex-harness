/**
 * Project-local MMO_SELECT persistence — the codex-native replacement for
 * the source's `.claude/settings.json` + `.mcp.json` round-trip.
 *
 * Why this exists instead of a port: the source's `--enable-agent` writes
 * MMO_SELECT into whichever file Claude Code reads at session start
 * (`.claude/settings.local.json`, or `.mcp.json` when the bundled server was
 * registered the clone-route way) because Claude Code itself is what spawns
 * the MCP server and needs to see the variable in ITS OWN environment.
 * Codex has no equivalent per-project settings file, and more importantly
 * doesn't need one here: the codex driver spawns the bridge itself directly
 * as a subprocess (plugin/mcp/model-dispatch/src/driverClient.ts — the fix
 * for the P3 finding that a model inside `codex exec` cannot call the
 * bridge's tools via function-calling), so the driver can just read this
 * file and fold its value into the `env` it hands `connectBridge()` at
 * dispatch time. No settings file for any host process to have cached.
 *
 * File: <projectRoot>/.sdlc/local/mmo-select.json — same directory
 * convention as write-contract.json (per-run, gitignored local state).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

function selectFilePath(projectRoot) {
  return join(projectRoot, ".sdlc", "local", "mmo-select.json");
}

/**
 * Returns the stored MMO_SELECT spec string, or undefined if no file
 * exists, the file doesn't parse, or it carries no usable value. Fails
 * open like every other check in this harness — a corrupt file must not
 * block a run, only lose the selection it would have carried.
 */
export function readMmoSelectFile(projectRoot) {
  const path = selectFilePath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const spec = parsed?.mmo_select;
    return typeof spec === "string" && spec.trim() ? spec.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the spec, or deletes the file entirely when `spec` is falsy/empty
 * — "empty and absent must behave identically" (the same invariant the
 * source's settings-file version of this enforces). Returns the path
 * written to (even when deleting), for the caller's confirmation message.
 */
export function writeMmoSelectFile(projectRoot, spec) {
  const path = selectFilePath(projectRoot);
  if (!spec || !spec.trim()) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort — an unwritable .sdlc/local/ shouldn't crash the caller;
      // the caller already validated pairs upstream in enableAgentPath.
    }
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mmo_select: spec }, null, 2) + "\n", "utf-8");
  return path;
}
