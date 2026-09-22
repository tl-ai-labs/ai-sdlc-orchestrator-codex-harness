/**
 * The MMO: log stream (docs/logging.md). One function — log(level, event,
 * fields) — plus setLevel. Byte-identical output to the ESM twin
 * (plugin/scripts/lib/log.mjs) for the same input is a hard requirement,
 * asserted by tools/test/logging.test.mjs — the two files cannot import each
 * other (this one compiles into the MCP server; the other runs standalone
 * from a command prompt that cannot import a module), so every change here
 * needs the matching change there.
 *
 * Never write to stdout: stdout is the MCP stdio JSON-RPC transport, and one
 * stray byte corrupts the framing (envBootstrap.ts).
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactText } from "./redact.js";

export type Level = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LEVEL_LABEL: Record<Level, string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
  debug: "DEBUG",
  trace: "TRACE",
};

const BARE_VALUE = /^[A-Za-z0-9_./:@+-]+$/;
const EVENT_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const ROTATE_MAX_BYTES = 5 * 1024 * 1024;
const STALE_LOCK_MS = 60_000;

let currentLevel: Level = resolveDefaultLevel();

function resolveDefaultLevel(): Level {
  const explicit = process.env.MMO_LOG_LEVEL?.trim().toLowerCase();
  if (explicit && explicit in LEVEL_ORDER) return explicit as Level;
  if (process.env.MMO_VERBOSE === "1") return "debug";
  if (process.env.MMO_DEBUG === "1") return "debug";
  if (process.env.SDLC_DEBUG === "1") return "debug";
  return "info";
}

/** Runtime override — a per-call MCP tool argument outranks every env var. */
export function setLevel(level: Level): void {
  currentLevel = level;
}

export function getLevel(): Level {
  return currentLevel;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatLevel(level: Level): string {
  return LEVEL_LABEL[level].padEnd(5) + "  ";
}

/** Bare when it matches BARE_VALUE; otherwise double-quoted with control chars escaped. */
function formatValue(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value);
  if (BARE_VALUE.test(s)) return s;
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Renders one logfmt line, no trailing newline. */
export function formatLine(level: Level, event: string, fields: Record<string, unknown>): string {
  if (!EVENT_NAME.test(event)) {
    throw new Error(`log: event name '${event}' must match ${EVENT_NAME} (dotted verb, lower_snake segments)`);
  }
  const fieldParts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    fieldParts.push(`${key}=${formatValue(value)}`);
  }
  const prefix = process.env.MMO_LOG_PREFIX ?? "MMO: ";
  const tail = fieldParts.length ? " " + fieldParts.join(" ") : "";
  return `${prefix}${formatTimestamp()} ${formatLevel(level)}${event}${tail}`;
}

// ─── sinks ──────────────────────────────────────────────────────────────

function scrubFreeText(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "string" ? redactText(v) : v;
  }
  return out;
}

/** POSIX guarantees an O_APPEND write below PIPE_BUF is atomic — one call, trailing newline included. */
function appendAtomic(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n");
  } catch {
    // A logging failure must never stop a run.
  }
}

/** Rotate under an exclusive lock; skip (keep appending) if another process holds it. */
function rotateIfNeeded(path: string): void {
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
      // Stale — a crashed process left this behind. Treat as abandoned.
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

let runLogPath: string | null = null;
let fallbackLogPath: string | null = null;

/** Called once per process, as soon as telemetry_path (or a project root) is known. */
export function configureSinks(opts: { telemetryPath?: string; runLogPath?: string; projectRoot?: string }): void {
  if (opts.telemetryPath) runLogPath = join(dirname(opts.telemetryPath), "orchestrator.log");
  if (opts.runLogPath) runLogPath = opts.runLogPath;
  if (opts.projectRoot) fallbackLogPath = join(opts.projectRoot, ".sdlc", "local", "debug.log");
}

function activeSinkPath(): string | null {
  return runLogPath ?? fallbackLogPath;
}

/**
 * Emit one log line. Filtered by the currently-effective level; ERROR/WARN/INFO
 * are always emitted regardless of setLevel (the level gate only ever raises
 * verbosity, never silences the always-on tiers) — enforced by ordering below.
 */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[currentLevel]) return;
  const scrubbed = scrubFreeText(fields);
  const line = formatLine(level, event, scrubbed);

  // stderr always.
  process.stderr.write(line + "\n");

  const path = activeSinkPath();
  if (path) {
    rotateIfNeeded(path);
    appendAtomic(path, line);
  }
}
