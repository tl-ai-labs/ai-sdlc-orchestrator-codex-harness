/**
 * Launch contract for the Antigravity agent worker. Silent failures the
 * seam is prone to: region the receipt claims but the call never used, an
 * API key letting the worker in through a door the evidence doesn't
 * describe, token count read under JS field names for a Python file,
 * cached count billed twice.
 *
 * Pure functions; no Python, no credentials, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_WORKER_TIMEOUT_SEC,
  WORKER_KILL_GRACE_SEC,
  WORKER_PYTHON_ENV,
  WORKER_STRIPPED_ENV,
  buildWorkerArgs,
  buildWorkerEnv,
  evidenceStem,
  mapSidecarTokens,
  resolveWorkerPython,
  sidecarToolCallCount,
  workerTaskMarkdown,
  workerThinkingLevel,
  workerVenvPython,
} from "../dist/delegation/workerProcess.js";
import { createAdapter } from "../dist/adapters/index.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PY = join(PACKAGE_ROOT, "worker", "gemini_worker.py");

/** Minimal packet — every field the renderers read, nothing they don't. */
function packet(over = {}) {
  return {
    id: "tp_codegen_042",
    phase: "codegen",
    task_type: "controller_handler",
    module: "employees",
    instruction: "Add a leave-balance endpoint.",
    inputs: [{ path: "src/leave.ts", content: "export const x = 1;", reason: "the module to extend" }],
    outputSchema: { type: "object", properties: { files: { type: "array" } } },
    acceptance: ["returns 200", "covered by a unit test"],
    budget: { maxInputTokens: 8000, maxOutputTokens: 4096 },
    pass_id: "pass1",
    ...over,
  };
}

// ---------------------------------------------------------------- interpreter

test("an explicit interpreter override wins, and a broken one is refused by name", () => {
  const env = { [WORKER_PYTHON_ENV]: "/opt/py310/bin/python" };
  assert.equal(
    resolveWorkerPython({ env, workerDir: "/w", exists: (p) => p === "/opt/py310/bin/python" }),
    "/opt/py310/bin/python",
  );
  // A typo'd override must not fall through to the virtual environment. Silently
  // running a DIFFERENT interpreter than the operator named is how a run comes
  // to disagree with the machine it ran on.
  assert.throws(
    () => resolveWorkerPython({ env, workerDir: "/w", exists: () => false }),
    /does not exist/,
  );
});

test("with no override the worker's own virtual environment is used", () => {
  const venv = workerVenvPython("/w");
  assert.equal(
    resolveWorkerPython({ env: {}, workerDir: "/w", exists: (p) => p === venv }),
    venv,
  );
});

