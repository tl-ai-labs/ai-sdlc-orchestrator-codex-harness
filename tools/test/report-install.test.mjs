/**
 * The report has to run from an installed plugin: the Codex cache is a copy
 * of ./plugin with no tools/, no node_modules and no build output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(REPO_ROOT, "plugin");
const REPORT = join(PLUGIN, "scripts", "report.mjs");
const WRAPPER = join(REPO_ROOT, "tools", "report.mjs");

const FIXTURE_SDLC = join(REPO_ROOT, "tools", "test", "fixtures", "report", "project", ".sdlc");

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30_000 });
const cleanup = (d) => { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } };

function sampleRun() {
  const dir = mkdtempSync(join(tmpdir(), "report-install-"));
  const ev = (o) => JSON.stringify({
    ts: "2026-10-13T10:00:00Z", pass: "r1", phase: "codegen", task_id: "t", model: "gemini-3.7-flash",
    provenance: "vendor", routing: { policy_name: "gpt-plus-flash" },
    input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.01, ...o,
  });
  writeFileSync(join(dir, "telemetry.jsonl"), [ev({}), ev({ phase: "senior_code_review", provenance: "modeled", cost_usd: 0.05 })].join("\n") + "\n");
  writeFileSync(join(dir, "driver-cost-modeled.jsonl"), ev({ phase: "driver_loop", provenance: "modeled", cost_usd: 0.2 }) + "\n");
  return dir;
}

function importSpecifiers(source) {
  const specs = new Set();
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) specs.add(m[1]);
  for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.add(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

function importGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  const problems = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(PLUGIN + sep)) problems.push(`${relative(REPO_ROOT, file)} imports ${spec}, outside ./plugin`);
        else if (!existsSync(target)) problems.push(`${relative(REPO_ROOT, file)} imports ${spec}, which does not exist`);
        else queue.push(target);
      } else if (!spec.startsWith("node:") && !builtinModules.includes(spec)) {
        problems.push(`${relative(REPO_ROOT, file)} imports the package ${spec}; an installed plugin has no node_modules`);
      }
    }
  }
  return { seen, problems };
}

test("the report and everything it imports live inside ./plugin and need only Node builtins", () => {
  const { seen, problems } = importGraph(REPORT);
  assert.deepEqual(problems, []);
  assert.ok(seen.has(join(PLUGIN, "scripts", "lib", "actors.mjs")), "the actor legend ships with the report");
});

test("a copy of ./plugin alone, without node_modules or dist, runs the report", () => {
  const cache = mkdtempSync(join(tmpdir(), "plugin-cache-"));
  const runDir = sampleRun();
  try {
    const installed = join(cache, "mmo-codex", "0.2.0");
    cpSync(PLUGIN, installed, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|dist|\.venv|__pycache__)$/.test(src),
    });
    assert.ok(!existsSync(join(cache, "mmo-codex", "tools")), "the simulated cache must not have tools/");
    for (const file of importGraph(REPORT).seen) {
      assert.ok(existsSync(join(installed, relative(PLUGIN, file))), `${relative(REPO_ROOT, file)} is in the cache`);
    }
    for (const args of [[runDir], [runDir, "--markdown"], [runDir, "--json"], [FIXTURE_SDLC], [FIXTURE_SDLC, "--markdown"]]) {
      const fromCache = run(join(installed, "scripts", "report.mjs"), args);
      const fromRepo = run(REPORT, args);
      assert.equal(fromCache.status, 0, fromCache.stderr);
      assert.equal(fromCache.stdout, fromRepo.stdout);
    }
  } finally { cleanup(cache); cleanup(runDir); }
});

test("tools/report.mjs is a wrapper: same stdout and exit code as the plugin script", () => {
  const runDir = sampleRun();
  try {
    for (const args of [[runDir], [runDir, "--markdown"], ["/nonexistent/run/dir"]]) {
      const a = run(WRAPPER, args);
      const b = run(REPORT, args);
      assert.equal(a.status, b.status, `exit code for ${args.join(" ")}`);
      assert.equal(a.stdout, b.stdout, `stdout for ${args.join(" ")}`);
    }
    assert.equal(run(WRAPPER, ["/nonexistent/run/dir"]).status, 2);
  } finally { cleanup(runDir); }
});

test("importing the report prints nothing and does not exit", () => {
  const probe = `import(${JSON.stringify(pathToFileURL(REPORT).href)}).then((m) => { process.stdout.write(typeof m.main + " " + typeof m.summarize); });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe, "--", "/nonexistent/run/dir"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "function function");
  assert.equal(r.stderr, "");
});

test("the usage message names the script that was run", () => {
  const r = run(REPORT, ["/nonexistent/run/dir"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(REPORT), r.stderr);
});

test("npm run report runs the plugin script", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.report, "node plugin/scripts/report.mjs");
});
