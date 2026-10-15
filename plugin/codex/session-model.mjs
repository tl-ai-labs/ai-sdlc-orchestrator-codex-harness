#!/usr/bin/env node
/**
 * Checks that an interactive codex session runs the policy's driver pin.
 *
 * Codex 0.160.1 gives every command the model runs CODEX_THREAD_ID, and
 * writes one `turn_context` record per turn (payload.model, and
 * payload.effort when one is set) to
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl
 * before the turn's first tool call. A session that cannot be read is
 * reported as unverified. start-run.mjs starts no run unless the status is
 * "match", and this CLI exits 1 for anything else.
 *
 *   node session-model.mjs [--project-root=<dir>] [--policy=<name>] [--json]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMain } from "../scripts/lib/is-main.mjs";
import { exitAfterFlush } from "../scripts/lib/exit.mjs";

export function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

export function sessionThreadId(env = process.env) {
  return env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
}

/** A null or empty home (an unset env var passed through) means the default, never the cwd. */
function homeOrDefault(codexHome) {
  return typeof codexHome === "string" && codexHome.length > 0 ? codexHome : defaultCodexHome();
}

function validDate(now) {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
}

function dayDir(sessions, date, utc) {
  const y = utc ? date.getUTCFullYear() : date.getFullYear();
  const m = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const d = utc ? date.getUTCDate() : date.getDate();
  return join(sessions, String(y), String(m).padStart(2, "0"), String(d).padStart(2, "0"));
}

function matchIn(dir, suffix) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
  return hit ? join(dir, hit) : null;
}

