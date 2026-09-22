/**
 * ESM twin of plugin/mcp/model-dispatch/src/log.ts. Byte-identical output
 * for the same input is a hard requirement, asserted by
 * tools/test/logging.test.mjs — the two files cannot import each other (one
 * compiles into the MCP server, the other runs standalone from
 * plugin/scripts/mmo-log.mjs, invoked from a command prompt that cannot
 * import a module), so every change here needs the matching change there.
 *
 * Never write to stdout: irrelevant for this file's own callers, but kept
 * true to the contract the TS twin exists under.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATTERNS } from "../dispatch-sanitize.mjs";
import { resolveLogLevel } from "./env.mjs";

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LEVEL_LABEL = { error: "ERROR", warn: "WARN", info: "INFO", debug: "DEBUG", trace: "TRACE" };

const BARE_VALUE = /^[A-Za-z0-9_./:@+-]+$/;
const EVENT_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const ROTATE_MAX_BYTES = 5 * 1024 * 1024;
const STALE_LOCK_MS = 60_000;

let currentLevel = resolveLogLevel().level;

/** Runtime override — a per-call MCP tool argument outranks every env var. */
export function setLevel(level) {
  currentLevel = level;
}

export function getLevel() {
  return currentLevel;
}

function formatTimestamp() {
  return new Date().toISOString();
}

function formatLevel(level) {
  return LEVEL_LABEL[level].padEnd(5) + "  ";
}

/** Bare when it matches BARE_VALUE; otherwise double-quoted with control chars escaped. */
function formatValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value);
  if (BARE_VALUE.test(s)) return s;
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Renders one logfmt line, no trailing newline. */
export function formatLine(level, event, fields) {
  if (!EVENT_NAME.test(event)) {
    throw new Error(`log: event name '${event}' must match ${EVENT_NAME} (dotted verb, lower_snake segments)`);
  }
  const fieldParts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    fieldParts.push(`${key}=${formatValue(value)}`);
  }
  const prefix = process.env.MMO_LOG_PREFIX ?? "MMO: ";
  const tail = fieldParts.length ? " " + fieldParts.join(" ") : "";
  return `${prefix}${formatTimestamp()} ${formatLevel(level)}${event}${tail}`;
}

// ─── redaction ────────────────────────────────────────────────────────────

/** Replace every secret-shaped match with a placeholder. Never throws, never partial-leaks. */
export function redactText(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, `[redacted:${name}]`);
  }
  return out;
}

function scrubFreeText(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "string" ? redactText(v) : v;
  }
  return out;
}

// ─── sinks ──────────────────────────────────────────────────────────────

/** POSIX guarantees an O_APPEND write below PIPE_BUF is atomic — one call, trailing newline included. */
function appendAtomic(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n");
  } catch {
    // A logging failure must never stop a run.
  }
}

/** Rotate under an exclusive lock; skip (keep appending) if another process holds it. */
function rotateIfNeeded(path) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return; // file does not exist yet — nothing to rotate
  }
  if (size < ROTATE_MAX_BYTES) return;

  const lockPath = `${path}.rotating`;
  try {
    if (existsSync(lockPath)) {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age < STALE_LOCK_MS) return; // another process is rotating right now
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
    appendFileSync(lockPath, "", { flag: "wx" });
  } catch {
    return; // lost the race — someone else is rotating
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    /* best-effort */
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

let runLogPath = null;
let fallbackLogPath = null;

/** Called once per process, as soon as telemetry_path (or a project root) is known. */
export function configureSinks(opts = {}) {
  if (opts.telemetryPath) runLogPath = join(dirname(opts.telemetryPath), "orchestrator.log");
  if (opts.runLogPath) runLogPath = opts.runLogPath;
  if (opts.projectRoot) fallbackLogPath = join(opts.projectRoot, ".sdlc", "local", "debug.log");
}

function activeSinkPath() {
  return runLogPath ?? fallbackLogPath;
}

/**
 * Emit one log line. Filtered by the currently-effective level; ERROR/WARN/INFO
 * are always emitted regardless of setLevel (the level gate only ever raises
 * verbosity, never silences the always-on tiers) — enforced by ordering below.
 */
export function log(level, event, fields = {}) {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[currentLevel]) return;
  const scrubbed = scrubFreeText(fields);
  const line = formatLine(level, event, scrubbed);

  process.stderr.write(line + "\n");

  const path = activeSinkPath();
  if (path) {
    rotateIfNeeded(path);
    appendAtomic(path, line);
  }
}
