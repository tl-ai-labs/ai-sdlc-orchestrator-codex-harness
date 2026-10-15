#!/usr/bin/env node
/**
 * Driver entry for the measured, headless run: spawns the `codex exec`
 * conductor with every pin the fairness argument depends on (see
 * docs/verification/p1-codex-runtime.md "Pins chosen"), records its event
 * stream as it arrives, and resumes the session until the run ends.
 *
 * Usage:
 *   node run.mjs [--brief=<path>] [--project-root=<path>] [--policy=<name>]
 *                [--run-id=<id>] [--output-dir=<path>] [--code-dir=<path>]
 *                [--gates=prompt|auto-approve|auto-abort]
 *                [--mode=greenfield|brownfield] [--intent=<id>] [--seed=<text>]
 *                [--resume=<run-id|thread-id>] [--max-turns=<n>]
 *                [--codex-bin=<path>] [--prompt-file=<path>] [--dry-run]
 *
 * Exit codes: 0 completed, 1 codex failed or pin rejected, 2 usage error or
 * refused before spending, 3 --max-turns reached, 4 stopped on purpose,
 * 128+signal when interrupted.
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { codexEvents, driverCostRow, modeledDriverCostRows, readDriverRecord } from "./telemetry/event-reader.mjs";
import { argvPin, assertPinnedInvocation, findPinRejection } from "./telemetry/fairnessPin.mjs";
import { assertResumePolicy, codexEnv, policyRecord, readRecordedPolicy, resolveRunPolicy, RunRefusal } from "./run-policy.mjs";
import { assertUnderCostCap, COST_CAP_EXCEEDED, driverCapWarning } from "../mcp/model-dispatch/dist/costCap.js";
import { DriverTurnTracker } from "../mcp/model-dispatch/dist/driverUsage.js";
import { configureSinks, log, redactText } from "../scripts/lib/log.mjs";
import {
  assertRunDirApart,
  lastGateMode,
  movedRunFolder,
  readRunRecords,
  resolveCodeDir,
  resolveRun,
  runDirFor,
  runSettings,
  UsageError,
} from "./run-folder.mjs";
import {
  appendRecord,
  classifyDriverAuth,
  completionEvidence,
  completionReason,
  countLines,
  invocationCount,
  isDeliberate,
  latestRunEnd,
  liveDriver,
  outcomeExitCode,
  previousRunEnd,
  QUESTION_FILE,
  snapshotStopEvidence,
  stopCheck,
  STDERR_TAIL_MAX,
  STDOUT_LINE_MAX,
} from "./run-record.mjs";
import { endWriteContract, finalizeRun, regenerateDriverFiles } from "./run-finalize.mjs";
import { hookArgs } from "./hook-wiring.mjs";
import { abandonCommand, ContractRefusal, finalEndRefusal, reopenRun } from "../scripts/write-contract.mjs";
import { gitRoot, liveLock, readContract, readLock } from "../scripts/lib/contract-lock.mjs";
import { renderPrompt, renderSkills, staleSkills } from "./render.mjs";
import { listDriverPriceFn } from "../mcp/model-dispatch/dist/driverPricing.js";
import { reportCommand } from "../scripts/report.mjs";
import { gateLine } from "../scripts/lib/gate-record.mjs";
import { staleBridgeBuild, staleBuildWarning } from "./bridge-build.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { exitAfterFlush } from "../scripts/lib/exit.mjs";

const CODEX_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(CODEX_DIR);
export const WRITE_MANIFEST_MJS = join(PLUGIN_ROOT, "scripts", "write-manifest.mjs");

/** Sandbox and approval pins — see the verification doc's "Pins chosen". */
export const SANDBOX_MODE = "workspace-write";
export const APPROVAL_POLICY = "never";

/**
 * Where codex keeps its own state. Needed as a writable directory because
 * the seat-backed dispatch path (`codex-cli` adapter) spawns a NESTED
 * `codex exec` inside this one's sandbox, and that inner process cannot
 * start without writing there:
 *
 *   Error: failed to initialize in-process app-server client:
 *   Read-only file system (os error 30)
 *
 * Found by the first quick-demo run, which failed three requirements
 * dispatches in ~330ms each. Granting it is harmless for the API path and
 * required for the seat path.
 */
export function defaultCodexHome() {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Where `npm install` keeps its cache: npm's own setting when exported, else npm's default. */
export function defaultNpmCache() {
  return process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || join(homedir(), ".npm");
}

/** The sandbox's extra writable folders, as one config key both `exec` and `exec resume` accept. */
function writableRoots(roots) {
  const kept = roots.filter(Boolean);
  return kept.length ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(kept)}`] : [];
}

/**
 * Job types a brownfield run can be given up front. Mirrors the `id` values
 * in plugin/config/intents.json — read from there rather than duplicated, so
 * a new intent cannot be valid in one place and rejected in the other.
 */
export function validIntents(pluginRoot = PLUGIN_ROOT) {
  const raw = JSON.parse(readFileSync(join(pluginRoot, "config", "intents.json"), "utf-8"));
  return (Array.isArray(raw) ? raw : (raw.intents ?? [])).map((i) => i.id);
}

/**
 * The handover block the brownfield guide already reads.
 *
 * Its step 4 branches on a block naming `intent:` and `seed_description:`,
 * supplied by whichever entry point invoked it. Interactively that comes from
 * the job-alias skill the user picked. Headlessly there was no way to supply
 * it at all — so a `--gates=auto-approve` brownfield run reached step 4a,
 * which asks the user to choose a job type, with stdin closed and nobody to
 * answer. That is what these flags fix.
 *
 * Returns "" when nothing was supplied, which leaves the guide's documented
 * third case (ask which job type) exactly as it was.
 */
export function renderHandover({ mode, intent, seed } = {}) {
  const lines = [];
  if (mode) lines.push(`mode: ${mode}`);
  if (intent) lines.push(`intent: ${intent}`);
  // Multi-line seed text would break the block's one-key-per-line shape.
  if (seed) lines.push(`seed_description: ${String(seed).replace(/\s+/g, " ").trim()}`);
  if (lines.length === 0) return "";
  return [
    "## Handover",
    "",
    "This run was started with the job already chosen. Treat the block below as the handover",
    "the brownfield guide's step 4 reads, and do not ask the questions it already answers.",
    "",
    "```",
    ...lines,
    "```",
    "",
  ].join("\n");
}

const NO_QUESTIONS =
  "Do not ask a question you cannot receive an answer to: if the run cannot go on without an " +
  'answer, write {"reason": "<why the run cannot go on>", "needs": "<the question>"} to stop.json in ' +
  "your run folder and end your turn.";

/**
 * What the conductor is told to do at each approval gate. `codex exec` runs
 * with stdin closed, so under `prompt` the driver relays the gate: the
 * conductor records it as pending and ends its turn, and run.mjs asks the
 * person at the terminal and resumes with the answer. `prompt` stays the
 * default because defaulting to auto-approve would turn the review gates
 * into decoration.
 */
