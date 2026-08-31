#!/usr/bin/env node
// Single-page policy console server. Started by plugin/scripts/setup-policy.mjs;
// bound to 127.0.0.1 on a caller-chosen port; serves one HTML page plus a small
// JSON API. No framework, one npm dep (yaml).

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const POLICIES_DIR = resolve(SCRIPT_DIR, "..", "config", "policies");
const INDEX_HTML = resolve(SCRIPT_DIR, "index.html");
const INTENTS_PATH = resolve(SCRIPT_DIR, "..", "config", "intents.json");

// ── schema (mirrors plugin/policy-console/lib/policySchema.ts post-cherry-pick) ─

const PHASES = [
  { id: "requirements_analysis", label: "Requirements", note: "judgment · low volume" },
  { id: "architecture_design", label: "Design", note: "foundational · decision-bearing" },
  { id: "plan_task_packets", label: "Task planning", note: "needs full context" },
  { id: "codegen", label: "Codegen", note: "schema-driven boilerplate" },
  { id: "tests", label: "Tests", note: "scaffold-heavy" },
  { id: "docs", label: "Docs", note: "volume work" },
  { id: "senior_code_review", label: "Senior review", note: "cross-file judgment" },
  { id: "security_review", label: "Security review", note: "risk-bearing · low volume" },
  { id: "debug", label: "Debug", note: "escalates to opus at retry ≥ 2" },
];

/**
 * Brownfield intents, read from the same registry the job commands use —
 * one source, so the console's tabs can never list an intent that doesn't
 * exist (or miss one that does).
 */
const INTENTS = JSON.parse(readFileSync(INTENTS_PATH, "utf-8")).intents.map((i) => ({
  id: i.id,
  title: i.title,
}));

/**
 * Which phases the Intent matrix (plugin/skills/pipeline/SKILL.md, "Intent
 * matrix — brownfield only") marks SKIP for a given intent. Hand-synced with
 * that table — there is no machine-readable source for it yet, same
 * constraint as codegenTaskTypes' hand-sync with the policy YAML. A phase
 * missing from an intent's list here is never skipped for that intent.
 *
 * bugfix's architecture_design is conditional in the matrix ("SKIP unless
 * design-affecting"), not a flat skip — still listed here so the console
 * shows it disabled by default, with a note explaining the condition rather
 * than presenting it identically to docs/test's unconditional skip.
 */
const INTENT_SKIPPED_PHASES = {
  docs: ["architecture_design"],
  bugfix: ["architecture_design"],
  "feature-extend": [],
  "feature-new": [],
  refactor: [],
  test: ["architecture_design"],
  deps: [],
};
const CONDITIONAL_SKIP_NOTE = {
  "bugfix:architecture_design": "Skipped unless the fix is design-affecting",
};

const KNOWN_ADAPTERS = [
  "builtin-anthropic",
  "claude-cli",
  "mcp:model-dispatch",
  "antigravity-worker",
];
const ADAPTER_LABEL = {
  "builtin-anthropic": "Anthropic (Claude)",
  "claude-cli": "Anthropic (Claude Code CLI, Max subscription)",
  "mcp:model-dispatch": "Gemini — completion call",
  "antigravity-worker": "Gemini — Antigravity agent (SDK worker)",
};

const GEMINI_TIERS = ["off", "minimal", "low", "medium", "high"];
const ANTHROPIC_EFFORT_TIERS = ["off", "low", "medium", "high", "xhigh", "max"];
const SHIPPED_PRESETS = ["opus-only", "opus-plus-flash"];
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function thinkingSupport(model) {
  if (model.adapter === "mcp:model-dispatch" || model.adapter === "antigravity-worker") return GEMINI_TIERS;
  if (model.adapter === "builtin-anthropic" || model.adapter === "claude-cli") return ANTHROPIC_EFFORT_TIERS;
  return [];
}

function thinkingField(model) {
  return model.adapter === "builtin-anthropic" || model.adapter === "claude-cli" ? "effort" : "tier";
}