test("with nothing installed it refuses instead of falling back to system python3", () => {
  // THE CASE THIS EXISTS FOR: macOS ships /usr/bin/python3 at 3.9, and
  // google-antigravity needs >= 3.10. A `python3` fallback would turn a missing
  // setup into an ImportError thrown inside a subprocess several paid phases
  // into a run. Refusing at construction — which preflight_dispatch exercises
  // before the run spends anything — costs one sentence instead.
  let message = "";
  try {
    resolveWorkerPython({ env: {}, workerDir: "/w", exists: () => false });
    assert.fail("expected a refusal");
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /npm run setup/, "the refusal must name the command that fixes it");
  assert.match(message, new RegExp(WORKER_PYTHON_ENV), "the refusal must name the override");
  assert.doesNotMatch(message, /python3["'\s]*$/, "no system-python fallback may be implied");
});

// ------------------------------------------------------------ argument vector

test("--region is passed on every invocation, never left to the environment", () => {
  // The drift this prevents: the policy declares one region and the ambient
  // GOOGLE_CLOUD_LOCATION says another, so the manifest and the endpoint
  // disagree with no artifact contradicting either. Passing it explicitly makes
  // them the same value by construction.
  const args = buildWorkerArgs({
    script: "/p/worker/gemini_worker.py",
    taskFile: "/out/delegation/worker-task-tp_codegen_042.md",
    model: "gemini-3.5-flash",
    region: "asia-south1",
    workdir: "/proj/src",
    outDir: "/out/delegation",
    usageFile: "/out/delegation/worker-usage-tp_codegen_042.json",
    thinking: "HIGH",
    timeoutSec: 540,
  });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.ok(args.includes("--region"), "the region flag is missing");
  assert.equal(flag("--region"), "asia-south1");
  assert.equal(flag("--model"), "gemini-3.5-flash", "the model must come from the policy leaf");
  assert.equal(flag("--workdir"), "/proj/src");
  assert.equal(flag("--usage-file"), "/out/delegation/worker-usage-tp_codegen_042.json");
  assert.equal(flag("--timeout"), "540", "the timeout must reach the worker as a string arg");
  assert.equal(args[0], "/p/worker/gemini_worker.py", "the script must be argv[0]");
});

test("every flag the worker declares is one the builder actually passes", () => {
  // Cross-file contract. The worker's argparse block is the source of truth for
  // what it accepts; a flag renamed on one side and not the other fails at run
  // time, inside a subprocess, after the run has already started spending.
  const py = readFileSync(WORKER_PY, "utf8");
  const declared = [...py.matchAll(/add_argument\("(--[a-z-]+)"/g)].map((m) => m[1]);
  const passed = buildWorkerArgs({
    script: "s", taskFile: "t", model: "m", region: "r", workdir: "w",
    outDir: "o", usageFile: "u", thinking: "NONE", timeoutSec: 1,
  });
  assert.ok(declared.length >= 8, "the worker's argparse block was not found");
  for (const flag of declared) {
    assert.ok(passed.includes(flag), `the worker declares ${flag} but the adapter never passes it`);
  }
});

test("the two timeouts are ordered so the worker's own deadline fires first", () => {
  // The worker's timeout raises inside run(), prints a reason and exits non-zero
  // — a diagnosable failure. The adapter's kills a process group and learns
  // nothing. The grace window is what guarantees the diagnosable one happens.
  assert.ok(WORKER_KILL_GRACE_SEC > 0, "the adapter must not race the worker's own deadline");
  const py = readFileSync(WORKER_PY, "utf8");
  const pyDefault = Number(py.match(/add_argument\("--timeout", type=int, default=(\d+)\)/)?.[1]);
  assert.equal(
    DEFAULT_WORKER_TIMEOUT_SEC,
    pyDefault,
    "the TypeScript and Python halves disagree about how long a delegation may run",
  );
});

// -------------------------------------------------------------- child process

test("the child is pinned to one project and region, and cannot use an API key", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/Users/somebody",
    DYLD_LIBRARY_PATH: "/opt/homebrew/opt/expat/lib",
    GOOGLE_APPLICATION_CREDENTIALS: "/creds/adc.json",
    GEMINI_API_KEY: "an-api-key-value",
    GOOGLE_API_KEY: "another-api-key-value",
    GOOGLE_CLOUD_PROJECT: "some-other-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    UNSET: undefined,
  };
  const child = buildWorkerEnv(parent, { project: "billed-project", location: "asia-south1" });

  // The claim this adapter exists to make is "the Antigravity SDK reached this
  // model through Vertex on project P in region R". An API key is a second,
  // unrecorded door — and the sidecar would still name P, because the worker
  // writes what it was TOLD, not what the transport chose.
  for (const key of WORKER_STRIPPED_ENV) {
    assert.equal(child[key], undefined, `${key} reached the worker`);
  }
  assert.equal(child.GOOGLE_CLOUD_PROJECT, "billed-project", "the parent's project outranked the pin");
  assert.equal(child.GOOGLE_CLOUD_LOCATION, "asia-south1", "the parent's region outranked the pin");

  // Things the child genuinely needs: credentials, a home for ADC to be found
  // under, and on macOS the loader path some Homebrew Pythons need for pyexpat.
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, "/creds/adc.json");
  assert.equal(child.HOME, "/Users/somebody");
  assert.equal(child.DYLD_LIBRARY_PATH, "/opt/homebrew/opt/expat/lib");
  assert.equal(child.PYTHONUNBUFFERED, "1", "a killed worker must still have flushed its stderr");
  assert.ok(!("UNSET" in child), "undefined values must not become the string 'undefined'");
});

// ----------------------------------------------------------------- accounting

test("sidecar token counts are read under Python's field names", () => {
  // The sidecar is usage_metadata.model_dump() from the PYTHON SDK, so the keys
  // are snake_case. Reading the JavaScript SDK's camelCase names here yields
  // undefined, which floors to zero, which reports a delegation that cost real
  // money as having cost nothing.
  const tokens = mapSidecarTokens({
    usage: {
      prompt_token_count: 11554,
      cached_content_token_count: 9000,
      candidates_token_count: 300,
      thoughts_token_count: 97,
    },
  });
  // prompt_token_count INCLUDES cached, and computeCostUsd requires the two to
  // be disjoint. Without the subtraction every cached token is billed twice —
  // once at the full rate and once at the cached rate — which makes an
  // effective cache look more expensive than no cache at all.
  assert.equal(tokens.input, 2554);
  assert.equal(tokens.input_cached, 9000);
  assert.equal(tokens.input + tokens.input_cached, 11554, "the input split must be lossless");
  // Thinking is billed at the output rate and reported in its own field, so the
  // billed output is the sum — and the thinking half is surfaced separately for
  // reading, not for a second charge.
  assert.equal(tokens.output, 397);
  assert.equal(tokens.output_reasoning, 97);
});

test("an absent, empty or impossible sidecar degrades to zeros rather than NaN", () => {
  for (const input of [null, undefined, {}, { usage: null }]) {
    const t = mapSidecarTokens(input);
    assert.deepEqual(t, { input: 0, input_cached: 0, output: 0, output_reasoning: 0 });
  }
  // Vendor edge case: a cached count larger than the prompt count. Unclamped it
  // yields a negative fresh count, which flows into the run's totals and can
  // make a phase appear to have cost less than nothing.
  const weird = mapSidecarTokens({
    usage: { prompt_token_count: 100, cached_content_token_count: 400 },
  });
  assert.equal(weird.input, 0);
  assert.equal(weird.input_cached, 400);
});

