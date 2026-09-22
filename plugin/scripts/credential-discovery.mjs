#!/usr/bin/env node
/**
 * Provider-agnostic credential discovery scanner. Reads shell env,
 * home-dir configs, shell rc files, and repo .env* / source files
 * (names only — never values, per plan §19) to figure out what
 * credentials the user already has for Anthropic, Gemini, and
 * (optionally) Antigravity.
 *
 * The setup shepherd (§7.6) invokes this before asking the user to
 * set anything up: found → use; not found → offer three options
 * (set up now / switch policy / skip).
 *
 * Never reads the value side of any env file. Never emits a value.
 * The word "detected" here means "we saw the name defined" — never
 * "we captured the secret."
 *
 * Usage:
 *   node credential-discovery.mjs
 *   node credential-discovery.mjs --repo-root /path/to/repo
 *   node credential-discovery.mjs --providers anthropic,gemini
 *   node credential-discovery.mjs --include-antigravity
 *
 * Output: JSON on stdout, schema below. Exit 0 on success.
 */

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { log } from "./lib/log.mjs";

// ─── helpers ─────────────────────────────────────────────────────────

/** Find the repo root by walking up from `start` looking for `.git`. */
function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** True if the value is a real string (env var set + non-empty). */
function envSet(name, env = process.env) {
  const v = env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/** True if a path exists AND is small enough to be a plausible config file. */
function fileExistsSensibly(path, maxBytes = 512 * 1024) {
  try {
    const s = statSync(path);
    return s.isFile() && s.size <= maxBytes;
  } catch {
    return false;
  }
}

function dirExistsSensibly(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Extract env var *names* (LHS of KEY=VALUE) from an env-file's text.
 * Returns a sorted deduped list. Never keeps values.
 * Handles quoted values, comments, leading whitespace, `export ` prefixes.
 */
function extractEnvKeyNames(text) {
  const names = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Optional `export ` prefix; then KEY = ...
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Grep the given files for env-var references. Returns per-var occurrence
 * list. Only records variable NAMES (from the reference pattern), never
 * the surrounding code. Bounded by fileCount and per-file byte cap.
 */
function grepEnvReferencesInCode(root, varNames, opts = {}) {
  const fileCount = opts.fileCount ?? 400;
  const bytesPerFile = opts.bytesPerFile ?? 256 * 1024;
  const skipDirs = new Set([
    "node_modules", ".git", "dist", "build", ".next", "target", ".sdlc",
    "vendor", "third_party", "coverage", ".venv", "__pycache__",
  ]);
  const okExt = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".php", ".ex"]);

  const hits = new Map(); // varName → [ { file, count } ]
  const varSet = new Set(varNames);

  // Compile a single alternation regex once
  if (varSet.size === 0) return {};
  const alt = [...varSet].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(
    `(?:process\\.env\\.|process\\.env\\[["'\`]|os\\.environ\\[["']|os\\.getenv\\(["']|System\\.getenv\\(["']|ENV\\[["']|env\\.)(${alt})\\b`,
    "g"
  );

  let seen = 0;
  const stack = [root];
  while (stack.length && seen < fileCount) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      if (seen >= fileCount) break;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name) || ent.name.startsWith(".")) continue;
        stack.push(p);
      } else if (ent.isFile()) {
        const dot = ent.name.lastIndexOf(".");
        const ext = dot >= 0 ? ent.name.slice(dot) : "";
        if (!okExt.has(ext)) continue;
        try {
          const st = statSync(p);
          if (st.size > bytesPerFile) continue;
          const text = readFileSync(p, "utf8");
          const found = new Map();
          let m;
          re.lastIndex = 0;
          while ((m = re.exec(text)) !== null) {
            found.set(m[1], (found.get(m[1]) ?? 0) + 1);
          }
          for (const [v, c] of found.entries()) {
            if (!hits.has(v)) hits.set(v, []);
            hits.get(v).push({ file: p, count: c });
          }
          seen++;
        } catch { /* skip unreadable */ }
      }
    }
  }

  const out = {};
  for (const [v, list] of hits.entries()) {
    // Cap the list per var so the output stays reasonable
    out[v] = list.slice(0, 10);
  }
  return out;
}

