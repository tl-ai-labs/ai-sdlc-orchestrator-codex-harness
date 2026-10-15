#!/usr/bin/env node
/**
 * plan-packets — Phase 4's planner packet, and the plan that comes back. The planner is a dispatched worker that sees
 * only its packet, so the plan's shape is held by the shipped schema in plugin/config/schemas/ and every child is
 * checked here before packets.json exists.
 *
 * Usage:
 *   node plan-packets.mjs --build --run-dir=<dir> --instruction=<file> [--inputs=<file>] [--previous=<result.json>]
 *   node plan-packets.mjs --accept=<result.json> --run-dir=<dir>
 *
 * --build writes <run-dir>/tp-plan-<n>.json and prints it with the --out path its dispatch writes. --inputs is a JSON
 * array of {path, reason, content?}; a missing or empty content is read from disk. Once a plan in this session is
 * refused, the next --build takes --previous=<that result>: its problems and the refused plan go into the new packet.
 * --accept reads a dispatch result (dispatch.mjs --out) and writes <run-dir>/packets.json.
 *
 * A session (one driver process, or one start-run session) builds at most PLAN_ATTEMPTS planner packets that reach
 * the planner, and stops after MAX_DISPATCH_FAILURES dispatches that bring back no reply. A resumed run is a new
 * session.
 *
 * Exit codes: 0 done; 1 the plan was refused or its dispatch failed (problems on stderr, nothing written), or the
 * session has had its attempts; 2 usage, or a run record, instruction or inputs file this script cannot use.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, readRunJson, UsageError } from "../codex/interactive-run.mjs";
import { FROZEN_FILE, readRegular } from "./lib/contract-lock.mjs";
import { firstMatch, hardcodedHit } from "./lib/off-limits.mjs";
import { isRunId } from "./lib/run-id.mjs";
import { guardedHit, insidePath, judgedPaths, realPath } from "./lib/write-guard.mjs";
import { projectOffLimits } from "./write-contract.mjs";
import { scan } from "./dispatch-sanitize.mjs";
import { isMain } from "./lib/is-main.mjs";
import { exitAfterFlush } from "./lib/exit.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = dirname(dirname(SCRIPT));

export const PLAN_ATTEMPTS = 3;
export const MAX_DISPATCH_FAILURES = 2;
export const PLAN_SCHEMA_FILES = Object.freeze({
  greenfield: "plan-packets.greenfield.json",
  brownfield: "plan-packets.brownfield.json",
});
export const MAX_INPUT_BYTES = 128 * 1024;
export const PLAN_FLAGS = Object.freeze({ value: ["run-dir", "instruction", "inputs", "previous", "accept"], boolean: ["build"] });

const MAX_PACKET_INPUT_BYTES = 384 * 1024;
/** The env files a plan may write. `.env` itself is the Phase 7 bootstrap's copy of `.env.test`, never a packet's. */
const PLAN_ENV_FILES = [".env.example", ".env.test"];
const MAX_PACKETS = 200;
/** Brownfield task types that change a file already on disk, so a missing target is a wrong path, not a new file. */
const EDIT_TASK_TYPES = new Set(["existing_file_edit", "patch_apply", "doc_update", "bug_fix_apply"]);
// Reasoning tokens count against the ceiling; the OpenAI adapter doubles it on truncation.
const PLAN_OUTPUT_TOKENS = 8000;
const PLAN_FIELDS = [
  "phase", "task_type", "subtype", "module", "instruction", "inputs", "output_schema_json", "acceptance", "budget",
  "artifact_path",
];
/** Run metadata: the script sets these from the run record, whatever a planner wrote there. */
const RUN_FIELDS = new Set(["id", "pass_id", "intent", "retry_count"]);
const FIELD_HINTS = {
  task_id: "the script numbers the packets itself",
  title: "put it in instruction",
  path: "the path a packet writes is artifact_path",
  type: "the work type is task_type",
  outputSchema: "give the child's schema as output_schema_json, a JSON string",
  depends_on: "list the packets in dependency order instead",
};
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const SCHEMA_KEYWORDS = ["type", "anyOf", "oneOf", "allOf", "enum", "const", "$ref", "not"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v) => JSON.stringify(v);
const firstLine = (v) => String(v ?? "").split("\n")[0];

export function loadPlanSchema(mode, pluginRoot = PLUGIN_ROOT) {
  return JSON.parse(readFileSync(join(pluginRoot, "config", "schemas", PLAN_SCHEMA_FILES[mode]), "utf-8"));
}

const childProperties = (schema) => schema.properties.packets.items.properties;

// ── the run ─────────────────────────────────────────────────────────────────

/** run-folder.mjs reads driver-events.jsonl through the built bridge, which only a headless run's folder needs. */
async function headlessRecords(runDir) {
  let folder;
  try {
    folder = await import("../codex/run-folder.mjs");
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new UsageError(`the dispatch bridge is not built (${err.message}); run verify-setup.mjs --fix first.`);
  }
  const records = folder.readRunRecords(runDir);
  return { settings: folder.runSettings(records), records };
}

/**
 * When the latest driver process began. Its first invocation_start opens it: the first after a run_end, or one a
 * different driver_pid wrote, so a driver killed before its run_end still ends its session.
 */
export function driverSessionStart(records) {
  let start = 0;
  let open = false;
  let pid;
  for (const r of records) {
    if (r.legacy) continue;
    if (r.kind === "run_end") {
      open = false;
      continue;
    }
    if (r.kind !== "invocation_start") continue;
    const otherDriver = pid !== undefined && r.driver_pid !== undefined && r.driver_pid !== pid;
    if (!open || otherDriver) start = Date.parse(r.at ?? "") || 0;
    open = true;
    pid = r.driver_pid;
  }
  return start;
}

