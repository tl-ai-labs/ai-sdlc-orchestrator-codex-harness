/**
 * Every shipped brief has the section headings docs/brief-template.md
 * documents — otherwise a run starts, spends tokens, and produces a thin
 * requirements document. Headings read from the template, not hardcoded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The headings the template defines, in order.
 *
 * The template documents them under its "Section set" marker; everything above
 * that marker is guidance for the author, not part of the contract. Briefs
 * qualify their headings in practice ("## Scope (vertical slice — five
 * modules)"), so the check is prefix-based rather than exact.
 */
function requiredHeadings() {
  const template = readFileSync(join(ROOT, "docs", "brief-template.md"), "utf8");
  const sectionSet = template.split("## Section set")[1];
  assert.ok(sectionSet, "brief-template.md must keep its 'Section set' marker");
  return sectionSet
    .split("\n")
    .filter((line) => /^## /.test(line))
    .map((line) => line.replace(/^## /, "").trim());
}

const briefs = readdirSync(join(ROOT, "examples"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ name: entry.name, path: join(ROOT, "examples", entry.name, "brief.md") }))
  .filter((entry) => existsSync(entry.path));

test("the repo ships at least one brief to run against", () => {
  assert.ok(briefs.length > 0, "examples/ must contain at least one <name>/brief.md");
});

for (const brief of briefs) {
  test(`examples/${brief.name}/brief.md carries every section the pipeline reads`, () => {
    const text = readFileSync(brief.path, "utf8");
    const headings = text.split("\n").filter((line) => /^## /.test(line)).map((l) => l.replace(/^## /, "").trim());

    for (const required of requiredHeadings()) {
      assert.ok(
        headings.some((h) => h.startsWith(required)),
        `missing section "${required}" — the requirements phase expects it`
      );
    }

    assert.match(text, /^# Project Brief — .+/m, "the brief must open with a titled Project Brief heading");
    assert.ok(
      text.split("\n").some((line) => /^### /.test(line)),
      "Scope must be broken into numbered modules; the orchestrator decomposes them into task packets"
    );
  });

  test(`examples/${brief.name}/brief.md states acceptance criteria a reviewer can run`, () => {
    // Gate 4 evaluates against these. Qualitative criteria ("well tested")
    // give the gate nothing to check, so require an enumerated list.
    const criteria = readFileSync(brief.path, "utf8").split(/^## Acceptance criteria/m)[1] || "";
    const numbered = criteria.split("\n").filter((line) => /^\d+\.\s+\S/.test(line));
    assert.ok(numbered.length >= 5, `expected at least 5 numbered acceptance criteria, found ${numbered.length}`);
  });
}
