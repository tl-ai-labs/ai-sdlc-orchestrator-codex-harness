import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_POLICY_NAME,
  KNOWN_ADAPTER_IDS,
  PLUGIN_POLICY_DIR,
  POLICY_NAME_RE,
  loadPolicy,
  loadPolicyFromPath,
  resolvePolicy,
  resolvePolicySource,
  shippedPresetNames,
} from "../dist/policy.js";
import { REGISTERED_ADAPTER_IDS } from "../dist/adapters/index.js";
import { connectBridge } from "../dist/driverClient.js";
import { claudePolicyPath } from "./fixtures/claudePolicies.mjs";
import {
  observePolicy,
  DEFAULT_POLICY as VERIFY_DEFAULT_POLICY,
  POLICY_NAME_RE as VERIFY_POLICY_NAME_RE,
} from "../../../codex/verify-setup.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const PLUGIN_ROOT = join(SERVER_DIR, "..", "..");
const SHIPPED = join(PLUGIN_POLICY_DIR, "gpt-plus-flash.yaml");

function project({ override, projectJson } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-policy-res-"));
  if (override !== undefined) writeFileSync(join(root, "routing-policy.yaml"), override);
  if (projectJson !== undefined) {
    mkdirSync(join(root, ".sdlc"), { recursive: true });
    writeFileSync(
      join(root, ".sdlc", "project.json"),
      typeof projectJson === "string" ? projectJson : JSON.stringify(projectJson),
    );
  }
  return root;
}

function customPolicy({ name = "my-custom", cap = 5, adapter = "openai" } = {}) {
  return readFileSync(SHIPPED, "utf-8")
    .replace(/^name: .*$/m, `name: ${name}`)
    .replace(/^hard_cost_cap_usd: .*$/m, `hard_cost_cap_usd: ${cap}`)
    .replace("adapter: openai", `adapter: ${adapter}`);
}