export const GATE_MODES = {
  prompt:
    "A person is at the terminal that started this run, but cannot type into your session. At " +
    "each gate, print the gate block, append " +
    '{"gate": N, "artifact": "<file>", "decision": "pending", "ts": "<ISO 8601 time>"} to gates.jsonl in your run folder, ' +
    "then end your turn without doing anything else. The person's answer arrives as your next " +
    "message: record their decision on a new gates.jsonl line and act on it. Never record a " +
    "decision they did not give. Any other question for the person (the brownfield job type or " +
    "interview, the Phase 7 environment check) goes the same way: print it, write " +
    `{"question": "<the question, one line>"} to ${QUESTION_FILE} in your run folder, and end ` +
    "your turn; the answer arrives as your next message.",
  "auto-approve":
    "You are running UNATTENDED — there is no user to answer, and stdin is closed. At each " +
    "gate, print what was produced and where it is, record the decision as `auto-approved`, " +
    `and continue without waiting. ${NO_QUESTIONS} ` +
    "If an artifact looks wrong enough that a reviewer would have rejected it, say so plainly " +
    "in the gate record and in your final report rather than passing it silently.",
  "auto-abort":
    "You are running UNATTENDED with gates set to abort. At each gate, print what was " +
    "produced, record the decision as `aborted`, and stop the run there. Use this to produce " +
    `one phase's artifact for inspection without proceeding. ${NO_QUESTIONS}`,
};

export const RUN_FLAGS = Object.freeze({
  value: [
    "brief", "output-dir", "project-root", "policy", "run-id", "code-dir", "gates",
    "mode", "intent", "seed", "resume", "max-turns", "codex-bin", "prompt-file",
  ],
  boolean: ["dry-run"],
});

/** `--k=v` and `--k v`; an unknown flag, a stray word or a missing value is a UsageError. */
export function parseArgs(argv) {
  const args = {};
  const known = () => [...RUN_FLAGS.value, ...RUN_FLAGS.boolean].map((f) => `--${f}`).join(", ");
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    if (!raw.startsWith("--") || raw === "--") {
      throw new UsageError(`unexpected argument '${raw}': every run.mjs option is a --flag. Known flags: ${known()}.`);
    }
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (Object.prototype.hasOwnProperty.call(args, name)) throw new UsageError(`--${name} is given more than once.`);
    if (RUN_FLAGS.boolean.includes(name)) {
      const v = eq === -1 ? "true" : raw.slice(eq + 1);
      if (v !== "true" && v !== "false") throw new UsageError(`--${name} takes no value (or =true / =false).`);
      args[name] = v === "true";
    } else if (RUN_FLAGS.value.includes(name)) {
      let value = eq === -1 ? argv[i + 1] : raw.slice(eq + 1);
      if (eq === -1) {
        if (value === undefined || String(value).startsWith("--")) {
          throw new UsageError(`--${name} needs a value (--${name}=<value>).`);
        }
        i += 1;
      }
      if (String(value) === "") throw new UsageError(`--${name} needs a value (--${name}=<value>).`);
      args[name] = String(value);
    } else {
      throw new UsageError(`unknown flag --${name}. Known flags: ${known()}.`);
    }
  }
  return args;
}

export { renderPrompt, renderSkills, RENDERED_SKILLS } from "./render.mjs";

/**
 * The full `codex exec` argv. Built as a pure function so the pins are
 * assertable in a test without spawning anything — the fairness argument
 * rests on these exact flags, so "did we really pass them" is worth a test
 * of its own rather than a code reading.
 *
 * The prompt goes last, behind a bare `--`, so a prompt starting with `---`
 * reaches codex as a prompt and not as flags.
 */
export function buildCodexArgs({
  pin,
  promptText,
  /** Where the write hook's script lives; its wiring comes from <pluginRoot>/hooks/hooks.json. */
  pluginRoot = PLUGIN_ROOT,
  cwd,
  codexHome = defaultCodexHome(),
  npmCache = defaultNpmCache(),
  /** Resume this session instead of starting a new one. See RESUME_PROMPT. */
  resumeThreadId = null,
  /** Greenfield only: a new app's folder is usually not a git repo, and codex refuses one without this. */
  skipGitRepoCheck = false,
}) {
  return [
    "exec",
    // `resume <id>` must follow `exec` and precede the prompt. Everything
    // else about the invocation is identical, so the pin, sandbox, hooks and
    // network grant apply to a resumed turn exactly as to the first.
    ...(resumeThreadId ? ["resume", resumeThreadId] : []),
    "--json",
    ...(skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    "--dangerously-bypass-hook-trust",
    "-m",
    pin.model,
    "-c",
    `model_reasoning_effort="${pin.effort}"`,
    // `--sandbox`, `-C` and `--add-dir` are `codex exec` flags that
    // `codex exec resume` does NOT accept — passing them there is a usage
    // error and codex exits 2 before doing any work. Their config-key
    // equivalents are accepted by both, so a resumed turn keeps the same
    // sandbox, working directory and writable roots as the first.
    //
    // This cost the Workforce Ops run: 57 dispatches of real work completed,
    // then the resume died instantly on argument parsing.
    "-c",
    `sandbox_mode="${SANDBOX_MODE}"`,
    "-c",
    `approval_policy="${APPROVAL_POLICY}"`,
    // Without this the bridge subprocess dispatch.mjs spawns is killed by
    // the sandbox with no diagnostic at all — see the verification doc.
    "-c",
    "sandbox_workspace_write.network_access=true",
    // `-C/--cd` is likewise exec-only. A resumed session restores its own
    // working directory, and spawnCodex sets the process cwd regardless, so
    // omitting it here changes nothing about where the turn runs.
    ...(cwd && !resumeThreadId ? ["-C", cwd] : []),
    // CODEX_HOME: writable so a nested `codex exec` (the seat-backed dispatch
    // path) can initialise its own app-server state. See defaultCodexHome above.
    // npm's cache: Phase 7's `npm install` writes there, and a denied write
    // reaches npm as EPERM, which it reports as root-owned cache files.
    ...writableRoots([codexHome, npmCache]),
    // The plugin's own hook entry, wired for this session, and the installed copy off so a call is judged once.
    ...hookArgs(pluginRoot),
    "--",
    promptText,
  ];
}

/**
 * How many `codex exec` invocations one driver process may spend. One turn
 * ends at the session's context ceiling with exit 0, so a real project needs
 * several; a gate answer's invocation does not count.
 */
export const DEFAULT_MAX_TURNS = 12;

/** After forwarding SIGINT/SIGTERM/SIGHUP to codex's group, wait this long before SIGKILL. */
export const KILL_GRACE_MS = 10_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
/** A closed terminal ends stdin and sends SIGHUP in no fixed order; wait this long for the signal before reading end of input as "no answer". */
const END_OF_INPUT_SETTLE_MS = 150;

const quietStreams = new WeakSet();

/**
 * A write to a closed terminal (EIO) or to a pipe whose reader died (EPIPE)
 * fails as an 'error' event on the stream. Unheard, that event ends the
 * driver before it can stop codex and write its record.
 */
export function ignoreWriteErrors(stream) {
  if (!stream || typeof stream.on !== "function" || quietStreams.has(stream)) return;
  quietStreams.add(stream);
  stream.on("error", () => {});
}

function writeQuietly(stream, text) {
  try {
    stream.write(text);
  } catch { /* nobody is reading; the run record still has it */ }
}

/**
 * Null while dispatched plus the conductor's modeled spend is under the
 * policy's hard_cost_cap_usd. Once it is not, the bridge refuses every
 * dispatch, so a resumed session could only spend conductor tokens being
 * refused. `opts.codexHome` is where codex writes the session file the cap
 * falls back to before the first driver row exists.
 */
export function costCapStop(policy, telemetryPath, opts = {}) {
  try {
    const spend = assertUnderCostCap(policy, telemetryPath, opts);
    const warning = spend ? driverCapWarning(spend) : null;
    if (warning) opts.onDriverWarning?.(warning);
    return null;
  } catch (err) {
    if (err?.code === COST_CAP_EXCEEDED) return err.message;
    throw err;
  }
}

/** Session id to resume, from the `thread.started` event codex emits first. */
export function threadIdFrom(stdout) {
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "thread.started" && ev.thread_id) return ev.thread_id;
    } catch { /* not every line is JSON */ }
  }
  return null;
}

