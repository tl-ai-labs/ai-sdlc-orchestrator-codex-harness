/**
 * Whether the dispatch bridge's dist/ was built from the source beside it.
 * A pull or an edit changes src/ and leaves dist/ as it was, and nothing
 * fails: run.mjs, start-run and every dispatch load the old build. Node
 * only, so it still works when dist/ is the problem.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** A copied tree's files can differ by a few milliseconds; a real edit or pull is later than that. */
export const BUILD_SLACK_MS = 2000;

export function bridgePaths(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "model-dispatch");
  return { serverDir, src: join(serverDir, "src"), dist: join(serverDir, "dist") };
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function sources(dir) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of names) {
    const path = join(dir, d.name);
    if (d.isDirectory()) out.push(...sources(path));
    else if (d.name.endsWith(".ts") && !d.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/**
 * The source files whose built .js is missing or older than they are, or
 * null when the build matches (or there is no build or no source to
 * compare: verify-setup's mcp-build check covers a missing build).
 */
export function staleBridgeBuild(pluginRoot, { slackMs = BUILD_SLACK_MS } = {}) {
  const { serverDir, src, dist } = bridgePaths(pluginRoot);
  if (!existsSync(join(dist, "server.js"))) return null;
  const stale = [];
  for (const file of sources(src)) {
    const built = mtimeMs(join(dist, relative(src, file).replace(/\.ts$/, ".js")));
    const edited = mtimeMs(file);
    if (built === null || (edited !== null && edited > built + slackMs)) stale.push(relative(serverDir, file));
  }
  return stale.length ? { serverDir, files: stale.sort() } : null;
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The command that rebuilds the bridge in place, ready to paste. */
export function rebuildCommand(pluginRoot) {
  return `node ${shq(join(pluginRoot, "codex", "verify-setup.mjs"))} --fix`;
}

export function staleFilesShown(stale) {
  const n = stale.files.length;
  return stale.files.slice(0, 3).join(", ") + (n > 3 ? `, and ${n - 3} more` : "");
}

/** One line naming the stale files and the rebuild, for a start-of-run warning. */
export function staleBuildWarning(stale, pluginRoot) {
  if (!stale) return null;
  const shown = staleFilesShown(stale);
  return (
    `the dispatch bridge's build is older than its source (${shown}), so this run would use the old bridge. ` +
    `Rebuild it with ${rebuildCommand(pluginRoot)}`
  );
}
