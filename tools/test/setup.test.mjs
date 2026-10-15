/**
 * Guards the clone-route setup wizard (tools/setup.mjs).
 *
 * The wizard is an interactive script, so what is testable without driving a
 * TTY is: that it runs to completion non-interactively without hanging, that
 * its verdict reaches the exit code, and that it never writes state into the
 * repo as a side effect of merely *checking*. Those are exactly the three
 * ways a setup wizard fails badly — hanging a CI job, reporting success while
 * blocked, or silently changing a checkout it was only asked to inspect.
 *
 * Every run gets its own codexSandbox(): a temporary HOME and CODEX_HOME with
 * the codex and npm stand-ins first on PATH. The wizard's last step runs
 * `codex mcp add`, which a real codex writes into ~/.codex/config.toml, and
 * its build step runs `npm ci`; neither may reach this computer's own.
 *
 * The decision logic it shares with verify-setup.mjs (credential state,
 * version pins) is covered in verify-setup.test.mjs against the imported
 * functions directly, not re-derived here through the wizard's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexSandbox } from "./lib/sandbox.mjs";
import { STAND_IN_BIN, isSandboxCodexHome } from "./lib/stand-ins.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = join(REPO_ROOT, "plugin", "mcp", "model-dispatch");
const DIST_ENTRY = join(SERVER_DIR, "dist", "server.js");

/**
 * Runs the wizard with stdin closed — the shape a CI job or a piped shell
 * gives it. A wizard that waits for input here would hang the job forever,
 * so the timeout is the assertion as much as the exit code is.
 */
function runWizard(sb, env = {}, root = REPO_ROOT) {
  assertSandboxed({ ...sb.env, ...env });
  return spawnSync(process.execPath, [join(root, "tools", "setup.mjs")], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...sb.env, ...env },
  });
}

function assertSandboxed(env) {
  assert.ok(isSandboxCodexHome(env.CODEX_HOME), `CODEX_HOME ${env.CODEX_HOME} is not a test sandbox`);
  assert.equal(env.PATH.split(delimiter)[0], STAND_IN_BIN, "the codex stand-in must come first on PATH");
}

function inSandbox(fn, extraEnv = {}) {
  const sb = codexSandbox(extraEnv);
  try {
    return fn(sb);
  } finally {
    sb.cleanup();
  }
}

/**
 * A copy of the wizard and the plugin it reads, for a test that needs its own
 * project state. `built` keeps the bridge's dist/, with an empty node_modules/
 * when this checkout has one, so the copy's build step sees what this
 * checkout's does.
 */
function wizardClone({ built = true } = {}) {
  const clone = mkdtempSync(join(tmpdir(), "mmo-wizard-clone-"));
  mkdirSync(join(clone, "tools"));
  cpSync(join(REPO_ROOT, "tools", "setup.mjs"), join(clone, "tools", "setup.mjs"));
  const skipped = built ? /[\\/](node_modules|\.venv)$/ : /[\\/](node_modules|dist|\.venv)$/;
  cpSync(join(REPO_ROOT, "plugin"), join(clone, "plugin"), {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => !skipped.test(src),
  });
  if (built && existsSync(join(SERVER_DIR, "node_modules"))) {
    mkdirSync(join(clone, "plugin", "mcp", "model-dispatch", "node_modules"));
  }
  return clone;
}

/**
 * Runs `fn(clone)` with a wizard clone whose `.sdlc/project.json` names the
 * policy. The wizard reads that file to decide whether a missing
 * OPENAI_API_KEY blocks setup. In this checkout it is the developer's own
 * choice, and two test runs at once would read each other's pin.
 */
function withPolicy(name, fn) {
  const clone = wizardClone();
  try {
    mkdirSync(join(clone, ".sdlc"));
    writeFileSync(join(clone, ".sdlc", "project.json"), JSON.stringify({ default_policy: name }, null, 2));
    return fn(clone);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

test("the wizard runs to completion with stdin closed instead of hanging", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.notEqual(r.signal, "SIGTERM", "wizard hung waiting for input that will never come");
  assert.ok(typeof r.status === "number", "wizard must exit with a status");
});

test("every question falls through to a documented default when non-interactive", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.match(
    r.stdout,
    /non-interactive/,
    "a skipped question must say so, not silently pick an answer",
  );
});

