import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeMmoSelectFile } from "../../plugin/codex/mmoSelect.mjs";
import "./lib/stand-ins.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "plugin", "scripts", "setup-policy.mjs");
const POLICIES = join(REPO, "plugin", "config", "policies");

/**
 * --check-creds in an empty project, with a HOME holding no Google
 * credential and an empty PATH, so gcloud never runs and only the
 * environment given here counts.
 */
function checkCreds(policy, { env = {}, setup } = {}) {
  const root = mkdtempSync(join(tmpdir(), "creds-project-"));
  const home = mkdtempSync(join(tmpdir(), "creds-home-"));
  try {
    setup?.(root);
    const r = spawnSync(process.execPath, [SCRIPT, "--check-creds", `--policy=${policy}`, `--project-root=${root}`], {
      encoding: "utf8",
      env: { HOME: home, PATH: "", ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout), root };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const KEYS = { OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "gm-test" };

test("gpt-plus-flash on its default completion leaf needs no ADC", () => {
  const out = checkCreds("gpt-plus-flash", { env: KEYS });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.policy, { name: "gpt-plus-flash", source: "preset", path: join(POLICIES, "gpt-plus-flash.yaml") });
});

test("selecting the agent leaf needs ADC and no longer needs GEMINI_API_KEY", () => {
  const out = checkCreds("gpt-plus-flash", { env: { OPENAI_API_KEY: "sk-test", MMO_SELECT: "gemini-flash=flash-agsdk-worker" } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing.map((m) => m.kind), ["vertex_adc"]);
});

test("the project's stored slot selection counts like MMO_SELECT", () => {
  const out = checkCreds("gpt-plus-flash", {
    env: KEYS,
    setup: (root) => writeMmoSelectFile(root, "gemini-flash=flash-agsdk-worker"),
  });
  assert.deepEqual(out.missing?.map((m) => m.kind), ["vertex_adc"]);
});

test("a stored slot selection outranks a legacy SDLC_SELECT, as a dispatch sees it", () => {
  const out = checkCreds("gpt-plus-flash", {
    env: { ...KEYS, SDLC_SELECT: "gemini-flash=flash-agsdk-worker" },
    setup: (root) => writeMmoSelectFile(root, "gemini-flash=flash-completion"),
  });
  assert.equal(out.ok, true, JSON.stringify(out));
});

test("a legacy SDLC_SELECT still counts when nothing else selects a leaf", () => {
  const out = checkCreds("gpt-plus-flash", { env: { ...KEYS, SDLC_SELECT: "gemini-flash=flash-agsdk-worker" } });
  assert.deepEqual(out.missing?.map((m) => m.kind), ["vertex_adc"]);
});

test("flash-agsdk-only needs ADC and no API key", () => {
  const out = checkCreds("flash-agsdk-only", { env: {} });
  assert.deepEqual(out.missing.map((m) => m.kind), ["vertex_adc"]);
});

test("a project's routing-policy.yaml is checked instead of the named preset", () => {
  const override = readFileSync(join(POLICIES, "gpt-plus-flash.yaml"), "utf8").replace(/^name: .*$/m, "name: team-metered");
  const out = checkCreds("gpt-seat-plus-flash", {
    env: { GEMINI_API_KEY: "gm-test" },
    setup: (root) => writeFileSync(join(root, "routing-policy.yaml"), override),
  });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing.map((m) => m.name), ["OPENAI_API_KEY"]);
  assert.equal(out.policy.name, "team-metered");
  assert.equal(out.policy.source, "project-override");
  assert.equal(out.policy.path, join(out.root, "routing-policy.yaml"));
  assert.match(out.note, /overrides --policy and default_policy.*instead of 'gpt-seat-plus-flash'/);
});

test("--print-only names a routing-policy.yaml that overrides the default, on stderr only", () => {
  const root = mkdtempSync(join(tmpdir(), "print-only-override-"));
  try {
    mkdirSync(join(root, ".sdlc"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "project.json"), JSON.stringify({ default_policy: "gpt-seat-plus-flash" }));
    const quiet = spawnSync(process.execPath, [SCRIPT, "--print-only", `--project-root=${root}`], { encoding: "utf8" });
    assert.equal(quiet.stdout, "gpt-seat-plus-flash\n");
    assert.equal(quiet.stderr, "");

    const override = readFileSync(join(POLICIES, "gpt-plus-flash.yaml"), "utf8").replace(/^name: .*$/m, "name: team-metered");
    writeFileSync(join(root, "routing-policy.yaml"), override);
    const r = spawnSync(process.execPath, [SCRIPT, "--print-only", `--project-root=${root}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "gpt-seat-plus-flash\n");
    assert.equal(
      r.stderr,
      `setup-policy: runs in this project use ${join(root, "routing-policy.yaml")} (policy 'team-metered'), ` +
        "which overrides default_policy and --policy.\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