test("the tool-call count comes from the count, not from the capped list", () => {
  // The worker records tool calls in full only up to its own cap and sets
  // tool_calls_truncated when it stops. Counting the list would report the cap
  // as a total — a ceiling presented as a measurement.
  assert.equal(
    sidecarToolCallCount({ tool_call_count: 1400, tool_calls_truncated: true, tool_calls: [1, 2, 3] }),
    1400,
  );
  assert.equal(sidecarToolCallCount({}), 0);
  assert.equal(sidecarToolCallCount(null), 0);
});

// ------------------------------------------------------------------ the brief

test("the brief tells the worker where it is and that excerpts are excerpts", () => {
  const md = workerTaskMarkdown(packet(), { workdir: "/proj/src" });
  assert.match(md, /\/proj\/src/, "the worker is never told where it is allowed to act");
  assert.match(md, /src\/leave\.ts/, "the excerpt's real path must be named so it can be opened");
  assert.match(md, /extracts, not whole files/i, "excerpts must not read as the whole input");
  assert.match(md, /returns 200/, "the acceptance criteria dropped out of the brief");
});

test("a schema packet demands bare JSON; a free-text packet demands the deliverable", () => {
  // An agent that has just run six tools is far likelier to narrate what it did
  // than a model that only ever produced one message, and stdout is parsed as
  // JSON. The instruction has to be explicit about the fence and the preamble.
  const json = workerTaskMarkdown(packet(), { workdir: "/w" });
  assert.match(json, /single JSON object and nothing else/i);
  assert.match(json, /no ``` fence around it/i);
  assert.match(json, /"properties"/, "the schema itself must be in the brief");

  const free = workerTaskMarkdown(packet({ outputSchema: { __free_text__: true } }), {
    workdir: "/w",
  });
  assert.doesNotMatch(free, /single JSON object/i, "a free-text packet must not demand JSON");
  assert.match(free, /not a report about producing it/i);
});

test("evidence filenames cannot escape the directory they were meant for", () => {
  // Packet ids are authored by a model-written plan. A `/` in one would write
  // the sidecar somewhere else entirely — and the adapter would then read back
  // a file that is not there and report a paid delegation as having cost zero.
  assert.equal(evidenceStem(packet()), "tp_codegen_042");
  assert.equal(evidenceStem(packet({ id: "../../etc/passwd" })), "etc-passwd");
  assert.equal(evidenceStem(packet({ id: "" })), "codegen-untitled");
});

test("thinking level comes from the policy's reasoning tier, defaulting to none", () => {
  assert.equal(workerThinkingLevel(undefined), "NONE");
  assert.equal(workerThinkingLevel({}), "NONE");
  assert.equal(workerThinkingLevel({ tier: "high" }), "HIGH");
  assert.equal(workerThinkingLevel({ tier: "minimal" }), "MINIMAL");
});

// -------------------------------------------------------------- registration

test("the registry builds the worker adapter and prices it where it will run", () => {
  // Registration is one line in adapters/index.ts and is easy to forget when a
  // policy gains a leaf. This also pins the pricing resolution, which is the
  // reason `region:` is declared on the leaf at all: Vertex adds 10% on a
  // regional endpoint for Gemini 3+, so a run's cost is only reproducible if
  // the region is written down beside the rates.
  const saved = {
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION,
    python: process.env[WORKER_PYTHON_ENV],
  };
  process.env.GOOGLE_CLOUD_PROJECT = "unit-test-project";
  delete process.env.GOOGLE_CLOUD_LOCATION;
  // Any file that exists satisfies the interpreter check; this test never runs it.
  process.env[WORKER_PYTHON_ENV] = process.execPath;
  try {
    const base = {
      id: "flash-agsdk-worker",
      adapter: "antigravity-worker",
      model_name: "gemini-3.5-flash",
      pricing: { input: 0.3, input_cached: 0.075, output: 2.5 },
    };

    const global = createAdapter(base);
    assert.equal(global.project, "unit-test-project");
    assert.equal(global.location, "global", "an undeclared region must fall back, not fail");
    assert.deepEqual(global.billedPricing, base.pricing, "the global endpoint carries no surcharge");

    const regional = createAdapter({ ...base, region: "asia-south1" });
    assert.equal(regional.location, "asia-south1", "the leaf's region must outrank the fallback");
    assert.equal(regional.billedPricing.output, 2.5 * 1.1, "the regional surcharge was not applied");
  } finally {
    if (saved.project === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = saved.project;
    if (saved.location === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
    else process.env.GOOGLE_CLOUD_LOCATION = saved.location;
    if (saved.python === undefined) delete process.env[WORKER_PYTHON_ENV];
    else process.env[WORKER_PYTHON_ENV] = saved.python;
  }
});
