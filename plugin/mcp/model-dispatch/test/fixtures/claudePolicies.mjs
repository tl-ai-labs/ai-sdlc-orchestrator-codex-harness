// The Claude harness's policies, kept outside the plugin as test data: this harness ships and runs none of them.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicyFromPath } from "../../dist/policy.js";

export const CLAUDE_POLICY_DIR = fileURLToPath(new URL("../../../../../tools/test/fixtures/policies/claude/", import.meta.url));

export const claudePolicyPath = (name) => join(CLAUDE_POLICY_DIR, `${name}.yaml`);

export const claudePolicy = (name) => loadPolicyFromPath(claudePolicyPath(name));
