#!/usr/bin/env node
/**
 * Chains the bundled MCP server's test suite into the root `npm test`.
 *
 * Root suite has no dependencies (a fresh clone can run it). Server tests
 * need TypeScript compilation → require the server's deps installed. Runs
 * the server suite when possible; when not, says so loudly. Never passes
 * silently — that would report green while a whole package went untested.
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
      "  To include them:  npm run verify -- --fix   (then re-run npm test)\n",
  );
  process.exit(0);
}

console.log("\n> MCP server tests (plugin/mcp/model-dispatch)\n");
const result = spawnSync("npm", ["test"], { cwd: SERVER_DIR, stdio: "inherit" });
process.exit(result.status ?? 1);
