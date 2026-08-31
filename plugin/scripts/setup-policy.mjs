#!/usr/bin/env node
/**
 * Setup-time policy chooser. Invoked by the setup shepherd once per project.
 *
 * The console (plugin/policy-console) is a shared install-level static HTML
 * page served by a tiny Node http server — it doesn't know which project
 * launched it. So this script does the coupling: snapshot policies before →
 * launch server + browser → wait for user to save → diff to find the
 * new/modified policy → write its name to the current project's
 * .sdlc/project.json as `default_policy`. Both /mmo:greenfield and /mmo:brownfield
 * read that field via session-hydrate.
 *
 * Flow is hybrid on purpose:
 *   - happy path: user saves, presses Enter, script detects exactly one new file
 *     and uses it silently
 *   - user closes without saving OR saves multiple times: script prints the full
 *     list and asks them to type one name
 *
 * Usage:
 *   node setup-policy.mjs                           # interactive; the shepherd's default call
 *   node setup-policy.mjs --policy=<name>           # scripted; skip browser, just write the name
 *   node setup-policy.mjs --no-browser              # start server, print URL, don't auto-open
 *   node setup-policy.mjs --skip-install            # assume npm install already ran
 *   node setup-policy.mjs --print-only              # print resolved default_policy from project.json; no writes
 *   node setup-policy.mjs --list-json               # enumerate policies as JSON (no writes)
 *   node setup-policy.mjs --check-creds --policy=X  # verify creds for a policy; JSON out
 *   node setup-policy.mjs --guard-active-run        # check .sdlc/local/state.json; JSON out
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { platform } from "node:os";
import { OFF_LIMITS_DEFAULT } from "./lib/off-limits.mjs";

export { OFF_LIMITS_DEFAULT };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const CONSOLE_DIR = join(PLUGIN_ROOT, "policy-console");
// Test-only override. Never set in production; the tests point this at a
// fixture dir so they can exercise malformed YAML without polluting the
// shipped policy set.
const POLICIES_DIR = process.env.SDLC_POLICIES_DIR_FOR_TESTS
  ? resolve(process.env.SDLC_POLICIES_DIR_FOR_TESTS)
  : join(PLUGIN_ROOT, "config", "policies");
const DEFAULT_PORT = 3000;
const PORT_PROBE_MAX = 10;
const SERVER_READY_TIMEOUT_MS = 30_000;
const POLICY_SAVE_TIMEOUT_MS = 10 * 60_000; // 10 minutes to save a policy in the browser
const POLICY_SAVE_DEBOUNCE_MS = 400;         // let a write settle before diffing

function parseArgs(argv) {
  const out = {
    policy: null,
    noBrowser: false,
    skipInstall: false,
    printOnly: false,
    projectRoot: null,
    listJson: false,
    checkCreds: false,
    guardActiveRun: false,
  };
  // Index-based loop so `--policy value` and `--project-root value` (space-separated,
  // two argv tokens) parse the same as the `=` form. Command files historically
  // used the space form; without this, --project-root silently stayed null and
  // resolveProjectRoot() fell back to git-rev-parse-from-cwd — reintroducing
  // the SiteNotes cross-repo bug.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-browser") out.noBrowser = true;
    else if (a === "--skip-install") out.skipInstall = true;
    else if (a === "--print-only") out.printOnly = true;
    else if (a === "--list-json") out.listJson = true;
    else if (a === "--check-creds") out.checkCreds = true;
    else if (a === "--guard-active-run") out.guardActiveRun = true;
    else if (a.startsWith("--policy=")) out.policy = a.slice("--policy=".length);
    else if (a === "--policy") out.policy = argv[++i] ?? null;
    else if (a.startsWith("--project-root=")) out.projectRoot = a.slice("--project-root=".length);
    else if (a === "--project-root") out.projectRoot = argv[++i] ?? null;
  }
  return out;
}

/**
 * Where does `.sdlc/` belong? Preferably the git top-level so teammates who
 * clone the repo inherit the policy choice via the committed `project.json`.
 * But two real cases have no git: a fresh empty greenfield folder before
 * `git init`, and a brownfield project someone cloned then `rm -rf .git`-ed.
 * Both should still work — fall back to cwd. Returns { root, hasGit } so
 * write flows can surface a transparency note when they fell back.
 */
