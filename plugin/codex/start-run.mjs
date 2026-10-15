#!/usr/bin/env node
/**
 * Starts a run from a `$mmo-codex:*` skill in a codex session: checks the
 * session runs the policy's driver pin, creates the run folder, renders the
 * playbooks into `<run folder>/skills/` with real paths, writes run.json,
 * logs run.start, and prints where everything is. A resumed brownfield run
 * gets back the write contract its end switched off.
 *
 * Usage:
 *   node start-run.mjs --mode=greenfield|brownfield [--project-root=<path>]
 *                      [--policy=<name>] [--brief=<path>] [--code-dir=<path>]
 *                      [--intent=<id>] [--gates=prompt|auto-approve|auto-abort]
 *                      [--run-id=<id>] [--resume=<run-id>] [--json]
 *
 * Exit codes: 0 started, 1 the session is not on the driver pin (or that
 * cannot be read) or the harness could not load or render, 2 usage error or
 * refused.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

import { renderedSkillPath, renderSkills } from "./render.mjs";
import {
  GATE_RECORD,
  INTERACTIVE_GATE_MODES,
  intentIds,
  parseFlags,
  PLUGIN_ROOT,
  pluginVersion,
  readRunJson,
  ROUTE,
  RUN_JSON,
  RUN_JSON_VERSION,
  shellQuote,
  UsageError,
  writeRunJson,
} from "./interactive-run.mjs";
import { assertResumePolicy, policyRecord, resolveRunPolicy, RunRefusal } from "./run-policy.mjs";
import { checkSessionModel } from "./session-model.mjs";
import { staleBridgeBuild, staleBuildWarning } from "./bridge-build.mjs";
import { appendSessionMarker } from "./session-marker.mjs";
import { ContractRefusal, guardCheckCommand, reopenRun } from "../scripts/write-contract.mjs";
import { isRunId, runDirFor } from "../scripts/lib/run-id.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { configureSinks, log } from "../scripts/lib/log.mjs";
import { exitAfterFlush } from "../scripts/lib/exit.mjs";

export const START_FLAGS = Object.freeze({
  value: ["mode", "project-root", "policy", "brief", "code-dir", "intent", "gates", "run-id", "resume"],
  boolean: ["json"],
});

const FLAG_HINTS = {
  "output-dir":
    "--output-dir is a run.mjs flag. A run started in a session keeps its record in <project-root>/.sdlc/runs/<run-id>/.",
  seed: "--seed is a run.mjs flag. In a session, hand the job description to the brownfield guide's step 4 instead.",
};

export function parseStartArgs(argv) {
  return parseFlags(argv, { ...START_FLAGS, script: "start-run.mjs", hints: FLAG_HINTS });
}

function gitToplevel(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? String(r.stdout).trim() || null : null;
}

function isGitWorkTree(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && String(r.stdout).trim() === "true";
}

/** run-folder.mjs needs the built bridge; a plugin update wipes dist/, so say how to rebuild. */
async function loadRunFolder(pluginRoot) {
  try {
    return await import("./run-folder.mjs");
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    const e = new Error(
      `the dispatch bridge is not built (${err.message}). Run node ${shellQuote(join(pluginRoot, "codex", "verify-setup.mjs"))} --fix, then start the run again.`,
    );
    e.exitCode = 1;
    throw e;
  }
}

/** How the printed `policy:` line names where the policy came from; the playbooks quote these. */
const POLICY_SOURCE_LABEL = {
  "project-override": "routing-policy.yaml",
  flag: "--policy",
  "project-default": "project.json",
  "builtin-default": "default",
};

function refuseChange(flag, given, recorded, runId) {
  if (given !== undefined && recorded !== undefined && recorded !== null && given !== recorded) {
    throw new UsageError(`--${flag}=${given} differs from run ${runId}'s ${flag} (${recorded}); a resumed run keeps its ${flag}.`);
  }
}

/**
 * Creates or resumes the run and returns what start-run prints. `deps`
 * replaces cwd, env (CODEX_HOME and CODEX_THREAD_ID locate the session's
 * rollout), stderr, the clock, the id's random part, and the git checks.
 */