// ── policy readers ────────────────────────────────────────────────────

function listPolicyIds() {
  if (!existsSync(POLICIES_DIR)) return [];
  return readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort((a, b) => {
      if (a === "opus-only") return -1;
      if (b === "opus-only") return 1;
      if (a === "opus-plus-flash") return -1;
      if (b === "opus-plus-flash") return 1;
      return a.localeCompare(b);
    });
}

function readPolicyRaw(id) {
  return readFileSync(join(POLICIES_DIR, `${id}.yaml`), "utf-8");
}

function extractHeaderComment(rawYaml) {
  const firstLine = rawYaml.split("\n")[0]?.trim();
  if (firstLine?.startsWith("#")) return firstLine.replace(/^#\s*/, "");
  return undefined;
}

function hasWhen(rule) {
  return "when" in rule;
}

function resolveSlot(policy, use) {
  const slot = policy.select?.[use];
  return slot ? slot.default : use;
}

function resolvePhaseDefault(policy, phaseId) {
  for (const rule of policy.rules) {
    if (hasWhen(rule)) {
      if (rule.when.retry_count) continue;
      const phases = Array.isArray(rule.when.phase) ? rule.when.phase : rule.when.phase ? [rule.when.phase] : [];
      if (phases.includes(phaseId)) return resolveSlot(policy, rule.use);
    }
  }
  const fallback = policy.rules.find((r) => "default" in r);
  return fallback ? resolveSlot(policy, fallback.default) : undefined;
}

function resolvePhaseThinking(policy, phaseId) {
  for (const rule of policy.rules) {
    if (hasWhen(rule)) {
      if (rule.when.retry_count) continue;
      const phases = Array.isArray(rule.when.phase) ? rule.when.phase : rule.when.phase ? [rule.when.phase] : [];
      if (phases.includes(phaseId)) return rule.reasoning?.tier ?? rule.reasoning?.effort ?? "off";
    }
  }
  return "off";
}

function codegenTaskTypes(policy) {
  for (const rule of policy.rules) {
    if (hasWhen(rule) && rule.when.task_type) {
      const phases = Array.isArray(rule.when.phase) ? rule.when.phase : [rule.when.phase];
      if (phases.includes("codegen")) {
        return Array.isArray(rule.when.task_type) ? rule.when.task_type : [rule.when.task_type];
      }
    }
  }
  return undefined;
}


/**
 * Per-intent routing overrides — `{when: {phase, intent}}` rules layered on
 * top of the blanket per-phase rule. Returns `{ [intentId]: { [phaseId]:
 * modelId | null } }`; `null` means "no override, use the phase default."
 * Skipped phases (INTENT_SKIPPED_PHASES) are left `null` regardless of
 * anything in the YAML — an override on a phase that never runs for that
 * intent is dead configuration, not a state the UI should offer.
 */
function intentPhaseOverrides(policy) {
  const overrides = {};
  for (const intent of INTENTS) {
    overrides[intent.id] = {};
    for (const phase of PHASES) overrides[intent.id][phase.id] = null;
  }
  for (const rule of policy.rules) {
    if (!hasWhen(rule) || !rule.when.intent) continue;
    const phases = Array.isArray(rule.when.phase) ? rule.when.phase : rule.when.phase ? [rule.when.phase] : [];
    const intents = Array.isArray(rule.when.intent) ? rule.when.intent : [rule.when.intent];
    for (const intentId of intents) {
      if (!overrides[intentId]) continue; // an intent this console doesn't know about — ignore
      for (const phaseId of phases) {
        if (!(phaseId in overrides[intentId])) continue; // phase outside the visible PHASES list
        if (INTENT_SKIPPED_PHASES[intentId]?.includes(phaseId)) continue; // dead rule — never reached
        overrides[intentId][phaseId] = resolveSlot(policy, rule.use);
      }
    }
  }
  return overrides;
}

function debugEscalationRule(policy) {
  return policy.rules.find(
    (r) =>
      hasWhen(r) &&
      !!r.when.retry_count &&
      (Array.isArray(r.when.phase) ? r.when.phase.includes("debug") : r.when.phase === "debug"),
  );
}

function fallbackRule(policy) {
  return policy.rules.find((r) => "default" in r);
}

/**
 * Rules for phases NOT in the visible PHASES list (e.g. brownfield's
 * `discovery`, `change_plan` in `opus-plus-flash.yaml`). The console UI
 * only renders 9 phases, but the base policy may name more. Without this,
 * buildCustomPolicy iterates only PHASES and silently drops those rules
 * on save — a data-loss regression from the old TypeScript app. Skip the
 * debug-escalation rule (retry_count>=2) since it's already carried by
 * `debugEscalationRule` separately.
 */
function extraPhaseRules(policy) {
  const visible = new Set(PHASES.map((p) => p.id));
  const isDebugEscalation = (r) =>
    r.when?.retry_count &&
    (Array.isArray(r.when.phase) ? r.when.phase.includes("debug") : r.when.phase === "debug");
  return policy.rules.filter((r) => {
    if (!("when" in r) || !r.when.phase) return false;
    if (isDebugEscalation(r)) return false;
    const phases = Array.isArray(r.when.phase) ? r.when.phase : [r.when.phase];
    return phases.every((p) => !visible.has(p));
  });
}

function summarizePolicy(id, policy, headerComment) {
  const routing = {};
  const thinking = {};
  for (const phase of PHASES) {
    routing[phase.id] = resolvePhaseDefault(policy, phase.id) ?? policy.models[0]?.id ?? "";
    thinking[phase.id] = resolvePhaseThinking(policy, phase.id);
  }
  return {
    id,
    origin: SHIPPED_PRESETS.includes(id) ? "preset" : "custom",
    desc: headerComment || `${policy.models.length} models across ${policy.rules.length} routing rules.`,
    models: policy.models,
    select: policy.select,
    routing,
    thinking,
    intentOverrides: intentPhaseOverrides(policy),
    structural: {
      codegenTaskTypes: codegenTaskTypes(policy),
      debugEscalation: debugEscalationRule(policy),
      fallback: fallbackRule(policy),
      extraPhaseRules: extraPhaseRules(policy),
    },
  };
}

function loadAllPolicySummaries() {
  return listPolicyIds().map((id) => {
    const raw = readPolicyRaw(id);
    const policy = parseYaml(raw);
    return summarizePolicy(id, policy, extractHeaderComment(raw));
  });
}

// ── build (mirrors lib/buildPolicy.ts) ────────────────────────────────

function buildCustomPolicy(base, input) {
  const { select, structural } = base;
  const { models } = input;
  const rules = [];

  const intentOverrides = input.intentOverrides ?? {};

  for (const phase of PHASES) {
    if (phase.id === "debug" && structural.debugEscalation) rules.push(structural.debugEscalation);

    // Intent-specific overrides for this phase, most specific first — these
    // MUST precede the blanket phase rule below, since pickModel() returns
    // on the first matching rule. A packet with no `intent` (greenfield, or
    // an intent this policy doesn't override) falls through to the blanket
    // rule untouched. Skipped phases (INTENT_SKIPPED_PHASES) never get here
    // with a real override — intentPhaseOverrides() keeps them null.
    for (const intent of INTENTS) {
      const modelId = intentOverrides[intent.id]?.[phase.id];
      if (!modelId) continue;
      const rule = { when: { phase: phase.id, intent: intent.id }, use: modelId };
      // Inherits the phase's own thinking tier rather than exposing a
      // separate picker per intent — one more independent axis (7 intents ×
      // 9 phases × thinking tier) was more surface than this UI could stay
      // readable at. Revisit if a real policy needs it.
      const tier = input.thinking[phase.id];
      if (tier && tier !== "off") {
        const model = models.find((m) => m.id === modelId);
        rule.reasoning = model && thinkingField(model) === "effort" ? { effort: tier } : { tier };
      }
      rules.push(rule);
    }

    const rule = {
      when:
        phase.id === "codegen" && structural.codegenTaskTypes
          ? { phase: phase.id, task_type: structural.codegenTaskTypes }
          : { phase: phase.id },
      use: input.routing[phase.id],
    };
    const tier = input.thinking[phase.id];
    if (tier && tier !== "off") {
      const model = models.find((m) => m.id === input.routing[phase.id]);
      rule.reasoning = model && thinkingField(model) === "effort" ? { effort: tier } : { tier };
    }
    rules.push(rule);
  }

  // Carry through rules for phases the console UI doesn't edit — brownfield's
  // discovery / change_plan in opus-plus-flash.yaml is the concrete case. Old
  // code silently dropped these on save; a saved custom policy would then fall
  // through to the default for those phases.
  if (Array.isArray(structural.extraPhaseRules)) {
    for (const r of structural.extraPhaseRules) rules.push(r);
  }

  rules.push(structural.fallback ?? { default: models[0]?.id ?? input.routing[PHASES[0].id] });

  return {
    version: base.version,
    name: input.name,
    models,
    ...(select ? { select } : {}),
    rules,
  };
}

function renderPolicyYaml(policy, baseId) {
  const today = new Date().toISOString().slice(0, 10);
  const header = `# Customized from ${baseId} via the policy console — ${today}.\n`;
  return header + stringifyYaml(policy, { lineWidth: 0 });
}

// ── save handler (mirrors app/actions.ts) ─────────────────────────────

function validateSaveInput(input) {
  const errors = [];
  const name = (input.name ?? "").trim();

  if (!name) errors.push("Name is required.");
  else if (!NAME_PATTERN.test(name)) {
    errors.push("Name must be lowercase, filesystem-safe (letters, digits, hyphens), starting with a letter or digit.");
  }

  const existing = listPolicyIds();
  if (name && existing.includes(name)) {
    errors.push(`Name "${name}" already exists — pick a name that isn't ${existing.join(", ")}.`);
  }
  if (!existing.includes(input.baseId)) {
    errors.push(`Base policy "${input.baseId}" no longer exists on disk. Reload and pick again.`);
  }
  if (errors.length) return { errors };

  const seenIds = new Set();
  for (const m of input.models ?? []) {
    if (!m.id || seenIds.has(m.id)) errors.push(`Model id "${m.id}" is missing or duplicated in this policy's model list.`);
    seenIds.add(m.id);
    if (!KNOWN_ADAPTERS.includes(m.adapter)) {
      errors.push(`Model "${m.id}" names adapter "${m.adapter}", which has no real implementation. Known: ${KNOWN_ADAPTERS.join(", ")}.`);
    }
    if (!m.model_name?.trim()) errors.push(`Model "${m.id}" is missing a model_name.`);
    for (const k of ["input", "input_cached", "output"]) {
      if (typeof m.pricing?.[k] !== "number" || m.pricing[k] < 0) {
        errors.push(`Model "${m.id}": pricing.${k} must be a number ≥ 0.`);
      }
    }
  }
  if (errors.length) return { errors };

  const modelIds = new Set((input.models ?? []).map((m) => m.id));
  for (const phase of PHASES) {
    const chosen = input.routing?.[phase.id];
    if (!chosen || !modelIds.has(chosen)) {
      errors.push(`Phase "${phase.id}" is routed to "${chosen}", which isn't in this policy's model list.`);
    }
  }
  for (const intent of INTENTS) {
    for (const phase of PHASES) {
      const chosen = input.intentOverrides?.[intent.id]?.[phase.id];
      if (!chosen) continue; // null/undefined = no override, valid
      if (INTENT_SKIPPED_PHASES[intent.id]?.includes(phase.id)) {
        errors.push(`"${intent.id}" skips "${phase.id}" — an override here can never fire. Clear it.`);
      } else if (!modelIds.has(chosen)) {
        errors.push(`"${intent.id}" overrides "${phase.id}" to "${chosen}", which isn't in this policy's model list.`);
      }
    }
  }
  if (errors.length) return { errors };

  for (const phase of PHASES) {
    const tier = input.thinking?.[phase.id];
    if (!tier || tier === "off") continue;
    const model = (input.models ?? []).find((m) => m.id === input.routing[phase.id]);
    const supported = model ? thinkingSupport(model) : [];
    if (!supported.includes(tier)) {
      errors.push(`Phase "${phase.id}" sets thinking tier "${tier}", which "${model?.id}" doesn't support.`);
    }
  }
  return { errors, name };
}

function savePolicy(input) {
  const { errors, name } = validateSaveInput(input);
  if (errors.length) return { ok: false, errors };

  const base = parseYaml(readPolicyRaw(input.baseId));
  const policy = buildCustomPolicy(
    {
      version: base.version,
      select: base.select,
      structural: {
        codegenTaskTypes: codegenTaskTypes(base),
        debugEscalation: debugEscalationRule(base),
        fallback: fallbackRule(base),
        extraPhaseRules: extraPhaseRules(base),
      },
    },
    { ...input, name },
  );
  const yamlText = renderPolicyYaml(policy, input.baseId);
  const path = join(POLICIES_DIR, `${name}.yaml`);

  try {
    writeFileSync(path, yamlText, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false, errors: [`Name "${name}" already exists — pick a different name.`] };
    return { ok: false, errors: [`Could not write policy file: ${err?.message ?? String(err)}`] };
  }
  return { ok: true, errors: [], path, yaml: yamlText };
}

// ── http server ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { port: 3000, host: "127.0.0.1" };
  for (const a of argv) {
    if (a.startsWith("--port=")) out.port = Number(a.slice("--port=".length));
    else if (a === "--port") continue;
    else if (a.startsWith("--host=")) out.host = a.slice("--host=".length);
  }
  const i = argv.indexOf("--port");
  if (i !== -1 && argv[i + 1]) out.port = Number(argv[i + 1]);
  const j = argv.indexOf("--host");
  if (j !== -1 && argv[j + 1]) out.host = argv[j + 1];
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // Loose upper bound — a policy JSON payload should never approach 1 MB.
      if (size > 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      sendHtml(res, 200, readFileSync(INDEX_HTML, "utf-8"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/policies") {
      sendJson(res, 200, {
        policies: loadAllPolicySummaries(),
        phases: PHASES,
        adapters: KNOWN_ADAPTERS,
        adapterLabel: ADAPTER_LABEL,
        intents: INTENTS,
        intentSkippedPhases: INTENT_SKIPPED_PHASES,
        conditionalSkipNote: CONDITIONAL_SKIP_NOTE,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { ok: false, errors: ["Invalid JSON body."] });
        return;
      }
      sendJson(res, 200, savePolicy(payload));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/preview") {
      // Server-side YAML preview so the browser never has to serialize YAML
      // itself. Same code path as save, minus the write.
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { ok: false, errors: ["Invalid JSON body."] });
        return;
      }
      const { errors, name } = validateSaveInput({ ...payload, name: payload.name || "preview" });
      if (errors.length) {
        sendJson(res, 200, { ok: false, errors });
        return;
      }
      const base = parseYaml(readPolicyRaw(payload.baseId));
      const policy = buildCustomPolicy(
        {
          version: base.version,
          select: base.select,
          structural: {
            codegenTaskTypes: codegenTaskTypes(base),
            debugEscalation: debugEscalationRule(base),
            fallback: fallbackRule(base),
            extraPhaseRules: extraPhaseRules(base),
          },
        },
        { ...payload, name },
      );
      sendJson(res, 200, { ok: true, yaml: renderPolicyYaml(policy, payload.baseId) });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err?.message ?? String(err) });
  }
});

const args = parseArgs(process.argv.slice(2));
server.listen(args.port, args.host, () => {
  process.stderr.write(`policy-server: listening on http://${args.host}:${args.port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(130)));