// ─── shell rc discovery ──────────────────────────────────────────────

/**
 * Peek at shell rc files for `export KEY=…` lines. Names only. Detects
 * env vars the user has set persistently but which may not be exported
 * into the current shell (e.g. added to ~/.zshrc after this terminal
 * was opened).
 */
function scanShellRcs(varNames, home = homedir()) {
  const candidates = [".zshrc", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".envrc"];
  const varSet = new Set(varNames);
  if (varSet.size === 0) return [];
  const alt = [...varSet].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`^\\s*(?:export\\s+)?(${alt})\\s*=`, "m");

  const found = [];
  for (const rc of candidates) {
    const p = join(home, rc);
    if (!fileExistsSensibly(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      const names = new Set();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(re);
        if (m) names.add(m[1]);
      }
      if (names.size > 0) found.push({ path: p.replace(home, "~"), names: [...names].sort() });
    } catch { /* skip */ }
  }
  return found;
}

// ─── env file discovery in repo ──────────────────────────────────────

function scanRepoEnvFiles(root) {
  const patterns = [".env", ".env.example", ".env.local", ".env.development", ".env.test", ".env.production"];
  const perFile = {};
  const flat = new Set();

  for (const p of patterns) {
    const abs = join(root, p);
    if (!fileExistsSensibly(abs)) continue;
    try {
      const text = readFileSync(abs, "utf8");
      const keys = extractEnvKeyNames(text);
      perFile[p] = keys;
      keys.forEach((k) => flat.add(k));
    } catch { /* skip */ }
  }
  return { perFile, all: [...flat].sort() };
}

// ─── per-provider scans ──────────────────────────────────────────────

function scanAnthropic(envKeysInRepo, codeReferences) {
  const sources = [];

  // Shell env
  sources.push({
    location: "env:ANTHROPIC_API_KEY",
    kind: "shell-env",
    detected: envSet("ANTHROPIC_API_KEY"),
  });

  // Home-dir credentials file (documented location the CLI uses)
  const credPath = join(homedir(), ".anthropic", "credentials");
  sources.push({
    location: credPath.replace(homedir(), "~"),
    kind: "credential-file",
    detected: fileExistsSensibly(credPath),
  });

  // The `claude` CLI itself — a Max-subscription user can dispatch Anthropic
  // calls through it via the claude-cli adapter, no ANTHROPIC_API_KEY needed.
  const claudeProbe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 3000 });
  const claudeCliDetected = claudeProbe.status === 0;
  sources.push({
    location: "claude-cli",
    kind: "cli-subprocess",
    detected: claudeCliDetected,
    note: claudeCliDetected
      ? "The claude-cli adapter can dispatch Anthropic calls through this binary using its OAuth session."
      : "The `claude` binary is not on PATH — install Claude Code to use the claude-cli adapter.",
  });

  // Fallback: Claude Code subscription auth — this is what estimated-mode uses
  // for judgment phases when no vendor key is set.
  sources.push({
    location: "claude-code-subscription",
    kind: "fallback",
    detected: true,
    note: "If no vendor key is set, judgment phases can run in estimated mode using your existing Claude Code auth.",
  });

  const rcHits = scanShellRcs(["ANTHROPIC_API_KEY"]);
  for (const rc of rcHits) {
    sources.push({
      location: rc.path,
      kind: "shell-rc",
      detected: true,
      note: `Present in ${rc.path}; may not be exported in current shell if you added it after opening this terminal.`,
    });
  }

  const repoRefs = ["ANTHROPIC_API_KEY"].filter((k) => codeReferences[k]?.length);
  const inEnvFiles = ["ANTHROPIC_API_KEY"].filter((k) => envKeysInRepo.all.includes(k));

  const found =
    sources.some((s) => s.kind !== "fallback" && s.detected) ||
    inEnvFiles.length > 0 ||
    repoRefs.length > 0;

  return {
    name: "anthropic",
    required: true,
    found,
    fallback_available: true,
    sources,
    repo_signals: {
      referenced_in_env_files: inEnvFiles,
      referenced_in_code_files: repoRefs.length > 0 ? codeReferences.ANTHROPIC_API_KEY ?? [] : [],
    },
  };
}