export async function startRun(args, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const pluginRoot = deps.pluginRoot ?? PLUGIN_ROOT;
  const now = deps.now ? new Date(deps.now()) : new Date();
  const isGitRepo = deps.isGitRepo ?? isGitWorkTree;
  const toplevel = deps.gitToplevel ?? gitToplevel;
  const folder = await loadRunFolder(pluginRoot);

  if (args.gates !== undefined && !(args.gates in INTERACTIVE_GATE_MODES)) {
    throw new UsageError(`--gates=${args.gates} is not one of ${Object.keys(INTERACTIVE_GATE_MODES).join(", ")}.`);
  }

  let earlier = null;
  let projectRoot;
  if (args.resume !== undefined) {
    if (!isRunId(args.resume)) throw new UsageError(`--resume=${args.resume} is not a run id (the run folder's name).`);
    const candidates = args["project-root"] !== undefined ? [resolve(cwd, args["project-root"])] : [cwd, toplevel(cwd)].filter(Boolean);
    projectRoot = candidates.find((root) => existsSync(runDirFor(root, args.resume))) ?? candidates[0];
    const dir = runDirFor(projectRoot, args.resume);
    earlier = readRunJson(dir);
    if (!earlier) {
      const how = existsSync(join(dir, "driver-events.jsonl"))
        ? `it was started by run.mjs; continue it with node ${shellQuote(join(pluginRoot, "codex", "run.mjs"))} --resume=${args.resume}`
        : "no run folder by that name holds one";
      throw new UsageError(`--resume=${args.resume}: no ${RUN_JSON} at ${dir}: ${how}.`);
    }
    if (earlier.outcome === "completed") {
      throw new UsageError(`run ${args.resume} already completed (${dir}). Start a new run instead of resuming it.`);
    }
    refuseChange("mode", args.mode, earlier.mode, args.resume);
    refuseChange("intent", args.intent, earlier.intent, args.resume);
    // A routing-policy.yaml can win over the --policy a run started with, so either name is that run's.
    if (args.policy !== earlier.policy_requested) refuseChange("policy", args.policy, earlier.policy, args.resume);
    refuseChange("run-id", args["run-id"], earlier.run_id, args.resume);
    if (args["code-dir"] !== undefined || args.brief !== undefined) {
      throw new UsageError("a resumed run keeps its --code-dir and --brief; drop them.");
    }
  }

  const mode = args.mode ?? earlier?.mode;
  if (mode !== "greenfield" && mode !== "brownfield") {
    throw new UsageError(
      mode === undefined ? "--mode=greenfield or --mode=brownfield is required." : `--mode=${mode} is not one of greenfield, brownfield.`,
    );
  }
  if (!earlier) {
    projectRoot = resolve(cwd, args["project-root"] ?? (mode === "brownfield" ? (toplevel(cwd) ?? ".") : "."));
  }
  if (mode === "brownfield" && !isGitRepo(projectRoot)) {
    throw new UsageError(
      `${projectRoot} is not a git repository. Brownfield needs git (git init); for a new app in an empty folder use $mmo-codex:greenfield.`,
    );
  }

  const intent = args.intent ?? earlier?.intent ?? undefined;
  if (args.intent !== undefined && (earlier?.intent ?? null) === null) {
    if (mode === "greenfield") throw new UsageError("--intent applies to brownfield runs; --mode=greenfield takes none.");
    const allowed = intentIds(pluginRoot);
    if (!allowed.includes(intent)) throw new UsageError(`--intent=${intent} is not one of ${allowed.join(", ")}.`);
  }
  if (mode === "brownfield" && args.brief !== undefined) {
    throw new UsageError(
      "--brief is for greenfield. A brownfield run's intent brief is written into the run folder at the guide's step 4; hand a file over there.",
    );
  }

  const stderr = deps.stderr ?? process.stderr;
  const warn = (line) => stderr.write(`${line}\n`);
  let policy;
  try {
    policy = resolveRunPolicy({
      projectRoot,
      policyArg: args.policy ?? earlier?.policy_requested ?? earlier?.policy ?? null,
      warn,
      now,
    });
    if (earlier) {
      assertResumePolicy({
        recorded: { name: earlier.policy, path: earlier.policy_path ?? null, sha256: earlier.policy_sha256 ?? null, pin: earlier.pin ?? null },
        run: policy,
        runDir: runDirFor(projectRoot, args.resume),
        warn,
      });
    }
  } catch (err) {
    if (err instanceof RunRefusal) throw new UsageError(err.message.replace(/^run: /, ""));
    throw err;
  }
  if (policy.notice && args.policy !== undefined) warn(policy.notice);
  const gates = args.gates ?? earlier?.gates ?? "prompt";

  let runId;
  let runDir;
  if (earlier) {
    runId = earlier.run_id ?? args.resume;
    runDir = runDirFor(projectRoot, args.resume);
  } else {
    ({ runId, runDir } = folder.resolveRun({
      projectRoot,
      runIdFlag: args["run-id"],
      mode,
      intent,
      now,
      rand: deps.rand,
    }));
  }

  const codeDir = earlier?.code_dir ?? folder.resolveCodeDir({ projectRoot, codeDir: args["code-dir"], mode });
  let briefPath;
  if (earlier) briefPath = earlier.brief_path;
  else if (mode === "greenfield") {
    briefPath = args.brief ? (isAbsolute(args.brief) ? args.brief : resolve(cwd, args.brief)) : join(projectRoot, "brief.md");
    if (!existsSync(briefPath)) {
      throw new UsageError(`no brief at ${briefPath}. Pass --brief=<path>, or put brief.md in the project folder.`);
    }
  } else briefPath = join(runDir, "intent_brief.md");

  const pin = policy.driver.pin;
  // Before the run folder exists, so a session on the wrong model leaves nothing behind.
  const session = checkSessionModel({
    codexHome: env.CODEX_HOME ?? null,
    threadId: env.CODEX_THREAD_ID || null,
    pin,
    policyName: policy.name,
    now,
    warn: () => {},
  });
  if (session.status !== "match") {
    const e = new Error(`no run started: this session must run ${pin.model} at effort ${pin.effort}.\n${session.message}`);
    e.exitCode = 1;
    throw e;
  }

  let contract = null;
  if (earlier && mode === "brownfield") {
    try {
      contract = reopenRun({ projectRoot, runId, now });
    } catch (err) {
      if (err instanceof ContractRefusal) throw new UsageError(err.message);
      throw err;
    }
    if (contract.provenance?.error) warn(`start-run: provenance.json was not reopened: ${contract.provenance.error}`);
  }

  const values = {
    PLUGIN_ROOT: pluginRoot,
    PROJECT_ROOT: projectRoot,
    OUTPUT_DIR: runDir,
    CODE_DIR: codeDir,
    BRIEF_PATH: briefPath,
    POLICY: policy.name,
    RUN_ID: runId,
  };
  try {
    renderSkills(runDir, values, pluginRoot);
  } catch (err) {
    err.exitCode = 1;
    throw err;
  }

  const at = now.toISOString();
  const threadId = env.CODEX_THREAD_ID || null;
  const start = { at, codex_thread_id: threadId, resume: Boolean(earlier), gates, session_model: session.observed };
  const record = earlier
    ? {
        ...earlier,
        intent: intent ?? null,
        gates,
        starts: [...(earlier.starts ?? []), start],
        ended_at: null,
        outcome: null,
        deliberate: null,
        reason: null,
      }
    : {
        schema_version: RUN_JSON_VERSION,
        run_id: runId,
        route: ROUTE,
        mode,
        intent: intent ?? null,
        ...policyRecord(policy),
        pin,
        gates,
        project_root: projectRoot,
        code_dir: codeDir,
        brief_path: briefPath,
        plugin_root: pluginRoot,
        plugin_version: pluginVersion(pluginRoot),
        started_at: at,
        starts: [start],
        ended_at: null,
        outcome: null,
        deliberate: null,
        reason: null,
      };
  writeRunJson(runDir, record);
  // Opens the conductor's cost window at the turn that started the run, before any dispatch.
  appendSessionMarker(runDir, { tool: "start_run", policy: policy.path ?? policy.name }, { env, now: () => at, warn });

  configureSinks({ runLogPath: join(runDir, "orchestrator.log") });
  log("info", "run.start", {
    run_id: runId,
    route: ROUTE,
    mode,
    intent,
    policy: policy.name,
    gates,
    code_dir: codeDir,
    thread_id: threadId ?? undefined,
    resume: earlier ? true : undefined,
  });

  const staleWarning = staleBuildWarning((deps.staleBuild ?? staleBridgeBuild)(pluginRoot), pluginRoot);
  const playbook = renderedSkillPath(runDir, "pipeline");
  const guide = renderedSkillPath(runDir, "brownfield-guide");
  return {
    run_id: runId,
    route: ROUTE,
    resumed: Boolean(earlier),
    mode,
    intent: intent ?? null,
    run_dir: runDir,
    project_root: projectRoot,
    code_dir: codeDir,
    brief: mode === "greenfield" ? briefPath : null,
    intent_brief: mode === "brownfield" ? briefPath : null,
    policy: policy.name,
    policy_source: policy.source,
    policy_path: policy.path,
    gates,
    gate_instruction: `${INTERACTIVE_GATE_MODES[gates]} ${GATE_RECORD}`,
    plugin_root: pluginRoot,
    playbook,
    brownfield_guide: mode === "brownfield" ? guide : null,
    read_first: mode === "brownfield" ? guide : playbook,
    write_contract: contract?.live ? (contract.reopened ? "reopened" : "live") : null,
    // The resuming session may not run the hook (untrusted, or changed by an update): checked again before any write.
    guard_check: contract?.live ? guardCheckCommand(runId, projectRoot) : null,
    warnings: staleWarning ? [staleWarning] : [],
    end_run:
      `node ${shellQuote(join(pluginRoot, "codex", "end-run.mjs"))} --run-dir=${shellQuote(runDir)} ` +
      "--outcome=<outcome> --reason='<one line>'",
  };
}

