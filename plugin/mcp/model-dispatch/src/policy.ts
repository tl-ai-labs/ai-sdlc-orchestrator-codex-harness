/**
 * Policy loader & validator. Precedence:
 *   1. --policy=<name> (handled upstream)
 *   2. <projectRoot>/routing-policy.yaml
 *   3. plugin/config/policies/<name>.yaml
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Policy, ModelConfig } from "./types.js";

const PLUGIN_POLICY_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "config",
  "policies"
);

export function loadPolicy(opts: {
  policyName?: string;          // e.g. "opus-only"
  projectRoot?: string;         // for project-level override
}): Policy {
  // 1. Project override
  if (opts.projectRoot) {
    const override = join(opts.projectRoot, "routing-policy.yaml");
    if (existsSync(override)) {
      return validatePolicy(parseYaml(readFileSync(override, "utf-8")));
    }
  }
  // 2. Named preset
  const name = opts.policyName ?? "opus-only";
  const presetPath = join(PLUGIN_POLICY_DIR, `${name}.yaml`);
  if (!existsSync(presetPath)) {
    throw new Error(
      `Policy '${name}' not found at ${presetPath}. ` +
        `Available: opus-only, opus-plus-flash. ` +
        `Add your own by dropping a YAML in ${PLUGIN_POLICY_DIR}.`
    );
  }
  return validatePolicy(parseYaml(readFileSync(presetPath, "utf-8")));
}

export function loadPolicyFromPath(path: string): Policy {
  if (!existsSync(path)) throw new Error(`Policy file not found: ${path}`);
  return validatePolicy(parseYaml(readFileSync(path, "utf-8")));
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
  for (const m of raw.models) validateModel(m);
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

function validateModel(m: any) {
  for (const key of ["id", "adapter", "model_name", "pricing"]) {
    if (!(key in m)) throw new Error(`Policy model: missing '${key}'`);
  }
  for (const k of ["input", "input_cached", "output"]) {
    if (typeof m.pricing[k] !== "number") {
      throw new Error(`Policy model '${m.id}': pricing.${k} must be number`);
    }
  }
}

export function getModel(policy: Policy, modelId: string): ModelConfig {
  const m = policy.models.find((x) => x.id === modelId);
  if (!m) throw new Error(`Model id '${modelId}' not found in policy '${policy.name}'`);
  return m;
}