function resolveProjectRoot(explicit) {
  if (explicit) return { root: explicit, hasGit: existsSync(join(explicit, ".git")) };
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0) return { root: r.stdout.trim(), hasGit: true };
  return { root: process.cwd(), hasGit: false };
}

function fail(msg) {
  process.stderr.write(`setup-policy: ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`setup-policy: ${msg}\n`);
}

// ── policy directory helpers ─────────────────────────────────────────

function listPolicies() {
  if (!existsSync(POLICIES_DIR)) return [];
  return readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

function snapshotPolicies() {
  if (!existsSync(POLICIES_DIR)) return new Map();
  const out = new Map();
  for (const f of readdirSync(POLICIES_DIR)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const full = join(POLICIES_DIR, f);
    const st = statSync(full);
    out.set(f, st.mtimeMs);
  }
  return out;
}

function diffPolicies(before) {
  const after = snapshotPolicies();
  const added = [];
  const modified = [];
  for (const [name, mtime] of after) {
    if (!before.has(name)) added.push(name);
    else if (before.get(name) !== mtime) modified.push(name);
  }
  return { added, modified };
}

// ── port + server ────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolvePromise(false); });
    socket.once("error", () => { resolvePromise(true); });
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + PORT_PROBE_MAX; p++) {
    if (await isPortFree(p)) return p;
  }
  fail(`ports ${start}-${start + PORT_PROBE_MAX - 1} all busy — free one and retry.`);
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolvePromise) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => { resolvePromise(false); });
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function openBrowser(url) {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "linux" ? "xdg-open" : null;
  if (!cmd) {
    log(`auto-open not supported on ${p} — open ${url} manually.`);
    return;
  }
  try { spawnSync(cmd, [url], { stdio: "ignore" }); }
  catch { log(`could not auto-open browser; visit ${url} manually.`); }
}

// ── project.json writer ──────────────────────────────────────────────

/**
 * Malformed project.json is fatal, not empty. Silently returning `{}` (as an
 * earlier version did) let the next write overwrite hand-edited custom keys
 * with defaults — destroying user data without a warning. Force the user to
 * fix or delete the file explicitly.
 */
function readProjectJson(sdlcDir) {
  const path = join(sdlcDir, "project.json");
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (err) {
    fail(`${path} is not valid JSON: ${err?.message ?? err}. Fix or delete the file before rerunning.`);
  }
}

function writeProjectJson(sdlcDir, obj) {
  if (!existsSync(sdlcDir)) mkdirSync(sdlcDir, { recursive: true });
  const path = join(sdlcDir, "project.json");
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
  return path;
}

function saveDefaultPolicy(repoRoot, policyName) {
  const sdlcDir = join(repoRoot, ".sdlc");
  const existing = readProjectJson(sdlcDir);
  const merged = {
    // Spread existing FIRST, then override with the fields this call owns.
    // Reversed order (`{schema_version: 2, ...existing}`) let an older v1 file
    // keep its schema_version: 1 forever — the literal was silently discarded.
    ...existing,
    schema_version: 2,
    default_policy: policyName,
    // Only set on first write, or when the current list predates schema_version 2.
    // Users may hand-edit off_limits_default; we don't overwrite it once set.
    off_limits_default: existing.off_limits_default ?? OFF_LIMITS_DEFAULT,
    last_updated_at: new Date().toISOString(),
  };
  const path = writeProjectJson(sdlcDir, merged);
  return path;
}

// ── prompt helpers ───────────────────────────────────────────────────

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolvePromise) => {
    rl.question(question, (ans) => { rl.close(); resolvePromise(ans.trim()); });
  });
}

/**
 * Wait for a save to land in POLICIES_DIR. Resolves with the source that
 * triggered ("watch" | "enter" | "timeout"). Filesystem-signaled by default;
 * Enter is a parallel path for real terminals; timeout is the safety net.
 * The whole reason this exists instead of a plain readline prompt: Claude
 * Code's Bash tool doesn't attach an interactive stdin, so the previous
 * `await prompt("Press Enter…")` blocked forever and the coupling stalled
 * after the browser save landed on disk.
 */
function waitForPolicySave(before, timeoutMs) {
  return new Promise((resolvePromise) => {
    let done = false;
    let watcher = null;
    let rl = null;
    let debounceTimer = null;
    let timeoutTimer = null;

    const finish = (source) => {
      if (done) return;
      done = true;
      if (watcher) try { watcher.close(); } catch { /* already closed */ }
      if (rl) try { rl.close(); } catch { /* already closed */ }
      if (debounceTimer) clearTimeout(debounceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolvePromise(source);
    };

    try {
      watcher = watch(POLICIES_DIR, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const { added, modified } = diffPolicies(before);
          if (added.length + modified.length > 0) finish("watch");
        }, POLICY_SAVE_DEBOUNCE_MS);
      });
      watcher.on("error", () => { /* fall back to enter/timeout */ });
    } catch { /* watch may fail on some FS; the other paths still cover us */ }

    if (process.stdin.isTTY) {
      try {
        rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.on("error", () => {});
        rl.question("(or press Enter to check now): ", () => finish("enter"));
      } catch { /* stdin unavailable */ }
    }

    timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

// ── policy YAML introspection (line-based, avoids a runtime dep) ─────
//
// --list-json / --check-creds need three signals per policy:
//   1. every model's auth.env
//   2. any model uses adapter: antigravity-worker  → requires_vertex_adc
//   3. any model uses adapter: claude-cli          → requires_claude_cli
//
// Bringing in the `yaml` package would work but the plugin cache doesn't
// have a top-level node_modules — only plugin/policy-console does, and only
// after the browser flow runs `npm install` there. Line-scanning stays free
// of that dependency.

function introspectPolicy(name, path) {
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { return { name, error: `read failed: ${e?.message ?? e}` }; }

  if (!/^\s*models\s*:/m.test(text) || !/^\s*-?\s*adapter\s*:/m.test(text)) {
    return { name, error: "not a recognizable policy (missing models: or adapter:)" };
  }

  const adapters = new Set();
  for (const m of text.matchAll(/^\s*adapter\s*:\s*([A-Za-z0-9_.:-]+)/gm)) {
    adapters.add(m[1]);
  }

  // `auth:` appears in two shapes:
  //   auth: { env: GEMINI_API_KEY }
  //   auth:
  //     env: ANTHROPIC_API_KEY
  const envVars = new Set();
  for (const m of text.matchAll(/auth\s*:\s*\{[^}]*\benv\s*:\s*([A-Z0-9_]+)/g)) {
    envVars.add(m[1]);
  }
  for (const m of text.matchAll(/^\s*auth\s*:\s*$\n(?:\s*#.*\n)*\s+env\s*:\s*([A-Z0-9_]+)/gm)) {
    envVars.add(m[1]);
  }

  return {
    name,
    adapters: [...adapters].sort(),
    required_env: [...envVars].sort(),
    requires_vertex_adc: adapters.has("antigravity-worker"),
    requires_claude_cli: adapters.has("claude-cli"),
  };
}

function introspectAllPolicies() {
  if (!existsSync(POLICIES_DIR)) return [];
  const files = readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return files.map((f) => introspectPolicy(f.replace(/\.ya?ml$/, ""), join(POLICIES_DIR, f)));
}

// ── credential probes ────────────────────────────────────────────────

function probeVertexAdc() {
  try {
    const r = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (r.error) return { ok: false, reason: r.error.code === "ENOENT" ? "gcloud not installed" : r.error.message };
    if (r.status !== 0) return { ok: false, reason: (r.stderr || "").trim().split("\n")[0] || `gcloud exit ${r.status}` };
    if (!(r.stdout || "").trim()) return { ok: false, reason: "gcloud returned empty token" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

function probeClaudeCli() {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", stdio: "pipe" });
    if (r.error) return { ok: false, reason: r.error.code === "ENOENT" ? "claude binary not found" : r.error.message };
    if (r.status !== 0) return { ok: false, reason: (r.stderr || "").trim().split("\n")[0] || `claude --version exit ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

function envFix(name) {
  if (name === "ANTHROPIC_API_KEY") return "export ANTHROPIC_API_KEY=sk-ant-...  (get one from console.anthropic.com)";
  if (name === "GEMINI_API_KEY") return "export GEMINI_API_KEY=...  (get one from aistudio.google.com/apikey)";
  return `export ${name}=...`;
}

function checkCredsFor(policyName) {
  const path = join(POLICIES_DIR, policyName + ".yaml");
  if (!existsSync(path)) {
    return { ok: false, missing: [{ kind: "policy", name: policyName, fix: `policy "${policyName}" not found in ${POLICIES_DIR}` }] };
  }
  const info = introspectPolicy(policyName, path);
  if (info.error) {
    return { ok: false, missing: [{ kind: "policy", name: policyName, fix: info.error }] };
  }
  const missing = [];
  for (const envName of info.required_env) {
    if (!process.env[envName]) missing.push({ kind: "env", name: envName, fix: envFix(envName) });
  }
  if (info.requires_vertex_adc) {
    const p = probeVertexAdc();
    if (!p.ok) missing.push({ kind: "vertex_adc", fix: "gcloud auth application-default login", reason: p.reason });
  }
  if (info.requires_claude_cli) {
    const p = probeClaudeCli();
    if (!p.ok) missing.push({ kind: "claude_cli", fix: "install Claude Code CLI and log in with your Max account", reason: p.reason });
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// ── active-run guard ─────────────────────────────────────────────────
//
// A brownfield run mid-flight has a policy pinned into its provenance and
// task packets already dispatched under it. Changing default_policy
// underneath would surface as inconsistent telemetry rows and confused
// resumers, so /mmo:policy change refuses until the run reaches a
// terminal state. session-hydrate.mjs treats `complete`/`aborted` as
// terminal; we accept `completed` and `failed` as well since callers may
// spell it either way.

const TERMINAL_RUN_STATUSES = new Set(["complete", "completed", "aborted", "failed"]);

function checkActiveRun(projectRoot) {
  const path = join(projectRoot, ".sdlc", "local", "state.json");
  if (!existsSync(path)) return { active: false };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { active: false }; }
  if (!parsed || typeof parsed !== "object") return { active: false };
  const status = parsed.status;
  if (!status || TERMINAL_RUN_STATUSES.has(status)) return { active: false };
  return {
    active: true,
    run_id: parsed.run_id ?? null,
    phase: parsed.phase ?? null,
    status,
  };
}

// ── main flows ───────────────────────────────────────────────────────

async function scriptedFlow(policyName, resolved) {
  const existing = listPolicies();
  if (!existing.includes(policyName)) {
    fail(`policy "${policyName}" not found in ${POLICIES_DIR}. Available: ${existing.join(", ")}`);
  }
  if (!resolved.hasGit) noteGitFallback(resolved.root);
  const path = saveDefaultPolicy(resolved.root, policyName);
  log(`wrote default_policy="${policyName}" to ${path}`);
}

async function printOnlyFlow(resolved) {
  const existing = readProjectJson(join(resolved.root, ".sdlc"));
  const name = existing.default_policy ?? null;
  process.stdout.write((name ?? "") + "\n");
}

function noteGitFallback(root) {
  process.stderr.write(
    `setup-policy: not inside a git repository — writing to ${join(root, ".sdlc", "project.json")}. ` +
    `Once you 'git init' and commit .sdlc/project.json, teammates who clone the repo will inherit ` +
    `the policy choice.\n`,
  );
}

async function interactiveFlow(resolved, args) {
  if (!existsSync(CONSOLE_DIR)) {
    fail(`policy console not found at ${CONSOLE_DIR}.`);
  }
  if (!resolved.hasGit) noteGitFallback(resolved.root);

  const before = snapshotPolicies();

  if (!args.skipInstall && !existsSync(join(CONSOLE_DIR, "node_modules"))) {
    log("installing the policy console's one dep (yaml) — first-time only…");
    const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
      cwd: CONSOLE_DIR,
      stdio: "inherit",
    });
    if (install.status !== 0) fail("npm install failed in the policy console.");
  }

  const port = await findFreePort(DEFAULT_PORT);
  log(`starting policy console on http://127.0.0.1:${port} …`);

  const server = spawn("node", ["policy-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: CONSOLE_DIR,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
    detached: false,
  });
  server.on("error", (e) => fail(`could not start dev server: ${e.message}`));

  const cleanup = () => { try { server.kill("SIGTERM"); } catch { /* already dead */ } };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const url = `http://localhost:${port}`;
  const ready = await waitForServer(port, SERVER_READY_TIMEOUT_MS);
  if (!ready) fail(`dev server did not become ready in ${SERVER_READY_TIMEOUT_MS / 1000}s.`);

  if (!args.noBrowser) openBrowser(url);
  else log(`open ${url} in your browser.`);

  process.stderr.write("\n");
  process.stderr.write(`  → Configure your policy in the browser, then click Save.\n`);
  process.stderr.write(`  → The terminal detects your save automatically (no Enter needed).\n`);
  process.stderr.write(`  → To skip (pipelines will fall back to opus-plus-flash), press Ctrl-C.\n\n`);

  // Wait for a save (or Enter in a real TTY, or timeout). fs.watch is the
  // primary path because Claude Code's Bash tool doesn't provide interactive
  // stdin — `await prompt("Press Enter…")` would block forever there, and the
  // whole flow would stall AFTER the browser save landed on disk, leaving
  // `.sdlc/project.json` unwritten.
  const source = await waitForPolicySave(before, POLICY_SAVE_TIMEOUT_MS);
  log(`(save detected via ${source})`);

  const { added, modified } = diffPolicies(before);
  // Strip the .yaml extension — `default_policy` in project.json is a policy
  // *name* (`opus-only`, `opus-plus-flash`), not a filename. Downstream
  // consumers (session-hydrate, MCP policy loader, /mmo:policy print) all
  // treat it as the bare stem; the old single-candidate branch left the
  // extension on, producing `default_policy="foo.yaml"` and 404s downstream.
  const candidates = [...added, ...modified].map((f) => f.replace(/\.ya?ml$/, ""));

  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
    log(`detected saved policy: "${chosen}"`);
  } else if (candidates.length === 0) {
    if (!process.stdin.isTTY) {
      log("no save detected before timeout — nothing written to .sdlc/project.json. Re-run and save a policy in the browser.");
      cleanup();
      return;
    }
    const existing = listPolicies();
    process.stderr.write("\nNo new policy detected.\n");
    process.stderr.write("Available on-disk policies:\n");
    for (const name of existing) process.stderr.write(`  • ${name}\n`);
    const ans = await prompt(
      "\nType a policy name to use as this project's default, or press Enter to skip: ",
    );
    if (!ans) {
      log("skipped — no default_policy written; pipelines will use opus-plus-flash.");
      cleanup();
      return;
    }
    if (!existing.includes(ans)) {
      fail(`policy "${ans}" not found in ${POLICIES_DIR}.`);
    }
    chosen = ans;
  } else {
    // Multiple saves — pick most recent by mtime. Non-TTY sessions (Claude
    // Code Bash) can't answer a picker prompt; the most-recent one is what a
    // user would answer anyway. `candidates` are extension-stripped names, so
    // reconstruct the on-disk filename for statSync.
    const withMtime = candidates.map((name) => ({
      name,
      mtime: statSync(join(POLICIES_DIR, name + ".yaml")).mtimeMs,
    }));
    withMtime.sort((a, b) => b.mtime - a.mtime);
    chosen = withMtime[0].name;
    log(`multiple new/modified policies detected (${candidates.join(", ")}); using most recent: "${chosen}"`);
  }

  const path = saveDefaultPolicy(resolved.root, chosen);
  log(`wrote default_policy="${chosen}" to ${path}`);
  cleanup();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveProjectRoot(args.projectRoot);

  if (args.listJson) {
    process.stdout.write(JSON.stringify(introspectAllPolicies(), null, 2) + "\n");
    return;
  }
  if (args.guardActiveRun) {
    process.stdout.write(JSON.stringify(checkActiveRun(resolved.root)) + "\n");
    return;
  }
  if (args.checkCreds) {
    if (!args.policy) fail("--check-creds requires --policy=<name>");
    process.stdout.write(JSON.stringify(checkCredsFor(args.policy)) + "\n");
    return;
  }
  if (args.printOnly) return printOnlyFlow(resolved);
  if (args.policy) return scriptedFlow(args.policy, resolved);
  return interactiveFlow(resolved, args);
}

main().catch((e) => fail(e?.message ?? String(e)));