export function formatStart(result) {
  const lines = [
    `${result.resumed ? "Resumed" : "Started"} run ${result.run_id} (${result.route}, ${result.mode}, policy ${result.policy}).`,
    ...(result.warnings ?? []).map((w) => `warning: ${w}`),
    "",
  ];
  const keys = [
    "run_id", "run_dir", "project_root", "code_dir", "brief", "intent", "intent_brief", "policy",
    "write_contract", "guard_check", "plugin_root", "playbook", "brownfield_guide", "end_run",
  ];
  for (const key of keys) {
    if (result[key] === null || result[key] === undefined) continue;
    const value =
      key === "policy" ? `${result.policy} (from ${POLICY_SOURCE_LABEL[result.policy_source] ?? result.policy_source})` : result[key];
    lines.push(`${key}: ${value}`);
  }
  lines.push(`gates: ${result.gates} — ${result.gate_instruction}`);
  lines.push("");
  if (result.guard_check) {
    lines.push(
      "First: run guard_check in a shell call of its own, before any write. It proves the write hook runs in this " +
        "session; if it exits non-zero, print its message and stop.",
    );
  }
  const follow = result.resumed ? "continue the run from its first incomplete phase" : "follow it";
  lines.push(
    `Next: read ${result.read_first} and ${follow}. Read only the rendered copies in ${join(result.run_dir, "skills")}; ` +
      "the plugin's own skills/*/SKILL.md files carry unfilled placeholders.",
  );
  lines.push(
    `In the playbooks, <output_dir> is ${result.run_dir}, <code_dir> is ${result.code_dir}, ` +
      `and <telemetry_path> is ${join(result.run_dir, "telemetry.jsonl")}.`,
  );
  return lines.join("\n") + "\n";
}

export async function main(argv = [], deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const args = parseStartArgs(argv);
    const result = await startRun(args, deps);
    stdout.write(args.json ? JSON.stringify(result, null, 2) + "\n" : formatStart(result));
    return 0;
  } catch (err) {
    stderr.write(`start-run: ${err?.message ?? err}\n`);
    if (err?.name === "UsageError") return 2;
    return err?.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) {
  exitAfterFlush(await main(process.argv.slice(2)));
}