function withProject(opts, fn) {
  const root = project(opts);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("routing-policy.yaml beats policy_name, and the name comes from the file", () => {
  withProject({ override: customPolicy(), projectJson: { default_policy: "gpt-seat-plus-flash" } }, (root) => {
    const r = resolvePolicy({ policyName: "gpt-plus-flash", projectRoot: root });
    assert.equal(r.source, "project-override");
    assert.equal(r.path, join(root, "routing-policy.yaml"));
    assert.equal(r.requestedName, "gpt-plus-flash");
    assert.equal(r.policy.name, "my-custom");
    assert.equal(r.policy.hard_cost_cap_usd, 5);
  });
});

test("policy_name loads the preset when the project has no override", () => {
  withProject({ projectJson: { default_policy: "gpt-seat-plus-flash" } }, (root) => {
    const r = resolvePolicy({ policyName: "gpt-plus-flash-38", projectRoot: root });
    assert.equal(r.source, "flag");
    assert.equal(r.policy.name, "gpt-plus-flash-38");
  });
});

test("with no name, .sdlc/project.json default_policy decides", () => {
  withProject({ projectJson: { default_policy: "gpt-seat-plus-flash" } }, (root) => {
    const r = resolvePolicy({ projectRoot: root });
    assert.equal(r.source, "project-default");
    assert.equal(r.requestedName, "gpt-seat-plus-flash");
    assert.equal(r.policy.name, "gpt-seat-plus-flash");
  });
});

test("a default_policy written with its .yaml extension names the same preset, here and in verify-setup", () => {
  withProject({ projectJson: { default_policy: "gpt-seat-plus-flash.yaml" } }, (root) => {
    const r = resolvePolicy({ projectRoot: root });
    assert.equal(r.source, "project-default");
    assert.equal(r.policy.name, "gpt-seat-plus-flash");
    assert.equal(observePolicy(PLUGIN_ROOT, root).path, r.path);
  });
});

test("with nothing set, the built-in default is gpt-plus-flash, never opus-only", () => {
  withProject({}, (root) => {
    const r = resolvePolicy({ projectRoot: root });
    assert.equal(r.source, "builtin-default");
    assert.equal(r.policy.name, "gpt-plus-flash");
    assert.equal(DEFAULT_POLICY_NAME, "gpt-plus-flash");
  });
  assert.equal(loadPolicy({}).name, "gpt-plus-flash");
});

test("an empty or null default_policy falls through to the built-in default", () => {
  for (const value of ["", null]) {
    withProject({ projectJson: { default_policy: value } }, (root) => {
      assert.equal(resolvePolicySource({ projectRoot: root }).source, "builtin-default");
    });
  }
});

test("policy_path beats routing-policy.yaml", () => {
  withProject({ override: customPolicy() }, (root) => {
    const r = resolvePolicy({ policyName: "gpt-plus-flash", projectRoot: root, policyPath: SHIPPED });
    assert.equal(r.source, "path");
    assert.equal(r.path, SHIPPED);
    assert.equal(r.policy.name, "gpt-plus-flash");
  });
});

test("a malformed project.json throws naming the file", () => {
  withProject({ projectJson: "{ not json" }, (root) => {
    assert.throws(() => resolvePolicy({ projectRoot: root }), (err) => {
      assert.match(err.message, /project\.json is not valid JSON/);
      assert.ok(err.message.includes(join(root, ".sdlc", "project.json")));
      return true;
    });
  });
});

test("a non-string default_policy throws", () => {
  withProject({ projectJson: { default_policy: 7 } }, (root) => {
    assert.throws(() => resolvePolicy({ projectRoot: root }), /default_policy must be a policy name/);
  });
});

test("a default_policy naming a missing preset lists the runnable presets read from disk", () => {
  withProject({ projectJson: { default_policy: "no-such-policy" } }, (root) => {
    assert.throws(() => resolvePolicy({ projectRoot: root }), (err) => {
      assert.match(err.message, /'no-such-policy' \(from \.sdlc\/project\.json default_policy\) not found/);
      assert.match(err.message, /gpt-plus-flash-38/);
      assert.match(err.message, /flash-agsdk-only/);
      assert.doesNotMatch(err.message, /opus/);
      assert.match(err.message, /routing-policy\.yaml/);
      return true;
    });
  });
});

test("shippedPresetNames is the four runnable policies, and leaves out one this harness cannot run", () => {
  assert.deepEqual(shippedPresetNames(), ["flash-agsdk-only", "gpt-plus-flash", "gpt-plus-flash-38", "gpt-seat-plus-flash"]);
  const dir = mkdtempSync(join(tmpdir(), "mmo-presets-"));
  try {
    writeFileSync(join(dir, "gpt-plus-flash.yaml"), readFileSync(SHIPPED));
    writeFileSync(join(dir, "opus-plus-flash.yaml"), readFileSync(claudePolicyPath("opus-plus-flash")));
    writeFileSync(join(dir, "claude-driver.yaml"), readFileSync(SHIPPED, "utf-8").replace(/^(driver:\n  model_name: ).*$/m, "$1claude-opus-5"));
    assert.deepEqual(shippedPresetNames(dir), ["gpt-plus-flash"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a policy name that is a path or an unrendered placeholder is refused", () => {
  assert.throws(() => resolvePolicy({ policyName: "../x" }), /is not a policy name/);
  assert.throws(() => resolvePolicy({ policyName: "{{POLICY}}" }), /unrendered \{\{PLACEHOLDER\}\}/);
});

test("an unknown adapter id fails at load and lists the known ids", () => {
  withProject({ override: customPolicy({ adapter: "opnai" }) }, (root) => {
    assert.throws(() => resolvePolicy({ projectRoot: root }), (err) => {
      assert.match(err.message, /Policy model 'gpt': unknown adapter 'opnai'/);
      assert.match(err.message, /Known adapters: .*openai/);
      assert.ok(err.message.startsWith(join(root, "routing-policy.yaml")));
      return true;
    });
  });
});

test("the legacy mcp:gemini-flash-server adapter id still loads", () => {
  withProject({ override: readFileSync(SHIPPED, "utf-8").replace("adapter: mcp:model-dispatch", "adapter: mcp:gemini-flash-server") }, (root) => {
    assert.equal(resolvePolicy({ projectRoot: root }).policy.name, "gpt-plus-flash");
  });
});

test("the adapter ids policy.ts accepts are exactly the ones adapters/index.ts can build", () => {
  assert.deepEqual([...KNOWN_ADAPTER_IDS].sort(), [...REGISTERED_ADAPTER_IDS].sort());
});

test("the built bridge carries no opus-only fallback", () => {
  for (const file of ["server.js", "policy.js"]) {
    assert.doesNotMatch(readFileSync(join(SERVER_DIR, "dist", file), "utf-8"), /opus-only/, file);
  }
});

test("sha256 is the hash of the policy file's bytes", () => {
  const r = resolvePolicy({ policyName: "gpt-plus-flash" });
  assert.equal(r.sha256, createHash("sha256").update(readFileSync(SHIPPED)).digest("hex"));
});

test("loadPolicyFromPath still names a missing file", () => {
  assert.throws(() => loadPolicyFromPath("/nonexistent/p.yaml"), /Policy file not found: \/nonexistent\/p\.yaml/);
});

test("verify-setup's observePolicy picks the same file as resolvePolicySource", () => {
  assert.equal(VERIFY_DEFAULT_POLICY, DEFAULT_POLICY_NAME);
  const cases = [
    { override: customPolicy() },
    { projectJson: { default_policy: "gpt-seat-plus-flash" } },
    {},
  ];
  for (const opts of cases) {
    withProject(opts, (root) => {
      const bridge = resolvePolicySource({ projectRoot: root });
      const setup = observePolicy(PLUGIN_ROOT, root);
      assert.equal(setup.source, bridge.source, JSON.stringify(opts));
      assert.equal(setup.path, bridge.path, JSON.stringify(opts));
      assert.equal(setup.name, resolvePolicy({ projectRoot: root }).policy.name, JSON.stringify(opts));
    });
  }
});

test("verify-setup's observePolicy reports every project.json the resolver refuses", () => {
  assert.equal(VERIFY_POLICY_NAME_RE.source, POLICY_NAME_RE.source);
  const cases = [
    "{bad",
    JSON.stringify({ default_policy: "{{POLICY}}" }),
    JSON.stringify({ default_policy: 7 }),
    JSON.stringify({ default_policy: "../gpt-plus-flash" }),
  ];
  for (const projectJson of cases) {
    withProject({ projectJson }, (root) => {
      let bridgeError = null;
      try {
        resolvePolicySource({ projectRoot: root });
      } catch (err) {
        bridgeError = err.message;
      }
      assert.ok(bridgeError, `the resolver accepted ${projectJson}`);
      const setup = observePolicy(PLUGIN_ROOT, root);
      assert.equal(setup.source, "invalid-project-json", projectJson);
      assert.equal(setup.path, join(root, ".sdlc", "project.json"), projectJson);
      assert.equal(setup.usesOpenAiKey, null, projectJson);
      // Same wording up to the parser's own message, which differs between engines only in detail.
      assert.equal(setup.error.split(": ")[0], bridgeError.split(": ")[0], projectJson);
    });
  }
  withProject({ projectJson: JSON.stringify({ default_policy: "" }) }, (root) => {
    assert.equal(resolvePolicySource({ projectRoot: root }).source, "builtin-default");
    assert.equal(observePolicy(PLUGIN_ROOT, root).source, "builtin-default");
  });
});

test("preflight_dispatch says which policy file won", async () => {
  const root = project({ override: customPolicy() });
  const bridge = await connectBridge();
  try {
    const out = await bridge.callTool("preflight_dispatch", {
      auth_mode: "vendor",
      policy_name: "gpt-plus-flash",
      project_root: root,
    });
    assert.equal(out.policy.name, "my-custom");
    assert.equal(out.policy.source, "project-override");
    assert.equal(out.policy.path, join(root, "routing-policy.yaml"));
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});
