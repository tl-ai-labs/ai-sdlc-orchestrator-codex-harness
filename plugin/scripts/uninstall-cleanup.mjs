#!/usr/bin/env node
/**
 * Uninstall cleanup. Removes what this harness dropped on your machine and
 * your project, so removing the plugin leaves no footprint.
 *
 * PORTED from the Claude harness's plugin/scripts/brownfield-cleanup.mjs.
 * Renamed because the footprint is no longer brownfield-only: two of the four
 * artifacts below are created by setup, before any run happens.
 *
 * What this port cleans, and how it differs from the source:
 *
 *   1. `.sdlc/` — the per-project state directory. Carried unchanged; it is
 *      the same directory with the same contents.
 *   2. `.agents/skills/` — NEW here, and the reason a greenfield-only user
 *      now needs this script too. Codex scans `.agents/skills` rather than
 *      the `plugin/skills/` directory the harness ships, so
 *      `verify-setup.mjs --fix` symlinks each shipped skill into the project.
 *      Those links point into a plugin directory that uninstalling deletes,
 *      leaving a directory of dangling symlinks that codex keeps scanning.
 *   3. The `model-dispatch` MCP registration — NEW here. `tools/setup.mjs`
 *      runs `codex mcp add model-dispatch`, which writes into
 *      `~/.codex/config.toml`. That entry outlives the plugin and points at a
 *      `dist/server.js` that will no longer exist.
 *   4. The source also removed an `@.sdlc/CLAUDE-SDLC.md` import line from
 *      `CLAUDE.md`. DROPPED: nothing in this port writes an import line into
 *      `AGENTS.md` or anywhere else, so a cleanup for it would be code
 *      guarding against a state this harness cannot produce. Verified by
 *      grep before removing it, not assumed.
 *
 * Always asks before doing anything destructive.
 *
 * Usage:
 *   node uninstall-cleanup.mjs                # interactive, from cwd
 *   node uninstall-cleanup.mjs --repo /path   # explicit repo root
 *   node uninstall-cleanup.mjs --dry-run      # print, don't touch
 *   node uninstall-cleanup.mjs --yes          # no prompts (careful!)
 *   node uninstall-cleanup.mjs --keep-mcp     # leave the MCP registration
 *
 * Exit codes:
 *   0 — nothing to clean OR cleanup succeeded
 *   1 — cleanup failed OR user aborted
 */

import { existsSync, statSync, rmSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

/** The name tools/setup.mjs registers the bridge under. */
export const MCP_SERVER_NAME = "model-dispatch";

export function findRepoRoot(start = process.cwd(), exists = existsSync) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function parseArgs(argv) {
  const args = { repo: null, dryRun: false, yes: false, keepMcp: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] ?? null;
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
    else if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--keep-mcp") args.keepMcp = true;
  }
  return args;
}

/**
 * Is the bridge currently registered with codex?
 *
 * Uses `--json` and compares names exactly. A substring or `\b`-bounded match
 * over the table output would also match `model-dispatch-legacy`, because
 * `-` is a non-word character — and this answer decides whether the script
 * offers to unregister a server, so matching someone else's would break an
 * unrelated setup.
 */