test("a blocked setup reports its verdict through the exit code, not just on screen", () => {
  // Pinned to the metered policy so the block is real and not machine-dependent:
  // no key + a policy that bills one is a genuine blocker.
  const r = withPolicy("gpt-plus-flash", (clone) => inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "" }, clone)));
  assert.match(r.stdout, /Setup incomplete/);
  assert.equal(r.status, 1, "a caller checking only the exit code must see the block");
});

test("the same install is NOT blocked once the policy is one that needs no key", () => {
  // The other half of the same rule — a wizard that blocks here is telling a
  // ChatGPT-seat user to buy a key they will never use.
  const r = withPolicy("gpt-seat-plus-flash", (clone) => inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "" }, clone)));
  assert.match(r.stdout, /does not need one/);
  assert.ok(!/Setup incomplete/.test(r.stdout), `must not block: ${r.stdout}`);
  assert.equal(r.status, 0);
});

test("the wizard blames the policy for the key requirement, and names the keyless alternative", () => {
  // Pinned to the metered policy, which really does bill the key, so the block
  // is correct. What it must not do is present the key as unconditional: a
  // ChatGPT seat plus gpt-seat-plus-flash runs the same models without one.
  const r = withPolicy("gpt-plus-flash", (clone) => inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "" }, clone)));
  assert.match(r.stdout, /OPENAI_API_KEY is not set/);
  assert.match(r.stdout, /policy 'gpt-plus-flash' bills it/, "the reason must name the policy");
  assert.match(r.stdout, /gpt-seat-plus-flash/, "the way out must be on screen, not only in the docs");
  assert.ok(
    !/no in-session fallback/i.test(r.stdout),
    "the old claim that nothing covers the judgment tier is false since the seat policy landed",
  );
});

test("pinning a policy for the wizard leaves this checkout's .sdlc/project.json as it was", () => {
  const dir = join(REPO_ROOT, ".sdlc");
  const path = join(dir, "project.json");
  const state = () => ({ dir: existsSync(dir), file: existsSync(path) ? readFileSync(path, "utf8") : null });
  const before = state();
  withPolicy("gpt-seat-plus-flash", (clone) => {
    assert.deepEqual(state(), before, "the pin was written into the developer's own clone");
    assert.equal(JSON.parse(readFileSync(join(clone, ".sdlc", "project.json"), "utf8")).default_policy, "gpt-seat-plus-flash");
  });
  assert.deepEqual(state(), before);
});

test("a codex that is not logged in blocks setup, through the exit code", () => {
  const r = inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" }), { MMO_STAND_IN_LOGIN: "out" });
  assert.match(r.stdout, /not logged in/);
  assert.match(r.stdout, /Setup incomplete/);
  assert.equal(r.status, 1);
});

test("the wizard never mentions Anthropic (D9)", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.ok(!/ANTHROPIC/i.test(r.stdout), "no Anthropic credential belongs in codex setup");
});

test("checking setup does not write state into the repo", () => {
  // A wizard that writes a selection file just for looking would leave a
  // dirty checkout behind every CI run.
  const selectFile = join(REPO_ROOT, ".sdlc", "local", "mmo-select.json");
  const before = existsSync(selectFile) ? readFileSync(selectFile, "utf8") : null;
  inSandbox((sb) => runWizard(sb));
  const after = existsSync(selectFile) ? readFileSync(selectFile, "utf8") : null;
  assert.equal(after, before, "the wizard changed project state while only checking");
});

test("the wizard points at verify-setup for a re-check without questions", () => {
  const r = inSandbox((sb) => runWizard(sb));
  assert.match(r.stdout, /verify-setup\.mjs/, "the non-interactive re-check path must be discoverable");
});