/**
 * What a resumed turn is told. Short on purpose: the session already holds
 * the conductor prompt, and restating the pipeline burns the context that
 * ran out.
 */
export const RESUME_PROMPT =
  "Continue the run from where you stopped. Re-read your own artifacts in the run folder to see " +
  "what is already done — do not redo completed phases, and do not re-dispatch a packet whose " +
  "result file already exists. Pick up at the first incomplete phase. If a gate is waiting for " +
  "an answer, do not answer it yourself: follow the gate instruction below. If you have to stop " +
  "the run on purpose, record why before you end your turn (an aborted line in gates.jsonl, or " +
  'stop.json with {"reason": "<one line>", "needs": "<what the person must decide>"}): a turn that ' +
  "ends with no new record reads as running out of context, and the session is resumed. Do not stop " +
  "because phases remain: carry on to Gate 4. The rules you were given still apply: " +
  "you author no shipped content, every artifact comes back from a dispatch. Finish with Phase 9 " +
  `and Gate 4. Phase 9 is one command, node '${WRITE_MANIFEST_MJS}' with the arguments your playbook ` +
  "gives it: it writes manifest.json and SUMMARY.md, so do not write manifest.json or SUMMARY.md " +
  "yourself. Once Gate 4 is recorded as accepted or auto-approved and any close-out your playbook " +
  "gives is done, run that command again with --status=accepted or --status=auto-approved.";

/**
 * What a resumed session is told when its first prompt named another run
 * folder: without it the conductor keeps writing there, and this run never
 * sees its Gate 4.
 */
export function runFolderNote({ runDir, runId, from = null }) {
  return (
    `This run's folder is now '${runDir}' and its run id is ${runId}` +
    (from ? `, not the folder '${from}' your first prompt named.` : "; your first prompt may have named another folder or run id.") +
    " Use these wherever your prompt or playbooks name the run folder or the run id: gates.jsonl, stop.json, " +
    `${QUESTION_FILE}, preflight.json, the dispatch --telemetry path, pass_id, and Phase 9's command. Your playbooks ` +
    `for this folder are in '${join(runDir, "skills")}'; read them from there. What your earlier turns wrote stays ` +
    "where they wrote it: read it there to see what is already done."
  );
}

/**
 * What a resumed session is told when the plugin changed since its playbooks
 * were rendered: the session holds the old text, and the step it takes up may
 * be one the change rewrote.
 */
export function playbooksNote({ runDir, names }) {
  return (
    `The plugin changed since this run's playbooks were rendered, so ${names.map((n) => `${n}.md`).join(", ")} in ` +
    `'${join(runDir, "skills")}' were rendered again from it. Read the playbook for the step you take up again before ` +
    "you act: where it differs from what you read before, in a playbook or in your first prompt, follow it."
  );
}

/**
 * RESUME_PROMPT plus this invocation's gate mode, which may differ from the
 * first invocation's. `after` is the run_end of the driver process before
 * this one: when that stop was deliberate, the person resuming has chosen to
 * go past it, so the conductor takes up the step again instead of repeating
 * the stop from its old record. `folder` ({runDir, runId, from}) leads with
 * runFolderNote; `playbooks` ({runDir, names}) adds playbooksNote.
 */
export function resumePrompt(gateMode, after = null, folder = null, playbooks = null) {
  const parts = folder ? [runFolderNote(folder), RESUME_PROMPT] : [RESUME_PROMPT];
  if (playbooks?.names?.length) parts.push(playbooksNote(playbooks));
  if (after?.outcome && isDeliberate(after.outcome)) {
    parts.push(
      `The run last stopped on purpose (${after.outcome}${after.reason ? `: ${after.reason}` : ""}). ` +
        `The person has resumed it with --gates=${gateMode}: they chose to continue past that stop. ` +
        "Take up the step that stopped it again, under the gate mode below. The earlier record does " +
        "not stop this turn: if the run has to stop again, write a new record first (a new line in " +
        "gates.jsonl, a new preflight.json, or stop.json).",
    );
  }
  parts.push(`Gate mode for this invocation: ${GATE_MODES[gateMode]}`);
  return parts.join("\n\n");
}

/** The resume that carries a person's answer to a question that is not a gate. */
export function questionAnswerPrompt(answer, gateMode) {
  return (
    `Answer from the person to your question: ${String(answer).trim()}\n\n` +
    "Carry on from the step that asked.\n\n" +
    `Gate mode for this invocation: ${GATE_MODES[gateMode]}`
  );
}

/** The resume that carries a person's answer to a pending gate. */
export function gateAnswerPrompt(gate, answer, gateMode) {
  return (
    `Gate ${gate ?? "?"} answer from the person: ${String(answer).trim()}\n\n` +
    "Record their decision on a new gates.jsonl line, then act on it.\n\n" +
    `Gate mode for this invocation: ${GATE_MODES[gateMode]}`
  );
}

/**
 * Runs one codex invocation. Each complete stdout line goes to `onRecord` as
 * it arrives, and stderr to `onStderr`. codex leads its own process group
 * (not on Windows) so a forwarded signal reaches the shells it started.
 * stdin is closed: `codex exec` reads an attached stdin and can hang on a
 * pipe that never closes.
 */
export function spawnCodex(
  args,
  {
    spawnFn = spawn,
    cwd,
    env,
    codexBin = "codex",
    invocation = 1,
    resumeThreadId = null,
    onSpawned = () => {},
    onRecord = () => {},
    onStderr = () => {},
    clock = () => new Date().toISOString(),
  } = {},
) {
  return new Promise((resolvePromise) => {
    const turns = { started: 0, completed: 0, failed: 0 };
    let threadId = resumeThreadId;
    let sawThread = false;
    let failure = null;
    let pending = "";
    let settled = false;

    const onLine = (line) => {
      if (!line.trim()) return;
      const receivedAt = clock();
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        event = null;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        onRecord({ kind: "stdout_unparsed", invocation, received_at: receivedAt, line: line.slice(0, STDOUT_LINE_MAX) });
        return;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string" && !sawThread) {
        threadId = event.thread_id;
        sawThread = true;
      }
      if (event.type === "turn.started") turns.started += 1;
      else if (event.type === "turn.completed") turns.completed += 1;
      else if (event.type === "turn.failed") turns.failed += 1;
      // codex prints the reason a turn failed (a usage limit, a refused model) on stdout, not stderr.
      if (event.type === "turn.failed" && typeof event.error?.message === "string") failure = event.error.message;
      else if (event.type === "error" && typeof event.message === "string" && !/^Reconnecting/.test(event.message)) failure ??= event.message;
      onRecord({ kind: "codex", invocation, thread_id: threadId, received_at: receivedAt, event });
    };
    const finish = (end) => {
      if (settled) return;
      settled = true;
      if (pending) onLine(pending);
      pending = "";
      resolvePromise({ threadId, turns, failure, ...end });
    };

    let child;
    try {
      child = spawnFn(codexBin, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      onSpawned(null);
      finish({ exitStatus: null, signal: null, spawnError: String(err?.message ?? err) });
      return;
    }
    onSpawned(child);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        onLine(line);
      }
    });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
    child.on("error", (err) => {
      if (child.pid === undefined) finish({ exitStatus: null, signal: null, spawnError: String(err?.message ?? err) });
    });
    child.on("close", (code, signal) => finish({ exitStatus: code, signal: signal ?? null, spawnError: null }));
  });
}

