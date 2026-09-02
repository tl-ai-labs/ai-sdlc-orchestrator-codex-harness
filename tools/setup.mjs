#!/usr/bin/env node
/**
 * Clone-route setup wizard. Checks Node / codex CLI / credentials, builds the
 * bundled MCP server, optionally builds the Python agent worker, and registers
 * the bridge with codex.
 *
 * REBUILT for codex. What changed from the Claude harness's version, and why:
 *
 *   - The `claude` binary probe becomes a codex probe that also asserts the
 *     version pin — codex is definitionally already present (it is how you got
 *     here), so "is it installed" matters less than "is it new enough", which
 *     every capability finding in docs/verification/p1-codex-runtime.md is
 *     gated on.
 *   - ANTHROPIC_API_KEY reporting is gone entirely (D9) and OPENAI_API_KEY
 *     takes its place — as a hard requirement rather than a soft one, since
 *     no in-session mode covers the judgment tier here.
 *   - The final step no longer copies `.md` files into `./.claude/{commands,
 *     agents}/` and writes `.mcp.json`. Codex has no equivalent per-project
 *     discovery directory; the bridge is registered with `codex mcp add`
 *     instead, and the conductor prompt is passed to `codex exec` by the
 *     driver at run time rather than installed anywhere.
 *
 * Shares its credential logic with plugin/codex/verify-setup.mjs by import,
 * exactly as the source shares with its own verify-setup — one copy, not two.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  buildWorkerEnvironment,
  workerPaths,
  vertexCredentialState,
  inspectCredentialFile,
  probeCodexCli,
  probeCodexLogin,
  meetsMinVersion,
  mcpPaths,
  MIN_CODEX_VERSION,
  AGENT_WORKER_SELECT,
} from "../plugin/codex/verify-setup.mjs";
import { writeMmoSelectFile } from "../plugin/codex/mmoSelect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PLUGIN_ROOT = join(ROOT, "plugin");

// Duplicated with verify-setup.mjs's adcPath and the server's defaultAdcPath
// (three package roots that cannot import each other). Sync by hand.
const ADC_FILE = join(homedir(), ".config", "gcloud", "application_default_credentials.json");

// ─── small helpers ────────────────────────────────────────────────────
const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const ok = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.log(`  ${c.amber}!${c.reset} ${m}`);
const fail = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
let stepNo = 0;
const step = (m) => console.log(`\n${c.bold}[${++stepNo}]${c.reset} ${m}`);
const hint = (m) => console.log(`  ${c.dim}${m}${c.reset}`);

// Non-interactive runs (CI, a piped shell) must not hang on a prompt that
// nobody will answer. Every question falls through to its documented default.
const INTERACTIVE = input.isTTY === true;
const rl = INTERACTIVE ? createInterface({ input, output }) : null;

async function askYesNo(q, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  if (!INTERACTIVE) {
    console.log(`  ${c.dim}?${c.reset} ${q} ${suffix} ${c.dim}→ ${defaultYes ? "yes" : "no"} (non-interactive)${c.reset}`);
    return defaultYes;
  }
  const a = (await rl.question(`  ${c.dim}?${c.reset} ${q} ${suffix} `)).trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

// ─── main flow ────────────────────────────────────────────────────────
console.log(`\n${c.bold}AI-SDLC orchestrator (codex harness) — setup${c.reset}`);
console.log(`${c.dim}Checks prerequisites and prepares this machine to run the pipeline.${c.reset}`);

let blocked = false;

// [1] Node
step("Node.js version");
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor >= 20) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} — this repo needs Node 20 or newer.`);
  hint("Install the latest LTS from https://nodejs.org, or via nvm: nvm install --lts");
  process.exit(1);
}

// [2] codex CLI + version pin + login
step("Codex CLI");
const cli = probeCodexCli();
if (!cli.present) {
  fail("codex not found on PATH.");
  hint("npm install -g @openai/codex, then re-run this wizard.");
  blocked = true;
} else if (!meetsMinVersion(cli.version, MIN_CODEX_VERSION)) {
  fail(`codex ${cli.version?.join(".") ?? "unknown"} — this harness is verified against ${MIN_CODEX_VERSION.join(".")} or newer.`);
  hint("npm install -g @openai/codex@latest");
  blocked = true;
} else {
  ok(`codex ${cli.version.join(".")}`);
  const login = probeCodexLogin();
  if (login.loggedIn) {
    // Never prints the token or reads auth.json — status probe only (D7).
    ok(login.detail || "logged in");
  } else {
    fail("codex is not logged in — the driver leg cannot authenticate.");
    hint("Run `codex login`, then re-run this wizard.");
    blocked = true;
  }
}

// [3] Credentials
step("Credentials");
const env = process.env;

if (env.OPENAI_API_KEY) {
  ok("OPENAI_API_KEY is set — the judgment tier can dispatch.");
} else {
  fail("OPENAI_API_KEY is not set.");
  hint("Every judgment phase (requirements, design, planning, both reviews) dispatches through it.");
  hint("There is no in-session fallback: without it, preflight halts every run.");
  hint("Get a key at https://platform.openai.com/api-keys and export it.");
  blocked = true;
}

const vertex = vertexCredentialState({
  env,
  serviceAccountFile: env.GOOGLE_APPLICATION_CREDENTIALS
    ? inspectCredentialFile(env.GOOGLE_APPLICATION_CREDENTIALS)
    : null,
  adcFile: inspectCredentialFile(ADC_FILE),
});

if (env.GEMINI_API_KEY) {
  ok("GEMINI_API_KEY is set — the mechanical tier reaches Gemini via AI Studio.");
} else if (vertex.state === "credential") {
  ok(`Vertex credential found (${vertex.source}) — the mechanical tier reaches Gemini via Vertex.`);
  hint("Note: this proves a credential exists, not that the project is entitled to the pinned model.");
  hint("Settle that for about 2¢ before a real run: node plugin/scripts/probe-agent-worker.mjs");
} else if (vertex.state === "broken") {
  fail(`A Google credential is configured but unusable: ${vertex.detail}`);
  hint("Every Gemini dispatch would fail at the moment it tries to sign.");
  blocked = true;
} else if (vertex.state === "project-only") {
  warn(`GOOGLE_CLOUD_PROJECT is set to '${env.GOOGLE_CLOUD_PROJECT}' but no credential was found.`);
  hint("A project ID says where to bill, not who is asking. Fine inside Google Cloud; a dead end elsewhere.");
} else {
  warn("No Gemini credentials found — mechanical phases would abort at the first dispatch.");
  hint("Either: gcloud auth application-default login   (Vertex)");
  hint("Or:     export GEMINI_API_KEY=…                 (AI Studio, https://aistudio.google.com/app/apikey)");
}

// [4] Mechanical tier door
step("How the mechanical tier reaches Gemini");
hint("Two doors to the same model:");
hint("  model path — one completion call per packet. Cheap, predictable. The default.");
hint("  agent path — an Antigravity SDK session with tools and a working directory. Costlier");
hint("               per packet; it reads and edits the workspace itself.");
const wantAgent =
  vertex.state === "credential" &&
  (await askYesNo("Use the agent path for mechanical work?", false));

if (wantAgent) {
  const path = writeMmoSelectFile(ROOT, AGENT_WORKER_SELECT);
  ok(`Agent path selected (MMO_SELECT=${AGENT_WORKER_SELECT}) — written to ${path}`);
} else {
  ok("Model path (the default). Nothing to configure.");
  if (vertex.state !== "credential") {
    hint("The agent path is Vertex-ADC-only, so it is not offered without a Vertex credential.");
  }
}

// [5] Build the bridge
step("Bundled MCP server");
const { serverDir, distEntry, nodeModules } = mcpPaths(PLUGIN_ROOT);
if (existsSync(distEntry) && existsSync(nodeModules)) {
  ok("Already installed and built.");
} else if (await askYesNo("Install dependencies and build the bridge now?", true)) {
  for (const [label, args] of [["installing dependencies", ["ci"]], ["building", ["run", "build"]]]) {
    process.stdout.write(`  ${c.dim}→ ${label}…${c.reset}\n`);
    const r = run("npm", args, serverDir);
    if (r.status !== 0) {
      fail(`${label} failed:\n${(r.stderr || r.stdout || "").trim()}`);
      blocked = true;
      break;
    }
  }
  if (existsSync(distEntry)) ok("Built.");
} else {
  warn("Skipped — the bridge cannot dispatch until it is built.");
  blocked = true;
}

// [6] Agent worker Python env — conditional
if (wantAgent) {
  step("Antigravity agent worker (Python)");
  const { venvPython } = workerPaths(PLUGIN_ROOT);
  if (existsSync(venvPython)) {
    ok("Python environment already present.");
  } else if (await askYesNo("Build the worker's Python environment now? (needs Python 3.10+)", true)) {
    const built = buildWorkerEnvironment(PLUGIN_ROOT, (m) => console.log(m));
    if (built.ok) ok(`Built with ${built.detail}`);
    else {
      fail(built.detail);
      blocked = true;
    }
  } else {
    warn("Skipped — mechanical packets would fail until it exists.");
  }
}

// [7] Register the bridge with codex
step("Register the bridge with codex");
hint("This makes the server visible to `codex mcp list` / `codex mcp get`.");
hint("The driver spawns the bridge itself at dispatch time, so registration is for");
hint("inspection and forward-compatibility rather than something a run depends on.");
if (cli.present && (await askYesNo("Register `model-dispatch` with codex now?", true))) {
  const existing = run("codex", ["mcp", "get", "model-dispatch"]);
  if (existing.status === 0) {
    ok("Already registered.");
  } else {
    const r = run("codex", ["mcp", "add", "model-dispatch", "--", "node", distEntry]);
    if (r.status === 0) ok("Registered.");
    else {
      warn(`Could not register: ${(r.stderr || r.stdout || "").trim()}`);
      hint("Not fatal — the driver does not depend on it.");
    }
  }
} else if (!cli.present) {
  warn("Skipped — codex is not on PATH.");
}

// ─── closing ──────────────────────────────────────────────────────────
console.log("");
if (blocked) {
  console.log(`${c.bold}Setup incomplete.${c.reset} Resolve the items marked ✗ above, then re-run:`);
  console.log(`  node tools/setup.mjs`);
  console.log(`\nTo re-check without the questions:`);
  console.log(`  node plugin/codex/verify-setup.mjs`);
} else {
  console.log(`${c.bold}Setup complete.${c.reset} Run the pipeline against a brief:\n`);
  console.log(`  node plugin/codex/run.mjs \\`);
  console.log(`    --brief=./brief.md \\`);
  console.log(`    --project-root="$(pwd)" \\`);
  console.log(`    --output-dir="$(pwd)/.sdlc"`);
  console.log(`\n${c.dim}Add --dry-run to see the pinned invocation without spending anything.${c.reset}`);
  console.log(`${c.dim}Re-check this setup any time: node plugin/codex/verify-setup.mjs${c.reset}`);
}

rl?.close();
process.exit(blocked ? 1 : 0);
