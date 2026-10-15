/**
 * The stand-ins that keep the root suite offline (tools/test/lib/stand-ins.mjs, tools/test/lib/sandbox.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_MARKER, STAND_IN_BIN, STAND_IN_NPM, isSandboxCodexHome, withStandIns } from "./lib/stand-ins.mjs";
import { codexSandbox } from "./lib/sandbox.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function withUnmarkedCodexHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-unmarked-codex-home-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withSandbox(fn, extraEnv) {
  const sb = codexSandbox(extraEnv);
  try {
    return fn(sb);
  } finally {
    sb.cleanup();
  }
}

test("npm test loads the stand-ins before every root test file", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /^node --test --import \.\/tools\/test\/lib\/stand-ins\.mjs tools\/test\/\*\.test\.mjs && /);
});

test("npm test's preload reaches a root test file that never imports the stand-ins", () => {
  const script = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts.test;
  const preload = script.match(/--import (\S+)/)?.[1];
  assert.ok(preload, `npm test preloads nothing: ${script}`);
  const dir = mkdtempSync(join(tmpdir(), "mmo-preload-fixture-"));
  try {
    const fixture = join(dir, "plain.test.mjs");
    const report = join(dir, "report.json");
    writeFileSync(
      fixture,
      [
        'import { test } from "node:test";',
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { delimiter, join } from "node:path";',
        'test("sees what npm test gives it", () => {',
        "  const home = process.env.CODEX_HOME;",
        "  const seen = { path: process.env.PATH.split(delimiter), home, marked: existsSync(join(home, process.env.MARKER)) };",
        "  writeFileSync(process.env.REPORT, JSON.stringify(seen));",
        "});",
      ].join("\n"),
    );
    const env = { ...process.env, REPORT: report, MARKER: SANDBOX_MARKER };
    env.PATH = env.PATH.split(delimiter).filter((entry) => entry !== STAND_IN_BIN && entry !== STAND_IN_NPM).join(delimiter);
    delete env.CODEX_HOME;
    delete env.MMO_TEST_CODEX_HOME;
    // Set inside a test process; a nested `node --test` that sees it reports to this run instead of running the file.
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", "--import", preload, fixture], { cwd: REPO_ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const seen = JSON.parse(readFileSync(report, "utf8"));
    assert.deepEqual(seen.path.slice(0, 2), [STAND_IN_BIN, STAND_IN_NPM]);
    assert.ok(seen.home.startsWith(join(tmpdir(), "mmo-test-codex-home-")), seen.home);
    assert.notEqual(seen.home, process.env.CODEX_HOME, "the child made its own, since none was handed down");
    assert.equal(seen.marked, true);
    assert.equal(existsSync(seen.home), false, "the preload removes its CODEX_HOME when the run ends");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stand-ins come first on PATH and CODEX_HOME is a marked temporary directory", () => {
  assert.deepEqual(process.env.PATH.split(delimiter).slice(0, 2), [STAND_IN_BIN, STAND_IN_NPM]);
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome.startsWith(join(tmpdir(), "mmo-test-codex-home-")), codexHome);
  assert.ok(existsSync(join(codexHome, SANDBOX_MARKER)));
  assert.notEqual(realpathSync(codexHome), resolve(homedir(), ".codex"));
  assert.equal(process.env.MMO_TEST_CODEX_HOME, codexHome, "a child process must reuse this one, not make its own");
});

test("withStandIns puts the stand-ins first once each and keeps every other entry in order", () => {
  const path = withStandIns(["/usr/bin", STAND_IN_BIN, "/bin", STAND_IN_NPM, "/usr/bin"].join(delimiter));
  assert.equal(path, [STAND_IN_BIN, STAND_IN_NPM, "/usr/bin", "/bin", "/usr/bin"].join(delimiter));
  assert.equal(withStandIns(""), [STAND_IN_BIN, STAND_IN_NPM].join(delimiter));
});

test("codex on PATH is the stand-in", () => {
  const r = spawnSync("codex", ["--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^codex-cli 0\.160\.1 \(stand-in for tests\)$/m);
});

test("the codex stand-in refuses a CODEX_HOME no test made, and writes nothing there", () => {
  withUnmarkedCodexHome((dir) => {
    for (const args of [["--version"], ["mcp", "add", "model-dispatch", "--", "node", "x.js"]]) {
      const r = spawnSync("codex", args, { encoding: "utf8", env: { ...process.env, CODEX_HOME: dir } });
      assert.equal(r.status, 97, `codex ${args.join(" ")}`);
      assert.match(r.stderr, /not a test sandbox/);
    }
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("the codex stand-in refuses when CODEX_HOME is unset, the case a real codex resolves to ~/.codex", () => {
  const env = { ...process.env };
  delete env.CODEX_HOME;
  const r = spawnSync("codex", ["mcp", "add", "model-dispatch", "--", "node", "x.js"], { encoding: "utf8", env });
  assert.equal(r.status, 97);
});

test("the codex stand-in answers login, mcp get, mcp add and mcp list the way codex 0.160.1 does", () => {
  withSandbox((sb) => {
    const run = (args, env = {}) => spawnSync("codex", args, { encoding: "utf8", env: { ...sb.env, ...env } });
    const login = run(["login", "status"]);
    assert.equal(login.status, 0);
    assert.match(login.stderr, /^Logged in using ChatGPT$/m);
    const out = run(["login", "status"], { MMO_STAND_IN_LOGIN: "out" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /^Not logged in$/m);

    const missing = run(["mcp", "get", "model-dispatch"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^Error: No MCP server named 'model-dispatch' found\.$/m);
    assert.deepEqual(JSON.parse(run(["mcp", "list", "--json"]).stdout), []);

    const add = run(["mcp", "add", "model-dispatch", "--", "node", "/x/server.js"]);
    assert.equal(add.status, 0);
    assert.match(add.stdout, /Added global MCP server 'model-dispatch'\./);
    assert.match(sb.config(), /^\[mcp_servers\.model-dispatch\]\ncommand = "node"$/m);
    assert.equal(run(["mcp", "get", "model-dispatch"]).status, 0);
    assert.deepEqual(JSON.parse(run(["mcp", "list", "--json"]).stdout), [{ name: "model-dispatch" }]);
  });
});

test("the codex stand-in never runs a model and refuses what it does not answer", () => {
  withSandbox((sb) => {
    for (const args of [["exec", "say hi"], ["exec", "resume", "--last", "go on"], ["login"], ["mcp", "remove", "x"]]) {
      const r = spawnSync("codex", args, { encoding: "utf8", env: sb.env });
      assert.equal(r.status, 1, `codex ${args.join(" ")} must be refused`);
      assert.equal(r.stdout, "");
    }
    assert.equal(sb.config(), "");
  });
});

test("gcloud on PATH answers like a computer that cannot reach Google", () => {
  const r = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stand-in for tests: no network/);
  assert.equal(r.stdout, "");
});

test("npm on PATH is the stand-in: it records the call and touches nothing", () => {
  withSandbox((sb) => {
    const cwd = mkdtempSync(join(tmpdir(), "mmo-npm-cwd-"));
    try {
      const r = spawnSync("npm", ["ci"], { cwd, encoding: "utf8", env: sb.env });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(sb.calls(), ["npm ci"]);
      assert.deepEqual(readdirSync(cwd), [], "the stand-in must not create node_modules");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("the npm stand-in refuses a CODEX_HOME no test made", () => {
  withUnmarkedCodexHome((dir) => {
    const r = spawnSync("npm", ["ci"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: dir } });
    assert.equal(r.status, 97);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("codexSandbox gives each test its own HOME and CODEX_HOME and drops the shell's credentials", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  let a;
  let b;
  try {
    a = codexSandbox();
    b = codexSandbox({ GEMINI_API_KEY: "test-only" });
    assert.notEqual(a.home, b.home);
    assert.notEqual(a.home, homedir());
    assert.equal(a.env.HOME, a.home);
    assert.equal(a.env.CODEX_HOME, join(a.home, ".codex"));
    assert.ok(isSandboxCodexHome(a.codexHome));
    assert.equal("OPENAI_API_KEY" in a.env, false, "a test states its own credentials");
    assert.equal(b.env.GEMINI_API_KEY, "test-only");
    assert.deepEqual(a.env.PATH.split(delimiter).slice(0, 2), [STAND_IN_BIN, STAND_IN_NPM]);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
    a?.cleanup();
    b?.cleanup();
  }
  assert.ok(!existsSync(a.home) && !existsSync(b.home), "cleanup must remove the temporary HOME");
});
