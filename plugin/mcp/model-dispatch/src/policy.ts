/**
 * Policy resolver, loader and validator. The bridge and run.mjs (through
 * dist/policy.js) both resolve here, so the policy a run prices and caps is
 * the one its dispatches route by. First hit wins:
 *   1. an explicit file (the bridge's `policy_path`)
 *   2. <projectRoot>/routing-policy.yaml
 *   3. a named preset (--policy / `policy_name`)
 *   4. <projectRoot>/.sdlc/project.json `default_policy`
 *   5. DEFAULT_POLICY_NAME
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Policy, ModelConfig } from "./types.js";
import { KNOWN_ADAPTER_IDS, ANTHROPIC_ADAPTER_IDS } from "./adapters/ids.js";
import { isListedModel } from "./prices.js";

export { KNOWN_ADAPTER_IDS, ANTHROPIC_ADAPTER_IDS };

export const PLUGIN_POLICY_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "config",
  "policies"
);

export const DEFAULT_POLICY_NAME = "gpt-plus-flash";
export const PROJECT_POLICY_FILE = "routing-policy.yaml";

// Prompts render the name unquoted (`--policy={{POLICY}}`), and it becomes a
// file name, so no separators and no shell metacharacters.
export const POLICY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type PolicySource = "path" | "project-override" | "flag" | "project-default" | "builtin-default";

export interface PolicyQuery {
  policyName?: string;
  projectRoot?: string;
  policyPath?: string;
}

export interface PolicyLocation {
  source: PolicySource;
  /** Absolute path of the file that won. */
  path: string;
  /** The name the caller or the project asked for, even when another file won. */
  requestedName: string | null;
}

export interface ResolvedPolicy extends PolicyLocation {
  policy: Policy;
  /** Hex sha256 of the file's bytes. */
  sha256: string;
}

function given(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function presetPath(name: string, label: string): string {
  if (!POLICY_NAME_RE.test(name)) {
    const hint = /\{\{.*\}\}/.test(name) ? " It is an unrendered {{PLACEHOLDER}}: the command was never filled in." : "";
    throw new Error(
      `Policy name '${name}' (${label}) is not a policy name: use letters, digits, '.', '_' and '-' only.${hint}`
    );
  }
  return join(PLUGIN_POLICY_DIR, `${name}.yaml`);
}

/** `default_policy` from <projectRoot>/.sdlc/project.json, or null when unset. A trailing .yaml is dropped. */
export function readProjectDefaultPolicy(projectRoot: string): string | null {
  const path = join(projectRoot, ".sdlc", "project.json");
  if (!existsSync(path)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: any) {
    throw new Error(`${path} is not valid JSON: ${err?.message ?? err}. Fix or delete the file.`);
  }
  const value = parsed?.default_policy;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`${path}: default_policy must be a policy name (a string), got ${JSON.stringify(value)}.`);
  }
  return value.replace(/\.ya?ml$/, "") || null;
}

/** Which file a query resolves to. Does not read the policy itself. */
export function resolvePolicySource(opts: PolicyQuery): PolicyLocation {
  const flagName = given(opts.policyName);
  const policyPath = given(opts.policyPath);
  if (policyPath) return { source: "path", path: resolve(policyPath), requestedName: flagName };

  const projectRoot = given(opts.projectRoot) ? resolve(opts.projectRoot!) : null;
  if (projectRoot) {
    const override = join(projectRoot, PROJECT_POLICY_FILE);
    if (existsSync(override)) return { source: "project-override", path: override, requestedName: flagName };
  }
  if (flagName) return { source: "flag", path: presetPath(flagName, "--policy"), requestedName: flagName };

  const projectDefault = projectRoot ? readProjectDefaultPolicy(projectRoot) : null;
  if (projectDefault) {
    return {
      source: "project-default",
      path: presetPath(projectDefault, "from .sdlc/project.json default_policy"),
      requestedName: projectDefault,
    };
  }
  return { source: "builtin-default", path: presetPath(DEFAULT_POLICY_NAME, "built-in default"), requestedName: null };
}

/** Preset names in the plugin's policy directory that a run can use: no Anthropic adapter, and a GPT driver when one is named. */
export function shippedPresetNames(dir: string = PLUGIN_POLICY_DIR): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }
  return files
    .filter((f) => {
      try {
        const raw = parseYaml(readFileSync(join(dir, f), "utf-8"));
        if (!Array.isArray(raw?.models) || anthropicAdapters(raw).length > 0) return false;
        return raw.driver === undefined || isGptModel(raw.driver?.model_name);
      } catch {
        return false;
      }
    })
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
}

