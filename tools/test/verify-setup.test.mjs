/**
 * Unit tests for plugin/codex/verify-setup.mjs — the offline setup
 * check+repair tool, rebuilt from the Claude harness's version (see the
 * file's own docstring for what changed and why).
 *
 * Most pure-helper tests here confirm the source's carried-verbatim
 * behavior still holds (credential inspection, select-spec parsing) —
 * these are not exhaustively re-derived from the source's own suite, since
 * nothing about their logic changed; the goal is confidence the carry was
 * clean, not a duplicate of the source's own coverage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  nodeMajorFrom,
  isUnexpandedPlaceholder,
  usableEnv,
  unexpandedDeclaredEnv,
  inspectCredentialFile,
  vertexCredentialState,
  hasGeminiCredentials,
  parseSelectSpec,
  selectSpecProblem,
  selectsAgentWorker,
  hasVertexCredentials,
  parseCodexVersion,
  meetsMinVersion,
  MIN_CODEX_VERSION,
  probeCodexCli,
  probeCodexLogin,
  evaluate,
  enableAgentPath,
  AGENT_WORKER_MODEL_ID,
  AGENT_WORKER_SLOT,
  DECLARED_ENV,
  skillPaths,
  skillLinkState,
  linkSkills,
  nextStepsBanner,
  policyAdapters,
  observePolicy,
  DEFAULT_POLICY,
  SEAT_POLICY,
} from "../../plugin/codex/verify-setup.mjs";
import { readMmoSelectFile, writeMmoSelectFile } from "../../plugin/codex/mmoSelect.mjs";

function makeProject() {
  return mkdtempSync(join(tmpdir(), "verify-setup-test-"));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── carried-verbatim pure helpers — smoke coverage ──────────────────────

test("nodeMajorFrom parses a version string", () => {
  assert.equal(nodeMajorFrom("20.11.1"), 20);
  assert.equal(nodeMajorFrom("garbage"), 0);
});

test("isUnexpandedPlaceholder / usableEnv drop ${NAME}-shaped values", () => {
  assert.equal(isUnexpandedPlaceholder("${OPENAI_API_KEY}"), true);
  assert.equal(isUnexpandedPlaceholder("sk-real-value"), false);
  const cleaned = usableEnv({ A: "${A}", B: "real", C: "" });
  assert.deepEqual(cleaned, { B: "real" });
});

test("unexpandedDeclaredEnv only reports DECLARED_ENV names", () => {
  const result = unexpandedDeclaredEnv({ OPENAI_API_KEY: "${OPENAI_API_KEY}", NOT_DECLARED: "${X}" });
  assert.deepEqual(result, ["OPENAI_API_KEY"]);
});

test("DECLARED_ENV has no ANTHROPIC_API_KEY and does have OPENAI_API_KEY (D9)", () => {
  assert.ok(!DECLARED_ENV.includes("ANTHROPIC_API_KEY"));
  assert.ok(DECLARED_ENV.includes("OPENAI_API_KEY"));
});

test("inspectCredentialFile: missing file", () => {
  const result = inspectCredentialFile("/nonexistent/path.json");
  assert.equal(result.usable, false);
  assert.equal(result.present, false);
});

test("inspectCredentialFile: a complete service_account credential is usable", () => {
  const dir = makeProject();
  try {
    const path = join(dir, "sa.json");
    writeFileSync(path, JSON.stringify({ type: "service_account", client_email: "sa@example.com", private_key: "-----BEGIN" }));
    assert.equal(inspectCredentialFile(path).usable, true);
  } finally { cleanup(dir); }
});

test("inspectCredentialFile: a service_account missing private_key is unusable", () => {
  const dir = makeProject();
  try {
    const path = join(dir, "sa.json");
    writeFileSync(path, JSON.stringify({ type: "service_account", client_email: "sa@example.com" }));
    const result = inspectCredentialFile(path);
    assert.equal(result.usable, false);
    assert.match(result.detail, /missing private_key/);
  } finally { cleanup(dir); }
});

test("vertexCredentialState: explicit GOOGLE_APPLICATION_CREDENTIALS wins over ADC", () => {
  const state = vertexCredentialState({
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/x" },
    serviceAccountFile: { usable: true, detail: null },
    adcFile: { usable: true, present: true, detail: null },
  });
  assert.equal(state.state, "credential");
  assert.equal(state.source, "GOOGLE_APPLICATION_CREDENTIALS");
});

test("vertexCredentialState: project-only when just GOOGLE_CLOUD_PROJECT is set", () => {
  const state = vertexCredentialState({ env: { GOOGLE_CLOUD_PROJECT: "p" } });
  assert.equal(state.state, "project-only");
});

test("hasGeminiCredentials: true on a GEMINI_API_KEY alone", () => {
  assert.equal(hasGeminiCredentials({ env: { GEMINI_API_KEY: "x" } }), true);
});

test("parseSelectSpec parses slot=option pairs and flags malformed entries", () => {
  assert.deepEqual(parseSelectSpec("gemini-flash=flash-agsdk-worker"), {
    pairs: { "gemini-flash": "flash-agsdk-worker" },
    invalid: [],
  });
  assert.deepEqual(parseSelectSpec("bad-entry"), { pairs: {}, invalid: ["bad-entry"] });
});

test("selectSpecProblem names a bare leaf name specifically", () => {
  const problem = selectSpecProblem({ MMO_SELECT: AGENT_WORKER_MODEL_ID });
  assert.ok(problem);
  assert.match(problem.message, /is the option, not the whole selection/);
});

test("selectsAgentWorker / hasVertexCredentials", () => {
  assert.equal(selectsAgentWorker({ MMO_SELECT: "gemini-flash=flash-agsdk-worker" }), true);
  assert.equal(selectsAgentWorker({ MMO_SELECT: "gemini-flash=flash-completion" }), false);
  assert.equal(hasVertexCredentials({ state: "credential" }), true);
  assert.equal(hasVertexCredentials({ state: "project-only" }), false);
});

// ── codex-native version/login probing ──────────────────────────────────

test("parseCodexVersion extracts a semver triple from 'codex-cli 0.151.0'", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.151.0\n"), [0, 151, 0]);
});

test("parseCodexVersion returns null on unparseable output", () => {
  assert.equal(parseCodexVersion("garbage"), null);
});

test("meetsMinVersion: exact match, above, and below the pin", () => {
  assert.equal(meetsMinVersion([0, 151, 0], MIN_CODEX_VERSION), true);
  assert.equal(meetsMinVersion([0, 152, 0], MIN_CODEX_VERSION), true);
  assert.equal(meetsMinVersion([0, 150, 9], MIN_CODEX_VERSION), false);
  assert.equal(meetsMinVersion(null, MIN_CODEX_VERSION), false);
});

test("probeCodexCli reports absent when the binary can't be spawned", () => {
  const fakeRun = () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
  assert.deepEqual(probeCodexCli(fakeRun), { present: false, version: null });
});

test("probeCodexCli parses a successful --version call", () => {
  const fakeRun = () => ({ status: 0, stdout: "codex-cli 0.151.0\n" });
  assert.deepEqual(probeCodexCli(fakeRun), { present: true, version: [0, 151, 0] });
});

test("probeCodexLogin recognizes the real 'Logged in using ChatGPT' string", () => {
  const fakeRun = () => ({ status: 0, stdout: "Logged in using ChatGPT\n" });
  const result = probeCodexLogin(fakeRun);
  assert.equal(result.loggedIn, true);
});

test("probeCodexLogin recognizes 'Not logged in' — must not false-positive on the substring 'logged in'", () => {
  const fakeRun = () => ({ status: 0, stdout: "Not logged in\n" });
  const result = probeCodexLogin(fakeRun);
  assert.equal(result.loggedIn, false);
});

test("probeCodexLogin reads the status off stderr — codex-cli 0.152.1 puts it there, stdout empty", () => {
  const fakeRun = () => ({ status: 0, stdout: "", stderr: "Logged in using ChatGPT\n" });
  const result = probeCodexLogin(fakeRun);
  assert.equal(result.loggedIn, true, "a working ChatGPT seat must not be reported as logged out");
  assert.match(result.detail, /Logged in using ChatGPT/);
});

test("probeCodexLogin still reads 'Not logged in' when it arrives on stderr", () => {
  const fakeRun = () => ({ status: 0, stdout: "", stderr: "Not logged in\n" });
  assert.equal(probeCodexLogin(fakeRun).loggedIn, false);
});

// ── evaluate(): the decision table ───────────────────────────────────────

// A metered policy, since that is what an unconfigured project falls back to.
const METERED_POLICY = { name: DEFAULT_POLICY, selected: true, path: "/p.yaml", usesOpenAiKey: true };
const SEAT_POLICY_STATE = { name: SEAT_POLICY, selected: true, path: "/s.yaml", usesOpenAiKey: false };

const HEALTHY = {
  nodeMajor: 22,
  codexCli: { present: true, version: [0, 151, 0] },
  codexLogin: { loggedIn: true },
  hasNodeModules: true,
  hasDist: true,
  env: { OPENAI_API_KEY: "sk-x", GEMINI_API_KEY: "g-x" },
  policy: METERED_POLICY,
};

test("evaluate: a fully healthy install passes with no problems", () => {
  const state = evaluate(HEALTHY);
  assert.equal(state.ok, true);
  assert.deepEqual(state.problems, []);
});

test("evaluate: old Node is blocking", () => {
  const state = evaluate({ ...HEALTHY, nodeMajor: 18 });
  assert.equal(state.ok, false);
  assert.ok(state.problems.some((p) => p.id === "node-version" && p.severity === "blocking"));
});

test("evaluate: codex CLI absent is blocking", () => {
  const state = evaluate({ ...HEALTHY, codexCli: { present: false, version: null } });
  assert.equal(state.ok, false);
  const p = state.problems.find((p) => p.id === "codex-cli");
  assert.equal(p.severity, "blocking");
  assert.match(p.message, /not found on PATH/);
});

test("evaluate: codex CLI present but below the version pin is blocking", () => {
  const state = evaluate({ ...HEALTHY, codexCli: { present: true, version: [0, 140, 0] } });
  const p = state.problems.find((p) => p.id === "codex-cli");
  assert.equal(p.severity, "blocking");
  assert.match(p.message, /0\.140\.0/);
});

test("evaluate: codex present but not logged in is blocking, distinct from absence", () => {
  const state = evaluate({ ...HEALTHY, codexLogin: { loggedIn: false } });
  const p = state.problems.find((p) => p.id === "codex-login");
  assert.ok(p, "codex-login problem must be reported");
  assert.equal(p.severity, "blocking");
});

test("evaluate: codex-login is not checked at all when codex itself is absent — one problem, not two confusing ones", () => {
  const state = evaluate({ ...HEALTHY, codexCli: { present: false, version: null }, codexLogin: { loggedIn: false } });
  assert.equal(state.problems.some((p) => p.id === "codex-login"), false);
});

test("evaluate: missing node_modules / dist are both blocking", () => {
  const state1 = evaluate({ ...HEALTHY, hasNodeModules: false });
  assert.ok(state1.problems.some((p) => p.id === "mcp-dependencies" && p.severity === "blocking"));
  const state2 = evaluate({ ...HEALTHY, hasDist: false });
  assert.ok(state2.problems.some((p) => p.id === "mcp-build" && p.severity === "blocking"));
});

test("evaluate: missing OPENAI_API_KEY blocks on a policy that bills it", () => {
  const state = evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "g-x" } });
  const p = state.problems.find((p) => p.id === "openai-key");
  assert.ok(p, "openai-key problem must be reported");
  assert.equal(p.severity, "blocking");
  assert.equal(state.ok, false);
  // The way out must be named, not just the key shop.
  assert.match(p.fix, new RegExp(SEAT_POLICY));
});

test("evaluate: missing OPENAI_API_KEY is NOT a problem under the seat policy — it names no openai adapter", () => {
  const state = evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "g-x" }, policy: SEAT_POLICY_STATE });
  assert.equal(state.problems.some((p) => p.id === "openai-key"), false);
  assert.equal(state.ok, true);
});

test("evaluate: an unselected policy is reported as the default it would fall back to, still blocking", () => {
  const state = evaluate({
    ...HEALTHY,
    env: { GEMINI_API_KEY: "g-x" },
    policy: { ...METERED_POLICY, selected: false },
  });
  const p = state.problems.find((p) => p.id === "openai-key");
  assert.equal(p.severity, "blocking");
  assert.match(p.message, /has not chosen a policy/);
  assert.match(p.message, new RegExp(DEFAULT_POLICY));
});

test("evaluate: an unreadable policy downgrades the key check to a warning, not a false block", () => {
  const state = evaluate({
    ...HEALTHY,
    env: { GEMINI_API_KEY: "g-x" },
    policy: { name: "custom", selected: true, path: "/nope.yaml", usesOpenAiKey: null },
  });
  const p = state.problems.find((p) => p.id === "openai-key");
  assert.equal(p.severity, "warning");
  assert.equal(state.ok, true, "an unknown policy must not fail an otherwise-healthy install");
});

test("evaluate: no ANTHROPIC_API_KEY check exists at all (D9)", () => {
  const state = evaluate(HEALTHY);
  assert.equal(state.problems.some((p) => p.id === "anthropic-key"), false);
});

test("evaluate: a broken Google credential is blocking", () => {
  const state = evaluate({
    ...HEALTHY,
    vertex: { state: "broken", detail: "bad credential" },
  });
  const p = state.problems.find((p) => p.id === "gemini-credentials-broken");
  assert.equal(p.severity, "blocking");
});

test("evaluate: no Gemini credentials at all is a warning, not blocking", () => {
  const state = evaluate({
    ...HEALTHY,
    env: { OPENAI_API_KEY: "sk-x" },
    vertex: { state: "none" },
  });
  const p = state.problems.find((p) => p.id === "gemini-credentials");
  assert.equal(p.severity, "warning");
  assert.equal(state.ok, true, "warnings alone must not fail evaluate()");
});

test("evaluate: agent path selected with no Vertex credential is blocking", () => {
  const state = evaluate({
    ...HEALTHY,
    env: { ...HEALTHY.env, MMO_SELECT: "gemini-flash=flash-agsdk-worker" },
    vertex: { state: "none" },
  });
  const p = state.problems.find((p) => p.id === "agent-worker-credentials");
  assert.equal(p.severity, "blocking");
});

test("evaluate: agent worker missing a venv is blocking", () => {
  const state = evaluate({
    ...HEALTHY,
    env: { ...HEALTHY.env, MMO_SELECT: "gemini-flash=flash-agsdk-worker" },
    vertex: { state: "credential" },
    agentWorker: { hasVenv: false, sdkImportable: false },
  });
  assert.ok(state.problems.some((p) => p.id === "agent-worker-python" && p.severity === "blocking"));
});

// ── enableAgentPath: the project-local file replacing settings.json/.mcp.json ──

test("enableAgentPath(enabled: true) writes the agent-worker slot to the project file", () => {
  const dir = makeProject();
  try {
    const result = enableAgentPath({ projectRoot: dir, enabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.spec, `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`);
    assert.equal(readMmoSelectFile(dir), `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`);
  } finally { cleanup(dir); }
});

test("enableAgentPath(enabled: false) after enabling removes the file entirely", () => {
  const dir = makeProject();
  try {
    enableAgentPath({ projectRoot: dir, enabled: true });
    const result = enableAgentPath({ projectRoot: dir, enabled: false });
    assert.equal(result.spec, undefined);
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { cleanup(dir); }
});

test("enableAgentPath(enabled: false) preserves an unrelated existing slot", () => {
  const dir = makeProject();
  try {
    // Seed a selection carrying both the agent-worker slot and an unrelated
    // one, the way a hand-edit or a future feature's own slot might.
    writeMmoSelectFile(dir, `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID},other-slot=other-option`);

    const result = enableAgentPath({ projectRoot: dir, enabled: false });
    assert.equal(result.spec, "other-slot=other-option", "disable removes only its own slot's pairing");
  } finally { cleanup(dir); }
});

test("enableAgentPath(enabled: false) on a project with no prior selection is a harmless no-op", () => {
  const dir = makeProject();
  try {
    const result = enableAgentPath({ projectRoot: dir, enabled: false });
    assert.equal(result.ok, true);
    assert.equal(result.spec, undefined);
  } finally { cleanup(dir); }
});

// ── cross-file consistency: the agent-worker leaf id must match the policy ──

test("AGENT_WORKER_MODEL_ID / AGENT_WORKER_SLOT match the official policy's actual leaf", () => {
  const policyPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "plugin", "config", "policies", "gpt-plus-flash.yaml",
  );
  const policy = parseYaml(readFileSync(policyPath, "utf8"));
  assert.ok(
    policy.models.some((m) => m.id === AGENT_WORKER_MODEL_ID),
    `gpt-plus-flash.yaml must declare a model with id '${AGENT_WORKER_MODEL_ID}'`,
  );
  assert.ok(
    policy.select && AGENT_WORKER_SLOT in policy.select,
    `gpt-plus-flash.yaml must declare a select slot named '${AGENT_WORKER_SLOT}'`,
  );
});

// ── skill discoverability ────────────────────────────────────────────────
//
// Measured with `codex debug prompt-input` and recorded in
// docs/verification/p1-codex-runtime.md: codex scans `<repo>/.agents/skills`
// and does NOT scan `plugin/skills/`. The manifest's `"skills": "./skills/"`
// publishes them to someone who installs the plugin and does nothing for
// someone working in a clone — which is how this port was built and how a
// contributor will work.

/** A throwaway repo with `n` shipped skills and an optional subset linked. */
function skillFixture(shipped, linked = []) {
  const root = mkdtempSync(join(tmpdir(), "mmo-skills-"));
  const pluginRoot = join(root, "plugin");
  for (const name of shipped) {
    mkdirSync(join(pluginRoot, "skills", name), { recursive: true });
    writeFileSync(join(pluginRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  for (const name of linked) {
    mkdirSync(join(root, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", name, "SKILL.md"), "linked");
  }
  return { root, pluginRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("skillPaths points at plugin/skills for the source and .agents/skills for the scan path", () => {
  const { sourceDir, linkDir } = skillPaths(join("/p", "plugin"), "/proj");
  assert.equal(sourceDir, join("/p", "plugin", "skills"));
  assert.equal(linkDir, join("/proj", ".agents", "skills"));
});

test("skillLinkState reports every shipped skill missing when nothing is linked", () => {
  const fx = skillFixture(["greenfield", "pass"]);
  try {
    const state = skillLinkState(fx.pluginRoot, fx.root);
    assert.deepEqual(state.shipped, ["greenfield", "pass"]);
    assert.deepEqual(state.linked, []);
    assert.deepEqual(state.missing, ["greenfield", "pass"]);
  } finally { fx.cleanup(); }
});

test("skillLinkState reports a partial link, not just all-or-nothing", () => {
  // The realistic broken state: someone adds a skill after running --fix.
  const fx = skillFixture(["greenfield", "pass"], ["greenfield"]);
  try {
    const state = skillLinkState(fx.pluginRoot, fx.root);
    assert.deepEqual(state.linked, ["greenfield"]);
    assert.deepEqual(state.missing, ["pass"]);
  } finally { fx.cleanup(); }
});

test("skillLinkState ignores a directory with no SKILL.md", () => {
  const fx = skillFixture(["greenfield"]);
  try {
    mkdirSync(join(fx.pluginRoot, "skills", "assets"));
    assert.deepEqual(skillLinkState(fx.pluginRoot, fx.root).shipped, ["greenfield"]);
  } finally { fx.cleanup(); }
});

test("evaluate: unlinked skills warn but do not block", () => {
  // A headless run.mjs invocation renders its own skill copies and never
  // consults .agents/skills, so this must not fail an otherwise-good setup.
  const state = evaluate({
    ...HEALTHY,
    skills: { shipped: ["greenfield", "pass"], linked: [], missing: ["greenfield", "pass"] },
  });
  const problem = state.problems.find((p) => p.id === "skills-discoverable");
  assert.ok(problem, "unlinked skills must be reported");
  assert.equal(problem.severity, "warning");
  assert.equal(state.ok, true, "the install is still usable headlessly");
  assert.match(problem.message, /\.agents\/skills/, "must name the path codex actually scans");
});

test("evaluate: fully linked skills raise nothing", () => {
  const state = evaluate({
    ...HEALTHY,
    skills: { shipped: ["greenfield"], linked: ["greenfield"], missing: [] },
  });
  assert.equal(state.problems.find((p) => p.id === "skills-discoverable"), undefined);
});

test("the next-steps banner teaches codex's mention syntax, not Claude's slash commands", () => {
  // `codex exec` does not expand slash commands at all, and codex namespaces
  // a plugin's skills by the plugin name — so `$mmo-codex:greenfield`.
  const banner = nextStepsBanner(mkdtempSync(join(tmpdir(), "mmo-banner-")), true);
  assert.doesNotMatch(banner, /\/mmo:/, "'/mmo:' is Claude Code syntax and does nothing here");
  assert.match(banner, /\$mmo-codex:greenfield/);
  assert.match(banner, /\$mmo-codex:pass/);
});

test("linkSkills repairs a link left dangling by a plugin update", () => {
  // The realistic broken state: --fix linked the skills, then a plugin update
  // moved or deleted the directory they point into. skillLinkState correctly
  // reports the skill missing (it follows the link and finds no SKILL.md) —
  // but an implementation that skips any path where something already exists
  // never repairs it, and returns true, so --fix reports success forever
  // while the skill stays unreachable.
  const fx = skillFixture(["alpha"]);
  try {
    mkdirSync(join(fx.root, ".agents", "skills"), { recursive: true });
    symlinkSync(
      join(fx.pluginRoot, "skills", "gone-away"),
      join(fx.root, ".agents", "skills", "alpha"),
      "dir",
    );
    assert.deepEqual(skillLinkState(fx.pluginRoot, fx.root).missing, ["alpha"]);

    assert.equal(linkSkills(fx.pluginRoot, fx.root), true);
    assert.deepEqual(
      skillLinkState(fx.pluginRoot, fx.root).missing, [],
      "a dangling link must be cleared and recreated, not skipped",
    );
  } finally { fx.cleanup(); }
});

test("linkSkills is a no-op when every skill is already linked correctly", () => {
  const fx = skillFixture(["alpha"]);
  try {
    assert.equal(linkSkills(fx.pluginRoot, fx.root), true);
    const first = skillLinkState(fx.pluginRoot, fx.root);
    // Second call must not churn a working link.
    assert.equal(linkSkills(fx.pluginRoot, fx.root), true);
    assert.deepEqual(skillLinkState(fx.pluginRoot, fx.root), first);
    assert.ok(existsSync(join(fx.root, ".agents", "skills", "alpha", "SKILL.md")));
  } finally { fx.cleanup(); }
});

test("linkSkills never deletes a real directory someone else put in .agents/skills", () => {
  // The repair path removes a stale link to make room for a fresh one. But
  // .agents/skills/ is a directory codex scans, not one this harness owns —
  // a real directory there is another author's skill. A half-written one has
  // no SKILL.md yet, which is precisely what makes skillLinkState report our
  // same-named skill as missing. Recursively deleting it would destroy their
  // work to install a symlink.
  const fx = skillFixture(["alpha"]);
  try {
    const squatted = join(fx.root, ".agents", "skills", "alpha");
    mkdirSync(squatted, { recursive: true });
    writeFileSync(join(squatted, "draft.md"), "someone else's work in progress");

    assert.deepEqual(skillLinkState(fx.pluginRoot, fx.root).missing, ["alpha"]);
    assert.equal(linkSkills(fx.pluginRoot, fx.root), false, "must refuse rather than overwrite");
    assert.ok(
      existsSync(join(squatted, "draft.md")),
      "the other author's file must survive",
    );
  } finally { fx.cleanup(); }
});

// ── policy resolution: which policies actually bill OPENAI_API_KEY ───────
//
// These run against the shipped policy files rather than fixtures. The
// question the check asks — "does this policy name the openai adapter" — is
// answered by a regex over YAML, so if a policy is ever restructured or an
// adapter renamed, the check would silently stop finding it and report a
// metered policy as key-free. That failure is invisible until a run aborts
// mid-phase, so it is worth pinning to the real files.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_PLUGIN_ROOT = join(REPO_ROOT, "plugin");

test("policyAdapters pulls every adapter id out of a models block", () => {
  const yaml = [
    "models:",
    "  - id: gpt",
    "    adapter: openai   # trailing comment must not be captured",
    "  - id: flash",
    "    adapter: mcp:model-dispatch",
  ].join("\n");
  assert.deepEqual(policyAdapters(yaml), ["openai", "mcp:model-dispatch"]);
});

test("policyAdapters returns nothing for empty or absent input rather than throwing", () => {
  assert.deepEqual(policyAdapters(""), []);
  assert.deepEqual(policyAdapters(null), []);
});

test("the shipped gpt-plus-flash really does route judgment through the openai adapter", () => {
  const state = observePolicy(SHIPPED_PLUGIN_ROOT, mkdtempSync(join(tmpdir(), "no-project-")));
  assert.equal(state.name, DEFAULT_POLICY, "an unconfigured project falls back to the default");
  assert.equal(state.selected, false);
  assert.equal(state.usesOpenAiKey, true);
});

test("the shipped gpt-seat-plus-flash names no openai adapter — the whole point of it", () => {
  const root = mkdtempSync(join(tmpdir(), "seat-project-"));
  mkdirSync(join(root, ".sdlc"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "project.json"), JSON.stringify({ default_policy: SEAT_POLICY }));

  const state = observePolicy(SHIPPED_PLUGIN_ROOT, root);
  assert.equal(state.name, SEAT_POLICY);
  assert.equal(state.selected, true);
  assert.equal(state.usesOpenAiKey, false);
  rmSync(root, { recursive: true, force: true });
});

test("a policy name with no file behind it is 'unknown', not 'needs no key'", () => {
  const root = mkdtempSync(join(tmpdir(), "bogus-project-"));
  mkdirSync(join(root, ".sdlc"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "project.json"), JSON.stringify({ default_policy: "no-such-policy" }));

  const state = observePolicy(SHIPPED_PLUGIN_ROOT, root);
  assert.equal(state.usesOpenAiKey, null, "absence of a file is not evidence of absence of a key requirement");
  rmSync(root, { recursive: true, force: true });
});

test("a malformed project.json falls back to the default instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "bad-json-"));
  mkdirSync(join(root, ".sdlc"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "project.json"), "{ not json");

  assert.equal(observePolicy(SHIPPED_PLUGIN_ROOT, root).name, DEFAULT_POLICY);
  rmSync(root, { recursive: true, force: true });
});
