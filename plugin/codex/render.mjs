/**
 * Renders the `{{PLACEHOLDER}}` text the model reads: the conductor prompt and
 * the playbooks. No dependencies beyond node, so the interactive start script
 * can load it from an installed plugin.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Throws on any placeholder left unrendered: a model handed `{{OUTPUT_DIR}}`
 * writes its artifacts into a folder literally named that.
 */
export function renderPrompt(template, values, label = "conductor prompt") {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
  const leftover = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`run: ${label} has unrendered placeholder(s): ${[...new Set(leftover)].join(", ")}`);
  }
  return rendered;
}

/**
 * The playbooks, rendered into `<run folder>/skills/` on both routes. Codex
 * loads `plugin/skills/<name>/SKILL.md` raw, so the model reads only these
 * copies. A file a playbook links to by a relative path is rendered beside it,
 * so the link resolves in the copy as it does in the source.
 */
export const RENDERED_SKILLS = [
  ["pipeline", join("pipeline", "SKILL.md")],
  ["brownfield-guide", join("brownfield-guide", "SKILL.md")],
  ["discovery", join("brownfield-guide", "discovery.md")],
  ["roles/architect", join("pipeline", "roles", "architect.md")],
  ["roles/senior-reviewer", join("pipeline", "roles", "senior-reviewer.md")],
  ["roles/security-reviewer", join("pipeline", "roles", "security-reviewer.md")],
];

export function renderedSkillPath(outputDir, name) {
  return join(outputDir, "skills", `${name}.md`);
}

/** The rendered playbooks in `outputDir` that a render of the plugin as it is now would change, by name. */
export function staleSkills(outputDir, values, pluginRoot = PLUGIN_ROOT) {
  const stale = [];
  for (const [name, rel] of RENDERED_SKILLS) {
    const source = join(pluginRoot, "skills", rel);
    if (!existsSync(source)) continue;
    let have = null;
    try {
      have = readFileSync(renderedSkillPath(outputDir, name), "utf-8");
    } catch {
      /* not rendered yet */
    }
    if (have !== renderPrompt(readFileSync(source, "utf-8"), values, `skills/${rel}`)) stale.push(name);
  }
  return stale;
}

export function renderSkills(outputDir, values, pluginRoot = PLUGIN_ROOT) {
  const written = [];
  for (const [name, rel] of RENDERED_SKILLS) {
    const source = join(pluginRoot, "skills", rel);
    if (!existsSync(source)) continue;
    const target = renderedSkillPath(outputDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPrompt(readFileSync(source, "utf-8"), values, `skills/${rel}`), "utf-8");
    written.push(target);
  }
  return written;
}
