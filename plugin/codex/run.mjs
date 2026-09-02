#!/usr/bin/env node
/**
 * Driver entry — the measured, headless run.
 *
 * Constructs and invokes `codex exec` with every pin the fairness argument
 * depends on, wires the write-contract hook, captures the `--json` event
 * stream, and turns that stream into run artifacts: the driver's own
 * modeled cost, the pin-rejection check, and the trajectory record.
 *
 * What this script does NOT do is author content or decide pipeline order:
 * the conductor prompt does that inside codex, dispatching each phase's
 * real model call out to dispatch.mjs (which speaks MCP to the bridge on
 * its behalf — see that file for why the conductor cannot call the bridge
 * itself). This script is the harness around the conductor, not the
 * conductor.
 *
 * Every pin below is the one recorded in
 * docs/verification/p1-codex-runtime.md section "Pins chosen", and each was
 * verified live before being pinned. Two of them are load-bearing in
 * non-obvious ways:
 *   - `sandbox_workspace_write.network_access=true` — without it the bridge
 *     subprocess is silently killed by the sandbox (empty stderr, no JS
 *     error; the sandbox finding in the verification doc).
 *   - the `--` separator before the prompt — a prompt beginning with `---`
 *     (skill/frontmatter shaped) is otherwise parsed as CLI flags.
 *
 * Usage:
 *   node run.mjs --brief=<path> --output-dir=<path> \
 *                [--project-root=<path>] [--policy=<name>] [--run-id=<id>] \
 *                [--code-dir=<path>] [--gates=prompt|auto-approve|auto-abort] \
 *                [--mode=greenfield|brownfield] [--intent=<id>] [--seed=<text>] \
 *                [--resume=<session-id>] [--max-turns=<n>] \
 *                [--codex-bin=<path>] [--prompt-file=<path>] [--dry-run]
 *
 * `--mode`, `--intent` and `--seed` supply the handover the brownfield guide's
 * step 4 reads. Without them an unattended brownfield run reaches the "which
 * job type?" question with stdin closed and nobody to answer it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { parseEventStream, modeledDriverCostEvents } from "./telemetry/event-reader.mjs";
import { readPin, assertPinnedInvocation, findPinRejection } from "./telemetry/fairnessPin.mjs";

const CODEX_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(CODEX_DIR);
const WRITE_CONTRACT_HOOK = join(CODEX_DIR, "hooks", "write-contract-check.mjs");
const DEFAULT_POLICY = "gpt-plus-flash";

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

/**
 * What the conductor is told to do at each approval gate.
 *
 * `codex exec` runs with stdin closed, so a conductor told to "wait for the
 * user's answer" in that mode waits for something that can never arrive.
 * The flag surface here (`--gates`) is the one the brownfield guide already
 * documents; this is its implementation.
 *
 * `prompt` remains the default because a gate nobody reads is a weaker
 * guarantee than one somebody does, and defaulting to auto-approve would
 * quietly turn the review gates into decoration.
 */
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

export const GATE_MODES = {
  prompt:
    "Stop and ask the user at each gate. Print what was produced, where it is, and what you " +
    "propose to do next, then wait for their answer before continuing.",
  "auto-approve":
    "You are running UNATTENDED — there is no user to answer, and stdin is closed. At each " +
    "gate, print what was produced and where it is, record the decision as `auto-approved`, " +
    "and continue without waiting. Do not ask a question you cannot receive an answer to. " +
    "If an artifact looks wrong enough that a reviewer would have rejected it, say so plainly " +
    "in the gate record and in your final report rather than passing it silently.",
  "auto-abort":
    "You are running UNATTENDED with gates set to abort. At each gate, print what was " +
    "produced, record the decision as `aborted`, and stop the run there. Use this to produce " +
    "one phase's artifact for inspection without proceeding.",
};

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