function notFound(location: PolicyLocation): Error {
  if (location.source === "path" || location.source === "project-override") {
    return new Error(`Policy file not found: ${location.path}`);
  }
  const name = location.requestedName ?? DEFAULT_POLICY_NAME;
  const from = location.source === "project-default" ? " (from .sdlc/project.json default_policy)" : "";
  return new Error(
    `Policy '${name}'${from} not found at ${location.path}. ` +
      `Shipped presets: ${shippedPresetNames().join(", ")}. ` +
      `For a policy of your own, save it as <project root>/${PROJECT_POLICY_FILE}: ` +
      `the plugin's policy directory is replaced on every update.`
  );
}

export function resolvePolicy(opts: PolicyQuery): ResolvedPolicy {
  const location = resolvePolicySource(opts);
  if (!existsSync(location.path)) throw notFound(location);
  const bytes = readFileSync(location.path);
  let policy: Policy;
  try {
    policy = validatePolicy(parseYaml(bytes.toString("utf-8")));
  } catch (err: any) {
    throw new Error(`${location.path}: ${err?.message ?? err}`);
  }
  return { ...location, policy, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Parses policy YAML without validating it, for callers that only read model fields. */
export function parsePolicyText(text: string): unknown {
  return parseYaml(text);
}

export function loadPolicy(opts: { policyName?: string; projectRoot?: string }): Policy {
  return resolvePolicy(opts).policy;
}

export function loadPolicyFromPath(path: string): Policy {
  return resolvePolicy({ policyPath: path }).policy;
}

/** The Anthropic adapters a policy's models name, sorted. This harness runs none. */
export function anthropicAdapters(policy: { models?: unknown }): string[] {
  const models: any[] = Array.isArray(policy?.models) ? policy.models : [];
  const ids = models.map((m) => m?.adapter).filter((a): a is string => typeof a === "string" && ANTHROPIC_ADAPTER_IDS.has(a));
  return [...new Set(ids)].sort();
}

/** The conductor runs in codex, and this harness pins it to a GPT model. */
export function isGptModel(name: unknown): boolean {
  return typeof name === "string" && /^gpt-/.test(name);
}

function validatePolicy(raw: any): Policy {
  if (!raw || typeof raw !== "object") {
    throw new Error("Policy: root must be an object");
  }
  if (typeof raw.version !== "number") {
    throw new Error("Policy: 'version' (number) required");
  }
  if (typeof raw.name !== "string") {
    throw new Error("Policy: 'name' (string) required");
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error("Policy: 'models' (non-empty array) required");
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error("Policy: 'rules' (non-empty array) required");
  }
  if (
    raw.hard_cost_cap_usd !== undefined &&
    !(typeof raw.hard_cost_cap_usd === "number" && Number.isFinite(raw.hard_cost_cap_usd) && raw.hard_cost_cap_usd > 0)
  ) {
    throw new Error("Policy: 'hard_cost_cap_usd' must be a positive number, or omitted for no cap");
  }
  for (const m of raw.models) validateModel(m);
  if (raw.driver !== undefined) validateDriver(raw.driver);
  const modelIds = new Set<string>(raw.models.map((m: ModelConfig) => m.id));
  const slotNames = validateSelect(raw, modelIds);
  // Every rule references a known model id or a declared slot; check at load
  // so a routing failure never reaches a paid dispatch.
  raw.rules.forEach((r: any, i: number) => {
    const used = r.use ?? r.default;
    if (!used) throw new Error(`Policy rule ${i}: needs 'use' or 'default'`);
    if (!modelIds.has(used) && !slotNames.has(used)) {
      const known = [...modelIds, ...slotNames].join(", ");
      throw new Error(
        `Policy rule ${i}: references unknown model id '${used}'. Known: ${known}`
      );
    }
  });
  return raw as Policy;
}

/**
 * Validate the optional `select:` block and return the slot names it declares.
 * A slot name that collides with a model id is refused: `use: <name>` would
 * be ambiguous.
 */
function validateSelect(raw: any, modelIds: Set<string>): Set<string> {
  const names = new Set<string>();
  if (raw.select === undefined) return names;
  if (typeof raw.select !== "object" || raw.select === null || Array.isArray(raw.select)) {
    throw new Error("Policy: 'select' must be a map of slot name → { default, options }");
  }
  for (const [name, slot] of Object.entries<any>(raw.select)) {
    if (modelIds.has(name)) {
      throw new Error(
        `Policy select '${name}': collides with a model id — a rule naming it would be ` +
          `ambiguous. Rename the slot or the model.`
      );
    }
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      throw new Error(`Policy select '${name}': must be an object with 'default' and 'options'`);
    }
    if (!Array.isArray(slot.options) || slot.options.length === 0) {
      throw new Error(`Policy select '${name}': 'options' (non-empty array of model ids) required`);
    }
    for (const opt of slot.options) {
      if (!modelIds.has(opt)) {
        throw new Error(
          `Policy select '${name}': option '${opt}' is not a model id in this policy. ` +
            `Known: ${[...modelIds].join(", ")}`
        );
      }
    }
    if (typeof slot.default !== "string" || !slot.options.includes(slot.default)) {
      throw new Error(
        `Policy select '${name}': 'default' must be one of its own options ` +
          `(${slot.options.join(", ")}). A default outside the option list is a routing ` +
          `target no run could ever have chosen deliberately.`
      );
    }
    names.add(name);
  }
  return names;
}

function validatePricing(pricing: any, where: string) {
  if (!pricing || typeof pricing !== "object") {
    throw new Error(`${where}: pricing must be { input, input_cached, output }`);
  }
  for (const k of ["input", "input_cached", "output"]) {
    if (typeof pricing[k] !== "number" || !Number.isFinite(pricing[k]) || pricing[k] < 0) {
      throw new Error(`${where}: pricing.${k} must be a number >= 0`);
    }
  }
}

function validateModel(m: any) {
  for (const key of ["id", "adapter", "model_name"]) {
    if (!(key in m)) throw new Error(`Policy model: missing '${key}'`);
  }
  if (!KNOWN_ADAPTER_IDS.has(m.adapter)) {
    throw new Error(
      `Policy model '${m.id}': unknown adapter '${m.adapter}'. Known adapters: ${[...KNOWN_ADAPTER_IDS].join(", ")}.`
    );
  }
  if (m.pricing !== undefined) validatePricing(m.pricing, `Policy model '${m.id}'`);
  if (m.pricing_override !== undefined && typeof m.pricing_override !== "boolean") {
    throw new Error(`Policy model '${m.id}': pricing_override must be true or false`);
  }
  if (m.pricing_override === true && m.pricing === undefined) {
    throw new Error(`Policy model '${m.id}': pricing_override: true needs a pricing block to bill`);
  }
  // Date-free on purpose: a replay prices historical events on their own day.
  if (m.pricing_override !== true && !isListedModel(m.model_name)) {
    throw new Error(
      `Policy model '${m.id}': '${m.model_name}' is not on the price list ` +
        `(plugin/mcp/model-dispatch/src/prices.ts). Add its verified price entry there, or give this ` +
        `model a pricing block with pricing_override: true.`
    );
  }
}

function validateDriver(d: any) {
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    throw new Error("Policy: 'driver' must be an object with model_name and reasoning.effort");
  }
  if (typeof d.model_name !== "string" || d.model_name.length === 0) {
    throw new Error("Policy driver: 'model_name' (non-empty string) required");
  }
  if (typeof d.reasoning?.effort !== "string" || d.reasoning.effort.length === 0) {
    throw new Error("Policy driver: 'reasoning.effort' (non-empty string) required");
  }
  if (d.pricing !== undefined) validatePricing(d.pricing, "Policy driver");
  if (d.pricing_override !== undefined && typeof d.pricing_override !== "boolean") {
    throw new Error("Policy driver: pricing_override must be true or false");
  }
  if (d.pricing_override === true && d.pricing === undefined) {
    throw new Error("Policy driver: pricing_override: true needs a pricing block to bill");
  }
  if (d.pricing_override !== true && !isListedModel(d.model_name)) {
    throw new Error(
      `Policy driver: '${d.model_name}' is not on the price list (plugin/mcp/model-dispatch/src/prices.ts), ` +
        `so the conductor's cost could not be modeled. Add its verified price entry there, or give the driver ` +
        `block a pricing block with pricing_override: true.`
    );
  }
}

export function getModel(policy: Policy, modelId: string): ModelConfig {
  const m = policy.models.find((x) => x.id === modelId);
  if (!m) throw new Error(`Model id '${modelId}' not found in policy '${policy.name}'`);
  return m;
}