function readJsonFile(path, maxBytes = 1024 * 1024) {
  const bytes = readRegular(path, maxBytes);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

export function briefTaskType(text, allowed) {
  const lines = String(text ?? "").split("\n");
  const at = lines.findIndex((l) => /^##\s+Task type\b/i.test(l));
  if (at === -1) return null;
  for (const line of lines.slice(at + 1)) {
    if (/^#/.test(line)) return null;
    const word = line.replace(/[`*\-\s]+/g, " ").trim().split(" ")[0];
    if (word) return allowed.includes(word) ? word : null;
  }
  return null;
}

/** run.json on the interactive route, driver-events.jsonl on the headless one. */
export async function readRunFacts(runDirArg, { pluginRoot = PLUGIN_ROOT } = {}) {
  const runDir = resolve(String(runDirArg));
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new UsageError(`--run-dir=${runDirArg} is not a folder.`);

  let rec = null;
  let sessionStartMs = 0;
  const session = readRunJson(runDir);
  if (session) {
    rec = session;
    const starts = Array.isArray(session.starts) ? session.starts : [];
    sessionStartMs = Date.parse(starts.at(-1)?.at ?? "") || 0;
  } else {
    const { settings: s, records } = await headlessRecords(runDir);
    if (s) {
      rec = { ...s, mode: s.run_mode === "greenfield" ? "greenfield" : "brownfield", project_root: s.cwd };
      sessionStartMs = driverSessionStart(records);
    }
  }
  if (!rec) {
    throw new UsageError(`${runDir} holds no run record (run.json or driver-events.jsonl): Phase 4 runs inside a run start-run.mjs or run.mjs started.`);
  }
  const runId = rec.run_id;
  if (!isRunId(runId)) throw new UsageError(`the run record in ${runDir} names no run id.`);
  const mode = rec.mode === "greenfield" ? "greenfield" : "brownfield";
  const canonicalRoot = basename(dirname(runDir)) === "runs" && basename(dirname(dirname(runDir))) === ".sdlc"
    ? dirname(dirname(dirname(runDir)))
    : null;
  const projectRoot = typeof rec.project_root === "string" ? resolve(rec.project_root) : canonicalRoot;
  if (!projectRoot) throw new UsageError(`the run record in ${runDir} names no project root.`);
  const codeDir = typeof rec.code_dir === "string" ? resolve(rec.code_dir) : mode === "greenfield" ? join(projectRoot, "src") : projectRoot;
  const codeRel = insidePath(projectRoot, codeDir);
  if (codeRel === null) throw new UsageError(`the run's code directory ${codeDir} is outside its project root ${projectRoot}.`);
  const runRel = insidePath(projectRoot, runDir);
  const schema = loadPlanSchema(mode, pluginRoot);

  const facts = {
    runDir, runId, mode, projectRoot, codeDir,
    stacksDir: join(pluginRoot, "skills", "pipeline", "stacks"),
    codeRel,
    runRel,
    notesPrefix: runRel ? `${runRel}/notes/` : null,
    schema,
    phases: childProperties(schema).phase.enum,
    taskTypes: childProperties(schema).task_type.enum ?? null,
    intent: null,
    contract: null,
    offLimits: [],
    briefTaskType: null,
    sessionStartMs,
  };

  if (mode === "brownfield") {
    // Gate 0 re-confirms the intent and the freeze records that value, which can differ from the handover's.
    const confirmed = readJsonFile(join(runDir, "provenance.json"))?.intent;
    const intent = typeof confirmed === "string" && confirmed ? confirmed : (rec.intent ?? null);
    if (typeof intent !== "string" || !intent) {
      throw new UsageError(`run ${runId} records no intent (run record or provenance.json): a brownfield plan carries one on every packet.`);
    }
    const contract = readJsonFile(join(runDir, FROZEN_FILE), 128 * 1024);
    if (!isObject(contract) || !Array.isArray(contract.allowlist) || !Array.isArray(contract.off_limits)) {
      throw new UsageError(`no frozen write contract at ${join(runDir, FROZEN_FILE)}: a brownfield plan comes after Gate 0 froze it.`);
    }
    if (contract.run_id !== runId) throw new UsageError(`${join(runDir, FROZEN_FILE)} is run ${contract.run_id}'s contract, not run ${runId}'s.`);
    facts.intent = intent;
    facts.contract = contract;
    facts.offLimits = contract.off_limits.filter((p) => typeof p === "string");
    const briefPaths = [join(runDir, "intent_brief.md"), ...(typeof rec.brief_path === "string" ? [rec.brief_path] : [])];
    for (const p of briefPaths) {
      const bytes = readRegular(p, 256 * 1024);
      if (!bytes) continue;
      facts.briefTaskType = briefTaskType(bytes.toString("utf8"), facts.taskTypes);
      break;
    }
  } else {
    facts.offLimits = projectOffLimits(projectRoot);
  }
  return facts;
}

// ── paths ───────────────────────────────────────────────────────────────────

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** What is wrong with a path's text, however it is anchored: a control character, or space around a name. */
function pathTextProblem(raw) {
  if (CONTROL_CHARS.test(raw)) return `${quote(raw)} holds a control character (a tab, a newline or a NUL); write the path on one line`;
  const names = raw.split("/");
  if (names.some((n) => n !== n.trim())) {
    return `${quote(raw)} has a space at the start or end of a name; write ${quote(names.map((n) => n.trim()).join("/"))}`;
  }
  return null;
}

/** A path as written, made project-relative, or the reason it cannot be one. A leading `./` is dropped. */
export function relPath(raw) {
  if (typeof raw !== "string") return { problem: `is ${quote(raw)}, not a path` };
  if (raw.trim() === "") return { problem: "is empty" };
  const text = pathTextProblem(raw);
  if (text) return { problem: text };
  if (raw.includes("\\")) return { problem: `${quote(raw)} holds a backslash; write the path with / between folders` };
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return { problem: `${quote(raw)} is absolute; write it relative to the project root` };
  const rel = raw.replace(/^(?:\.\/)+/, "");
  const names = rel.split("/");
  if (names.includes("..")) return { problem: `${quote(raw)} climbs out of its folder with ".."` };
  if (names.some((n) => n === "" || n === ".")) {
    return { problem: `${quote(raw)} is not a normalised path; write ${quote(posix.normalize(rel).replace(/\/+$/, ""))}` };
  }
  return { rel };
}

const ENV_PATTERNS = [".env", ".env.*"];
const isPlanEnvFile = (rel) => PLAN_ENV_FILES.includes(posix.basename(rel).toLowerCase());

/** The always-off-limits pattern `rel` matches. `envFile`: one a plan may write, so only its folder is judged. */
function hardHit(rel, { envFile = false } = {}) {
  if (!envFile) return hardcodedHit(rel);
  const folder = posix.dirname(rel);
  return folder === "." ? null : hardcodedHit(folder);
}

function offLimitsHit(facts, rel, { envFile = false } = {}) {
  const patterns = envFile ? facts.offLimits.filter((p) => !ENV_PATTERNS.includes(p)) : facts.offLimits;
  return hardHit(rel, { envFile }) ?? firstMatch(rel, patterns, { ci: true });
}

/**
 * What a slice names: a project-relative path, or (`absoluteOk`) an absolute one inside the project, the run folder
 * or the plugin's stack guides. `rel` is set for a file in the project, which is then named by it; any other keeps
 * its absolute path as its `label`.
 */
function slicePath(facts, raw, { absoluteOk = false } = {}) {
  if (!(absoluteOk && typeof raw === "string" && isAbsolute(raw))) {
    const r = relPath(raw);
    return r.problem ? r : { abs: join(facts.projectRoot, r.rel), rel: r.rel, label: r.rel };
  }
  const text = pathTextProblem(raw);
  if (text) return { problem: text };
  const inProject = insidePath(facts.projectRoot, raw);
  if (inProject === "") return { problem: `${quote(raw)} is the project folder, not a file` };
  if (inProject !== null) {
    const r = relPath(inProject);
    return r.problem ? r : { abs: join(facts.projectRoot, r.rel), rel: r.rel, label: r.rel };
  }
  if (insidePath(facts.runDir, raw) === null && insidePath(facts.stacksDir, raw) === null) {
    return { problem: `${quote(raw)} is outside the project, the run folder and the plugin's stack guides` };
  }
  return { abs: resolve(raw), rel: null, label: raw };
}

const sliceRoot = (facts, abs) => [facts.projectRoot, facts.runDir, facts.stacksDir].find((d) => insidePath(d, abs) !== null);

/** The off-limits pattern a slice's path matches as written, or null. */
function sliceHit(facts, at) {
  if (at.rel !== null) return offLimitsHit(facts, at.rel);
  return hardcodedHit(insidePath(sliceRoot(facts, at.abs), at.abs) ?? at.abs);
}

/** Why a slice's file may not go to a model: off-limits, or a link out of its folder, judged as the write guard judges a write. */
function readProblem(facts, at) {
  const root = sliceRoot(facts, at.abs);
  const { paths, leaves } = judgedPaths(root, at.abs);
  if (leaves) return `${quote(at.label)} leads outside ${root === facts.projectRoot ? "the project" : "its folder"} through a link`;
  for (const p of paths) {
    const hit = root === facts.projectRoot ? offLimitsHit(facts, p) : hardcodedHit(p);
    if (hit) return `${quote(at.label)} is off-limits (pattern ${quote(hit)}), so it does not go to a model`;
  }
  return null;
}

function locateRead(facts, raw, opts) {
  const at = slicePath(facts, raw, opts);
  if (at.problem) return at;
  const problem = readProblem(facts, at);
  return problem ? { problem } : at;
}

function secretProblem(label, content) {
  const found = scan(content, { maxFindings: 1 })[0];
  return found ? `${quote(label)} holds what looks like a secret (${found.name}, line ${found.line}), so it does not go to a model; give a slice without it` : null;
}

/** `whole`: the file a packet rewrites, which it must read in full. */
function readText(abs, label, { whole = false } = {}) {
  const real = realPath(abs);
  let st;
  try {
    st = lstatSync(real);
  } catch {
    return { problem: `${quote(label)} has no file on disk to read`, missing: true };
  }
  if (!st.isFile()) return { problem: `${quote(label)} is not a file` };
  if (st.size > MAX_INPUT_BYTES) {
    const kb = Math.ceil(st.size / 1024);
    return {
      problem: whole
        ? `${quote(label)} is ${kb} KB, over the ${MAX_INPUT_BYTES / 1024} KB a packet that rewrites a whole file may read; plan a smaller file or a narrower change`
        : `${quote(label)} is ${kb} KB, over the ${MAX_INPUT_BYTES / 1024} KB a slice read from disk may hold; give the part the worker needs as content`,
    };
  }
  const bytes = readRegular(real, MAX_INPUT_BYTES);
  if (!bytes) return { problem: `${quote(label)} could not be read` };
  if (bytes.includes(0)) return { problem: `${quote(label)} is not a text file` };
  return { content: bytes.toString("utf8") };
}

/**
 * The reason `rel` is not a path this run's plan may write, `{warning}` for a miss a non-strict contract allows, or {}.
 * Brownfield follows the write guard's order: the run's guarded records, the always-off-limits list, the run folder,
 * the contract's off-limits, then its allowlist. The run folder is matched without regard to case, as the disk does.
 */
export function targetProblem(facts, rel) {
  const lower = rel.toLowerCase();
  const runLower = facts.runRel === null ? null : facts.runRel.toLowerCase();
  const inNotes = facts.notesPrefix !== null && rel.startsWith(facts.notesPrefix) && rel.length > facts.notesPrefix.length;
  const inRunFolder = runLower !== null && (lower === runLower || lower.startsWith(`${runLower}/`));
  const notes = facts.notesPrefix
    ? `a note that is not shipped code goes under ${facts.notesPrefix}`
    : "this run's folder is outside the project, so a plan writes no notes";
  const misspeltNotes = facts.notesPrefix !== null && lower.startsWith(facts.notesPrefix.toLowerCase());
  const runFolder = (what) =>
    misspeltNotes
      ? { problem: `${quote(rel)} spells this run's notes folder another way; write it under ${facts.notesPrefix}` }
      : { problem: `${quote(rel)} ${what}; ${notes}` };
  if (facts.mode === "brownfield") {
    const c = facts.contract;
    const g = guardedHit(rel, facts.runId);
    if (g) return { problem: `${quote(rel)} is ${g}, a record the plugin keeps for the run` };
    const hard = hardcodedHit(rel);
    if (hard) return { problem: `${quote(rel)} matches always-off-limits pattern ${quote(hard)}` };
    if (inNotes) return {};
    if (inRunFolder) return runFolder("is in the run folder beside the run's own records");
    const off = firstMatch(rel, c.off_limits, { ci: true });
    if (off) return { problem: `${quote(rel)} matches off-limits pattern ${quote(off)}` };
    if (firstMatch(rel, c.allowlist)) return {};
    const why = `${quote(rel)} is not in the run's frozen allowlist (${c.allowlist.map(quote).join(", ")}); ${notes}`;
    return c.strict === false ? { warning: `${why}. Allowed because the contract is not strict.` } : { problem: why };
  }
  const hard = hardHit(rel, { envFile: isPlanEnvFile(rel) });
  if (hard) return { problem: `${quote(rel)} matches always-off-limits pattern ${quote(hard)}` };
  if (inNotes) return {};
  if (inRunFolder || lower === ".sdlc" || lower.startsWith(".sdlc/")) return runFolder("is among the run records");
  if (facts.codeRel === "" || rel.startsWith(`${facts.codeRel}/`)) return {};
  return { problem: `${quote(rel)} is outside the code directory ${facts.codeRel}/; ${notes}` };
}

function checkTarget(facts, raw) {
  const r = relPath(raw);
  if (r.problem) return r;
  const { paths, leaves } = judgedPaths(facts.projectRoot, join(facts.projectRoot, r.rel));
  if (leaves) return { problem: `${quote(r.rel)} leads outside the project through a link` };
  const warnings = [];
  for (const p of paths) {
    const v = targetProblem(facts, p);
    if (v.problem) return { problem: p === r.rel ? v.problem : `${quote(r.rel)} resolves to ${quote(p)} through a link: ${v.problem}` };
    if (v.warning) warnings.push(v.warning);
  }
  return { rel: r.rel, warnings };
}

// ── the child's own schema ──────────────────────────────────────────────────

export function childSchemaProblem(node, at = "", depth = 0) {
  const where = at ? `${at} ` : "";
  const sub = (name) => (at ? `${at}.${name}` : name);
  if (depth > 32) return `${where}nests too deep`;
  if (!isObject(node)) return `${where}is not a JSON Schema object`;
  // GeminiFlashAdapter's marker for a markdown reply.
  if ("__free_text__" in node) return node.__free_text__ === true && Object.keys(node).length === 1 ? null : `${where}mixes __free_text__ with a schema`;
  if (!SCHEMA_KEYWORDS.some((k) => k in node)) {
    return `${where}names no type (it holds ${Object.keys(node).slice(0, 4).map(quote).join(", ") || "nothing"}); give each value a {"type": ...} schema`;
  }
  if ("type" in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.length === 0 || !types.every((t) => JSON_TYPES.has(t))) return `${where}type ${quote(node.type)} is not a JSON Schema type`;
  }
  if ("required" in node && !(Array.isArray(node.required) && node.required.every((r) => typeof r === "string"))) {
    return `${where}required is not a list of property names`;
  }
  const kids = [];
  if ("properties" in node) {
    if (!isObject(node.properties)) return `${where}properties is not an object`;
    for (const [k, v] of Object.entries(node.properties)) kids.push([v, sub(`properties.${k}`)]);
  }
  if ("additionalProperties" in node && typeof node.additionalProperties !== "boolean") {
    kids.push([node.additionalProperties, sub("additionalProperties")]);
  }
  if ("items" in node) {
    if (Array.isArray(node.items)) node.items.forEach((v, i) => kids.push([v, sub(`items[${i}]`)]));
    else kids.push([node.items, sub("items")]);
  }
  if ("prefixItems" in node) {
    if (!Array.isArray(node.prefixItems)) return `${where}prefixItems is not a list`;
    node.prefixItems.forEach((v, i) => kids.push([v, sub(`prefixItems[${i}]`)]));
  }
  if ("not" in node) kids.push([node.not, sub("not")]);
  for (const k of ["$defs", "definitions"]) {
    if (!(k in node)) continue;
    if (!isObject(node[k])) return `${where}${k} is not an object`;
    for (const [name, v] of Object.entries(node[k])) kids.push([v, sub(`${k}.${name}`)]);
  }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (!(k in node)) continue;
    if (!Array.isArray(node[k]) || node[k].length === 0) return `${where}${k} is not a non-empty list`;
    node[k].forEach((v, i) => kids.push([v, sub(`${k}[${i}]`)]));
  }
  for (const [v, path] of kids) {
    const p = childSchemaProblem(v, path, depth + 1);
    if (p) return p;
  }
  return null;
}

// ── a plan ──────────────────────────────────────────────────────────────────

export function readDispatchResult(path) {
  const abs = resolve(String(path));
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf-8"));
  } catch (err) {
    throw new UsageError(`cannot read the dispatch result ${abs}: ${err?.code === "ENOENT" ? "no such file" : err.message}.`);
  }
  if (!isObject(parsed) || !isObject(parsed.result)) throw new UsageError(`${abs} is not a dispatch result (the --out file of dispatch.mjs).`);
  return { path: abs, result: parsed };
}

/** A dispatch that brought back no reply: nothing in it is the planner's to fix. A cut-off reply is the planner's. */
export function dispatchFailure(result) {
  const r = result.result;
  if (r.success === true || String(r.terminal_reason ?? "").startsWith("output_cap")) return null;
  return { terminal_reason: String(r.terminal_reason ?? "unknown"), error: firstLine(r.error ?? "no error recorded").trim().replace(/\.+$/, "") };
}

function planValue(result) {
  const r = result.result;
  if (r.success !== true) {
    return { problem: "The reply was cut off at its output ceiling before the plan was complete. Plan fewer packets, or shorter instructions." };
  }
  let value = r.result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { problem: "The reply is not JSON." };
    }
  }
  if (isObject(value) && value._truncated === true) return { problem: "The reply was cut off at its output ceiling. Plan fewer packets, or shorter instructions." };
  if (isObject(value) && Object.keys(value).length === 1 && typeof value.raw === "string") return { problem: "The reply is not JSON." };
  return { value };
}

/**
 * The plan in a dispatch result: `packets` in the canonical shape when it passes, else `problems`. A dispatch that
 * failed also sets `failure`, and its one problem says so.
 */
export function judgePlan(facts, result) {
  const events = Array.isArray(result.events) ? result.events.filter(isObject) : [];
  const event = events[0] ?? null;
  if (event?.phase && event.phase !== "plan_task_packets") throw new UsageError(`that result is a ${event.phase} dispatch, not a plan.`);
  if (event?.pass && event.pass !== facts.runId) throw new UsageError(`that result is from run ${event.pass}, not run ${facts.runId}.`);

  const problems = [];
  const warnings = [];
  const out = { problems, warnings, packets: null, value: undefined, failure: dispatchFailure(result) };
  if (out.failure) {
    problems.push(`The plan dispatch failed (terminal_reason ${out.failure.terminal_reason}): ${out.failure.error}.`);
    return out;
  }
  const got = planValue(result);
  if (got.problem) {
    problems.push(got.problem);
    return out;
  }
  const plan = got.value;
  out.value = plan;
  if (Array.isArray(plan)) {
    problems.push('The plan is a bare list. Return an object, {"packets": [...]}.');
    return out;
  }
  if (!isObject(plan)) {
    problems.push(`The plan is ${plan === null ? "null" : `a ${typeof plan}`}. Return an object, {"packets": [...]}.`);
    return out;
  }
  for (const k of Object.keys(plan)) if (k !== "packets") problems.push(`The plan has a field ${quote(k)}; its only field is "packets".`);
  if (!Array.isArray(plan.packets) || plan.packets.length === 0) {
    problems.push('"packets" must be a non-empty list of packets.');
    return out;
  }
  if (plan.packets.length > MAX_PACKETS) {
    problems.push(`The plan has ${plan.packets.length} packets, more than ${MAX_PACKETS}. Plan file-sized units, one packet per file.`);
    return out;
  }

  const children = plan.packets.map((raw, i) => judgeFields(facts, raw, `packets[${i}]`, problems, warnings));

  // Targets first: an input may name a file an earlier packet writes.
  const writers = new Map();
  children.forEach((c, i) => {
    if (!c?.artifact_path) return;
    const key = c.artifact_path.toLowerCase();
    const w = writers.get(key);
    if (!w) writers.set(key, { path: c.artifact_path, indices: [i] });
    else if (w.path !== c.artifact_path) {
      problems.push(`packets[${i}] writes ${quote(c.artifact_path)}, the file packets[${w.indices[0]}] writes as ${quote(w.path)}. Spell one file one way.`);
    } else w.indices.push(i);
  });
  children.forEach((c, i) => {
    if (c) c.inputs = judgeInputs(facts, c.rawInputs, `packets[${i}]`, i, writers, problems, warnings, c.task_type);
  });
  for (const w of writers.values()) {
    for (let n = 1; n < w.indices.length; n++) {
      const i = w.indices[n];
      const raw = Array.isArray(children[i].rawInputs) ? children[i].rawInputs : [];
      const lists = raw.some((s) => isObject(s) && slicePath(facts, s.path, { absoluteOk: true }).rel?.toLowerCase() === w.path.toLowerCase());
      if (!lists) {
        problems.push(
          `packets[${i}] writes ${quote(w.path)} after packets[${w.indices[n - 1]}] does; list ${quote(w.path)} among its inputs ` +
            'with content "" so it starts from the file that packet leaves, or plan one packet for the file.',
        );
      }
    }
  }
  if (problems.length > 0) return out;

  const seq = {};
  out.packets = children.map((c) => {
    seq[c.phase] = (seq[c.phase] ?? 0) + 1;
    return {
      id: `tp_${c.phase}_${String(seq[c.phase]).padStart(3, "0")}`,
      phase: c.phase,
      task_type: c.task_type,
      ...(c.subtype ? { subtype: c.subtype } : {}),
      module: c.module,
      instruction: c.instruction,
      inputs: c.inputs,
      outputSchema: c.outputSchema,
      acceptance: c.acceptance,
      budget: c.budget,
      retry_count: 0,
      pass_id: facts.runId,
      ...(facts.mode === "brownfield" ? { intent: facts.intent } : {}),
      ...(c.artifact_path ? { artifact_path: c.artifact_path } : {}),
    };
  });
  return out;
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

function judgeFields(facts, raw, at, problems, warnings) {
  const fail = (msg) => problems.push(`${at}${msg}`);
  if (!isObject(raw)) {
    fail(` is ${Array.isArray(raw) ? "a list" : `a ${raw === null ? "null" : typeof raw}`}, not a packet object.`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (PLAN_FIELDS.includes(k) || RUN_FIELDS.has(k)) continue;
    fail(` has a field ${quote(k)} the plan does not take: ${FIELD_HINTS[k] ?? `a packet's fields are ${PLAN_FIELDS.join(", ")}`}.`);
  }
  const brown = facts.mode === "brownfield";
  for (const k of PLAN_FIELDS) {
    if (k in raw) continue;
    if (k === "subtype" || (k === "artifact_path" && !brown)) continue;
    fail(` has no ${k}.`);
  }

  const c = { rawInputs: raw.inputs };
  if ("phase" in raw) {
    if (facts.phases.includes(raw.phase)) c.phase = raw.phase;
    else fail(`.phase ${quote(raw.phase)} is not a phase a planned packet takes. Use one of: ${facts.phases.join(", ")}.`);
  }
  if ("task_type" in raw) {
    const t = raw.task_type;
    if (facts.taskTypes ? !facts.taskTypes.includes(t) : !(typeof t === "string" && /^[a-z][a-z0-9_]*$/.test(t))) {
      fail(facts.taskTypes
        ? `.task_type ${quote(t)} is not a brownfield task type. Use one of: ${facts.taskTypes.join(", ")}.`
        : `.task_type ${quote(t)} is not a snake_case work type, such as controller_handler or test_unit.`);
    } else if (facts.briefTaskType && t !== facts.briefTaskType) {
      fail(`.task_type ${quote(t)} differs from the intent brief's task type; every packet in this run is ${quote(facts.briefTaskType)}.`);
    } else c.task_type = t;
  }
  if (raw.subtype !== undefined && raw.subtype !== null && typeof raw.subtype !== "string") fail(".subtype must be a string or null.");
  else c.subtype = nonEmpty(raw.subtype) ? raw.subtype.trim() : null;
  if ("module" in raw) {
    if (nonEmpty(raw.module) && raw.module.length <= 64 && !raw.module.includes("\n")) c.module = raw.module.trim();
    else fail(".module must be a short name, such as auth or cross.");
  }
  if ("instruction" in raw) {
    if (nonEmpty(raw.instruction)) c.instruction = raw.instruction.trim();
    else fail(".instruction is empty.");
  }
  if ("inputs" in raw && !Array.isArray(raw.inputs)) {
    fail(`.inputs is ${typeof raw.inputs === "string" ? "a string" : isObject(raw.inputs) ? "an object" : quote(raw.inputs)}; give a list of {"path", "content", "reason"} slices, [] when the worker reads none.`);
  }
  if ("output_schema_json" in raw) {
    const s = raw.output_schema_json;
    let parsed;
    let ok = typeof s === "string";
    if (!ok) fail(".output_schema_json must be a string holding the child's JSON Schema, JSON-encoded.");
    else {
      try {
        parsed = JSON.parse(s);
      } catch {
        ok = false;
        fail(`.output_schema_json does not parse as JSON: ${quote(s.slice(0, 80))}. Encode a JSON Schema object, such as {"type":"object","properties":{"content":{"type":"string"}},"required":["content"]}.`);
      }
    }
    if (ok) {
      const p = childSchemaProblem(parsed);
      if (p) fail(`.output_schema_json ${p}.`);
      else c.outputSchema = parsed;
    }
  }
  if ("acceptance" in raw) {
    const a = raw.acceptance;
    if (Array.isArray(a) && a.length > 0 && a.every(nonEmpty)) c.acceptance = a.map((x) => x.trim());
    else fail(".acceptance must be a non-empty list of testable bullets, each a non-empty string.");
  }
  if ("budget" in raw) {
    const b = raw.budget;
    const whole = (n) => Number.isInteger(n) && n > 0;
    if (isObject(b) && whole(b.maxInputTokens) && whole(b.maxOutputTokens) && Object.keys(b).length === 2) {
      c.budget = { maxInputTokens: b.maxInputTokens, maxOutputTokens: b.maxOutputTokens };
    } else fail(`.budget must be {"maxInputTokens": <whole number>, "maxOutputTokens": <whole number>}, got ${quote(b)}.`);
  }
  if (raw.artifact_path === null && brown) fail(".artifact_path is null; every brownfield packet names the one path it writes.");
  else if (raw.artifact_path !== undefined && raw.artifact_path !== null) {
    const t = checkTarget(facts, raw.artifact_path);
    if (t.problem) fail(`.artifact_path ${t.problem}.`);
    else {
      c.artifact_path = t.rel;
      warnings.push(...t.warnings.map((w) => `${at}.artifact_path ${w}`));
    }
  }
  return c;
}

/**
 * A worker writes the whole file it is given, so the file a packet writes, and a file an earlier packet writes, reach
 * it whole: the first read from disk here, the second at Phase 5, once that packet has run. Either one given as a
 * slice is refused.
 */
function judgeInputs(facts, inputs, at, index, writers, problems, warnings, taskType) {
  if (!Array.isArray(inputs)) return null;
  const out = [];
  let bytes = 0;
  inputs.forEach((s, j) => {
    const where = `${at}.inputs[${j}]`;
    if (typeof s === "string") {
      problems.push(`${where} is a string (${quote(s.slice(0, 60))}); give {"path", "content", "reason"}, with content "" to have the file read from disk.`);
      return;
    }
    if (!isObject(s) || typeof s.path !== "string" || typeof s.content !== "string" || typeof s.reason !== "string") {
      problems.push(`${where} must be {"path": string, "content": string, "reason": string}.`);
      return;
    }
    for (const k of Object.keys(s)) if (!["path", "content", "reason"].includes(k)) problems.push(`${where} has a field ${quote(k)}; a slice holds path, content and reason.`);
    if (!nonEmpty(s.reason)) problems.push(`${where}.reason is empty; say why the worker needs it.`);
    const loc = slicePath(facts, s.path, { absoluteOk: true });
    if (loc.problem) {
      problems.push(`${where}.path ${loc.problem}.`);
      return;
    }
    const w = loc.rel === null ? undefined : writers.get(loc.rel.toLowerCase());
    const earlier = w ? w.indices.filter((k) => k < index) : [];
    const own = w ? w.indices.includes(index) : false;
    const given = s.content.trim() !== "";
    // A plan's own .env.example holds no values, and its .env.test only test ones.
    const planFixture = earlier.length > 0 && isPlanEnvFile(loc.rel);
    const hit = planFixture ? offLimitsHit(facts, loc.rel, { envFile: true }) : sliceHit(facts, loc);
    if (hit) {
      problems.push(`${where}.path ${quote(loc.label)} is off-limits (pattern ${quote(hit)}), so it does not go to a model.`);
      return;
    }
    if (earlier.length > 0) {
      if (given) {
        problems.push(`${where} gives content for ${quote(loc.rel)}, which packets[${earlier.at(-1)}] writes first; leave content "" so the worker gets the file as that packet leaves it.`);
        return;
      }
      out.push({ path: loc.rel, content: "", reason: s.reason.trim() });
      return;
    }
    if (own && given) {
      problems.push(`${where} gives content for ${quote(loc.rel)}, the file this packet writes; leave content "" so the worker gets the whole file.`);
      return;
    }
    let content = s.content;
    if (!given) {
      const blocked = readProblem(facts, loc);
      const read = blocked ? { problem: blocked } : readText(loc.abs, loc.label, { whole: own });
      const edits = facts.mode === "brownfield" && EDIT_TASK_TYPES.has(taskType);
      if (read.missing && own && !edits) {
        // The plan rules tell the planner to list the file it writes with content "": for a new file that is empty.
        warnings.push(`${where}.path ${quote(loc.rel)} is the file this packet creates; nothing is on disk yet, so the input was left out.`);
        return;
      }
      if (read.problem) {
        const later = w ? w.indices.filter((k) => k > index) : [];
        problems.push(
          read.missing && own
            ? `${where}.path ${quote(loc.rel)} is not on disk, but task_type ${quote(taskType)} changes a file that already exists. Fix the path, or plan the packet as new_file_add.`
            : read.missing && later.length > 0
              ? `${where} reads ${quote(loc.rel)}, which packets[${later[0]}] writes later. List the packets in dependency order.`
              : `${where}.path ${read.problem}.`,
        );
        return;
      }
      content = read.content;
    }
    const secret = secretProblem(loc.label, content);
    if (secret) {
      problems.push(`${where}.content ${secret}.`);
      return;
    }
    bytes += Buffer.byteLength(content);
    out.push({ path: loc.label, content, reason: s.reason.trim() });
  });
  if (bytes > MAX_PACKET_INPUT_BYTES) {
    problems.push(`${at}.inputs hold ${Math.ceil(bytes / 1024)} KB, over the ${MAX_PACKET_INPUT_BYTES / 1024} KB one packet may carry. Slice them.`);
  }
  return out;
}

// ── the planner packet ──────────────────────────────────────────────────────

/** The rules the planner is told, from the run record. The checks above hold it to each of them. */
export function planRules(facts) {
  const lines = [
    "## Plan rules",
    "These hold for every packet. A plan that breaks one is refused and planned again.",
    "",
    "- List the packets in dependency order: each runs only after every packet before it.",
    "- One packet per file. A later packet changes a file an earlier packet writes only when it lists that file among its inputs with content \"\": it then starts from the file that packet leaves.",
    "- Paths are relative to the project root, with / between folders, and never climb out with `..`. A stack guide keeps the absolute path it was given to you under.",
    `- Leave an input's content "" to have the whole file read when the packet runs (at most ${MAX_INPUT_BYTES / 1024} KB). It is always "" for the file the packet writes and for a file an earlier packet writes; any other input may be a slice.`,
    "- output_schema_json is the JSON Schema the worker's reply must match, encoded as a JSON string.",
    "- budget.maxOutputTokens: 3000 for a source, test or doc file; 5000 for a large one. maxInputTokens: about the inputs' size in tokens plus 2000.",
    `- Run id ${facts.runId}. ${facts.runRel ? `The run's records (requirements.md, design.md) are under ${facts.runRel}/.` : ""}`.trimEnd(),
    facts.notesPrefix
      ? `- A note that is not shipped code (a reproduction, a diagnosis) is written under ${facts.notesPrefix}.`
      : "- This run's folder is outside the project, so the plan writes no notes.",
  ];
  if (facts.mode === "brownfield") {
    lines.push(
      `- Every packet's artifact_path matches the run's frozen allowlist: ${facts.contract.allowlist.map((g) => `\`${g}\``).join(", ")}, or is a note.`,
      `- Never name these, as a target or an input: ${facts.offLimits.map((g) => `\`${g}\``).join(", ")}.`,
    );
    if (facts.briefTaskType) lines.push(`- Every packet's task_type is \`${facts.briefTaskType}\`, the one the intent brief names.`);
  } else {
    lines.push(
      `- Generated code goes under \`${facts.codeRel || "."}/\`; artifact_path is null only for a packet that writes no file.`,
      "- Never name secrets or tool config (`.env`, `.git/`, `.codex/`, `.agents/`) as an input or a target. `.env.example` and `.env.test` may be targets, and a later packet may read one an earlier packet writes.",
    );
  }
  return lines.join("\n");
}

function nextPlanSeq(runDir) {
  let max = 0;
  for (const name of readdirSync(runDir)) {
    const m = /^tp-plan-(\d+)(?:-result)?\.json$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(3, "0");
}

/** The packet number a result answers: its task id, else its file name. */
function resultSeq(result, path) {
  const id = Array.isArray(result.events) && isObject(result.events[0]) ? result.events[0].task_id : null;
  const m = (typeof id === "string" && /^tp_plan_(\d+)$/.exec(id)) || /^tp-plan-(\d+)-result\.json$/.exec(basename(path));
  return m ? Number(m[1]) : null;
}

function resultState(facts, path) {
  if (!existsSync(path)) return { state: "pending" };
  let judged;
  try {
    judged = judgePlan(facts, readDispatchResult(path).result);
  } catch {
    return { state: "unreadable" };
  }
  if (judged.failure) return { state: "failed", failure: judged.failure };
  return { state: judged.problems.length > 0 ? "refused" : "passes" };
}

/**
 * The planner packets this session built, oldest first, each with what its dispatch brought back. A packet file
 * older than the session belongs to an earlier one: --build writes each packet once, and a resumed run starts its
 * attempts again.
 */
export function planHistory(facts) {
  const out = [];
  for (const name of readdirSync(facts.runDir)) {
    const m = /^tp-plan-(\d+)\.json$/.exec(name);
    if (!m) continue;
    let st;
    try {
      st = statSync(join(facts.runDir, name));
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < facts.sessionStartMs) continue;
    const resultPath = join(facts.runDir, `tp-plan-${m[1]}-result.json`);
    out.push({ seq: Number(m[1]), resultPath, ...resultState(facts, resultPath) });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Every packet that reached the planner, or may have: all but a dispatch that brought back no reply. */
const attemptsIn = (history) => history.filter((e) => e.state !== "failed");
const lastRefused = (history) => history.findLast((e) => e.state === "refused") ?? null;
const samePath = (a, b) => realPath(a) === realPath(b);

/** A problem here is the conductor's command, not the planner's, so it exits 2 and is not an attempt. */
function conductorInputs(facts, path) {
  if (!path) return [];
  let list;
  try {
    list = JSON.parse(readFileSync(resolve(path), "utf-8"));
  } catch (err) {
    throw new UsageError(`cannot read --inputs=${path}: ${err?.code === "ENOENT" ? "no such file" : err.message}.`);
  }
  if (!Array.isArray(list)) throw new UsageError(`--inputs=${path} must hold a JSON list of {"path", "reason"} slices.`);
  const problems = [];
  const out = [];
  list.forEach((s, i) => {
    const where = `inputs[${i}]`;
    if (!isObject(s) || typeof s.path !== "string" || !nonEmpty(s.reason) || (s.content !== undefined && typeof s.content !== "string")) {
      problems.push(`${where} must be {"path": string, "reason": string}, with an optional "content" string.`);
      return;
    }
    const at = locateRead(facts, s.path, { absoluteOk: true });
    if (at.problem) {
      problems.push(`${where}.path ${at.problem}.`);
      return;
    }
    let content = s.content ?? "";
    if (content.trim() === "") {
      const read = readText(at.abs, at.label);
      if (read.problem) {
        problems.push(`${where}.path ${read.problem}.`);
        return;
      }
      content = read.content;
    }
    const secret = secretProblem(at.label, content);
    if (secret) {
      problems.push(`${where}.content ${secret}.`);
      return;
    }
    out.push({ path: at.label, content, reason: s.reason.trim() });
  });
  const bytes = out.reduce((n, s) => n + Buffer.byteLength(s.content), 0);
  if (bytes > MAX_PACKET_INPUT_BYTES) {
    problems.push(`the slices hold ${Math.ceil(bytes / 1024)} KB, over the ${MAX_PACKET_INPUT_BYTES / 1024} KB one packet may carry; slice the largest.`);
  }
  if (problems.length) throw new UsageError(`--inputs=${path} was not used; nothing was written:\n${numbered(problems)}`);
  return out;
}

const MAX_LISTED = 30;
const numbered = (items) => {
  const shown = items.slice(0, MAX_LISTED).map((p, i) => `${i + 1}. ${p}`);
  if (items.length > MAX_LISTED) shown.push(`${MAX_LISTED + 1}. And ${items.length - MAX_LISTED} more problems of the kinds above.`);
  return shown.join("\n");
};

/**
 * The next planner packet, or `{stop}` when this session may build no more. `history` is planHistory's; once a plan
 * in it is refused, `previous` must be that result, so its problems reach the planner. A `previous` from an earlier
 * session (a resumed run) is carried the same way.
 */
export function buildPlanPacket(facts, { instruction, inputs = [], previous = null, seq = "001", history = [] }) {
  const failed = history.filter((e) => e.state === "failed");
  if (failed.length >= MAX_DISPATCH_FAILURES) return { stop: failureStop(failed.length, failed.at(-1).failure) };
  const passing = history.find((e) => e.state === "passes");
  if (passing) throw new UsageError(`${passing.resultPath} holds a plan that passes: run --accept on it instead of planning again.`);
  const used = attemptsIn(history);
  const refused = lastRefused(history);
  if (used.length >= PLAN_ATTEMPTS) return { stop: limitStop(facts, (refused ?? used.at(-1)).resultPath) };
  const judged = previous ? judgePlan(facts, previous.result) : null;
  if (judged?.failure) throw new UsageError(`${previous.path} is a dispatch that failed, with no plan in it for the planner to correct: drop --previous.`);
  if (judged && judged.problems.length === 0) throw new UsageError(`${previous.path} holds a plan that passes: run --accept on it instead of planning again.`);
  if (refused && !(previous && samePath(previous.path, refused.resultPath))) {
    throw new UsageError(
      previous
        ? `--previous names ${previous.path}, but this session's last refused plan is ${refused.resultPath}: pass --previous='${refused.resultPath}'.`
        : `the planner's last plan, ${refused.resultPath}, was refused: add --previous='${refused.resultPath}' so the next packet carries its problems.`,
    );
  }
  const attempt = used.length + 1;
  const parts = [instruction.trim(), "", planRules(facts)];
  const slices = [...inputs];
  if (judged) {
    parts.push(
      "",
      "## Your previous plan was refused",
      "Return a corrected plan. Fix every problem below; keep what was not named.",
      numbered(judged.problems),
    );
    const plan = judged.value === undefined ? null : JSON.stringify(judged.value, null, 2);
    if (plan && Buffer.byteLength(plan) <= MAX_INPUT_BYTES) {
      slices.push({
        path: insidePath(facts.projectRoot, previous.path) ?? previous.path,
        content: plan,
        reason: "The plan you returned last time, refused for the problems listed in the instruction.",
      });
    }
  }
  const text = parts.join("\n");
  const size = text.length + JSON.stringify(slices).length + JSON.stringify(facts.schema).length;
  const packet = {
    id: `tp_plan_${seq}`,
    phase: "plan_task_packets",
    task_type: "plan",
    module: "cross",
    instruction: text,
    inputs: slices,
    outputSchema: facts.schema,
    acceptance: [
      "Returns one object whose packets list holds the whole plan, in dependency order.",
      "Every packet keeps to the plan rules in the instruction.",
      "Each output_schema_json parses to a JSON Schema object.",
    ],
    budget: { maxInputTokens: Math.ceil(size / 4 / 1000) * 1000 + 2000, maxOutputTokens: PLAN_OUTPUT_TOKENS },
    retry_count: attempt - 1,
    pass_id: facts.runId,
    ...(facts.mode === "brownfield" ? { intent: facts.intent, ...(facts.runRel ? { artifact_path: `${facts.runRel}/packets.json` } : {}) } : {}),
  };
  return { packet, attempt };
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

function limitStop(facts, resultPath) {
  const wider = facts.mode === "brownfield" ? " A file the job needs outside the frozen allowlist takes a new run, whose Gate 0 confirms the wider scope." : "";
  return {
    head: `plan-packets: the planner has had its ${PLAN_ATTEMPTS} attempts in this session and no plan passed. Do not dispatch another plan.`,
    record: {
      reason: `Phase 4: the planner returned no plan that passes plan-packets.mjs in ${PLAN_ATTEMPTS} attempts.`,
      needs:
        `See why with node '${SCRIPT}' --accept='${resultPath}' --run-dir='${facts.runDir}'. To steer the next plan, edit ` +
        `${join(facts.runDir, "plan-instruction.md")} (the files each packet changes, and the design sections they come from), ` +
        `then resume the run: Phase 4 plans again from that file, with ${PLAN_ATTEMPTS} new attempts.${wider}`,
    },
  };
}

function failureStop(count, failure) {
  return {
    head: `plan-packets: the plan dispatch failed ${count} times in this session. Do not dispatch another plan.`,
    record: {
      reason: `Phase 4: the plan dispatch failed ${count} times (terminal_reason ${failure.terminal_reason}): ${failure.error}.`,
      needs:
        `The planner's model sent no reply: ${failure.error}. Fix what that names (a usage limit, an API key, the network), ` +
        "then resume the run: Phase 4 plans again.",
    },
  };
}

function stopMessage(facts, stop) {
  return (
    `${stop.head}\nStop the run. On the run.mjs route write ${join(facts.runDir, "stop.json")}:\n${JSON.stringify(stop.record)}\n` +
    "In a session, tell the user why and record the end with --outcome=stopped.\n"
  );
}

// ── the command ─────────────────────────────────────────────────────────────

export async function main(argv = [], deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const args = parseFlags(argv, { ...PLAN_FLAGS, script: "plan-packets.mjs" });
    const build = args.build === true;
    if (build === (args.accept !== undefined)) throw new UsageError("give one of --build or --accept=<result.json>.");
    if (args["run-dir"] === undefined) throw new UsageError("--run-dir=<the run folder> is required.");
    if (build && args.instruction === undefined) throw new UsageError("--build needs --instruction=<file>.");
    if (!build) {
      for (const f of ["instruction", "inputs", "previous"]) if (args[f] !== undefined) throw new UsageError(`--${f} goes with --build, not --accept.`);
    }
    const facts = await readRunFacts(args["run-dir"], deps);

    if (build) {
      let instruction;
      try {
        instruction = readFileSync(resolve(args.instruction), "utf-8");
      } catch (err) {
        throw new UsageError(`cannot read --instruction=${args.instruction}: ${err?.code === "ENOENT" ? "no such file" : err.message}.`);
      }
      if (instruction.trim() === "") throw new UsageError(`--instruction=${args.instruction} is empty: say what to plan.`);
      const inputs = conductorInputs(facts, args.inputs);
      const previous = args.previous !== undefined ? readDispatchResult(args.previous) : null;
      const seq = nextPlanSeq(facts.runDir);
      const built = buildPlanPacket(facts, { instruction, inputs, previous, seq, history: planHistory(facts) });
      if (built.stop) {
        stderr.write(stopMessage(facts, built.stop));
        return 1;
      }
      const packetPath = join(facts.runDir, `tp-plan-${seq}.json`);
      writeAtomic(packetPath, JSON.stringify(built.packet, null, 2) + "\n");
      stdout.write(`packet: ${packetPath}\nresult: ${join(facts.runDir, `tp-plan-${seq}-result.json`)}\nattempt: ${built.attempt} of ${PLAN_ATTEMPTS}\n`);
      return 0;
    }

    const { path, result } = readDispatchResult(args.accept);
    const judged = judgePlan(facts, result);
    const history = planHistory(facts);
    for (const w of judged.warnings) stderr.write(`warning: ${w}\n`);
    if (judged.failure) {
      const known = history.some((e) => e.state === "failed" && samePath(e.resultPath, path));
      const failures = history.filter((e) => e.state === "failed").length + (known ? 0 : 1);
      const f = judged.failure;
      stderr.write(`plan-packets: the plan dispatch in ${path} failed (terminal_reason ${f.terminal_reason}): ${f.error}. Nothing was written.\n`);
      if (failures >= MAX_DISPATCH_FAILURES) {
        stderr.write(stopMessage(facts, failureStop(failures, f)));
      } else {
        const refused = lastRefused(history);
        stderr.write(
          `The planner sent no reply, so this is not one of its ${PLAN_ATTEMPTS} attempts and nothing goes back to it. ` +
            `Next: run the --build command again${refused ? ` with --previous='${refused.resultPath}'` : ""} and dispatch the new packet; ` +
            `failed dispatch number ${MAX_DISPATCH_FAILURES} in this session stops the run.\n`,
        );
      }
      return 1;
    }
    if (judged.problems.length > 0) {
      const seq = resultSeq(result, path);
      const attempt = attemptsIn(history).filter((e) => !samePath(e.resultPath, path) && (seq === null || e.seq < seq)).length + 1;
      stderr.write(
        `plan-packets: the plan in ${path} was refused (attempt ${attempt} of ${PLAN_ATTEMPTS}). Nothing was written.\n` +
          `${numbered(judged.problems)}\n`,
      );
      stderr.write(
        attempt >= PLAN_ATTEMPTS
          ? stopMessage(facts, limitStop(facts, path))
          : `Next: run the --build command again with --previous='${path}' added; it hands these problems to the planner.\n`,
      );
      return 1;
    }
    const target = join(facts.runDir, "packets.json");
    writeAtomic(target, JSON.stringify(judged.packets, null, 2) + "\n");
    const byPhase = {};
    for (const p of judged.packets) byPhase[p.phase] = (byPhase[p.phase] ?? 0) + 1;
    const counts = Object.entries(byPhase).map(([k, n]) => `${k} ${n}`).join(", ");
    stdout.write(`packets: ${target} (${judged.packets.length} packets: ${counts})\n`);
    return 0;
  } catch (err) {
    stderr.write(`plan-packets: ${err?.message ?? err}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  exitAfterFlush(await main(process.argv.slice(2)));
}