function walk(dir, suffix, depth) {
  const direct = matchIn(dir, suffix);
  if (direct || depth === 0) return direct;
  let names;
  try {
    names = readdirSync(dir).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const child = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch { /* vanished */ }
    if (!isDir) continue;
    const hit = walk(child, suffix, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** The rollout file of a thread, or null. Today's and yesterday's folders first, then the whole tree. */
export function findRolloutFile(threadId, { codexHome, now } = {}) {
  if (!threadId) return null;
  const sessions = join(homeOrDefault(codexHome), "sessions");
  now = validDate(now);
  const suffix = `-${threadId}.jsonl`;
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const tried = new Set();
  for (const date of [now, yesterday]) {
    for (const utc of [false, true]) {
      const dir = dayDir(sessions, date, utc);
      if (tried.has(dir)) continue;
      tried.add(dir);
      const hit = matchIn(dir, suffix);
      if (hit) return hit;
    }
  }
  return walk(sessions, suffix, 3);
}

/** The model and effort of the last turn a rollout recorded. Reads turn_context records only. */
export function lastTurnContext(path) {
  let last = null;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.includes('"turn_context"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "turn_context" || !row.payload) continue;
    const p = row.payload;
    const collab = p.collaboration_mode?.settings?.reasoning_effort ?? null;
    last = {
      model: p.model ?? p.collaboration_mode?.settings?.model ?? null,
      effort: p.effort ?? collab,
      effort_source: p.effort ? "turn" : collab ? "collaboration_mode" : null,
      turn_id: p.turn_id ?? null,
    };
  }
  return last;
}

/** The effort codex uses for a model when none is set, from its models_cache.json. */
export function defaultEffort(model, codexHome) {
  try {
    const cache = JSON.parse(readFileSync(join(homeOrDefault(codexHome), "models_cache.json"), "utf-8"));
    const entry = (cache?.models ?? []).find((m) => m?.slug === model);
    return typeof entry?.default_reasoning_level === "string" ? entry.default_reasoning_level : null;
  } catch {
    return null;
  }
}

function stderrWarn(message) {
  process.stderr.write(`${message}\n`);
}

function fixLines(pin) {
  if (!pin?.model || !pin?.effort) return "";
  return [
    `  In this session: /model, choose ${pin.model} and effort ${pin.effort}, then send your next message.`,
    `  At launch: codex -s danger-full-access -m ${pin.model} -c model_reasoning_effort="${pin.effort}"`,
    `  Every session: model = "${pin.model}" and model_reasoning_effort = "${pin.effort}" in ~/.codex/config.toml.`,
  ].join("\n");
}

/**
 * Compares the session's last recorded turn with the driver pin. Never
 * throws: status is "match", "mismatch" or "unverified", and the last two
 * also go to `warn`.
 */
export function checkSessionModel(options = {}) {
  const opts = options ?? {};
  const codexHome = homeOrDefault(opts.codexHome);
  const threadId = opts.threadId === undefined ? sessionThreadId() : opts.threadId || null;
  const pin = opts.pin ?? null;
  const policyName = opts.policyName ?? null;
  const sink = typeof opts.warn === "function" ? opts.warn : stderrWarn;
  const warn = (message) => {
    try {
      sink(message);
    } catch { /* a failing warn sink still gets the result */ }
  };
  const now = validDate(opts.now);
  const base = { pin, policy: policyName, thread_id: threadId, rollout_path: null, observed: null, checked_at: now.toISOString() };
  const unverified = (reason) => {
    const fix = fixLines(pin);
    const message =
      `session model check: unverified (${reason}). Check with /status that this session runs ` +
      `${pin?.model ?? "the driver pin"} at effort ${pin?.effort ?? "?"}; driver cost is priced at that pin.` +
      (fix ? `\n${fix}` : "");
    warn(message);
    return { ...base, status: "unverified", reason, message };
  };
  try {
    return compare({ codexHome, threadId, pin, policyName, warn, now, base, unverified });
  } catch (err) {
    return unverified(`the check failed: ${err?.message ?? err}`);
  }
}

function compare({ codexHome, threadId, pin, policyName, warn, now, base, unverified }) {
  const label = policyName ? `policy '${policyName}'` : "the policy";
  if (!pin?.model || !pin?.effort) return unverified("no driver pin to compare with");
  if (!threadId) return unverified("CODEX_THREAD_ID is not set, so this is not a command codex ran");
  const rollout = findRolloutFile(threadId, { codexHome, now });
  if (!rollout) return unverified(`no rollout file for thread ${threadId} under ${join(codexHome, "sessions")}`);
  base.rollout_path = rollout;

  let turn;
  try {
    turn = lastTurnContext(rollout);
  } catch (err) {
    return unverified(`cannot read ${rollout}: ${err?.code ?? err?.message ?? err}`);
  }
  if (!turn?.model) return unverified(`${rollout} has no turn_context yet`);

  let effort = turn.effort;
  let effortSource = turn.effort_source;
  if (!effort) {
    effort = defaultEffort(turn.model, codexHome);
    effortSource = effort ? "codex default" : null;
  }
  base.observed = { model: turn.model, effort, effort_source: effortSource };
  if (!effort && turn.model === pin.model) return unverified(`the session's effort for ${turn.model} is not recorded`);

  if (turn.model === pin.model && effort === pin.effort) {
    const message =
      `session model check: ok. This session runs ${pin.model} at effort ${pin.effort}, the driver pin of ${label}.`;
    return { ...base, status: "match", reason: null, message };
  }
  const message =
    `session model check: this session runs ${turn.model} at effort ${effort ?? "unknown"}` +
    `${effortSource ? ` (${effortSource})` : ""}, but ${label} pins the driver to ${pin.model} at effort ` +
    `${pin.effort}. Driver cost would be priced for a model that did not run.\n${fixLines(pin)}`;
  warn(message);
  return { ...base, status: "mismatch", reason: "model or effort differs from the driver pin", message };
}

/**
 * What codex's session files say each thread of a run ran on. A headless run
 * pins the model on the command line and its event stream never names it,
 * so this is the only record of what answered. Read-only, never throws.
 */
export function observedSessionModels(threadIds, { codexHome, pin, policyName = null, now } = {}) {
  const ids = [...new Set((threadIds ?? []).filter((t) => typeof t === "string" && t))];
  const threads = ids.map((threadId) => {
    const r = checkSessionModel({ codexHome, threadId, pin, policyName, now, warn: () => {} });
    return { thread_id: threadId, status: r.status, observed: r.observed, rollout_path: r.rollout_path, reason: r.reason };
  });
  let status = "unverified";
  if (threads.some((t) => t.status === "mismatch")) status = "mismatch";
  else if (threads.length > 0 && threads.every((t) => t.status === "match")) status = "match";
  return { status, pin: pin ?? null, threads };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'`);
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (key === "json") {
      out.json = true;
      continue;
    }
    if (key !== "project-root" && key !== "policy") throw new Error(`unknown flag --${key}`);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === "") throw new Error(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`session-model: ${err.message}\n`);
    return 2;
  }
  const projectRoot = resolve(args["project-root"] ?? process.cwd());
  let run = null;
  try {
    const { resolveRunPolicy } = await import("./run-policy.mjs");
    run = resolveRunPolicy({ projectRoot, policyArg: args.policy ?? null });
  } catch (err) {
    process.stderr.write(`session model check: unverified (the policy could not be resolved: ${err?.message ?? err}).\n`);
    if (args.json) process.stdout.write(JSON.stringify({ status: "unverified", reason: "policy unresolved" }) + "\n");
    return 1;
  }
  const result = checkSessionModel({ pin: run.driver.pin, policyName: run.name });
  if (args.json) {
    process.stdout.write(JSON.stringify({ ...result, policy_source: run.source, policy_path: run.path }) + "\n");
  } else if (result.status === "match") {
    process.stdout.write(`${result.message}\n`);
  }
  return result.status === "match" ? 0 : 1;
}

if (isMain(import.meta.url, process.argv[1])) {
  exitAfterFlush(await main(process.argv.slice(2)));
}