/**
 * Substitutes the run's real paths into the conductor prompt. The prompt
 * ships with `{{PLACEHOLDER}}` markers rather than hardcoded paths because
 * the same text is also the basis for the interactive prompt install, where
 * the values differ per project.
 *
 * Throws on any placeholder left unrendered: a conductor prompt that reaches
 * the model still saying `{{OUTPUT_DIR}}` produces a run that writes its
 * artifacts to a directory literally named that, which is a confusing mess
 * to diagnose after the fact and trivially cheap to catch here.
 */
export function renderPrompt(template, values) {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
  const leftover = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(
      `run: conductor prompt has unrendered placeholder(s): ${[...new Set(leftover)].join(", ")}`,
    );
  }
  return rendered;
}

/**
 * The skills the conductor reads for phase-level detail. They ship with the
 * same `{{PLACEHOLDER}}` markers the conductor prompt uses, so they are
 * rendered into the run's output directory and the conductor is pointed at
 * the rendered copies — a skill read straight off disk would hand the model
 * uninterpolated `{{PLUGIN_ROOT}}` text in the middle of a command it is
 * being told to run.
 *
 * Note for whoever builds the interactive plugin route: codex's own skill
 * discovery reads `plugin/skills/*​/SKILL.md` directly and never passes
 * through this renderer, so that route needs its own answer to path
 * interpolation before those skills are usable there.
 */
export const RENDERED_SKILLS = [
  ["pipeline", join("pipeline", "SKILL.md")],
  ["brownfield-guide", join("brownfield-guide", "SKILL.md")],
];

export function renderSkills(outputDir, values, pluginRoot = PLUGIN_ROOT) {
  const written = [];
  for (const [name, rel] of RENDERED_SKILLS) {
    const source = join(pluginRoot, "skills", rel);
    if (!existsSync(source)) continue;
    const target = join(outputDir, "skills", `${name}.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPrompt(readFileSync(source, "utf-8"), values), "utf-8");
    written.push(target);
  }
  return written;
}

/** Loads the policy YAML the pins are read from. */
export function loadPolicyFile(policyName, pluginRoot = PLUGIN_ROOT) {
  const path = join(pluginRoot, "config", "policies", `${policyName}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`run: policy '${policyName}' not found at ${path}.`);
  }
  return parseYaml(readFileSync(path, "utf-8"));
}

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
  hookPath = WRITE_CONTRACT_HOOK,
  cwd,
  codexHome = defaultCodexHome(),
  /** Resume this session instead of starting a new one. See RESUME_PROMPT. */
  resumeThreadId = null,
}) {
  // The hook path is single-quoted inside the TOML double-quoted command
  // string: this repo's own checkout path contains spaces ("TL ai labs"),
  // and an unquoted path splits into separate argv entries when codex runs
  // the hook — the guard then silently never fires, which is the worst
  // possible failure for a write gate (it fails OPEN, invisibly).
  const quotedHook = `'${hookPath}'`;
  const hookConfig =
    `hooks.PreToolUse=[` +
    `{matcher="apply_patch",hooks=[{type="command",command="node ${quotedHook}"}]},` +
    `{matcher="Bash",hooks=[{type="command",command="node ${quotedHook}"}]}` +
    `]`;

  return [
    "exec",
    // `resume <id>` must follow `exec` and precede the prompt. Everything
    // else about the invocation is identical, so the pin, sandbox, hooks and
    // network grant apply to a resumed turn exactly as to the first.
    ...(resumeThreadId ? ["resume", resumeThreadId] : []),
    "--json",
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
    // Writable so a nested `codex exec` (the seat-backed dispatch path) can
    // initialise its own app-server state. See defaultCodexHome above.
    ...(codexHome ? ["-c", `sandbox_workspace_write.writable_roots=["${codexHome}"]`] : []),
    "-c",
    hookConfig,
    "--",
    promptText,
  ];
}

