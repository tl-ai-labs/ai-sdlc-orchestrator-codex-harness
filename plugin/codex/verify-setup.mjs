#!/usr/bin/env node
/**
 * Offline check + repair for the codex harness install. Proves the bundled
 * MCP server is actually built and reachable, and that the driver's own
 * runtime prerequisites (codex CLI version, login state) are met.
 *
 * REBUILT for codex, not ported, per Document A section 7 — "every probe is
 * Claude-shaped" in the source. Most of the pure decision logic below
 * (credential inspection, MMO_SELECT parsing, agent-worker Python checks)
 * carries verbatim from plugin/scripts/verify-setup.mjs in the Claude
 * harness — none of it has anything to do with which agent is driving.
 * What changed:
 *
 *   - `claude-cli` (binary-on-PATH only) → `codex-cli` (binary present AND
 *     meets the version pin, docs/verification/p1-codex-runtime.md section
 *     8) plus a separate `codex-login` check (auth state) — Claude Code had
 *     no equivalent login-state check here because the source's presence
 *     check was already blocking on the whole harness being unusable
 *     without it; codex's ChatGPT-seat/API-key split means presence and
 *     login are genuinely two different failure modes.
 *   - `anthropic-key` (warning) → `openai-key` (policy-dependent) — D9: no
 *     Anthropic credential anywhere in this harness. This began as an
 *     unconditional blocker, on the reasoning that every judgment-tier
 *     dispatch goes through the openai adapter (Document A section 3) and so
 *     a missing key blocks every policy. `gpt-seat-plus-flash` ended that:
 *     it reaches the same model at the same effort pin through `codex exec`
 *     on a ChatGPT seat and names no `openai` adapter, so it needs no key.
 *     The check now reads the policy that would actually run — blocking when
 *     that policy bills the key, silent when it does not, and a warning when
 *     the policy file cannot be read.
 *   - The MMO_SELECT persistence mechanism (--enable-agent/--disable-agent)
 *     drops the `.claude/settings.json` + `.mcp.json` round-trip entirely.
 *     Codex has no per-project settings file the way Claude Code's
 *     `.claude/settings.local.json` is, and — more importantly — the codex
 *     driver already spawns the bridge itself as a subprocess (P3 finding:
 *     a model inside `codex exec` cannot call the bridge's tools via
 *     function-calling at all), so there is no "settings file Claude Code
 *     reads at session start" for a selection to round-trip through in the
 *     first place. The selection instead lives in one small project-local
 *     file, `.sdlc/local/mmo-select.json`, that the driver reads directly
 *     and folds into the environment it passes when it spawns the bridge —
 *     see plugin/codex/mmoSelect.mjs. This is not a like-for-like port; it
 *     is a genuine simplification the driver-spawns-bridge architecture
 *     makes possible.
 *   - The "a new session is required" warning in the source's next-steps
 *     banner is dropped outright — check 10 in the verification doc found
 *     codex runs every invocation as a fresh process reading config fresh,
 *     the opposite of Claude Code's failure mode here.
 *
 * Usage:
 *   node verify-setup.mjs                  check + report; exit 1 if unusable
 *   node verify-setup.mjs --fix            check, repair, re-check
 *   node verify-setup.mjs --enable-agent   route mechanical tier to the agent
 *                                          and build what it needs (implies --fix)
 *   node verify-setup.mjs --disable-agent  back to the model path
 *   ...--project-root=<path>               override process.cwd()
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { readMmoSelectFile, writeMmoSelectFile } from "./mmoSelect.mjs";
// Imported directly rather than spawned as a subprocess and JSON-merged the
// way the source does it — there, env-checks lived in a package context this
// script could not import from; here they are siblings.
import { runChecks as runEnvChecks, renderText as renderEnvChecks } from "./env-checks.mjs";

// ─── pure helpers ─────────────────────────────────────────────────────

/** Major version from a `process.versions.node` string ("20.11.1" → 20). */
export function nodeMajorFrom(versionString) {
  const major = parseInt(String(versionString).split(".")[0], 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * Path gcloud writes ADC to. Duplicated with `defaultAdcPath` in
 * geminiTransports.ts (this script runs before `npm ci` and cannot import TS).
 * Sync by hand. Carried unchanged from the source — driver-agnostic.
 */
export function adcPath(home = homedir()) {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

/**
 * plugin.json's declared env pass-throughs. Sync by hand with
 * PLUGIN_DECLARED_ENV in model-dispatch/src/env.ts (same pre-`npm ci`
 * constraint as adcPath). No ANTHROPIC_API_KEY (D9); OPENAI_API_KEY added.
 */
export const DECLARED_ENV = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  "MMO_SELECT",
  "GEMINI_WORKER_PYTHON",
  "MMO_LOG_LEVEL",
  "MMO_VERBOSE",
  "MMO_LOG_PREFIX",
];

/** `${NAME}` and nothing else. Anchored so a real value with `$` survives. */
export function isUnexpandedPlaceholder(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(value ?? "").trim());
}

/** Copy of `env` with unusable values dropped. Non-mutating — this script only reports. */
export function usableEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed === "" || isUnexpandedPlaceholder(trimmed)) continue;
    out[key] = value;
  }
  return out;
}

/** Declared variables that reached us as unexpanded placeholders, in declaration order. */
export function unexpandedDeclaredEnv(env = {}) {
  return DECLARED_ENV.filter((name) => isUnexpandedPlaceholder(env[name]));
}

/**
 * Where a variable must be set for the bridge to see it. Codex has no
 * desktop-app-with-no-login-shell problem the way Claude Code's source
 * ENV_ADVICE warned about (codex is CLI-only — always has a login shell) —
 * the real Codex-specific gotcha is `[mcp_servers.model-dispatch.env]` in
 * config.toml, if the server was registered via `codex mcp add`, versus a
 * plain shell export reaching the driver script that spawns the bridge
 * itself directly (which it does — see driverClient.ts).
 */