/**
 * The pin check and the modeled driver rows for a run's driver-events text,
 * format v1 or legacy bare codex events. Pure.
 */
export function buildRunArtifacts({ jsonl, pin, pricing, passId, policy, now }) {
  const records = readDriverRecord(jsonl, now);
  const events = codexEvents(records);
  const rejection = findPinRejection(events);
  const modeled = modeledDriverCostRows(records, {
    runId: passId,
    model: pin.model,
    pricing,
    policyName: policy?.name,
    policyVersion: policy?.version ?? 1,
  });
  return { events, rejection, modeled };
}

/** `codex login status`, classified; the text itself is never kept. */
function readDriverAuth({ spawnFn, codexBin, cwd, env, timeoutMs = 5000 }) {
  return new Promise((resolveAuth) => {
    let text = "";
    let done = false;
    let child;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveAuth(classifyDriverAuth(text));
    };
    try {
      child = spawnFn(codexBin, ["login", "status"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolveAuth("unknown");
      return;
    }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (c) => (text += c));
    child.stderr?.on("data", (c) => (text += c));
    child.on("error", finish);
    child.on("close", finish);
  });
}

function isGitWorkTree(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && String(r.stdout).trim() === "true";
}

/**
 * Answers typed at the terminal. Only a line typed after its question is
 * printed may answer it: the stream is read from the start of the run, and
 * ask() drops whatever arrived before (a stray Enter during a long turn would
 * otherwise answer, or abort, a gate the person has not seen).
 */
export function createLineReader(stream) {
  let buf = "";
  let lines = [];
  let ended = !stream;
  let waiter = null;
  let attached = false;
  let cancelled = false;
  const flush = () => {
    if (!waiter) return;
    if (cancelled || lines.length || ended) {
      const w = waiter;
      waiter = null;
      w(!cancelled && lines.length ? lines.shift() : null);
    }
  };
  const onData = (chunk) => {
    buf += String(chunk);
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      lines.push(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
    flush();
  };
  const onEnd = () => {
    if (buf) lines.push(buf);
    buf = "";
    ended = true;
    flush();
  };
  const attach = () => {
    if (attached || !stream) return;
    attached = true;
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    // A read from a terminal that has gone away fails with EIO.
    stream.on("error", onEnd);
    stream.resume?.();
  };
  return {
    attach,
    /** Drops earlier input, calls `show` to print the question, then resolves with the next line, or null at end of input. */
    async ask(show = () => {}) {
      attach();
      // Lets input that is already readable arrive before it is dropped.
      await new Promise((r) => setImmediate(r));
      const dropped = lines.length + (buf ? 1 : 0);
      lines = [];
      buf = "";
      show(dropped);
      return new Promise((r) => {
        waiter = r;
        flush();
      });
    },
    /** Ends every wait, now and later, with null. */
    cancel() {
      cancelled = true;
      flush();
    },
    close() {
      if (!attached) return;
      stream.off?.("data", onData);
      stream.off?.("end", onEnd);
      stream.off?.("close", onEnd);
      stream.off?.("error", onEnd);
      stream.pause?.();
    },
  };
}

function gateQuestion(gate) {
  return gate === 4
    ? "Gate 4 — reply accept, or reject: <comments>:"
    : `Gate ${gate ?? "?"} — reply approved, revise: <comments>, or abort:`;
}

function lastAgentMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const item = events[i].item;
    if (events[i].type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      return item.text;
    }
  }
  return null;
}

/** run.end in orchestrator.log speaks the run-log vocabulary: a deliberate stop ends the run as aborted. */
function runLogOutcome(outcome) {
  if (outcome === "completed") return "completed";
  if (outcome === "max_turns") return "incomplete";
  if (outcome === "interrupted") return "interrupted";
  if (outcome === "codex_failed" || outcome === "pin_rejected") return "failed";
  return "aborted";
}

const BOUND_WORD = { floor: "at least ", ceiling: "at most ", mixed: "about " };

function money(usd, bound) {
  return usd == null ? "not measured" : `${BOUND_WORD[bound] ?? ""}$${usd.toFixed(4)}`;
}

/** Which incomplete turns the booked figure holds: a later running total on the thread, or the session file, can carry them. */
function incompleteText(m, cost) {
  const n = cost ? cost.driver_turns_incomplete : m.driver_turns_incomplete;
  if (!n) return "";
  const covered = Math.min(n, (cost ? cost.driver_turns_incomplete_covered : m.driver_turns_incomplete_covered) ?? 0);
  const unpriced = cost ? cost.driver_turns_incomplete_unpriced : m.driver_cost_complete === true ? 0 : n - covered;
  const groups = [
    [covered, "in a later turn's running total"],
    [n - unpriced - covered, "priced from the session file"],
    [unpriced, "not priced, cost not known, not $0"],
  ].filter(([k]) => k > 0);
  return ` (${n} incomplete: ${groups.map(([k, text]) => `${groups.length > 1 ? `${k} ` : ""}${text}`).join("; ")})`;
}