export function mcpRegistered(run = spawnSync) {
  const r = run("codex", ["mcp", "list", "--json"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return false;
  try {
    const entries = JSON.parse(String(r.stdout ?? "[]"));
    return Array.isArray(entries) && entries.some((e) => e?.name === MCP_SERVER_NAME);
  } catch {
    // Malformed output is not evidence of a registration.
    return false;
  }
}

/**
 * What is present to clean. Split out as a pure-ish survey so the decision
 * can be tested without a real repo or a real codex install.
 */
export function survey(repoRoot, { exists = existsSync, mcp = mcpRegistered } = {}) {
  const sdlcDir = join(repoRoot, ".sdlc");
  // `.agents/skills` only — NOT all of `.agents/`. The sibling
  // `.agents/plugins/marketplace.json` is a committed source file that makes
  // this repo installable; deleting it on uninstall would remove tracked
  // content the user never generated.
  const agentsDir = join(repoRoot, ".agents", "skills");
  const isDir = (p) => {
    try { return exists(p) && statSync(p).isDirectory(); } catch { return false; }
  };
  return {
    sdlcDir,
    agentsDir,
    sdlc: isDir(sdlcDir),
    // Checked with lstat so a directory of dangling symlinks — the exact
    // state an uninstall leaves behind — still counts as present.
    agents: (() => {
      try { return lstatSync(agentsDir).isDirectory(); } catch { return false; }
    })(),
    mcp: mcp(),
  };
}

export function nothingToDo(found) {
  return !found.sdlc && !found.agents && !found.mcp;
}

async function ask(question, defaultYes = false) {
  return await new Promise((r) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (ans) => {
      rl.close();
      const clean = String(ans).trim().toLowerCase();
      r(clean === "" ? defaultYes : clean === "y" || clean === "yes");
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.repo ? resolve(args.repo) : findRepoRoot();

  if (!repoRoot) {
    console.error("uninstall-cleanup: no git repo found from cwd. Pass --repo /path/to/repo.");
    process.exit(1);
  }

  console.log(`uninstall-cleanup: scanning ${repoRoot}`);
  const found = survey(repoRoot);

  if (nothingToDo(found)) {
    console.log("Nothing to clean. No .sdlc/, no .agents/skills/, and no registered model-dispatch server.");
    process.exit(0);
  }

  console.log("");
  console.log("Found the following to clean:");
  if (found.sdlc) {
    console.log(`  • ${found.sdlcDir} (whole directory — per-run records, telemetry, baseline)`);
  }
  if (found.agents) {
    console.log(`  • ${found.agentsDir} (symlinks to the shipped skills, created by verify-setup --fix)`);
  }
  if (found.mcp && !args.keepMcp) {
    console.log(`  • the '${MCP_SERVER_NAME}' MCP server registered in ~/.codex/config.toml`);
  }
  console.log("");

  if (args.dryRun) {
    console.log("--dry-run: exiting without changes.");
    process.exit(0);
  }

  if (found.sdlc) {
    if (!args.yes) {
      console.log("`.sdlc/` may contain committed history (runs, telemetry, ledger).");
      console.log("Commit or stash first if you want to keep it — this is not reversible without git.");
      if (!(await ask("Delete .sdlc/ entirely?", false))) {
        console.log("Aborted at the .sdlc/ prompt.");
        process.exit(1);
      }
    }
    try {
      rmSync(found.sdlcDir, { recursive: true, force: true });
      console.log(`✓ Removed ${found.sdlcDir}`);
    } catch (e) {
      console.error(`✗ Could not remove ${found.sdlcDir}: ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  if (found.agents) {
    // Defaults to yes: these hold no user data — every entry is a symlink to
    // a file the plugin ships — and left behind they dangle.
    if (args.yes || (await ask("Remove .agents/skills/ (skill links, no user data)?", true))) {
      try {
        rmSync(found.agentsDir, { recursive: true, force: true });
        console.log(`✓ Removed ${found.agentsDir}`);
      } catch (e) {
        console.error(`✗ Could not remove ${found.agentsDir}: ${e?.message ?? e}`);
      }
    } else {
      console.log("Keeping .agents/skills/. Its links will dangle once the plugin is gone.");
    }
  }

  if (found.mcp && !args.keepMcp) {
    if (args.yes || (await ask(`Unregister the '${MCP_SERVER_NAME}' MCP server from codex?`, true))) {
      const r = spawnSync("codex", ["mcp", "remove", MCP_SERVER_NAME], { encoding: "utf8" });
      if (r.status === 0) console.log(`✓ Unregistered ${MCP_SERVER_NAME}`);
      else console.error(`✗ Could not unregister: ${(r.stderr || r.stdout || "").trim()}`);
    }
  }

  console.log("");
  console.log("Cleanup complete. To remove the plugin itself:");
  console.log("  codex plugin remove mmo-codex");
  console.log("(or `codex plugin marketplace remove <name>` to also drop the marketplace registration).");
}

// Only run when invoked directly — the exports above are unit-tested.
// fileURLToPath, not `new URL(...).pathname`: the latter is not URL-decoded,
// so a path containing a space arrives as %20 and never matches.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`uninstall-cleanup: ${e?.message ?? e}`);
    process.exit(1);
  });
}
