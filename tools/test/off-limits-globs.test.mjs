/**
 * A `**` folder in a Gate 0 allowlist or an off-limits list matches zero or more folders, and a leading `./` names
 * the project root, so the patterns a person writes cover the files they mean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freezeContract } from "../../plugin/scripts/write-contract.mjs";
import { decideCall } from "../../plugin/scripts/lib/write-guard.mjs";
import { firstMatch, hardcodedHit, matchGlob } from "../../plugin/scripts/lib/off-limits.mjs";

test("the glob dialect: ** as a folder name takes zero or more folders, and ./ is the project root", () => {
  const cases = [
    ["src/a.ts", "src/**/*.ts", true],
    ["src/x/y/a.ts", "src/**/*.ts", true],
    ["src/a.js", "src/**/*.ts", false],
    ["lib/a.ts", "src/**/*.ts", false],
    ["README.md", "**/*.md", true],
    ["docs/a.md", "**/*.md", true],
    ["a.mdx", "**/*.md", false],
    ["a/b", "a/**/b", true],
    ["a/x/y/b", "a/**/b", true],
    ["ab", "a/**/b", false],
    ["x", "**/**/x", true],
    ["src/a.ts", "./src/**", true],
    ["src/a.ts", "./src/*.ts", true],
    ["src/a.ts", "././src/a.ts", true],
    ["./src/a.ts", "src/**", true],
    ["README.md", "./README.md", true],
    ["src/a/b.ts", "src/**", true],
    ["src", "src/**", false],
    ["src/a/b.ts", "src/*", false],
    ["axyb", "a**b", true],
    ["ax/yb", "a**b", true],
    ["docs/a.md", "docs/?.md", true],
  ];
  for (const [path, pattern, want] of cases) assert.equal(matchGlob(path, pattern), want, `${path} ~ ${pattern}`);
  assert.ok(matchGlob("SRC/A.TS", "src/**/*.ts", { ci: true }));
  assert.ok(!matchGlob("SRC/A.TS", "src/**/*.ts"));
  assert.equal(firstMatch("secrets/k.pem", ["docs/**", "**/secrets/**"]), "**/secrets/**");
  assert.equal(firstMatch("key.pem", ["**/*.pem"]), "**/*.pem");
  assert.equal(hardcodedHit(".env"), ".env");
  assert.equal(hardcodedHit("a/b/.git/config"), ".git/**");
});

/** A git project frozen for run r1, with `project.json` defaults when given. */
function frozen(allowlist, { offLimits = [], projectDefaults } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "globs-"));
  mkdirSync(join(dir, ".git"));
  if (projectDefaults) {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ off_limits_default: projectDefaults }));
  }
  freezeContract({ projectRoot: dir, runId: "r1", allowlist, offLimits, strict: true });
  return dir;
}

const add = (dir, path) => decideCall({ cwd: dir, tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` } });

test("a Gate 0 allowlist written with **/ or ./ allows the run's own writes at the top folder", () => {
  const dir = frozen(["src/**/*.ts", "**/*.md", "./lib/**"]);
  try {
    for (const path of ["src/a.ts", "src/x/b.ts", "README.md", "docs/a.md", "lib/x.js", "lib/a/b.js"]) {
      assert.equal(add(dir, path).decision, "allow", path);
    }
    for (const path of ["src/a.js", "app/a.ts", "package.json"]) {
      const r = add(dir, path);
      assert.equal(r.decision, "deny", path);
      assert.match(r.reason, /is not in the confirmed allowlist for run r1/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an off-limits pattern written with **/ or ./, from Gate 0 or project.json, refuses at the top folder too", () => {
  const dir = frozen(["**"], { offLimits: ["**/secrets/**", "./config/prod.json"], projectDefaults: ["**/*.pem"] });
  try {
    for (const [path, rule] of [["secrets/k.txt", "**/secrets/**"], ["app/secrets/k.txt", "**/secrets/**"], ["config/prod.json", "./config/prod.json"], ["key.pem", "**/*.pem"]]) {
      const r = add(dir, path);
      assert.equal(r.decision, "deny", path);
      assert.match(r.reason, new RegExp(`matches off-limits pattern "${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), path);
    }
    assert.equal(add(dir, "config/dev.json").decision, "allow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
