/**
 * Fails when a root test runs codex or gcloud, directly or through a script that does, outside the stand-ins
 * (tools/test/lib/stand-ins.mjs). This file is left out of its own scan: the scan's tests hold example sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outsideToolUsers, unsandboxedCalls } from "./lib/spawn-scan.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const HERE = dirname(THIS_FILE);
const REPO_ROOT = resolve(HERE, "..", "..");
const STAND_INS = [join(HERE, "lib", "stand-ins.mjs"), join(HERE, "lib", "sandbox.mjs")];
const USERS = outsideToolUsers(REPO_ROOT);

const scan = (source) =>
  unsandboxedCalls(source, { file: join(HERE, "example.test.mjs"), standIns: STAND_INS, users: USERS });

/** A throwaway repo holding `files` (repo-relative path → source), scanned the way the real one is. */
function withFixtureRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "mmo-scan-repo-"));
  try {
    for (const dir of ["plugin", "tools"]) mkdirSync(join(root, dir), { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const users = outsideToolUsers(root);
    const here = join(root, "tools", "test");
    const standIns = [join(here, "lib", "stand-ins.mjs"), join(here, "lib", "sandbox.mjs")];
    return fn({ users, scan: (source) => unsandboxedCalls(source, { file: join(here, "x.test.mjs"), standIns, users }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the scan finds the scripts and functions that run codex or gcloud", () => {
  for (const script of [
    "tools/setup.mjs",
    "plugin/codex/verify-setup.mjs",
    "plugin/scripts/setup-policy.mjs",
    "plugin/scripts/uninstall-cleanup.mjs",
    "plugin/codex/run.mjs",
  ]) {
    assert.ok(USERS.scripts.includes(script), `${script} missing from ${USERS.scripts.join(", ")}`);
  }
  for (const name of [
    "probeCodexCli",
    "probeCodexLogin",
    "mcpRegistered",
    "checkPluginConflicts",
    "spawnCodex",
    "runChecks",
    "survey",
  ]) {
    assert.ok(USERS.functions.includes(name), `${name} missing from ${USERS.functions.join(", ")}`);
  }
  assert.deepEqual(USERS.params.spawnCodex.sort(), ["codexBin", "spawnFn"]);
});

test("a run.mjs that names --codex-bin is redirected by it, however it falls back to codex", () => {
  const usage = " * Usage: node run.mjs [--brief=<path>] [--codex-bin=<path>]\n";
  const fallbacks = {
    "a ?? fallback": 'const codexBin = args["codex-bin"] ?? "codex";\n',
    "a helper that returns the bare name":
      'const RUN_FLAGS = ["brief", "codex-bin"];\nfunction codexBinFrom(cwd, value) {\n  if (!value) return "codex";\n  return value;\n}\n' +
      'const codexBin = codexBinFrom(process.cwd(), args["codex-bin"]);\n',
    "only the usage text": "",
  };
  for (const [shape, body] of Object.entries(fallbacks)) {
    const run = `/**\n${usage} */\nimport { spawn } from "node:child_process";\n${body}` +
      'export function spawnCodex(args, { spawnFn = spawn, codexBin = "codex" } = {}) {\n  return spawnFn(codexBin, args);\n}\n';
    withFixtureRepo({ "plugin/codex/run.mjs": run }, ({ users, scan: fixtureScan }) => {
      assert.ok(users.scripts.includes("plugin/codex/run.mjs"), shape);
      const call = (extra) => `const RUN = join(ROOT, "plugin", "codex", "run.mjs");\nspawnSync(process.execPath, [RUN${extra}]);`;
      assert.deepEqual(fixtureScan(call(", `--codex-bin=${STUB}`")), [], shape);
      assert.deepEqual(fixtureScan(call(', "--codex-bin", STUB')), [], shape);
      assert.equal(fixtureScan(call("")).length, 1, `${shape}: no flag`);
      assert.equal(fixtureScan(call(', "--codex-bin=codex"')).length, 1, `${shape}: the real codex`);
    });
  }
});

test("a --codex-bin redirects only a script that has the option", () => {
  const other = 'import { spawnSync } from "node:child_process";\nspawnSync("codex", ["login", "status"]);\n';
  withFixtureRepo({ "plugin/scripts/other.mjs": other }, ({ scan: fixtureScan }) => {
    const source = 'const OTHER = join(ROOT, "plugin", "scripts", "other.mjs");\nspawnSync(process.execPath, [OTHER, "--codex-bin=/x"]);';
    assert.equal(fixtureScan(source).length, 1);
  });
});

test("the scan flags the driver run without the stand-ins or a --codex-bin of its own", () => {
  const run = 'const RUN = join(ROOT, "plugin", "codex", "run.mjs");\n';
  assert.match(scan(run + 'spawnSync(process.execPath, [RUN, "--brief=b.md"]);').join("\n"), /plugin\/codex\/run\.mjs/);
  assert.deepEqual(scan(run + 'spawnSync(process.execPath, [RUN, "--brief=b.md", `--codex-bin=${STUB}`]);'), []);
  assert.deepEqual(scan('import "./lib/stand-ins.mjs";\n' + run + 'spawnSync(process.execPath, [RUN]);'), []);
  assert.equal(scan(run + 'spawnSync(process.execPath, [RUN, "--codex-bin=codex"]);').length, 1);
  assert.equal(scan(run + 'spawnSync(process.execPath, [RUN, "--codex-bin", "codex"]);').length, 1);
  const named = 'const CODEX = "codex";\n' + run;
  assert.equal(scan(named + "spawnSync(process.execPath, [RUN, `--codex-bin=${CODEX}`]);").length, 1);
  assert.equal(scan(named + 'spawnSync(process.execPath, [RUN, "--codex-bin", CODEX]);').length, 1);

  const imported = 'import { spawnCodex } from "../../plugin/codex/run.mjs";\n';
  assert.match(scan(imported + 'await spawnCodex(["exec", "hi"]);').join("\n"), /spawnCodex\(\) without/);
  assert.deepEqual(scan(imported + 'await spawnCodex(["exec", "hi"], { spawnFn: fakeSpawn });'), []);
  assert.deepEqual(scan(imported + 'await spawnCodex(["exec", "hi"], { codexBin: STUB });'), []);
});

test("the scan flags member calls and script paths built in two steps", () => {
  assert.equal(scan('cp.spawnSync("codex", ["mcp", "add", "x"]);').length, 1);
  assert.equal(scan('childProcess.execFileSync("gcloud", ["auth", "list"]);').length, 1);
  assert.equal(scan('cp.execSync("codex login status");').length, 1);
  const twoStep = 'const PLUGIN = join(ROOT, "plugin");\nconst VERIFY = join(PLUGIN, "codex", "verify-setup.mjs");\n';
  assert.match(scan(twoStep + "spawnSync(process.execPath, [VERIFY]);").join("\n"), /plugin\/codex\/verify-setup\.mjs/);
  assert.match(
    scan('spawnSync(process.execPath, [join(SOMEWHERE, "codex", "verify-setup.mjs")]);').join("\n"),
    /plugin\/codex\/verify-setup\.mjs/,
  );
});

test("the scan flags codex run from a module that does not load the stand-ins", () => {
  assert.equal(scan('spawnSync("codex", ["login", "status"]);').length, 1);
  assert.equal(scan('execSync("codex mcp add model-dispatch -- node x");').length, 1);
  assert.equal(scan("probeCodexCli();").length, 1);
  assert.deepEqual(scan("probeCodexCli(fakeRun);"), []);
  assert.deepEqual(scan('import "./lib/stand-ins.mjs";\nspawnSync("codex", ["login", "status"]);'), []);
});

test("the scan flags codex named by a const", () => {
  assert.equal(scan('const CODEX = "codex";\nspawnSync(CODEX, ["--version"]);').length, 1);
  assert.equal(scan('const BIN = process.env.CODEX_BIN ?? "codex";\ncp.execFileSync(BIN, ["login", "status"]);').length, 1);
  assert.equal(scan('const CODEX = "codex";\nexecSync(`${CODEX} login status`);').length, 1);
  assert.deepEqual(scan('const CODEX = "codex";\nif (CODEX) assert.equal(CODEX, "codex");'), []);
  assert.deepEqual(scan('import "./lib/stand-ins.mjs";\nconst CODEX = "codex";\nspawnSync(CODEX, ["--version"]);'), []);
});

test("the scan flags a function whose default reaches codex through another function or a const", () => {
  assert.match(scan("runChecks();").join("\n"), /runChecks\(\) with its default checks/);
  assert.deepEqual(scan("runChecks([fakeCheck]);"), []);
  assert.match(scan("survey(dir);").join("\n"), /survey\(\) without mcp/);
  assert.deepEqual(scan("survey(dir, { mcp: () => false });"), []);

  const checks = [
    'import { spawnSync } from "node:child_process";',
    'export function probe(name, run = spawnSync) {\n  return run("codex", [name]);\n}',
    "export const CHECKS = [probe];",
    "export function runAll(checks = CHECKS) {\n  return checks.map((fn) => fn());\n}",
  ].join("\n");
  const wrapper = 'import { runAll as runEverything } from "./checks.mjs";\n' +
    "export function wrapper({ go = runEverything } = {}) {\n  return go();\n}\n";
  withFixtureRepo({ "plugin/checks.mjs": checks, "plugin/wrapper.mjs": wrapper }, ({ users, scan: fixtureScan }) => {
    assert.deepEqual(users.positional.probe, { index: 1, param: "run" });
    assert.deepEqual(users.positional.runAll, { index: 0, param: "checks" });
    assert.deepEqual(users.params.wrapper, ["go"]);
    assert.equal(fixtureScan('probe("x");').length, 1, "the runner is the second parameter");
    assert.deepEqual(fixtureScan('probe("x", fakeRun);'), []);
    assert.equal(fixtureScan("runAll();").length, 1);
    assert.deepEqual(fixtureScan("runAll([]);"), []);
    assert.equal(fixtureScan("wrapper();").length, 1);
    assert.deepEqual(fixtureScan("wrapper({ go: fake });"), []);
  });
});

test("a script named only in a spawn's options is not a run of it", () => {
  const run = 'const RUN_MJS = join(ROOT, "plugin", "codex", "run.mjs");\n';
  const envOnly = "spawn(process.execPath, [script], { env: { RUN_MJS_URL: pathToFileURL(RUN_MJS).href } });";
  assert.deepEqual(scan(run + envOnly), []);
  assert.deepEqual(scan(run + "spawnSync(process.execPath, [script], { cwd: dirname(RUN_MJS) });"), []);
  assert.equal(scan(run + "spawn(process.execPath, [RUN_MJS], { env: { X: RUN_MJS } });").length, 1);
  assert.equal(scan(run + "fork(RUN_MJS, { env: process.env });").length, 1);
  assert.equal(scan(run + 'const args = [RUN_MJS, "--brief=b.md"];\nspawnSync(process.execPath, args, { env });').length, 1);
  assert.equal(scan(run + "execSync(`node ${RUN_MJS}`, { env: { X: 1 } });").length, 1);
});

test("the scan flags codex or gcloud run through a shell", () => {
  for (const source of [
    'spawnSync("sh", ["-c", "codex mcp add x -- node y"]);',
    'spawnSync("codex mcp add x", { shell: true });',
    "cp.execFileSync('bash', ['-lc', 'gcloud auth list']);",
    'const LINE = "codex login status";\nexecSync(LINE);',
    'const LINE = "codex login status";\nspawnSync("sh", ["-c", LINE]);',
    'const CODEX = "codex";\nspawnSync("sh", ["-c", `${CODEX} login status`]);',
  ]) {
    assert.match(scan(source).join("\n"), /runs (?:codex|gcloud) through a shell/, source);
    assert.deepEqual(scan('import "./lib/stand-ins.mjs";\n' + source), [], source);
  }
  assert.deepEqual(scan('spawnSync("which", ["codex"]);'), [], "codex as an argument runs nothing");
  assert.deepEqual(scan('spawnSync("sh", ["-c", "echo hi"], { env: { NOTE: "codex login status" } });'), []);
  assert.equal(scan('spawnSync("codex", ["login", "status"]);').length, 1, "a direct call is reported once");
});

test("the scan follows import aliases, namespace imports and undefined arguments", () => {
  const alias = 'import { runChecks as rc } from "../../plugin/codex/env-checks.mjs";\n';
  assert.match(scan(alias + "rc();").join("\n"), /runChecks\(\) with its default checks/);
  assert.deepEqual(scan(alias + "rc([fakeCheck]);"), []);
  const namespace = 'import * as envChecks from "../../plugin/codex/env-checks.mjs";\n';
  assert.match(scan(namespace + "envChecks.runChecks();").join("\n"), /runChecks\(\)/);
  assert.deepEqual(scan(namespace + "envChecks.runChecks([fakeCheck]);"), []);
  assert.deepEqual(scan("other.runChecks();"), [], "a method of the same name on something else");

  assert.equal(scan("probeCodexLogin(undefined);").length, 1);
  assert.equal(scan("probeCodexLogin(void 0);").length, 1);
  const spawnCodex = 'import { spawnCodex } from "../../plugin/codex/run.mjs";\n';
  assert.equal(scan(spawnCodex + 'spawnCodex(["exec"], { spawnFn: undefined });').length, 1);
  assert.deepEqual(scan(spawnCodex + 'spawnCodex(["exec"], { spawnFn: undefined, codexBin: STUB });'), []);
});

test("the scan flags importing a script that runs as soon as it loads", () => {
  assert.ok(USERS.runsOnImport.includes("tools/setup.mjs"), USERS.runsOnImport.join(", "));
  assert.ok(!USERS.runsOnImport.includes("plugin/codex/run.mjs"), "run.mjs only runs as the main module");

  const wizard = scan('import "./lib/stand-ins.mjs";\nawait import("../setup.mjs");').join("\n");
  assert.match(wizard, /line 2 runs tools\/setup\.mjs on import, inside the test process/);
  const WIZARD = 'const WIZARD = join(ROOT, "tools", "setup.mjs");\n';
  assert.match(scan(WIZARD + "await import(pathToFileURL(WIZARD).href);").join("\n"), /inside the test process/);
  const policy = 'import "../../plugin/scripts/setup-policy.mjs";\n';
  assert.match(scan(policy).join("\n"), /runs plugin\/scripts\/setup-policy\.mjs on import but the module does not/);
  assert.deepEqual(scan('import "./lib/stand-ins.mjs";\n' + policy), []);
  assert.deepEqual(scan('const { main } = await import("../../plugin/codex/run.mjs");'), []);

  const guarded = (guard) =>
    'import { spawnSync } from "node:child_process";\nexport function go() {\n  return spawnSync("codex", ["login", "status"]);\n}\n' + guard;
  withFixtureRepo(
    {
      "plugin/one-line.mjs": guarded("if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) go();\n"),
      "plugin/two-lines.mjs": guarded("const isMain = process.argv[1] &&\n  resolve(process.argv[1]) === fileURLToPath(import.meta.url);\n"),
      "plugin/always.mjs": guarded("go();\n"),
    },
    ({ users }) => assert.deepEqual(users.runsOnImport, ["plugin/always.mjs"]),
  );
});

test("the scan flags a script that runs gcloud, spawned without the stand-ins", () => {
  const source = 'const SCRIPT = resolve(HERE, "..", "plugin", "scripts", "setup-policy.mjs");\n' +
    'spawnSync("node", [SCRIPT, "--check-creds"]);';
  assert.match(scan(source).join("\n"), /plugin\/scripts\/setup-policy\.mjs/);
  assert.deepEqual(scan('import "./lib/stand-ins.mjs";\n' + source), []);
});

test("the scan flags a PATH that leaves the stand-ins out", () => {
  const head = 'import "./lib/stand-ins.mjs";\n';
  assert.match(
    scan(head + 'spawnSync("codex", ["--version"], { env: { ...process.env, PATH: "/usr/bin" } });').join("\n"),
    /PATH of its own/,
  );
  assert.deepEqual(scan(head + 'spawnSync("codex", ["--version"], { env: { PATH: withStandIns("/usr/bin") } });'), []);
  const run = 'spawnSync("codex", ["--version"], { env });';
  assert.match(scan(head + 'const env = { ...process.env, PATH: "/usr/bin" };\n' + run).join("\n"), /line 2 sets a PATH/);
  assert.match(scan(head + 'env.PATH = "/usr/bin";\n' + run).join("\n"), /line 2 sets a PATH/);
  assert.match(scan(head + 'env["PATH"] = dirs;\n' + run).join("\n"), /line 2 sets a PATH/);
  assert.deepEqual(scan(head + 'env.PATH = "";\n' + run), [], "an empty PATH reaches no codex at all");
  assert.deepEqual(scan('const env = { PATH: "/usr/bin" };'), [], "PATH matters only in a module that runs codex");
  assert.match(scan(head + 'process.env.PATH = "/usr/bin";\nspawnSync("codex", ["--version"]);').join("\n"), /line 2 sets/);
  assert.match(
    scan(head + 'const sb = codexSandbox({ PATH: "/usr/bin" });\nspawnSync("codex", [], { env: sb.env });').join("\n"),
    /line 2 sets/,
  );
});

test("the scan follows a PATH into a wrapper's callers, and only to the spawns it reaches", () => {
  const head = 'import "./lib/stand-ins.mjs";\n';
  const wrapper = 'function run(args, extraEnv = {}) {\n  return spawnSync("codex", args, { env: { ...process.env, ...extraEnv } });\n}\n';
  assert.deepEqual(scan(head + wrapper + 'run(["--version"], { HOME: "/tmp/h" });'), []);
  assert.match(scan(head + wrapper + 'run(["--version"], { PATH: "/usr/bin" });').join("\n"), /line 5 sets/);
  const arrow = 'const run = (args, env = {}) => spawnSync("codex", args, { env: { ...process.env, ...env } });\n';
  assert.match(scan(head + arrow + 'run(["--version"], { PATH: "/usr/bin" });').join("\n"), /line 3 sets/);

  const sandbox = 'const sb = codexSandbox();\nspawnSync("codex", ["--version"], { env: sb.env });\n';
  assert.deepEqual(scan(head + 'assert.equal(codexEnv(policy, { PATH: "/bin" }).PATH, "/bin");\n' + sandbox), []);
  const otherTest = 'test("a", () => {\n  const env = { ...process.env, PATH: "/usr/bin" };\n  assert.ok(env);\n});\n';
  const thisTest = 'test("b", () => {\n  const env = codexSandbox().env;\n  spawnSync("codex", ["--version"], { env });\n});\n';
  assert.deepEqual(scan(head + otherTest + thisTest), [], "another test's const of the same name");
  const param = 'function check(root) {\n  return spawnSync("codex", ["--version"], { cwd: root });\n}\n';
  const sameName = 'test("c", () => {\n  const root = { PATH: "/usr/bin" };\n  assert.ok(root);\n});\n';
  assert.deepEqual(scan(head + param + sameName), [], "a parameter is not the const of the same name elsewhere");
  const elsewhere = 'test("d", () => {\n  const env = { ...process.env };\n  env.PATH = "/usr/bin";\n  spawnSync(process.execPath, ["x.mjs"], { env });\n});\n';
  assert.deepEqual(scan(head + arrow + 'run(["--version"]);\n' + elsewhere), [], "an arrow's own parameter is not a global");
});

test("the scan flags the setup wizard run without a codexSandbox() env", () => {
  const head = 'import { codexSandbox } from "./lib/sandbox.mjs";\nconst WIZARD = join(ROOT, "tools", "setup.mjs");\n';
  assert.match(scan(head + "spawnSync(process.execPath, [WIZARD], { env: { ...process.env } });").join("\n"), /codexSandbox/);
  assert.deepEqual(scan(head + "const sb = codexSandbox();\nspawnSync(process.execPath, [WIZARD], { env: sb.env });"), []);
});

test("the scan finds the wizard from a path relative to the test file", () => {
  const run = "spawnSync(process.execPath, [WIZARD], { env: process.env });";
  for (const wizard of [
    'const WIZARD = join(HERE, "..", "setup.mjs");\n',
    'const WIZARD = fileURLToPath(new URL("../setup.mjs", import.meta.url));\n',
    'const WIZARD = resolve(fileURLToPath(import.meta.url), "..", "..", "setup.mjs");\n',
  ]) {
    assert.match(scan(wizard + run).join("\n"), /runs tools\/setup\.mjs without a codexSandbox\(\) env/, wizard);
  }
  assert.deepEqual(scan('const OTHER = join(HERE, "..", "report.mjs");\nspawnSync(process.execPath, [OTHER]);'), []);
});

test("no root test runs codex or gcloud outside the stand-ins", () => {
  const modules = [
    ...readdirSync(HERE).filter((name) => name.endsWith(".test.mjs")).map((name) => join(HERE, name)),
    ...readdirSync(join(HERE, "lib")).filter((name) => name.endsWith(".mjs")).map((name) => join(HERE, "lib", name)),
  ].filter((file) => file !== THIS_FILE);
  const problems = modules.flatMap((file) =>
    unsandboxedCalls(readFileSync(file, "utf8"), { file, standIns: STAND_INS, users: USERS }).map(
      (problem) => `${relative(REPO_ROOT, file)}: ${problem}`,
    ),
  );
  assert.deepEqual(problems, []);
});

test("the setup and setup-policy tests are the ones held to the stand-ins today", () => {
  // A scan that matched nothing would pass the test above for the wrong reason.
  const held = ["setup.test.mjs", "setup-policy.test.mjs"].filter((name) => {
    const source = readFileSync(join(HERE, name), "utf8");
    const file = join(HERE, name);
    const withoutImport = source.replace(/^import .*\.\/lib\/(?:stand-ins|sandbox)\.mjs";$/gm, "");
    return unsandboxedCalls(withoutImport, { file, standIns: STAND_INS, users: USERS }).length > 0;
  });
  assert.deepEqual(held, ["setup.test.mjs", "setup-policy.test.mjs"]);
});

test("the server-suite hint in tools/test-mcp.mjs names commands that exist", () => {
  const source = readFileSync(join(REPO_ROOT, "tools", "test-mcp.mjs"), "utf8");
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;
  for (const [, name] of source.matchAll(/npm run ([\w:-]+)/g)) {
    assert.ok(name in scripts, `tools/test-mcp.mjs suggests \`npm run ${name}\`, which package.json does not define`);
  }
  const nodeCommands = [...source.matchAll(/\bnode (\S+\.mjs)/g)].map((m) => m[1]);
  assert.ok(nodeCommands.length > 0, "the hint must name a command to run");
  for (const path of nodeCommands) assert.ok(existsSync(join(REPO_ROOT, path)), `${path} does not exist`);
  assert.ok(!/no dependencies/i.test(source), "the root suite needs root npm ci and a built server");
});