/** The conductor's figure and how it was checked, as the run's last lines say it; `cost` is the report's booking. */
export function driverLines(m, usage, cost) {
  const lines = [];
  const floor = m.driver_cost_complete === false || (m.driver_cost_complete == null && m.driver_turns_incomplete > 0);
  const figure = cost ? money(cost.driver_usd_modeled, cost.driver_bound) : money(m.driver_cost_usd_modeled, floor ? "floor" : "exact");
  lines.push(`invocations ${m.codex_invocations}, turns ${m.driver_turns}${incompleteText(m, cost)}, driver cost (modeled) ${figure}`);
  if (m.driver_cost_source) lines.push(`driver cost booked from: ${m.driver_cost_source}`);
  const cc = usage?.cross_check;
  if (cc) {
    const exec = cc.exec_stream_cost_usd == null ? "" : ` (exec stream ${money(cc.exec_stream_cost_usd)})`;
    lines.push(`token cross-check: ${cc.verdict}${cc.verified ? ", verified" : ", UNVERIFIED"}${exec}`);
  }
  return lines;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Why a brownfield run other than `runId` would be refused its Gate 0 freeze in
 * this project, or null: another run's live lock, or an active contract no
 * ended lock records.
 */
export function contractHeldBy(projectRoot, runId) {
  const live = liveLock(projectRoot);
  if (live && live.run_id !== runId) {
    return `run ${live.run_id} is live and holds this project's write contract, so this run's Gate 0 freeze would be refused. ` +
      `Resume that run (--resume=${live.run_id}), or end it: ${abandonCommand(live.run_id, projectRoot)}`;
  }
  if (live) return null;
  const contract = readContract(projectRoot);
  if (contract?.active !== true || contract.run_id === runId || readLock(projectRoot, contract.run_id)?.ended_at) return null;
  const id = typeof contract.run_id === "string" && contract.run_id ? contract.run_id : null;
  return `an active write contract${id ? ` for run ${id}` : ""} that no lock records holds this project, so this run's Gate 0 ` +
    `freeze would be refused.${id ? ` End it: ${abandonCommand(id, projectRoot)}` : ""}`;
}

/**
 * Why a brownfield --project-root would have its Gate 0 freeze refused for not
 * being the root of its git project, or null. Same test as the freeze's: a
 * `.git` in the folder itself.
 */
export function notGitProjectRoot(projectRoot, runMode) {
  const top = gitRoot(projectRoot);
  if (top === projectRoot) return null;
  const greenfield = runMode === undefined ? " For a new app in this folder, pass --mode=greenfield." : "";
  if (!top) {
    return `${projectRoot} has no .git folder, and none above it. A brownfield run's write contract is frozen at Gate 0 ` +
      `at the root of its git project, beside .git, so this run would stop there after spending. Pass the folder that ` +
      `holds .git as --project-root.${greenfield}`;
  }
  const rel = relative(top, projectRoot);
  return `${projectRoot} is inside the git project at ${top}, not its root. A brownfield run's write contract is frozen ` +
    `at Gate 0 at the git project's root, the only place the write hook reads it, so this run would stop there after ` +
    `spending. Start it from the root: --project-root=${shellQuote(top)}; Gate 0's allowlist can still keep its ` +
    `writes to ${rel}/**.${greenfield}`;
}

/** Where a path flag that names a place outside the project (a brief, a prompt, a binary) resolves: the shell's cwd. */
function fromCwd(cwd, value) {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** A bare command name is looked up on PATH; anything with a separator is a path. */
function codexBinFrom(cwd, value) {
  if (!value) return "codex";
  return /[\\/]/.test(value) ? fromCwd(cwd, value) : value;
}

/**
 * Runs the driver. `deps` replaces the process's own spawn, stdin, stdout,
 * stderr, clock, env, cwd and signal source (tests pass an EventEmitter),
 * plus loadPolicy (name → the policy object to use in place of the resolved
 * file's), isGitRepo and killGraceMs. Returns the exit code.
 */
export async function main(input = [], deps = {}) {
  try {
    const args = Array.isArray(input) ? parseArgs(input) : input;
    return await runDriver(args, deps);
  } catch (err) {
    if (err instanceof UsageError) {
      writeQuietly(deps.stderr ?? process.stderr, `run: ${err.message}\n`);
      return 2;
    }
    if (err instanceof RunRefusal) {
      writeQuietly(deps.stderr ?? process.stderr, `${err.message}\n`);
      return err.exitCode;
    }
    writeQuietly(deps.stderr ?? process.stderr, `run failed: ${err?.message ?? err}\n`);
    return 1;
  }
}

function refuseChange(flag, given, recorded, runId) {
  if (given !== undefined && recorded !== undefined && recorded !== null && given !== recorded) {
    throw new UsageError(`--${flag}=${given} differs from run ${runId}'s ${flag} (${recorded}); a resumed run keeps its ${flag}.`);
  }
}

function refusePathChange(flag, given, resolved, recorded, runId) {
  if (given !== undefined && recorded && resolved !== recorded) {
    throw new UsageError(
      `--${flag}=${given} resolves to ${resolved}, not run ${runId}'s ${recorded}; a resumed run keeps its ${flag}. Drop --${flag}.`,
    );
  }
}

async function runDriver(args, deps) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const spawnFn = deps.spawnFn ?? spawn;
  const clock = () => (deps.now ? new Date(deps.now()) : new Date()).toISOString();
  // lib/log.mjs writes to process.stderr whatever stderr is here.
  for (const s of [stdout, stderr, process.stderr]) ignoreWriteErrors(s);
  const say = (line = "") => writeQuietly(stdout, `${line}\n`);
  const warn = (line = "") => writeQuietly(stderr, `${line}\n`);

  const projectRoot = resolve(cwd, args["project-root"] ?? ".");
  if (args.mode !== undefined && args.mode !== "greenfield" && args.mode !== "brownfield") {
    throw new UsageError(`--mode=${args.mode} is not one of greenfield, brownfield.`);
  }
  if (args["max-turns"] !== undefined && !/^[1-9]\d*$/.test(args["max-turns"])) {
    throw new UsageError(`--max-turns=${args["max-turns"]} must be a positive whole number.`);
  }
  if (args.gates !== undefined && !(args.gates in GATE_MODES)) {
    throw new UsageError(`--gates=${args.gates} is not one of ${Object.keys(GATE_MODES).join(", ")}.`);
  }
  const maxTurns = Number(args["max-turns"] ?? DEFAULT_MAX_TURNS);

  const run = resolveRun({
    projectRoot,
    resume: args.resume,
    runIdFlag: args["run-id"],
    outputDir: args["output-dir"],
    mode: args.mode,
    intent: args.intent,
    now: deps.now ? new Date(deps.now()) : undefined,
  });
  const { runId, runDir } = run;
  const earlier = run.records;
  const live = liveDriver(earlier);
  if (live) {
    // Two drivers on one thread would interleave their records and run two codex turns at once.
    throw new UsageError(
      `run ${runId} is still being driven by process ${live.pid} (invocation ${live.invocation}, started ${live.at}). ` +
        `Let it finish, or stop it (kill ${live.pid}), then resume.`,
    );
  }
  if (latestRunEnd(earlier)?.outcome === "completed") {
    throw new UsageError(`run ${runId} already completed (${runDir}). Start a new run instead of resuming it.`);
  }
  const recorded = runSettings(earlier) ?? {};
  // A routing-policy.yaml can win over the --policy a run started with, so either name is that run's.
  if (args.policy !== recorded.policy_requested) refuseChange("policy", args.policy, recorded.policy, runId);
  refuseChange("mode", args.mode, recorded.run_mode, runId);
  refuseChange("intent", args.intent, recorded.intent, runId);

  const runMode = args.mode ?? recorded.run_mode ?? undefined;
  const intent = args.intent ?? recorded.intent ?? undefined;
  const gateMode = args.gates ?? lastGateMode(earlier) ?? "prompt";
  if (!(gateMode in GATE_MODES)) throw new UsageError(`recorded gate mode '${gateMode}' is not known; pass --gates.`);
  if (intent && !recorded.intent) {
    const allowed = validIntents();
    if (!allowed.includes(intent)) throw new UsageError(`--intent=${intent} is not one of ${allowed.join(", ")}.`);
    // An intent only means something to the brownfield guide.
    if (runMode === "greenfield") throw new UsageError("--intent applies to brownfield runs; --mode=greenfield takes none.");
  }

  const codeDir = args["code-dir"]
    ? resolveCodeDir({ projectRoot, codeDir: args["code-dir"], mode: runMode })
    : (recorded.code_dir ?? resolveCodeDir({ projectRoot, mode: runMode }));
  assertRunDirApart({ projectRoot, runId, runDir, codeDir });
  const briefPath = args.brief ? fromCwd(cwd, args.brief) : (recorded.brief_path ?? join(projectRoot, "brief.md"));
  // A resumed session is not told new values: its prompt and rendered playbooks keep the ones it started with.
  refusePathChange("code-dir", args["code-dir"], codeDir, recorded.code_dir, runId);
  refusePathChange("brief", args.brief, briefPath, recorded.brief_path, runId);
  const promptPath = args["prompt-file"] ? fromCwd(cwd, args["prompt-file"]) : join(CODEX_DIR, "prompts", "conductor.md");
  const codexBin = codexBinFrom(cwd, args["codex-bin"]);
  let threadId = run.resume?.threadId ?? null;
  if (!threadId && !args["prompt-file"] && !existsSync(briefPath)) {
    // Only the shipped conductor prompt reads a brief.
    throw new UsageError(`no brief at ${briefPath}. Pass --brief=<path>, or put brief.md at the project root.`);
  }

  if (gateMode === "prompt" && !stdin?.isTTY) {
    throw new UsageError(
      "--gates=prompt needs a person at this terminal, and stdin is not one. For an unattended run pass " +
        "--gates=auto-approve (replays of runs you have reviewed) or --gates=auto-abort (stop at the first gate).",
    );
  }
  if (runMode !== "greenfield" && !(deps.isGitRepo ?? isGitWorkTree)(projectRoot)) {
    throw new UsageError(
      `${projectRoot} is not a git repository. For a new app in an empty folder pass --mode=greenfield; ` +
        "brownfield needs git (git init).",
    );
  }
  if (runMode !== "greenfield") {
    const notRoot = notGitProjectRoot(projectRoot, runMode);
    if (notRoot) throw new UsageError(notRoot);
    const held = contractHeldBy(projectRoot, runId);
    if (held) throw new UsageError(held);
  }

  // Before anything is rendered: the prompt's --policy, the pin, the driver's
  // rates and the cap all come from this one resolution, the bridge's own.
  let policyRun;
  try {
    policyRun = resolveRunPolicy({
      projectRoot,
      policyArg: args.policy ?? recorded.policy_requested ?? recorded.policy ?? null,
      warn,
      now: deps.now ? new Date(deps.now()) : new Date(),
    });
    if (deps.loadPolicy) policyRun = { ...policyRun, policy: deps.loadPolicy(policyRun.name) };
  } catch (err) {
    throw err instanceof RunRefusal ? err : new UsageError(err?.message ?? String(err));
  }
  if (policyRun.notice && args.policy !== undefined) warn(policyRun.notice);
  if (args.resume) {
    assertResumePolicy({ recorded: readRecordedPolicy(runDir, { runId, warn }), run: policyRun, runDir, warn });
  }
  const policy = policyRun.policy;
  const policyName = policyRun.name;
  const pin = policyRun.driver.pin;
  const codexHome = env.CODEX_HOME ?? join(homedir(), ".codex");
  const priceFn = listDriverPriceFn(policy);
  const capWarned = new Set();
  // The bridge logs the same events before a dispatch; the driver logs each kind once per run.
  const onDriverWarning = (w) => {
    if (capWarned.has(w.event)) return;
    capWarned.add(w.event);
    log("warn", w.event, { run_id: runId, reason: w.reason ?? undefined });
  };
  const skipGitRepoCheck = runMode === "greenfield";

  const renderValues = {
    PLUGIN_ROOT: PLUGIN_ROOT,
    PROJECT_ROOT: projectRoot,
    OUTPUT_DIR: runDir,
    CODE_DIR: codeDir,
    BRIEF_PATH: briefPath,
    POLICY: policyName,
    RUN_ID: runId,
    GATE_INSTRUCTION: GATE_MODES[gateMode],
    HANDOVER: renderHandover({ mode: runMode, intent, seed: args.seed }),
  };
  const promptText = threadId ? null : renderPrompt(readFileSync(promptPath, "utf-8"), renderValues);
  const previous = previousRunEnd(earlier);
  const moved = movedRunFolder(earlier, runDir, { foreignThread: run.resume?.foreignThread === true });
  const folder = moved ? { runDir, runId, from: moved.from } : null;
  const skillsDir = join(runDir, "skills");
  // A resumed session keeps the playbooks it already read, unless they were rendered for another
  // folder or the plugin has changed since.
  const stale = run.resume && !moved && existsSync(skillsDir) ? staleSkills(runDir, renderValues) : [];
  const playbooks = stale.length > 0 ? { runDir, names: stale } : null;
  let nextPrompt = threadId ? resumePrompt(gateMode, previous, folder, playbooks) : promptText;
  const argvFor = (prompt, resumeThreadId) =>
    buildCodexArgs({ pin, promptText: prompt, cwd: projectRoot, codexHome, resumeThreadId, skipGitRepoCheck });
  try {
    // Checked on the argv codex will receive: the stream never says which model answered.
    assertPinnedInvocation(argvPin(argvFor(nextPrompt, threadId)), policy);
  } catch (err) {
    throw new UsageError(err?.message ?? String(err));
  }

  const staleWarning = staleBuildWarning((deps.staleBuild ?? staleBridgeBuild)(PLUGIN_ROOT), PLUGIN_ROOT);
  if (staleWarning) warn(`run: ${staleWarning}`);

  if (args["dry-run"]) {
    say(
      JSON.stringify(
        {
          ...policyRecord(policyRun),
          pin,
          driver_price: policyRun.driver.price,
          run_id: runId,
          output_dir: runDir,
          code_dir: codeDir,
          gates: gateMode,
          argv: argvFor(nextPrompt, threadId),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (run.resume && runMode !== "greenfield") {
    // The run end switched the contract off; the resumed conductor writes under it again.
    let reopened;
    try {
      reopened = reopenRun({ projectRoot, runId });
    } catch (err) {
      if (err instanceof ContractRefusal) throw new UsageError(err.message);
      throw err;
    }
    if (reopened.reopened) say(`run ${runId}: its write contract binds again, as frozen at Gate 0.`);
    if (reopened.provenance?.error) warn(`run ${runId}: provenance.json was not reopened: ${reopened.provenance.error}`);
  }

  mkdirSync(runDir, { recursive: true });
  if (!run.resume || moved || !existsSync(skillsDir) || playbooks) renderSkills(runDir, renderValues);
  if (run.resume?.foreignThread) {
    warn(
      `run ${runId}: no run folder under ${join(projectRoot, ".sdlc", "runs")} records thread ${threadId}; its earlier ` +
        `turns' cost is not in ${runDir}. The first resumed turn is priced from the thread's earlier total in codex's ` +
        `session file under ${codexHome} when that file is there, and at the thread's whole running total otherwise ` +
        "(flagged baseline_unknown). If that run used --output-dir, stop this one and pass the same --output-dir again.",
    );
  }
  configureSinks({ runLogPath: join(runDir, "orchestrator.log") });
  const driverAuth = await readDriverAuth({ spawnFn, codexBin, cwd: projectRoot, env });
  const driver = {
    policy,
    priceFn,
    codexHome,
    model: pin.model,
    policyName,
    policyVersion: policyRun.version ?? 1,
    policyRecord: policyRecord(policyRun),
    pin,
    sandbox: SANDBOX_MODE,
    approvalPolicy: APPROVAL_POLICY,
    auth: driverAuth,
  };
  const telemetryPath = join(runDir, "telemetry.jsonl");
  const gatesPath = join(runDir, "gates.jsonl");
  const stderrLogPath = join(runDir, "driver-stderr.log");
  const modeledPath = join(runDir, "driver-cost-modeled.jsonl");
  const runStartedAtMs = Date.parse(recorded.at ?? "") || Date.now();

  const tracker = new DriverTurnTracker();
  for (const r of earlier) tracker.push(r);
  const record = (rec) => {
    appendRecord(runDir, rec);
    for (const turn of tracker.push({ v: 1, ...rec })) {
      if (turn.status !== "complete") continue;
      appendFileSync(modeledPath, JSON.stringify(driverCostRow(turn, { runId, ...driver })) + "\n");
    }
  };

  log("info", "run.start", {
    run_id: runId,
    mode: runMode,
    intent,
    policy: policyName,
    gates: gateMode,
    resume: threadId ?? undefined,
  });

  const signals = deps.signals ?? process;
  const graceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  let stopping = null;
  let child = null;
  let killTimer = null;
  const lines = createLineReader(stdin);
  if (gateMode === "prompt") lines.attach();
  const childAlive = () => child && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const killGroup = (sig) => {
    if (!childAlive()) return;
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  const onSignal = (sig) => {
    if (stopping) {
      killGroup("SIGKILL");
      return;
    }
    stopping = sig;
    // Forward first: after SIGHUP the terminal is gone, and nothing printed here can reach it.
    killGroup(sig);
    killTimer = setTimeout(() => killGroup("SIGKILL"), graceMs);
    killTimer.unref?.();
    lines.cancel();
    warn(`run ${runId}: ${sig} received — stopping codex and writing the run record.`);
  };
  const handlers = FORWARDED_SIGNALS.map((sig) => [sig, () => onSignal(sig)]);
  for (const [sig, handler] of handlers) signals.on(sig, handler);
  const onExit = () => killGroup("SIGKILL");
  process.on("exit", onExit);

  let invocation = invocationCount(earlier);
  let resumeAfter = previous?.outcome ?? null;
  let gateAnswer = false;
  /** Set when the person answered a gate with abort: the run ends there whether or not the conductor records it. */
  let typedAbort = null;
  let turnsUsed = 0;
  let outcome = null;
  let reason = null;
  let lastEnd = null;
  const continueCommand = () => {
    const outputDir = runDir === runDirFor(projectRoot, runId) ? "" : ` --output-dir=${shellQuote(runDir)}`;
    return `node ${shellQuote(join(CODEX_DIR, "run.mjs"))} --resume=${runId} --project-root=${shellQuote(projectRoot)}${outputDir}`;
  };
  const recordGateAbort = (gate, note) => {
    try {
      appendFileSync(gatesPath, JSON.stringify(gateLine({ gate, decision: "aborted", note, recorded_by: "run.mjs" })) + "\n");
    } catch { /* the run record still says why */ }
  };

  try {
    for (;;) {
      if (stopping) {
        outcome = "interrupted";
        reason = `the driver received ${stopping}`;
        break;
      }
      const capBefore = costCapStop(policy, telemetryPath, { env, codexHome, priceFn, onDriverWarning });
      if (capBefore) {
        outcome = "cost_cap";
        reason = capBefore;
        break;
      }

      invocation += 1;
      if (!gateAnswer) turnsUsed += 1;
      const mode = threadId ? "resume" : "fresh";
      const startedAt = clock();
      const startedAtMs = Date.parse(startedAt);
      const gatesBefore = countLines(gatesPath);
      const evidenceBefore = snapshotStopEvidence(runDir, projectRoot);
      const events = [];
      let stderrPending = "";
      let stderrTail = "";
      let headerWritten = false;
      const stderrLine = (line) => {
        const clean = redactText(line);
        try { appendFileSync(stderrLogPath, `${clean}\n`); } catch { /* the console copy still shows it */ }
        warn(`codex[${invocation}]: ${clean}`);
        stderrTail = `${stderrTail}${clean}\n`.slice(-STDERR_TAIL_MAX);
      };

      // A record that cannot be written inside codex's output handler would otherwise escape as an uncaught error.
      let recordError = null;
      const result = await spawnCodex(argvFor(nextPrompt, threadId), {
        spawnFn,
        cwd: projectRoot,
        // Every dispatch.mjs codex starts then loads exactly the file this run priced and capped.
        env: codexEnv(policyRun, env),
        codexBin,
        invocation,
        resumeThreadId: threadId,
        clock,
        onSpawned: (c) => {
          child = c;
          const pid = c?.pid ?? null;
          record({
            kind: "invocation_start",
            run_id: runId,
            invocation,
            at: startedAt,
            mode,
            resume_thread_id: threadId,
            resume_after: resumeAfter,
            ...policyRecord(policyRun),
            pin: { model: pin.model, effort: pin.effort },
            gates: gateMode,
            max_turns: maxTurns,
            codex_bin: codexBin,
            cwd: projectRoot,
            output_dir: runDir,
            pid,
            pgid: pid !== null && process.platform !== "win32" ? pid : null,
            driver_pid: process.pid,
            run_mode: runMode ?? null,
            intent: intent ?? null,
            code_dir: codeDir,
            brief_path: briefPath,
            gate_answer: gateAnswer,
          });
          if (stopping) killGroup(stopping);
        },
        onRecord: (rec) => {
          try { record(rec); } catch (err) { recordError ??= err; }
          if (rec.kind === "codex") events.push({ ...rec.event, invocation });
        },
        onStderr: (chunk) => {
          if (!headerWritten) {
            headerWritten = true;
            const how = mode === "resume" ? `resume ${threadId}` : "fresh";
            try { appendFileSync(stderrLogPath, `--- invocation ${invocation} ${startedAt} ${how} ---\n`); } catch { /* see above */ }
          }
          stderrPending += chunk;
          let i;
          while ((i = stderrPending.indexOf("\n")) !== -1) {
            stderrLine(stderrPending.slice(0, i));
            stderrPending = stderrPending.slice(i + 1);
          }
        },
      });
      if (stderrPending) stderrLine(stderrPending);
      child = null;
      if (recordError) throw recordError;
      clearTimeout(killTimer);
      resumeAfter = null;
      if (result.threadId) threadId = result.threadId;
      lastEnd = {
        kind: "invocation_end",
        invocation,
        at: clock(),
        thread_id: threadId,
        exit_status: result.exitStatus,
        // A codex that handles the forwarded signal exits with a code; the record still names the signal.
        signal: result.signal ?? (stopping && !result.spawnError ? stopping : null),
        ended_by: result.spawnError ? "spawn_error" : stopping ? "driver_signal" : "exit",
        turns: result.turns,
        incomplete: result.turns.started > result.turns.completed,
        stderr_tail: stderrTail,
      };
      record(lastEnd);
      regenerateDriverFiles({ runDir, runId, driver });

      if (stopping) {
        // The conductor can finish the run, and a brownfield close-out end its lock, before codex exits.
        if (!result.spawnError && completionEvidence(runDir, runStartedAtMs).complete) {
          outcome = "completed";
          reason = `${completionReason(runDir)}; ${stopping} arrived after the run finished`;
        } else {
          outcome = "interrupted";
          reason = `the driver received ${stopping}`;
        }
        break;
      }

      const stop = result.spawnError
        ? null
        : stopCheck({
            runDir,
            projectRoot,
            runId,
            gateMode,
            startedAtMs,
            gatesLinesBefore: gatesBefore,
            runStartedAtMs,
            events,
            before: evidenceBefore,
          });
      if (typedAbort && stop?.outcome !== "aborted") {
        recordGateAbort(typedAbort.gate, "the person answered abort at the terminal");
        outcome = "aborted";
        reason = `gate ${typedAbort.gate ?? "?"} aborted at the terminal`;
        break;
      }
      typedAbort = null;
      if (result.spawnError) {
        outcome = "codex_failed";
        reason = /ENOENT/.test(result.spawnError)
          ? `could not launch '${codexBin}'. Install it (npm install -g @openai/codex), or point at it with --codex-bin=<path>.`
          : `codex failed to start: ${result.spawnError}`;
        break;
      }

      const waiting = stop?.outcome === "gate_pending" || stop?.outcome === "question_pending";
      if (!stop || waiting) {
        // Before a waiting gate too: a run over its cap ends here instead of asking for an answer it cannot act on.
        const capAfter = costCapStop(policy, telemetryPath, { env, codexHome, priceFn, onDriverWarning });
        if (capAfter) {
          outcome = "cost_cap";
          reason = !waiting
            ? capAfter
            : `${capAfter} ${stop.outcome === "gate_pending" ? `Gate ${stop.gate ?? "?"}` : "The conductor's question"} is still waiting for an answer.`;
          break;
        }
      }
      if (waiting) {
        const isGate = stop.outcome === "gate_pending";
        if (!threadId) {
          outcome = "codex_failed";
          reason = `${isGate ? "a gate" : "a question"} is waiting, but codex reported no thread id to resume with the answer`;
          break;
        }
        const text = lastAgentMessage(events);
        let answer = await lines.ask((dropped) => {
          say("");
          say(isGate ? `── Gate ${stop.gate ?? "?"} is waiting for your answer ──` : "── The conductor has a question for you ──");
          if (text) say(text);
          else if (!isGate && stop.question) say(stop.question);
          if (dropped) say(`(ignored ${dropped} line${dropped === 1 ? "" : "s"} typed before this question)`);
          writeQuietly(stdout, `${isGate ? gateQuestion(stop.gate) : "Your answer:"} `);
        });
        if (answer === null && !stopping) await new Promise((r) => setTimeout(r, END_OF_INPUT_SETTLE_MS));
        if (stopping) {
          outcome = "interrupted";
          reason = `the driver received ${stopping}`;
          break;
        }
        answer = answer?.trim() ?? "";
        if (!answer) {
          outcome = "aborted";
          if (!isGate) {
            reason = "no answer to the conductor's question";
            break;
          }
          reason = `no answer at gate ${stop.gate ?? "?"}`;
          recordGateAbort(stop.gate, "no answer at the terminal");
          break;
        }
        nextPrompt = isGate ? gateAnswerPrompt(stop.gate, answer, gateMode) : questionAnswerPrompt(answer, gateMode);
        typedAbort = isGate && /^abort/i.test(answer) ? { gate: stop.gate } : null;
        gateAnswer = true;
        continue;
      }
      if (stop) {
        outcome = stop.outcome;
        reason = stop.reason;
        break;
      }
      if (result.exitStatus !== 0) {
        outcome = "codex_failed";
        reason = `codex exited ${result.exitStatus ?? result.signal}${result.failure ? `: ${result.failure}` : ""}`;
        break;
      }
      if (!threadId) {
        outcome = "codex_failed";
        reason = "codex reported no thread id, so the session cannot be resumed";
        break;
      }
      if (turnsUsed >= maxTurns) {
        outcome = "max_turns";
        reason = `--max-turns=${maxTurns} reached before the run finished`;
        break;
      }
      say(`run ${runId}: invocation ${invocation} ended before the run finished — resuming ${threadId} (${turnsUsed}/${maxTurns})`);
      nextPrompt = resumePrompt(gateMode, null, folder);
      gateAnswer = false;
    }

    const exitCode = outcomeExitCode(outcome, stopping);
    record({
      kind: "run_end",
      invocation,
      at: clock(),
      outcome,
      deliberate: outcome === "completed" ? null : isDeliberate(outcome),
      reason,
      exit_code: exitCode,
      // A run stopped before its first spawn has no invocation_start; --resume reads its settings from here.
      run_id: runId,
      ...policyRecord(policyRun),
      gates: gateMode,
      run_mode: runMode ?? null,
      intent: intent ?? null,
      code_dir: codeDir,
      brief_path: briefPath,
    });
    // Read before the run end rewrites manifest.json with the outcome as its status.
    const summaryWhy = outcome === "completed" ? null : completionEvidence(runDir, runStartedAtMs).summaryReason;
    const {
      driverManifest: m,
      driverUsage,
      notes: finalNotes,
      contractLines,
      reportPath,
      cost,
    } = await finalizeRun({
      projectRoot,
      runDir,
      runId,
      mode: runMode ?? null,
      outcome,
      deliberate: isDeliberate(outcome),
      reason,
      policyName,
      codeDir,
      records: readRunRecords(runDir),
      driver,
      env,
      codexHome,
    });
    if (cost) log("info", "run.cost", { run_id: runId, ...cost, driver_provenance: "modeled" });
    log(outcome === "completed" ? "info" : "warn", "run.end", {
      run_id: runId,
      outcome: runLogOutcome(outcome),
      driver_outcome: outcome,
      reason,
      exit_code: exitCode,
    });

    say("");
    say(`run ${runId}: ${outcome} — ${reason}`);
    if (outcome === "codex_failed" && lastEnd?.stderr_tail) {
      warn("  last lines codex wrote to stderr:");
      for (const line of lastEnd.stderr_tail.trimEnd().split("\n").slice(-10)) warn(`    ${line}`);
      warn(`  full log: ${stderrLogPath}`);
    }
    if (summaryWhy && existsSync(join(runDir, "SUMMARY.md"))) warn(`  SUMMARY.md does not count as the final report: ${summaryWhy}`);
    for (const n of finalNotes) warn(`  ${n}`);
    for (const line of contractLines) say(`  ${line}`);
    if (m?.pin_rejection) warn(`  the codex CLI rejected the pinned model or effort — ${m.pin_rejection}`);
    for (const t of m?.driver_model_observed?.threads ?? []) {
      if (t.status !== "mismatch") continue;
      warn(
        `  driver model: codex's session file says thread ${t.thread_id} ran ${t.observed?.model} at effort ` +
          `${t.observed?.effort ?? "unknown"}, not the pin ${pin.model} at effort ${pin.effort} (${t.rollout_path})`,
      );
    }
    for (const w of m?.codex_warnings ?? []) warn(`  codex warning: ${w}`);
    for (const line of m ? driverLines(m, driverUsage, cost) : []) say(`  ${line}`);
    if (cost) say(`  run total (dispatched + driver): ${money(cost.run_total_usd, cost.run_total_bound)}`);
    say(`  run folder:  ${runDir}`);
    if (reportPath) say(`  report:      ${reportPath}`);
    say(`  Cost report: ${reportCommand(runDir)}`);
    if (outcome !== "completed") {
      const final = runMode === "greenfield" ? null : finalEndRefusal({ projectRoot, runId });
      say(`  Continue:    ${final ? `none: ${final}` : continueCommand()}`);
    }
    return exitCode;
  } catch (err) {
    // The run cannot finish its own end, so its write contract is ended here: a live one would hold every session.
    const ended = endWriteContract({
      projectRoot, runDir, runId, mode: runMode ?? null, outcome: "failed",
      reason: `run.mjs stopped on an error: ${err?.message ?? err}`,
    });
    for (const n of ended.notes) warn(`  ${n}`);
    for (const line of ended.lines) say(`  ${line}`);
    if (ended.contract?.ended) say(`  Continue:    ${continueCommand()}`);
    throw err;
  } finally {
    killGroup("SIGKILL");
    for (const [sig, handler] of handlers) (signals.off ?? signals.removeListener).call(signals, sig, handler);
    process.off("exit", onExit);
    clearTimeout(killTimer);
    lines.close();
  }
}

if (isMain(import.meta.url, process.argv[1])) {
  ignoreWriteErrors(process.stdout);
  ignoreWriteErrors(process.stderr);
  exitAfterFlush(await main(process.argv.slice(2)));
}