export const ENV_ADVICE =
  "your shell environment (the codex driver script inherits it directly when it spawns the bridge), " +
  "or the `--env` flags on `codex mcp add` if you registered the server that way";

/**
 * Credential types google-auth accepts in an ADC-shaped JSON file, and the
 * fields each one is useless without. Carried unchanged from the source.
 */
export const CREDENTIAL_REQUIRED_FIELDS = {
  authorized_user: ["client_id", "client_secret", "refresh_token"],
  service_account: ["client_email", "private_key"],
  external_account: ["audience", "subject_token_type", "token_url"],
  impersonated_service_account: ["service_account_impersonation_url", "source_credentials"],
};

/**
 * `usable: false` only when CERTAIN. Carried unchanged from the source —
 * Google credential inspection has nothing to do with which agent drives.
 */
export function inspectCredentialFile(path, { exists = existsSync, read = readFileSync } = {}) {
  if (!path) return { present: false, usable: false, type: null, detail: null };
  if (!exists(path)) {
    return { present: false, usable: false, type: null, detail: `${path} does not exist` };
  }

  let parsed;
  try {
    parsed = JSON.parse(read(path, "utf8"));
  } catch (err) {
    return { present: true, usable: false, type: null, detail: `${path} is not valid JSON (${err.message})` };
  }

  const type = typeof parsed?.type === "string" ? parsed.type.trim() : null;
  if (!type) {
    return {
      present: true,
      usable: false,
      type: null,
      detail: `${path} has no "type" field, so no Google auth library can tell what kind of credential it is`,
    };
  }

  const required = CREDENTIAL_REQUIRED_FIELDS[type];
  if (!required) {
    return { present: true, usable: true, type, detail: `credential type '${type}' is not one this check knows how to verify` };
  }

  const missing = required.filter((field) => !parsed[field]);
  if (missing.length > 0) {
    return {
      present: true,
      usable: false,
      type,
      detail: `${path} is a '${type}' credential but is missing ${missing.join(", ")}`,
    };
  }

  return { present: true, usable: true, type, detail: null };
}

/**
 * Vertex/Gemini credential state in four values. Carried unchanged from the
 * source — Gemini's own credential precedence has nothing to do with the driver.
 */
export function vertexCredentialState({ env = {}, serviceAccountFile = null, adcFile = null } = {}) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (serviceAccountFile?.usable) {
      return { state: "credential", source: "GOOGLE_APPLICATION_CREDENTIALS", detail: serviceAccountFile.detail };
    }
    return {
      state: "broken",
      source: "GOOGLE_APPLICATION_CREDENTIALS",
      detail:
        serviceAccountFile?.detail ??
        `GOOGLE_APPLICATION_CREDENTIALS points at ${env.GOOGLE_APPLICATION_CREDENTIALS}, which cannot be read`,
    };
  }

  if (adcFile?.usable) return { state: "credential", source: "gcloud ADC file", detail: adcFile.detail };
  if (adcFile?.present) return { state: "broken", source: "gcloud ADC file", detail: adcFile.detail };
  if (env.GOOGLE_CLOUD_PROJECT) return { state: "project-only", source: "GOOGLE_CLOUD_PROJECT", detail: null };
  return { state: "none", source: null, detail: null };
}

/** Fallback when a caller only knows "is there an ADC file". */
function assumedVertexState(env, hasAdcFile) {
  return vertexCredentialState({
    env,
    serviceAccountFile: env.GOOGLE_APPLICATION_CREDENTIALS
      ? { present: true, usable: true, type: null, detail: null }
      : null,
    adcFile: { present: hasAdcFile, usable: hasAdcFile, type: null, detail: null },
  });
}

/** Any door into Gemini open. Carried unchanged from the source. */
export function hasGeminiCredentials({ env = {}, vertex = null } = {}) {
  return Boolean(env.GEMINI_API_KEY || vertex?.state === "credential");
}

/** The three paths that decide whether the MCP dispatch path is real. Path unchanged from the source. */
export function mcpPaths(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "model-dispatch");
  return {
    serverDir,
    distEntry: join(serverDir, "dist", "server.js"),
    nodeModules: join(serverDir, "node_modules"),
  };
}

/**
 * Agent leaf id + slot. Sync by hand with gpt-plus-flash.yaml — rename
 * there = rename here, else this check silently stops firing.
 */
export const AGENT_WORKER_MODEL_ID = "flash-agsdk-worker";
export const AGENT_WORKER_SLOT = "gemini-flash";
export const AGENT_WORKER_SELECT = `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`;

/**
 * Mirrors parseSelectOverrides in routing.ts. Carried unchanged from the
 * source — the select-spec grammar is a bridge concern, not a driver one.
 */
