#!/usr/bin/env node
/**
 * The conductor's dispatch tool.
 *
 * In the Claude harness the orchestrator calls `execute_with_model` as an MCP
 * tool directly. On codex it cannot: a model inside `codex exec` has no
 * per-MCP-tool function binding at all (docs/verification/p1-codex-runtime.md
 * check 4, verified five ways). So the conductor shells out to THIS script
 * instead, and this script speaks MCP to the bridge on its behalf via
 * driverClient.js. The bridge, its five tool signatures, and the TaskPacket
 * contract are all unchanged — only who opens the socket moved.
 *
 * Follows the headless file-output rule from the port track's gotcha ledger:
 * the full result is written to `--out`, and stdout carries only a compact
 * one-line summary. A conductor that tried to parse a large result off
 * stdout would be reading a stream codex may truncate or interleave.
 *
 * Usage:
 *   node dispatch.mjs --packet=<packet.json> --out=<result.json> \
 *                     [--policy=<name>] [--project-root=<path>] \
 *                     [--telemetry=<path>] [--work-dir=<path>]
 *   node dispatch.mjs --preflight --auth-mode=vendor [--policy=<name>] \
 *                     [--project-root=<path>] --out=<result.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readMmoSelectFile } from "./mmoSelect.mjs";

const BRIDGE_CLIENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcp",
  "model-dispatch",
  "dist",
  "driverClient.js",
);

/** `--key=value` and bare `--flag` parsing. No positional arguments. */
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
 * The environment the bridge subprocess gets. MMO_SELECT resolves from the
 * project-local selection file when the caller's own environment doesn't
 * already set one — an explicit export still wins, so CI can override a
 * committed project default without editing the file.
 */
export function bridgeEnv(projectRoot, env = process.env, readSelect = readMmoSelectFile) {
  const stored = readSelect(projectRoot);
  if (env.MMO_SELECT || !stored) return undefined;
  return { MMO_SELECT: stored };
}

/**
 * Builds the `execute_with_model` argument object. Split out from the
 * dispatch itself so the argument shape is testable without a live bridge —
 * a wrong or missing field here is the failure mode that costs a whole
 * premium phase to discover.
 */
export function buildExecuteArgs({ packet, policy, projectRoot, telemetryPath, workDir }) {
  const args = { packet };
  if (policy) args.policy_name = policy;
  if (projectRoot) args.project_root = projectRoot;
  if (telemetryPath) args.telemetry_path = telemetryPath;
  if (workDir) args.work_dir = workDir;
  return args;
}

/** Builds the `preflight_dispatch` argument object. */
export function buildPreflightArgs({ authMode, policy, projectRoot }) {
  const args = { auth_mode: authMode };
  if (policy) args.policy_name = policy;
  if (projectRoot) args.project_root = projectRoot;
  return args;
}

/**
 * One compact line for the conductor to read off stdout. Deliberately
 * excludes the result body — that is what `--out` is for.
 */
export function summarize(toolName, result) {
  if (toolName === "preflight_dispatch") {
    const models = (result?.models ?? []).map((m) => `${m.id}:${m.ok ? "ok" : "FAILED"}`).join(" ");
    return `preflight ok=${result?.ok === true} ${models}`.trim();
  }
  const cost = result?.result?.cost_usd ?? result?.events?.[0]?.cost_usd;
  const model = result?.decision?.modelId ?? "unknown";
  const success = result?.result?.success;
  return `dispatch model=${model} success=${success === true} cost_usd=${cost ?? "n/a"}`;
}

function writeResult(outPath, payload) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

/**
 * Core dispatch. `connect` is injected so tests can exercise argument
 * construction, result writing and summarizing without a live bridge or
 * any vendor call.
 */
export async function runDispatch(args, { connect, env = process.env } = {}) {
  const projectRoot = args["project-root"] ? resolve(args["project-root"]) : process.cwd();
  const outPath = args.out;
  if (!outPath) throw new Error("dispatch: --out=<path> is required — results are written to a file, never stdout.");

  const isPreflight = Boolean(args.preflight);
  let toolName;
  let toolArgs;

  if (isPreflight) {
    if (!args["auth-mode"]) {
      throw new Error(
        "dispatch: --auth-mode=vendor|estimated is required for --preflight. The bridge refuses to " +
          "guess which models a run dispatches through it.",
      );
    }
    toolName = "preflight_dispatch";
    toolArgs = buildPreflightArgs({
      authMode: args["auth-mode"],
      policy: args.policy,
      projectRoot,
    });
  } else {
    if (!args.packet) throw new Error("dispatch: --packet=<path> is required.");
    let packet;
    try {
      packet = JSON.parse(readFileSync(resolve(args.packet), "utf-8"));
    } catch (err) {
      throw new Error(`dispatch: could not read the packet at ${args.packet} — ${err.message}`);
    }
    toolName = "execute_with_model";
    toolArgs = buildExecuteArgs({
      packet,
      policy: args.policy,
      projectRoot,
      telemetryPath: args.telemetry,
      workDir: args["work-dir"],
    });
  }

  const bridge = await connect({ env: bridgeEnv(projectRoot, env) });
  try {
    const result = await bridge.callTool(toolName, toolArgs);
    writeResult(outPath, result);
    // The tool call succeeding is not the same as the tool being happy. A
    // preflight that reports ok:false is the single most important "stop
    // now" signal in the whole run, and a caller that only checked the exit
    // code would read it as a pass — so the exit code carries the verdict
    // too, not just the payload.
    const verdict = toolName === "preflight_dispatch" ? result?.ok === true : true;
    return { ok: verdict, toolName, result, summary: summarize(toolName, result) };
  } finally {
    await bridge.close();
  }
}

// Direct-execution gate so the test suite can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const { connectBridge } = await import(BRIDGE_CLIENT);
  try {
    const { ok, summary } = await runDispatch(args, { connect: connectBridge });
    console.log(summary);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    // stderr, not stdout — the conductor reads stdout for the summary line.
    console.error(`dispatch failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
