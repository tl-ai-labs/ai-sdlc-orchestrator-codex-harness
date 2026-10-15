import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = join(REPO, "plugin", "codex", "run.mjs");
const POLICIES = join(REPO, "plugin", "config", "policies");
const RUN_ID = "e2e-policy";

/** A codex that records the policy file and model it was given, and reports one turn of 1000 in / 100 out. */
const STUB_CODEX = `#!/bin/sh
here="$(dirname "$0")"
printf '%s\\n' "$MMO_POLICY_PATH" >> "$here/seen-policy-path.txt"
prev=""
for a in "$@"; do
  if [ "$prev" = "-m" ]; then printf '%s\\n' "$a" >> "$here/seen-model.txt"; fi
  prev="$a"
done
echo '{"type":"thread.started","thread_id":"t-e2e"}'
echo '{"type":"turn.started"}'
echo '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":100}}'
exit 0
`;

function shipped(name) {
  return readFileSync(join(POLICIES, `${name}.yaml`), "utf-8");
}

/** gpt-plus-flash renamed, with driver rates double the preset's; billed only under pricing_override. */
function customOverride({ override = true } = {}) {
  return shipped("gpt-plus-flash")
    .replace(/^name: .*$/m, "name: my-custom")
    .replace(/^hard_cost_cap_usd: .*$/m, "hard_cost_cap_usd: 5")
    .replace(
      /^(driver:\n(?:  .*\n)*?)  pricing: .*$/m,
      `$1  pricing: { input: 4.00, input_cached: 0.40, output: 24.00 }${override ? "\n  pricing_override: true" : ""}`,
    );
}

function setup({ override, defaultPolicy } = {}) {
  const base = mkdtempSync(join(tmpdir(), "run-policy-e2e-"));
  const root = join(base, "proj");
  const bin = join(base, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "brief.md"), "# brief\n");
  writeFileSync(join(base, "prompt.md"), "Run {{RUN_ID}} on policy {{POLICY}}.\n");
  if (override !== undefined) writeFileSync(join(root, "routing-policy.yaml"), override);
  if (defaultPolicy !== undefined) {
    mkdirSync(join(root, ".sdlc"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "project.json"), JSON.stringify({ default_policy: defaultPolicy }));
  }
  const codex = join(bin, "codex");
  writeFileSync(codex, STUB_CODEX);
  chmodSync(codex, 0o755);
  return { base, root, bin, codex, outputDir: join(root, ".sdlc", "runs", RUN_ID) };
}

function runMjs(t, extra = []) {
  const r = spawnSync(
    process.execPath,
    [
      RUN,
      `--project-root=${t.root}`,
      `--output-dir=${t.outputDir}`,
      `--run-id=${RUN_ID}`,
      `--prompt-file=${join(t.base, "prompt.md")}`,
      `--codex-bin=${t.codex}`,
      "--gates=auto-approve",
      "--mode=greenfield",
      "--max-turns=1",
      ...extra,
    ],
    { encoding: "utf8", env: { ...process.env, CODEX_HOME: join(t.base, "codex-home") } },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lines(path) {
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
}

function manifest(t) {
  return JSON.parse(readFileSync(join(t.outputDir, "driver-manifest.json"), "utf-8"));
}

function withSetup(opts, fn) {
  const t = setup(opts);
  try {
    return fn(t);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
}

test("a run gives codex the routing-policy.yaml path, records it, and prices the driver at its rates", () => {
  withSetup({ override: customOverride() }, (t) => {
    const r = runMjs(t, ["--policy=gpt-seat-plus-flash"]);
    const why = `exit ${r.status}\n${r.stderr}`;
    assert.deepEqual(lines(join(t.bin, "seen-policy-path.txt")), [join(t.root, "routing-policy.yaml")], why);
    assert.deepEqual(lines(join(t.bin, "seen-model.txt")), ["gpt-5.6-terra"], why);

    const m = manifest(t);
    assert.equal(m.policy, "my-custom");
    assert.equal(m.policy_source, "project-override");
    assert.equal(m.policy_path, join(t.root, "routing-policy.yaml"));
    assert.equal(m.policy_requested, "gpt-seat-plus-flash");
    assert.match(m.policy_sha256, /^[0-9a-f]{64}$/);
    // 1000 input at $4.00/M + 100 output at $24.00/M; the price list would give 0.0032.
    assert.equal(m.driver_cost_usd_modeled, 0.0064);
    assert.equal(m.driver_price.basis, "custom");

    const start = lines(join(t.outputDir, "driver-events.jsonl")).map((l) => JSON.parse(l)).find((r) => r.kind === "invocation_start");
    assert.equal(start.policy, "my-custom");
    assert.equal(start.policy_path, m.policy_path, "a run killed before it ends still records the file it started on");
    assert.equal(start.policy_sha256, m.policy_sha256);
    assert.equal(start.policy_requested, "gpt-seat-plus-flash");
  });
});

test("a driver pricing block that differs from the list is documentation: the list bills, with a warning", () => {
  withSetup({ override: customOverride({ override: false }) }, (t) => {
    const r = runMjs(t);
    const m = manifest(t);
    assert.equal(m.driver_cost_usd_modeled, 0.0032, `exit ${r.status}\n${r.stderr}`);
    assert.equal(m.driver_price.basis, "list");
    assert.deepEqual(m.driver_price.rates, { input: 2, input_cached: 0.2, output: 12 });
    assert.match(r.stderr, /differs on input, input_cached, output from the price list 2\/0\.2\/12/);
    const row = lines(join(t.outputDir, "driver-cost-modeled.jsonl")).map((l) => JSON.parse(l))[0];
    assert.deepEqual([row.price_basis, row.price_tier, row.price_verified], ["list", "standard", m.price_list_verified]);
  });
});

test("a run on the project.json default gives codex that preset's absolute path", () => {
  withSetup({ defaultPolicy: "gpt-seat-plus-flash" }, (t) => {
    const r = runMjs(t);
    const preset = join(POLICIES, "gpt-seat-plus-flash.yaml");
    assert.deepEqual(lines(join(t.bin, "seen-policy-path.txt")), [preset], `exit ${r.status}\n${r.stderr}`);
    const m = manifest(t);
    assert.equal(m.policy, "gpt-seat-plus-flash");
    assert.equal(m.policy_source, "project-default");
    assert.equal(m.policy_path, preset);
    assert.equal(m.policy_requested, null);
    assert.equal(m.driver_cost_usd_modeled, 0.0032);
  });
});

test("--resume after a same-named routing-policy.yaml appears is refused before codex starts", () => {
  withSetup({}, (t) => {
    const first = runMjs(t, ["--policy=gpt-plus-flash"]);
    const seen = join(t.bin, "seen-policy-path.txt");
    assert.equal(lines(seen).length, 1, `exit ${first.status}\n${first.stderr}`);
    assert.equal(manifest(t).policy_path, join(POLICIES, "gpt-plus-flash.yaml"));

    writeFileSync(
      join(t.root, "routing-policy.yaml"),
      shipped("gpt-plus-flash").replace(/^hard_cost_cap_usd: .*$/m, "hard_cost_cap_usd: 1000"),
    );
    const resumed = runMjs(t, ["--policy=gpt-plus-flash", "--resume=t-e2e"]);
    assert.equal(resumed.status, 2, resumed.stderr);
    assert.match(resumed.stderr, /--resume refused: the policy file differs/);
    assert.equal(lines(seen).length, 1, "codex was started for a refused resume");
  });
});