function scanGemini(envKeysInRepo, codeReferences) {
  const sources = [];

  // Flavor 1: Google AI Studio direct API key
  const aiStudioEnvVars = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
  for (const v of aiStudioEnvVars) {
    sources.push({
      flavor: "google-ai-studio",
      location: `env:${v}`,
      kind: "shell-env",
      detected: envSet(v),
    });
  }
  const geminiConfigDir = join(homedir(), ".gemini");
  sources.push({
    flavor: "google-ai-studio",
    location: geminiConfigDir.replace(homedir(), "~"),
    kind: "config-dir",
    detected: dirExistsSensibly(geminiConfigDir),
  });

  // Flavor 2: Vertex AI (service account or ADC)
  sources.push({
    flavor: "vertex-ai",
    location: "env:GOOGLE_APPLICATION_CREDENTIALS",
    kind: "shell-env-path",
    detected: envSet("GOOGLE_APPLICATION_CREDENTIALS") && fileExistsSensibly(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? ""),
  });
  const adcPath = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  sources.push({
    flavor: "vertex-ai",
    location: adcPath.replace(homedir(), "~"),
    kind: "adc-file",
    detected: fileExistsSensibly(adcPath),
  });

  // gcloud tooling — best-effort; failure = not detected, never a crash
  const gcloudToken = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", timeout: 3000 });
  const gcloudProject = spawnSync("gcloud", ["config", "get-value", "project"], { encoding: "utf8", timeout: 3000 });
  const gcloudActive = gcloudToken.status === 0 && (gcloudToken.stdout ?? "").trim().length > 0;
  const projectValue = (gcloudProject.stdout ?? "").trim();
  const projectDetected = gcloudProject.status === 0 && projectValue.length > 0 && projectValue !== "(unset)";

  sources.push({
    flavor: "vertex-ai",
    location: "gcloud auth print-access-token",
    kind: "gcloud-cli",
    detected: gcloudActive,
    note: gcloudActive ? "gcloud is authenticated." : undefined,
  });
  sources.push({
    flavor: "vertex-ai",
    location: "gcloud config get-value project",
    kind: "gcloud-project",
    detected: projectDetected,
    note: projectDetected ? `Active project: ${projectValue}` : undefined,
  });

  // Env vars for GCP project/region — hints, not primary credentials
  sources.push({
    flavor: "vertex-ai",
    location: "env:GOOGLE_CLOUD_PROJECT",
    kind: "shell-env",
    detected: envSet("GOOGLE_CLOUD_PROJECT"),
  });
  sources.push({
    flavor: "vertex-ai",
    location: "env:GOOGLE_CLOUD_LOCATION",
    kind: "shell-env",
    detected: envSet("GOOGLE_CLOUD_LOCATION"),
  });

  // Shell rc scan
  const geminiVars = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];
  const rcHits = scanShellRcs(geminiVars);
  for (const rc of rcHits) {
    sources.push({
      flavor: "any",
      location: rc.path,
      kind: "shell-rc",
      detected: true,
      note: `Present in ${rc.path} (vars: ${rc.names.join(", ")}). May not be in current shell.`,
    });
  }

  // Repo signals
  const inEnvFiles = geminiVars.filter((k) => envKeysInRepo.all.includes(k));
  const codeRefs = {};
  for (const v of geminiVars) if (codeReferences[v]?.length) codeRefs[v] = codeReferences[v];

  // Was any concrete source detected?
  const found = sources.some((s) => s.detected) || inEnvFiles.length > 0 || Object.keys(codeRefs).length > 0;

  return {
    name: "gemini",
    required: false,
    found,
    flavors: {
      "google-ai-studio": sources.filter((s) => s.flavor === "google-ai-studio").some((s) => s.detected),
      "vertex-ai": sources.filter((s) => s.flavor === "vertex-ai").some((s) => s.detected),
    },
    sources,
    repo_signals: {
      referenced_in_env_files: inEnvFiles,
      referenced_in_code_files: codeRefs,
    },
  };
}