export function parseSelectSpec(spec) {
  const pairs = {};
  const invalid = [];
  if (!spec || !String(spec).trim()) return { pairs, invalid };
  for (const part of String(spec).split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      invalid.push(piece);
      continue;
    }
    pairs[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return { pairs, invalid };
}

/** Duplicated from workerProcess.ts's workerVenvPython. Carried unchanged. */
export function workerPaths(pluginRoot) {
  const workerDir = join(pluginRoot, "mcp", "model-dispatch", "worker");
  return {
    workerDir,
    venvPython: join(workerDir, ".venv", "bin", "python"),
    requirements: join(workerDir, "requirements.txt"),
  };
}

/** Has this install selected the agent? Carried unchanged from the source. */
export function selectsAgentWorker(env = {}) {
  const { pairs } = parseSelectSpec(usableEnv(env).MMO_SELECT);
  return Object.values(pairs).includes(AGENT_WORKER_MODEL_ID);
}

/** Blocking finding for a spec the server will refuse to parse. Carried unchanged. */
export function selectSpecProblem(env = {}) {
  const spec = usableEnv(env).MMO_SELECT;
  const { invalid } = parseSelectSpec(spec);
  if (invalid.length === 0) return null;

  const bareLeaf = invalid.includes(AGENT_WORKER_MODEL_ID);
  return {
    id: "select-spec",
    severity: "blocking",
    message:
      `MMO_SELECT is set to '${spec}', which is not a valid selection. ` +
      `Each entry must be spelled 'slot=option'; ${invalid
        .map((p) => `'${p}'`)
        .join(", ")} ${invalid.length === 1 ? "is" : "are"} not.` +
      (bareLeaf
        ? ` '${AGENT_WORKER_MODEL_ID}' is the option, not the whole selection — it needs the slot in front of it.`
        : ""),
    fix:
      `Set it to '${AGENT_WORKER_SELECT}' for the agent path, or remove it for the model path. ` +
      `Re-run this script with --enable-agent to have it written correctly for you.`,
  };
}

/** Only `credential` counts. Carried unchanged from the source. */
export function hasVertexCredentials(vertex = null) {
  return vertex?.state === "credential";
}

// ─── codex-native: driver CLI presence, version pin, login state ───────

/** The pin from docs/verification/p1-codex-runtime.md Document B section 8. */
export const MIN_CODEX_VERSION = [0, 151, 0];

/** "codex-cli 0.151.0" → [0, 151, 0]. Null when the string doesn't parse. */
// ─── skill discoverability ────────────────────────────────────────────
//
// Measured with `codex debug prompt-input`, recorded in
// docs/verification/p1-codex-runtime.md: codex scans `<repo>/.agents/skills`
// but does NOT scan `plugin/skills/`. The manifest's `"skills": "./skills/"`
// is a packaging declaration — it publishes the skills to someone who
// *installs* the plugin, and does nothing for someone working in a clone.
//
// So in a checkout the command surface ($mmo-codex:greenfield and friends)
// is simply absent until `.agents/skills` points at it. Symlinks are the
// mechanism the manual documents ("Codex supports symlinked skill folders
// and follows the symlink target"), and they were confirmed working here on
// WSL over /mnt/c with spaces in the path.
//
// This is a WARNING, not blocking: a headless `run.mjs` invocation renders
// its own copies of the skills it needs into the output directory and never
// consults `.agents/skills`. Only the interactive `$`-invocation surface
// depends on this.

/** Where the skills live, and where codex expects to find them. */
export function skillPaths(pluginRoot, projectRoot) {
  return {
    sourceDir: join(pluginRoot, "skills"),
    linkDir: join(projectRoot, ".agents", "skills"),
  };
}

/**
 * Which shipped skills are reachable by codex's scanner. Split out as a pure
 * function over injectable fs probes so the tests don't need real symlinks —
 * on a Windows checkout without developer mode they cannot be created at all.
 */
export function skillLinkState(
  pluginRoot,
  projectRoot,
  { exists = existsSync, readdir = readdirSync } = {},
) {
  const { sourceDir, linkDir } = skillPaths(pluginRoot, projectRoot);
  if (!exists(sourceDir)) return { shipped: [], linked: [], missing: [] };

  const isSkill = (dir) => exists(join(sourceDir, dir, "SKILL.md"));
  const shipped = readdir(sourceDir).filter(isSkill).sort();
  const linked = shipped.filter((name) => exists(join(linkDir, name, "SKILL.md")));
  return { shipped, linked, missing: shipped.filter((n) => !linked.includes(n)) };
}

/**
 * Create the `.agents/skills/<name>` → `plugin/skills/<name>` links.
 *
 * Relative link targets, so the repo stays movable. Deliberately does NOT
 * fall back to copying when symlinks are unavailable: a copy would go stale
 * the moment a skill is edited, and silently serving a stale workflow is a
 * worse failure than an honest one the operator can see and act on.
 */
export function linkSkills(pluginRoot, projectRoot, log = () => {}) {
  const { sourceDir, linkDir } = skillPaths(pluginRoot, projectRoot);
  const { missing } = skillLinkState(pluginRoot, projectRoot);
  if (missing.length === 0) return true;

  mkdirSync(linkDir, { recursive: true });
  for (const name of missing) {
    const linkPath = join(linkDir, name);
    // Anything already sitting here is broken by definition — `missing` means
    // the skill was NOT reachable through this path. The usual cause is a
    // link left pointing at a plugin directory that an update moved or
    // deleted. Clear it before relinking; skipping instead (the obvious
    // `if (exists) continue`) makes the entry unrepairable and lets --fix
    // report success while changing nothing.
    const existing = lstatSync(linkPath, { throwIfNoEntry: false });
    if (existing) {
      // Only ever remove a symlink. `.agents/skills/` is a directory codex
      // scans, not one this harness owns: a real directory here is somebody
      // else's skill — possibly a half-written one, which is exactly why it
      // has no SKILL.md yet and got reported missing. Deleting it recursively
      // to make room for our link would destroy their work. Report the clash
      // and leave it alone; a name collision needs a human decision.
      if (!existing.isSymbolicLink()) {
        log(
          `  ✗ ${name}: .agents/skills/${name} exists and is not a symlink — ` +
            "leaving it alone. Move or rename it if you want the shipped skill linked here.",
        );
        return false;
      }
      try {
        rmSync(linkPath, { recursive: true, force: true });
      } catch (err) {
        log(`  ✗ could not clear stale skill link ${name}: ${err.message}`);
        return false;
      }
    }
    try {
      symlinkSync(relative(linkDir, join(sourceDir, name)), linkPath, "dir");
      log(`  → linked skill ${name}`);
    } catch (err) {
      log(
        `  ✗ could not link skill ${name}: ${err.message}\n` +
          "    (on Windows this needs Developer Mode or an elevated shell)",
      );
      return false;
    }
  }
  return true;
}

export function parseCodexVersion(versionOutput) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionOutput ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Lexicographic triple comparison — [0,151,0] >= [0,151,0] is true. */
export function meetsMinVersion(version, min) {
  if (!version) return false;
  for (let i = 0; i < min.length; i++) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

/**
 * Probes the `codex` binary directly on PATH — the documented, expected
 * install route (Document B section 2). Deliberately does NOT fall back to
 * `npx @openai/codex`: that can silently trigger a network fetch on a
 * machine without codex installed, which is not offline/free, the standing
 * requirement for every check in this file.
 */
export function probeCodexCli(run = spawnSync) {
  const result = run("codex", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { present: false, version: null };
  }
  return { present: true, version: parseCodexVersion(result.stdout) };
}

/**
 * `codex login status`'s exact wording ("Logged in using ChatGPT" /
 * "Not logged in") per docs/verification/p1-codex-runtime.md checks 2-3.
 * Never reads or prints ~/.codex/auth.json itself (D7) — parses only this
 * command's own output.
 *
 * BOTH streams, deliberately. The verification doc read that line off stdout
 * on the build it was written against; codex-cli 0.152.1 prints it to stderr
 * and leaves stdout empty. Reading stdout alone therefore reported a working
 * ChatGPT seat as logged out — a blocking failure on a healthy install. The
 * wording is what identifies the state, so take it from wherever it lands.
 */
export function probeCodexLogin(run = spawnSync) {
  const result = run("codex", ["login", "status"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return { loggedIn: false, detail: null };
  const out = [result.stdout, result.stderr]
    .map((stream) => String(stream ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return { loggedIn: /logged in/i.test(out) && !/not logged in/i.test(out), detail: out || null };
}

/**
 * The policy run.mjs falls back to when a project has not chosen one. Sync
 * by hand with DEFAULT_POLICY in run.mjs (same pre-`npm ci` constraint as
 * adcPath — this script cannot import the driver's module graph).
 */
export const DEFAULT_POLICY = "gpt-plus-flash";

/** The subscription variant of the default: same models, no metered key. */
export const SEAT_POLICY = "gpt-seat-plus-flash";

/**
 * Adapter ids named by a policy's `models:` block. A regex, not a YAML
 * parse, for the pre-`npm ci` reason above — and all this check needs to
 * know is whether the string `openai` appears as an adapter.
 */
export function policyAdapters(yamlText) {
  return [...String(yamlText ?? "").matchAll(/^\s*adapter:\s*([^\s#]+)/gm)].map((m) => m[1]);
}

/**
 * Which policy this project would actually run, and whether that policy
 * bills OPENAI_API_KEY.
 *
 *   usesOpenAiKey: true   → some tier routes through the `openai` adapter
 *                  false  → none does (gpt-seat-plus-flash reaches the same
 *                           model through `codex exec` on the ChatGPT seat)
 *                  null   → the policy file could not be read, so unknown
 *
 * `selected: false` means there is no .sdlc/project.json yet — the driver
 * would fall back to DEFAULT_POLICY, so that is the one worth checking.
 */
export function observePolicy(pluginRoot, projectRoot = process.cwd(), read = readFileSync) {
  let chosen = null;
  try {
    chosen = JSON.parse(read(join(projectRoot, ".sdlc", "project.json"), "utf8")).default_policy ?? null;
  } catch { /* no project.json, or unreadable — the default is what would run */ }

  const selected = typeof chosen === "string" && chosen.length > 0;
  const name = selected ? chosen : DEFAULT_POLICY;
  const path = join(pluginRoot, "config", "policies", `${name}.yaml`);
  try {
    return { name, selected, path, usesOpenAiKey: policyAdapters(read(path, "utf8")).includes("openai") };
  } catch {
    return { name, selected, path, usesOpenAiKey: null };
  }
}

// ─── decision logic ─────────────────────────────────────────────────────

/**
 * Facts → ordered problem list. Pure. `blocking` fails the exit code;
 * `warning` limits which policies run.
 */
export function evaluate({
  nodeMajor,
  codexCli = { present: false, version: null },
  codexLogin = { loggedIn: false, detail: null },
  hasNodeModules,
  hasDist,
  hasAdcFile = false,
  env = {},
  vertex = null,
  hasGcloud = true,
  agentWorker = null,
  skills = null,
  policy = null,
}) {
  const problems = [];

  if (nodeMajor < 20) {
    problems.push({
      id: "node-version",
      severity: "blocking",
      message: `Node ${nodeMajor || "unknown"} detected; this harness needs Node 20 or newer.`,
      fix: "Install the current LTS from https://nodejs.org (or `nvm install --lts`).",
    });
  }

  if (!codexCli.present) {
    problems.push({
      id: "codex-cli",
      severity: "blocking",
      message: "codex CLI not found on PATH.",
      fix: "npm install -g @openai/codex, then confirm with `codex --version`.",
    });
  } else if (!meetsMinVersion(codexCli.version, MIN_CODEX_VERSION)) {
    problems.push({
      id: "codex-cli",
      severity: "blocking",
      message:
        `codex ${codexCli.version?.join(".") ?? "unknown"} detected; this harness's verification ` +
        `(docs/verification/p1-codex-runtime.md) is pinned to ${MIN_CODEX_VERSION.join(".")} or newer.`,
      fix: "npm install -g @openai/codex@latest (or your install method's equivalent upgrade command).",
    });
  }

  if (codexCli.present && !codexLogin.loggedIn) {
    problems.push({
      id: "codex-login",
      severity: "blocking",
      message: "codex is not logged in — the driver leg has no way to authenticate.",
      fix: "Run `codex login` (ChatGPT seat) or export OPENAI_API_KEY for the CLI's own auth, then re-run this check.",
    });
  }

  if (!hasNodeModules) {
    problems.push({
      id: "mcp-dependencies",
      severity: "blocking",
      message: "The bundled MCP server has no installed dependencies.",
      fix: "Re-run this script with --fix (runs `npm ci` in the server directory).",
    });
  }

  if (skills && skills.missing.length > 0) {
    problems.push({
      id: "skills-discoverable",
      severity: "warning",
      message:
        `${skills.missing.length} of ${skills.shipped.length} shipped skills are not on codex's ` +
        `scan path, so they cannot be invoked as $mmo-codex:<name>: ${skills.missing.join(", ")}. ` +
        "Codex scans .agents/skills, not plugin/skills. Headless `run.mjs` runs are unaffected.",
      fix: "Re-run this script with --fix (symlinks them into .agents/skills/).",
    });
  }

  if (!hasDist) {
    problems.push({
      id: "mcp-build",
      severity: "blocking",
      message:
        "The bundled MCP server is not built — dist/server.js does not exist. " +
        "Model dispatch would fail partway through a run.",
      fix: "Re-run this script with --fix (runs `npm run build` in the server directory).",
    });
  }

  const declaredPlaceholders = unexpandedDeclaredEnv(env);
  const realEnv = usableEnv(env);
  const vertexState = vertex ?? assumedVertexState(realEnv, hasAdcFile);

  const gcloudLogin = hasGcloud
    ? "`gcloud auth application-default login`"
    : "`gcloud auth application-default login` — but gcloud is not on this machine's PATH, " +
      "so install it first: https://cloud.google.com/sdk/docs/install";

  if (declaredPlaceholders.length > 0) {
    problems.push({
      id: "env-placeholders",
      severity: "warning",
      message:
        `${declaredPlaceholders.length} declared environment variable(s) arrived unset and unexpanded ` +
        `(${declaredPlaceholders.join(", ")}). The server strips these at startup and falls back to ` +
        "Application Default Credentials, so this is not itself a failure — but if you meant to set " +
        "any of them, the value is not reaching the bridge.",
      fix: `Set them in ${ENV_ADVICE}.`,
    });
  }

  // D9 left no Anthropic credential here, and this check began life as the
  // unconditional blocker its replacement note described: "every judgment-tier
  // dispatch goes through the openai adapter, so a missing key blocks every
  // policy". That stopped being true when gpt-seat-plus-flash landed — it
  // routes judgment work to the same model, at the same effort pin, through a
  // `codex exec` subprocess on the ChatGPT seat, and names no `openai` adapter
  // anywhere. So ask the policy that would actually run, rather than assuming.
  if (!realEnv.OPENAI_API_KEY && policy?.usesOpenAiKey !== false) {
    const unknown = !policy || policy.usesOpenAiKey === null;
    problems.push({
      id: "openai-key",
      severity: unknown ? "warning" : "blocking",
      message: unknown
        ? "OPENAI_API_KEY is not set, and the policy that would run" +
          (policy ? ` ('${policy.name}') could not be read from ${policy.path}` : " could not be determined") +
          " — so whether this install needs a key is unknown. If it routes judgment work through the " +
          "openai adapter, every phase will abort at its first dispatch."
        : "OPENAI_API_KEY is not set, and " +
          (policy.selected
            ? `this project's policy '${policy.name}'`
            : `this project has not chosen a policy, so a run falls back to the default '${policy.name}', which`) +
          " routes judgment work through the metered openai adapter. Every judgment-tier phase would abort " +
          "at its first dispatch.",
      fix:
        `Get a key at https://platform.openai.com/api-keys and put it in ${ENV_ADVICE}. ` +
        `Or, if you have a ChatGPT subscription, switch to '${SEAT_POLICY}' (run $mmo-codex:policy) — same ` +
        "model, same effort pin, judgment work on your seat through the codex CLI and no key at all. The " +
        "trade-off is cost reporting, not output: seat-billed judgment cost is modeled from token counts " +
        "rather than metered, and is kept out of the vendor total.",
    });
  }

  if (vertexState.state === "broken") {
    problems.push({
      id: "gemini-credentials-broken",
      severity: "blocking",
      message:
        `A Google credential is configured but is not usable: ${vertexState.detail}. ` +
        "This is not a missing credential — it is a present one that no Google auth library can load, " +
        "so every Gemini dispatch would fail at the moment it tries to sign.",
      fix:
        (realEnv.GOOGLE_APPLICATION_CREDENTIALS
          ? `Point GOOGLE_APPLICATION_CREDENTIALS at a complete service-account key, or unset it and run ${gcloudLogin} instead. ` +
            "An explicit GOOGLE_APPLICATION_CREDENTIALS takes precedence over the gcloud file, so leaving a broken one set " +
            "hides a working login."
          : `Run ${gcloudLogin} to write a fresh credentials file over the unusable one.`) +
        ` The AI Studio path is the other way in, if you would rather not fix this one: get a key at ` +
        `https://aistudio.google.com/app/apikey and put it in ${ENV_ADVICE}.`,
    });
  }

  if (
    vertexState.state !== "broken" &&
    !hasGeminiCredentials({ env: realEnv, vertex: vertexState })
  ) {
    const projectOnly = vertexState.state === "project-only";
    problems.push({
      id: "gemini-credentials",
      severity: "warning",
      message: projectOnly
        ? `GOOGLE_CLOUD_PROJECT is set to '${realEnv.GOOGLE_CLOUD_PROJECT}' but no credential was found. ` +
          "A project ID says where to bill, not who is asking. On a Google-hosted machine the credential comes " +
          "from the metadata server and this check cannot see it, so this may be fine; anywhere else, policies " +
          "that route mechanical phases to Gemini will abort at the first dispatch."
        : "No Gemini credentials found. Policies that route mechanical phases to Gemini will abort at the " +
          "first dispatch.",
      fix:
        `Either run ${gcloudLogin} — it writes a credentials file, so it needs no environment variable at all, ` +
        `and GOOGLE_CLOUD_PROJECT only if the account has several projects. Or, for the AI Studio path, get a ` +
        `key at https://aistudio.google.com/app/apikey and put it in ${ENV_ADVICE}.` +
        (projectOnly
          ? " If this machine runs inside Google Cloud, settle it for about two cents with scripts/probe-agent-worker.mjs rather than guessing."
          : ""),
    });
  }

  const specProblem = selectSpecProblem(realEnv);
  if (specProblem) problems.push(specProblem);

  if (selectsAgentWorker(realEnv) && !hasVertexCredentials(vertexState)) {
    const unproven = vertexState.state === "project-only";
    problems.push({
      id: unproven ? "agent-worker-credentials-unproven" : "agent-worker-credentials",
      severity: unproven ? "warning" : "blocking",
      message:
        `MMO_SELECT routes the mechanical tier to '${AGENT_WORKER_MODEL_ID}', which reaches Gemini ` +
        "through Vertex AI and application default credentials only. " +
        (unproven
          ? `This install names a project ('${realEnv.GOOGLE_CLOUD_PROJECT}') but has no credential this ` +
            "check can see. If it is not running inside Google Cloud, every delegated task will fail to " +
            "authenticate — after the premium phases are billed."
          : "This install has no credential for it" +
            (realEnv.GEMINI_API_KEY
              ? " — GEMINI_API_KEY is the AI Studio path, and the agent worker has no way to use it."
              : ".") +
            " Every delegated task would fail to authenticate."),
      fix: unproven
        ? "Settle it for about two cents before a real run: node scripts/probe-agent-worker.mjs. " +
          `If it fails to authenticate, run ${gcloudLogin}.`
        : `Run ${gcloudLogin}, and set GOOGLE_CLOUD_PROJECT if the account has several projects. ` +
          "To stay on the model path instead, re-run this script with --disable-agent.",
    });
  }

  if (agentWorker) {
    if (!agentWorker.hasVenv) {
      problems.push({
        id: "agent-worker-python",
        severity: "blocking",
        message:
          `MMO_SELECT routes the mechanical tier to '${AGENT_WORKER_MODEL_ID}', which runs a Python ` +
          "agent worker, but the worker has no Python environment. Every mechanical task would fail.",
        fix:
          "Re-run this check with --fix, which builds the environment. Or set GEMINI_WORKER_PYTHON " +
          "to a Python >= 3.10 that already has google-antigravity installed. " +
          "To go back to the model path instead, remove MMO_SELECT.",
      });
    } else if (!agentWorker.sdkImportable) {
      problems.push({
        id: "agent-worker-sdk",
        severity: "blocking",
        message:
          "The agent worker's Python environment exists but cannot import google.antigravity" +
          (agentWorker.detail ? ` (${agentWorker.detail})` : "") +
          ". The interpreter starts and then dies at its first import, inside a subprocess, " +
          "which is a much harder failure to read than this line.",
        fix:
          "Re-run this check with --fix, which rebuilds the environment from scratch. " +
          "The commonest cause is an environment built against an interpreter that has since " +
          "been upgraded or removed.",
      });
    }
  }

  return { ok: problems.every((p) => p.severity !== "blocking"), problems };
}

// ─── observation + repair ──────────────────────────────────────────────

function onPath(cmd) {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

/**
 * Import attempted, not inferred from directory presence — a venv built
 * against an upgraded/uninstalled interpreter looks healthy on disk and
 * fails on its first import. Carried unchanged from the source.
 */
function observeAgentWorker(pluginRoot, env) {
  if (!selectsAgentWorker(env)) return null;

  const override = usableEnv(env).GEMINI_WORKER_PYTHON;
  const python = override || workerPaths(pluginRoot).venvPython;
  if (!existsSync(python)) return { hasVenv: false, sdkImportable: false, detail: null };

  const probe = spawnSync(python, ["-c", "import google.antigravity"], { encoding: "utf8" });
  if (probe.status === 0) return { hasVenv: true, sdkImportable: true, detail: null };
  const stderr = (probe.stderr || "").trim().split("\n").filter(Boolean).pop() ?? null;
  return { hasVenv: true, sdkImportable: false, detail: stderr };
}

/**
 * `env` is a parameter so `--enable-agent` can pass in the selection it
 * just wrote, and `projectRoot` locates the .sdlc/local/mmo-select.json
 * file that resolveMmoSelect folds into the effective MMO_SELECT.
 */
function observe(pluginRoot, env = process.env, projectRoot = process.cwd()) {
  const { nodeModules, distEntry } = mcpPaths(pluginRoot);
  const resolvedSelect = env.MMO_SELECT ?? readMmoSelectFile(projectRoot) ?? undefined;
  const effectiveEnv = resolvedSelect !== undefined ? { ...env, MMO_SELECT: resolvedSelect } : env;
  const realEnv = usableEnv(effectiveEnv);
  const adcFile = adcPath();
  return {
    nodeMajor: nodeMajorFrom(process.versions.node),
    codexCli: probeCodexCli(),
    codexLogin: probeCodexLogin(),
    hasGcloud: onPath("gcloud"),
    hasNodeModules: existsSync(nodeModules),
    hasDist: existsSync(distEntry),
    hasAdcFile: existsSync(adcFile),
    vertex: vertexCredentialState({
      env: realEnv,
      serviceAccountFile: realEnv.GOOGLE_APPLICATION_CREDENTIALS
        ? inspectCredentialFile(realEnv.GOOGLE_APPLICATION_CREDENTIALS)
        : null,
      adcFile: inspectCredentialFile(adcFile),
    }),
    env: effectiveEnv,
    agentWorker: observeAgentWorker(pluginRoot, effectiveEnv),
    skills: skillLinkState(pluginRoot, projectRoot),
    policy: observePolicy(pluginRoot, projectRoot),
  };
}

/** `npm ci`, not `npm install` — resolve exactly the verified lockfile. Carried unchanged. */
function repair(pluginRoot, log) {
  const { serverDir } = mcpPaths(pluginRoot);
  for (const [label, args] of [
    ["installing dependencies", ["ci"]],
    ["building the server", ["run", "build"]],
  ]) {
    log(`  → ${label} (npm ${args.join(" ")})`);
    const result = spawnSync("npm", args, { cwd: serverDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      log(`  ✗ ${label} failed:\n${(result.stderr || result.stdout || "").trim()}`);
      return false;
    }
  }
  return true;
}

/** google-antigravity requires-python >= 3.10; macOS /usr/bin/python3 is 3.9. Carried unchanged. */
export const MIN_PYTHON = [3, 10];

/** Carried unchanged from the source — no Claude/codex coupling at all. */
export function findWorkerPython(run = spawnSync, resolve = onPath) {
  for (const name of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
    if (!resolve(name)) continue;
    const probe = run(name, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const [major, minor] = String(probe.stdout).trim().split(".").map(Number);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { command: name, version: `${major}.${minor}` };
    }
  }
  return null;
}

/** Carried unchanged from the source. */
export function buildWorkerEnvironment(pluginRoot, log = () => {}) {
  const { workerDir, venvPython } = workerPaths(pluginRoot);
  const python = findWorkerPython();
  if (!python) {
    return {
      ok: false,
      reason: "no-python",
      detail: `No Python ${MIN_PYTHON.join(".")} or newer found. macOS ships 3.9, which is too old. Install one (e.g. \`brew install python@3.12\`) and retry.`,
    };
  }

  log(`  → creating the worker environment with ${python.command} (${python.version})`);
  for (const [label, cmd, args] of [
    ["creating the virtual environment", python.command, ["-m", "venv", "--clear", ".venv"]],
    ["installing the Antigravity SDK", venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"]],
  ]) {
    const result = spawnSync(cmd, args, { cwd: workerDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "failed",
        detail: `${label} failed:\n${(result.stderr || result.stdout || "").trim()}`,
      };
    }
  }
  return { ok: true, reason: null, detail: `${python.command} (${python.version})` };
}

/** Points a green agent-path install at the probe. Path unchanged, content unchanged. */
export function agentProbeHint(pluginRoot, env = {}, ok = true) {
  if (!ok || !selectsAgentWorker(env)) return null;
  return (
    `\n  This install selects the agent path, and the checks above are all offline.\n` +
    `  They cannot tell whether this project carries the Antigravity entitlement,\n` +
    `  whether its region serves the model, or whether a well-formed credential is\n` +
    `  still live — each fails at the first delegated packet, after the premium\n` +
    `  phases are already billed. One trivial delegation settles all three for about\n` +
    `  two cents:\n` +
    `    node ${join(pluginRoot, "scripts", "probe-agent-worker.mjs")}`
  );
}

/**
 * End-of-successful-setup hand-off. Unlike the source, does NOT warn that
 * "a new session is required" — check 10 in the verification doc found
 * codex has no persistent session to go stale; every `codex exec` invocation
 * reads config.toml and the .sdlc/local files fresh.
 */
export function nextStepsBanner(cwd = process.cwd(), ok = true) {
  if (!ok) return null;
  let currentPolicy = null;
  try {
    const raw = readFileSync(join(cwd, ".sdlc", "project.json"), "utf8");
    currentPolicy = JSON.parse(raw).default_policy ?? null;
  } catch { /* no project.json yet — banner still worth printing */ }

  // `$name` is codex's skill-mention syntax, and codex namespaces a plugin's
  // skills by the plugin name — so these are `$mmo-codex:<skill>`, not the
  // Claude harness's `/mmo:<command>` slash commands. Verified in
  // docs/verification/p1-codex-runtime.md; `/skills` is the picker.
  const policyLine = currentPolicy
    ? `\n  Current policy: ${currentPolicy}   (change: $mmo-codex:policy)`
    : `\n  No policy set yet — run $mmo-codex:policy to pick one.`;

  return (
    `\n✓ Setup complete for this project.\n\n` +
    `  Type $ in codex to mention a skill (or /skills to browse):\n\n` +
    `    $mmo-codex:greenfield  — generate a new app from a brief (empty folder)\n` +
    `    $mmo-codex:brownfield  — work on this existing repo (docs, bugfix, feature, refactor, …)\n` +
    `    $mmo-codex:policy      — show / change this project's model policy\n` +
    `    $mmo-codex:pass        — headless/scripted run (for CI or replays)\n` +
    policyLine
  );
}

/**
 * Note when the agent door has opened since setup last ran. Not a
 * `problem` — the model path is a valid choice. Carried unchanged.
 */
export function agentPathAvailableHint(pluginRoot, vertex = null, env = {}) {
  if (!hasVertexCredentials(vertex)) return null;
  if (selectsAgentWorker(env)) return null;
  return (
    `\n  This machine now has credentials for the Antigravity SDK agent path, which\n` +
    `  the mechanical tier is not using. The model path is the cheaper default and\n` +
    `  staying on it is fine — but if you want Gemini to open the folder and run\n` +
    `  commands itself:\n` +
    `    node ${join(pluginRoot, "codex", "verify-setup.mjs")} --enable-agent`
  );
}

/**
 * Sets or clears the `gemini-flash` slot in the project-local MMO_SELECT
 * file. See plugin/codex/mmoSelect.mjs for the file format and why it
 * replaces the source's settings.json/.mcp.json round-trip.
 */
export function enableAgentPath({ projectRoot, enabled }) {
  const current = readMmoSelectFile(projectRoot);
  const { pairs } = parseSelectSpec(current);
  if (enabled) pairs[AGENT_WORKER_SLOT] = AGENT_WORKER_MODEL_ID;
  else delete pairs[AGENT_WORKER_SLOT];

  const spec = Object.entries(pairs)
    .map(([slot, option]) => `${slot}=${option}`)
    .join(",");
  const path = writeMmoSelectFile(projectRoot, spec || undefined);
  return { ok: true, spec: spec || undefined, path };
}

function report({ ok, problems }, log) {
  const blocking = problems.filter((p) => p.severity === "blocking");
  const warnings = problems.filter((p) => p.severity === "warning");

  for (const p of blocking) log(`  ✗ ${p.message}\n    fix: ${p.fix}`);
  for (const p of warnings) log(`  ! ${p.message}\n    fix: ${p.fix}`);

  if (ok && warnings.length === 0) log("  ✓ Setup is complete. The harness is ready to run.");
  else if (ok) log("  ✓ The harness can run. Warnings above limit which policies will work.");
  return ok;
}

// Direct-execution gate so the test suite can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // This file lives at <pluginRoot>/codex/verify-setup.mjs — two dirnames up.
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const log = (m) => console.log(m);
  const shouldFix = process.argv.includes("--fix");
  const enableAgent = process.argv.includes("--enable-agent");
  const disableAgent = process.argv.includes("--disable-agent");
  const brownfieldCheck = process.argv.includes("--brownfield-check");
  const headless = process.argv.includes("--headless");
  const projectRootEq = process.argv.find((a) => a.startsWith("--project-root="));
  const projectRootSpaceIdx = process.argv.indexOf("--project-root");
  const projectRoot = projectRootEq
    ? projectRootEq.slice("--project-root=".length)
    : (projectRootSpaceIdx >= 0 ? process.argv[projectRootSpaceIdx + 1] : process.cwd());

  log("\nAI-SDLC orchestrator (codex harness) — setup check");

  let env = process.env;

  if (enableAgent && disableAgent) {
    log("  ✗ --enable-agent and --disable-agent contradict each other. Pass one.");
    process.exit(1);
  }

  if (enableAgent || disableAgent) {
    const written = enableAgentPath({ projectRoot, enabled: enableAgent });
    env = { ...process.env };
    if (written.spec) env.MMO_SELECT = written.spec;
    else delete env.MMO_SELECT;

    log(
      enableAgent
        ? `  ✓ Mechanical tier set to the Antigravity SDK agent path (MMO_SELECT=${written.spec}) in ${written.path}.`
        : `  ✓ Mechanical tier set back to the model path in ${written.path}.`
    );
    log("    The codex driver reads this file directly on its next invocation — no new session needed.");
  }

  const repairing = shouldFix || enableAgent;

  let observed = observe(pluginRoot, env, projectRoot);
  let state = evaluate(observed);
  const needsRepair = state.problems.some(
    (p) => p.id === "mcp-dependencies" || p.id === "mcp-build"
  );

  if (needsRepair && repairing) {
    log("  The bundled MCP server needs building. Repairing:");
    if (repair(pluginRoot, log)) {
      observed = observe(pluginRoot, env, projectRoot);
      state = evaluate(observed);
    }
  }

  if (state.problems.some((p) => p.id === "skills-discoverable") && repairing) {
    log("  Putting the shipped skills on codex's scan path:");
    linkSkills(pluginRoot, projectRoot, log);
    observed = observe(pluginRoot, env, projectRoot);
    state = evaluate(observed);
  }

  const needsWorker = state.problems.some(
    (p) => p.id === "agent-worker-python" || p.id === "agent-worker-sdk"
  );
  if (needsWorker && repairing) {
    log("  The agent worker needs a Python environment. Repairing:");
    const built = buildWorkerEnvironment(pluginRoot, log);
    if (built.ok) {
      observed = observe(pluginRoot, env, projectRoot);
      state = evaluate(observed);
    } else log(`  ✗ ${built.detail}`);
  }

  const passed = report(state, log);
  for (const hint of [
    agentProbeHint(pluginRoot, env, passed),
    agentPathAvailableHint(pluginRoot, observed.vertex, env),
    // Suppressed under --brownfield-check: the next-steps banner is the end
    // of the run, and there is more to print below it.
    brownfieldCheck ? null : nextStepsBanner(projectRoot, passed),
  ]) {
    if (hint) log(hint);
  }

  // Brownfield-mode prerequisites — opt-in, so the ordinary check keeps its
  // current behaviour untouched. Headless (CI) passes both flags.
  let brownfieldOk = true;
  if (brownfieldCheck) {
    log("\nBrownfield-mode setup checks:");
    const bf = runEnvChecks();
    brownfieldOk = bf.ok;
    log(renderEnvChecks(bf).trimEnd());
    if (headless && !brownfieldOk) {
      log("\nHeadless mode: a blocker check needs human action. Fix the reported items and re-run.");
    }
    const banner = nextStepsBanner(projectRoot, passed && brownfieldOk);
    if (banner) log(banner);
  }

  process.exit(passed && brownfieldOk ? 0 : 1);
}
