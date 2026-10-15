#!/usr/bin/env node
/**
 * Chains the bundled MCP server's test suite into the root `npm test`.
 *
 * The root suite needs root `npm ci` (yaml) and the server built once
 * (driver.test imports run.mjs, which imports the server's dist/). The
 * server suite needs the server's own dependencies. When they are missing
 * it says so loudly instead of passing silently.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(ROOT, "plugin", "mcp", "model-dispatch");

if (!existsSync(join(SERVER_DIR, "node_modules"))) {
  console.log(
    "\n! MCP server tests NOT RUN — plugin/mcp/model-dispatch has no installed\n" +
      "  dependencies, so its TypeScript cannot be compiled. Everything above passed.\n" +
      "  To include them:  node plugin/codex/verify-setup.mjs --fix   (then re-run npm test)\n",
  );
  process.exit(0);
}

console.log("\n> MCP server tests (plugin/mcp/model-dispatch)\n");
const result = spawnSync("npm", ["test"], { cwd: SERVER_DIR, stdio: "inherit" });
process.exit(result.status ?? 1);