function scanAntigravity(gcpAuthDetected) {
  // Antigravity reuses GCP auth; we only care whether the SDK package itself
  // is installed AND some GCP path is authenticated. Even that is best-effort
  // in v1 — actual entitlement check happens at preflight_dispatch.
  const sources = [];

  const pipShow = spawnSync("pip", ["show", "google-antigravity-sdk"], { encoding: "utf8", timeout: 3000 });
  const pipDetected = pipShow.status === 0 && (pipShow.stdout ?? "").includes("Name:");
  sources.push({
    location: "pip show google-antigravity-sdk",
    kind: "python-sdk",
    detected: pipDetected,
    note: pipDetected ? undefined : "SDK not installed (pip show returned non-zero).",
  });

  const pip3Show = spawnSync("pip3", ["show", "google-antigravity-sdk"], { encoding: "utf8", timeout: 3000 });
  const pip3Detected = pip3Show.status === 0 && (pip3Show.stdout ?? "").includes("Name:");
  if (pip3Detected && !pipDetected) {
    sources.push({
      location: "pip3 show google-antigravity-sdk",
      kind: "python-sdk",
      detected: true,
    });
  }

  sources.push({
    location: "reuses-gcp-auth",
    kind: "gcp-inherited",
    detected: gcpAuthDetected,
    note: "Antigravity has no separate credentials — it uses whatever GCP auth Vertex would use.",
  });

  const found = (pipDetected || pip3Detected) && gcpAuthDetected;

  return {
    name: "antigravity",
    required: false,
    optional_and_opt_in: true,
    found,
    sources,
    note:
      "Antigravity is opt-in. Only checked when the policy uses flash-agsdk-worker or MMO_SELECT names it. " +
      "This scan is informational; the real reachability check runs at preflight_dispatch.",
  };
}

// ─── main ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { repoRoot: null, providers: null, includeAntigravity: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo-root" || a === "-r") args.repoRoot = argv[++i] ?? null;
    else if (a === "--providers") args.providers = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--include-antigravity") args.includeAntigravity = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : findRepoRoot() ?? process.cwd();
  const enabled = args.providers && args.providers.length > 0
    ? new Set(args.providers)
    : new Set(["anthropic", "gemini"]);
  if (args.includeAntigravity) enabled.add("antigravity");

  // Scan repo signals once — reused across providers.
  const envKeys = scanRepoEnvFiles(repoRoot);
  const varsOfInterest = [
    "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
    ...envKeys.all,
  ];
  const codeRefs = grepEnvReferencesInCode(repoRoot, [...new Set(varsOfInterest)]);

  const providers = [];
  if (enabled.has("anthropic")) providers.push(scanAnthropic(envKeys, codeRefs));
  if (enabled.has("gemini")) providers.push(scanGemini(envKeys, codeRefs));

  for (const p of providers) {
    const detectedSource = p.sources.find((s) => s.kind !== "fallback" && s.detected);
    const keyEnvMatch = detectedSource?.location?.match(/^env:(.+)$/);
    log("debug", "credential.discover", {
      provider: p.name,
      source: detectedSource?.kind ?? "none",
      key_env_name: keyEnvMatch?.[1],
      found: p.found,
    });
  }

  // Antigravity depends on gemini's GCP auth detection
  if (enabled.has("antigravity")) {
    const gemini = providers.find((p) => p.name === "gemini");
    const gcpAuthDetected = gemini?.flavors?.["vertex-ai"] ?? false;
    providers.push(scanAntigravity(gcpAuthDetected));
  }

  const out = {
    schema_version: 1,
    scanned_at: new Date().toISOString(),
    repo_root: repoRoot,
    env_keys_by_file: envKeys.perFile,
    providers,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

try {
  main();
} catch (e) {
  // Fail-safe: emit an empty but well-formed report so the shepherd
  // can still make progress. Never crash out — the user is waiting.
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    scanned_at: new Date().toISOString(),
    error: e?.message ?? String(e),
    providers: [],
  }) + "\n");
  process.exit(0);
}