test("the closing banner shows a runnable driver invocation, not a Claude one", () => {
  const r = inSandbox((sb) => runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" }));
  assert.ok(!/\bclaude\b/i.test(r.stdout), "no Claude Code invocation may survive into codex setup");
  assert.match(r.stdout, /Setup complete/, r.stdout);
  assert.match(r.stdout, /\$mmo-codex:greenfield/, "the session route comes first");
  assert.match(r.stdout, /--mode=greenfield/);
  assert.doesNotMatch(r.stdout, /--output-dir/, "run.mjs refuses an --output-dir of the shared .sdlc folder");
});

/** The banner's lines from `mkdir` to the run.mjs command, continuations joined, as argv with `~` and $HOME expanded. */
function bannerCommands(stdout, home) {
  const words = (line) => line.trim().split(/\s+/).map((w) => w.replace(/"/g, "").replace(/^~(?=\/)|\$HOME/g, home));
  const text = stdout.replace(/\\\n\s*/g, " ");
  const mkdir = text.split("\n").find((l) => /^\s*mkdir -p /.test(l));
  const run = text.split("\n").find((l) => /^\s*node plugin\/codex\/run\.mjs /.test(l));
  return { mkdir: mkdir && words(mkdir), run: run && words(run) };
}

test("the closing banner's headless command runs as printed from the clone root", () => {
  inSandbox((sb) => {
    const r = runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    const { mkdir, run } = bannerCommands(r.stdout, sb.home);
    assert.ok(run, `no run.mjs command in the banner:\n${r.stdout}`);
    const projectRoot = run.find((w) => w.startsWith("--project-root="))?.slice("--project-root=".length);
    assert.ok(projectRoot && resolve(REPO_ROOT, projectRoot) !== REPO_ROOT, "the clone is not the project a run writes into");
    assert.deepEqual(mkdir, ["mkdir", "-p", projectRoot], "the banner creates the project folder it names");
    mkdirSync(projectRoot, { recursive: true });
    assert.match(r.stdout, /add --gates=auto-approve for an unattended run/);
    const unattended = [...run.slice(1), "--gates=auto-approve", "--dry-run"];
    const dry = spawnSync(process.execPath, unattended, { cwd: REPO_ROOT, encoding: "utf8", env: sb.env });
    assert.equal(dry.status, 0, dry.stderr);
  });
});

test("the setup tests never reach a real codex", () => {
  inSandbox((sb) => {
    const r = spawnSync("codex", ["--version"], { encoding: "utf8", env: sb.env });
    assert.match(r.stdout, /stand-in for tests/);
    assert.deepEqual(sb.calls(), ["--version"]);
  });
});

test("the wizard registers the bridge in the test's CODEX_HOME, with this clone's server path", () => {
  inSandbox((sb) => {
    const r = runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    assert.match(r.stdout, /Registered\./, r.stdout);
    assert.ok(sb.calls().includes("login status"), sb.calls().join("\n"));
    assert.ok(
      sb.calls().includes(`mcp add model-dispatch -- node ${DIST_ENTRY}`),
      `expected the registration to name ${DIST_ENTRY}:\n${sb.calls().join("\n")}`,
    );
    assert.match(sb.config(), /^\[mcp_servers\.model-dispatch\]$/m);
  });
});

test("a second run finds the registration and does not add it again", () => {
  inSandbox((sb) => {
    runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    const adds = () => sb.calls().filter((call) => call.startsWith("mcp add")).length;
    const before = adds();
    const r = runWizard(sb, { OPENAI_API_KEY: "sk-test-not-real" });
    assert.match(r.stdout, /Already registered\./);
    assert.equal(adds(), before, "a registered bridge must not be added twice");
  });
});

test("the wizard does not run npm when the bridge is already built", {
  skip: !(existsSync(DIST_ENTRY) && existsSync(join(SERVER_DIR, "node_modules"))) && "the bridge is not built in this checkout",
}, () => {
  inSandbox((sb) => {
    const r = runWizard(sb);
    assert.match(r.stdout, /Already installed and built\./);
    assert.deepEqual(sb.calls().filter((call) => call.startsWith("npm ")), []);
  });
});

test("on a clone whose bridge is not built, the wizard's npm ci and build reach only the stand-in", () => {
  const clone = wizardClone({ built: false });
  try {
    inSandbox((sb) => {
      const r = runWizard(sb, {}, clone);
      assert.match(r.stdout, /installing dependencies/, r.stdout + r.stderr);
      assert.deepEqual(sb.calls().filter((call) => call.startsWith("npm ")), ["npm ci", "npm run build"]);
      assert.equal(existsSync(join(clone, "plugin", "mcp", "model-dispatch", "node_modules")), false);
    });
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});