/**
 * How many `codex exec` turns the driver will spend on one run.
 *
 * A single turn is not enough for a real project. The first Workforce Ops
 * reference run got through requirements, design and into codegen, then the
 * turn simply ended — it had accumulated 2.9M input tokens (2.8M of them
 * cached) and hit the context ceiling with six phases still to go. `exit=0`,
 * no error, just an unfinished run, which is the most misleading way for this
 * to fail.
 *
 * `codex exec resume <session-id>` continues the same session, so the driver
 * resumes until the pipeline signals completion or this cap is reached.
 */
export const DEFAULT_MAX_TURNS = 12;

/**
 * The pipeline's last act (phase 9) is to write manifest.json and SUMMARY.md.
 * SUMMARY.md is therefore the completion signal — an artifact only the final
 * phase produces, rather than a phrase in prose the model might improvise.
 */
export function runIsComplete(outputDir, exists = existsSync) {
  return exists(join(outputDir, "SUMMARY.md"));
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
 * What a resumed turn is told. Deliberately short: the session already holds
 * the conductor prompt and everything done so far, so restating the pipeline
 * would burn the very context that ran out.
 */
export const RESUME_PROMPT =
  "Continue the run from where you stopped. Re-read your own artifacts in the output directory " +
  "to see what is already done — do not redo completed phases, and do not re-dispatch a packet " +
  "whose result file already exists. Pick up at the first incomplete phase and carry on through " +
  "the remaining gates. The rules you were given still apply: you author no shipped content, " +
  "every artifact comes back from a dispatch. Finish with the final report, manifest.json and " +
  "SUMMARY.md.";

/**
 * Spawns codex and collects its stdout/stderr. stdin is closed explicitly:
 * `codex exec` reads stdin when attached and a phase can hang on a pipe
 * that never closes (gotcha ledger).
 */
export function spawnCodex(args, { spawnFn = spawn, cwd, codexBin = "codex" } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawnFn(codexBin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => resolvePromise({ status: null, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/**
 * Turns a finished run's raw JSONL into the artifacts a reader and the
 * cost report need. Pure — takes the stream text, returns what to write.
 */
export function buildRunArtifacts({ jsonl, pin, pricing, passId, now }) {
  const events = parseEventStream(jsonl, now);
  const rejection = findPinRejection(events);
  const modeled = modeledDriverCostEvents(events, {
    pass: passId,
    model: pin.model,
    pricing,
    now,
  });
  return { events, rejection, modeled };
}

async function main(args) {
  const projectRoot = args["project-root"] ? resolve(args["project-root"]) : process.cwd();
  const outputDir = args["output-dir"] ? resolve(args["output-dir"]) : join(projectRoot, ".sdlc");
  const policyName = args.policy ?? DEFAULT_POLICY;
  const runId = args["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");

  // Defaults to the shipped conductor prompt; --prompt-file overrides it for
  // a smoke test or a one-off.
  const promptPath = args["prompt-file"]
    ? resolve(args["prompt-file"])
    : join(CODEX_DIR, "prompts", "conductor.md");
  const codeDir = args["code-dir"] ? resolve(args["code-dir"]) : join(projectRoot, "src");
  const briefPath = args.brief ? resolve(args.brief) : join(projectRoot, "brief.md");
  if (!args["prompt-file"] && !existsSync(briefPath)) {
    // Only enforced for the shipped conductor prompt, which reads a brief. A
    // custom --prompt-file may legitimately not need one (smoke tests).
    throw new Error(
      `run: no brief at ${briefPath}. Pass --brief=<path>, or put brief.md at the project root.`,
    );
  }
  const gateMode = args.gates ?? "prompt";
  if (!(gateMode in GATE_MODES)) {
    throw new Error(`run: --gates=${gateMode} is not one of ${Object.keys(GATE_MODES).join(", ")}.`);
  }

  const mode = args.mode;
  if (mode && mode !== "greenfield" && mode !== "brownfield") {
    throw new Error(`run: --mode=${mode} is not one of greenfield, brownfield.`);
  }
  const intent = args.intent;
  if (intent) {
    const allowed = validIntents();
    if (!allowed.includes(intent)) {
      throw new Error(`run: --intent=${intent} is not one of ${allowed.join(", ")}.`);
    }
    // An intent only means something to the brownfield guide. Accepting it
    // alongside greenfield would silently do nothing.
    if (mode === "greenfield") {
      throw new Error("run: --intent applies to brownfield runs; --mode=greenfield takes none.");
    }
  }

  const renderValues = {
    PLUGIN_ROOT: PLUGIN_ROOT,
    PROJECT_ROOT: projectRoot,
    OUTPUT_DIR: outputDir,
    CODE_DIR: codeDir,
    BRIEF_PATH: briefPath,
    POLICY: policyName,
    RUN_ID: runId,
    GATE_INSTRUCTION: GATE_MODES[gateMode],
    HANDOVER: renderHandover({ mode, intent, seed: args.seed }),
  };
  const promptText = renderPrompt(readFileSync(promptPath, "utf-8"), renderValues);

  const policy = loadPolicyFile(policyName);
  const pin = readPin(policy);
  // Fails before spending anything if the driver script and the policy have
  // drifted apart — the only point where the pin is reliably enforceable
  // (the stream never echoes back which model actually answered).
  assertPinnedInvocation({ model: pin.model, effort: pin.effort }, policy);

  const gpt = policy.models.find((m) => m.id === "gpt");
  const codexArgs = buildCodexArgs({ pin, promptText, cwd: projectRoot });

  if (args["dry-run"]) {
    // Everything above this line is the part worth checking without paying
    // for a turn: pins resolved, argv built, artifacts directory chosen.
    console.log(JSON.stringify({ policy: policyName, pin, run_id: runId, output_dir: outputDir, argv: codexArgs }, null, 2));
    return 0;
  }

  mkdirSync(outputDir, { recursive: true });
  renderSkills(outputDir, renderValues);
  const started = new Date().toISOString();
  // `--codex-bin` covers machines where codex is not globally installed —
  // an npx wrapper, a version-managed install, a CI image that vendors it
  // somewhere specific. Without it the driver dies with a bare ENOENT that
  // says nothing about what to do next.
  const codexBin = args["codex-bin"] ?? "codex";
  const maxTurns = Number(args["max-turns"] ?? DEFAULT_MAX_TURNS);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`run: --max-turns=${args["max-turns"]} must be a positive integer.`);
  }

  // One `codex exec` turn does not finish a real project — it ends when the
  // session hits its context ceiling, with exit 0 and no error. Resume the
  // same session until the pipeline writes SUMMARY.md, or the cap is hit.
  //
  // `--resume=<id>` picks up a session from an earlier driver invocation
  // instead of starting a new one. Without it, continuing an interrupted run
  // means a fresh session that has to re-read every artifact to work out what
  // is already done — correct, but it pays for context the old session still
  // holds.
  const resumeFrom = args.resume ?? null;
  let result = await spawnCodex(
    resumeFrom
      ? buildCodexArgs({ pin, promptText: RESUME_PROMPT, cwd: projectRoot, resumeThreadId: resumeFrom })
      : codexArgs,
    { cwd: projectRoot, codexBin },
  );
  if (result.status === null && /ENOENT/.test(result.stderr ?? "")) {
    throw new Error(
      `run: could not launch '${codexBin}'. Install it (npm install -g @openai/codex), ` +
        `or point at it explicitly with --codex-bin=<path>.`,
    );
  }

  let stdout = result.stdout;
  // A resumed stream may not re-emit thread.started, so fall back to the id
  // we resumed from — otherwise the loop cannot resume a second time.
  const threadId = threadIdFrom(result.stdout) ?? resumeFrom;
  let invocations = 1;

  while (
    invocations < maxTurns &&
    result.status === 0 &&
    threadId &&
    !runIsComplete(outputDir)
  ) {
    console.log(
      `run ${runId}: session incomplete after invocation ${invocations} ` +
        `(no SUMMARY.md yet) — resuming ${threadId}`,
    );
    result = await spawnCodex(
      buildCodexArgs({ pin, promptText: RESUME_PROMPT, cwd: projectRoot, resumeThreadId: threadId }),
      { cwd: projectRoot, codexBin },
    );
    // Concatenated, so cost and event accounting cover every turn — the
    // modeled-cost reader sums each turn.completed it finds.
    stdout += result.stdout;
    invocations += 1;
  }

  if (!runIsComplete(outputDir)) {
    console.log(
      `run ${runId}: stopped after ${invocations} invocation(s) without SUMMARY.md — ` +
        (invocations >= maxTurns
          ? `hit --max-turns=${maxTurns}.`
          : `codex exited ${result.status}.`) +
        " Artifacts so far are in the output directory; re-run to continue.",
    );
  }

  const jsonlPath = join(outputDir, "driver-events.jsonl");
  writeFileSync(jsonlPath, stdout, "utf-8");

  const { events, rejection, modeled } = buildRunArtifacts({
    // The accumulated stream across every resumed turn, not just the last —
    // using result.stdout here would silently drop the cost and events of
    // every turn but the final one.
    jsonl: stdout,
    pin,
    pricing: gpt.pricing,
    passId: runId,
  });

  // Modeled driver cost goes in its own file, labelled, never mixed into the
  // bridge's own vendor-metered telemetry.jsonl (D4).
  const modeledPath = join(outputDir, "driver-cost-modeled.jsonl");
  writeFileSync(modeledPath, modeled.map((e) => JSON.stringify(e)).join("\n") + (modeled.length ? "\n" : ""), "utf-8");

  const totalModeled = modeled.reduce((sum, e) => sum + e.cost_usd, 0);
  const manifest = {
    run_id: runId,
    policy: policyName,
    // Recorded so a reader can tell whether a person actually reviewed the
    // gates or the run approved itself.
    gates: gateMode,
    pin: { ...pin, sandbox: SANDBOX_MODE, approval_policy: APPROVAL_POLICY },
    started_at: started,
    ended_at: new Date().toISOString(),
    codex_exit_status: result.status,
    driver_turns: modeled.length,
    // How many times the driver invoked codex. Distinct from driver_turns,
    // which counts model turns inside those invocations — a resumed run has
    // more of both, and only this one says how often the session had to be
    // picked back up.
    codex_invocations: invocations,
    // Whether the pipeline actually reached its final phase. A run that ran
    // out of turns still exits 0 with useful artifacts, so this is the field
    // that distinguishes "finished" from "stopped partway".
    completed: runIsComplete(outputDir),
    driver_cost_usd_modeled: Math.round(totalModeled * 1e6) / 1e6,
    pin_rejection: rejection,
    events_captured: events.length,
  };
  writeFileSync(join(outputDir, "driver-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  if (rejection) {
    console.error(`run: the codex CLI rejected the pinned model or effort — ${rejection}`);
    return 1;
  }
  console.log(
    `run ${runId} finished: exit=${result.status} turns=${modeled.length} ` +
      `driver_cost_usd(modeled)=${manifest.driver_cost_usd_modeled} artifacts=${outputDir}`,
  );
  // A run whose cost nobody reads has not demonstrated anything. Name the
  // command rather than printing the report inline — the report is long, and
  // stdout here is a summary line the caller may be parsing.
  console.log(`\n  Cost report:  node tools/report.mjs '${outputDir}'`);
  console.log(`                add --markdown to paste it somewhere.`);
  return result.status === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(await main(parseArgs(process.argv.slice(2))));
  } catch (err) {
    console.error(`run failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
