import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CREATABLE_WHEN_ABSENT, HARDCODED_OFF_LIMITS, OFF_LIMITS_DEFAULT, firstMatch, hardcodedHit, matchGlob, matchesAtAnyDepth,
} from "../../plugin/scripts/lib/off-limits.mjs";

test("the always-off-limits list is exactly secrets, Codex's config, git's store and the skill scan path", () => {
  assert.deepEqual(HARDCODED_OFF_LIMITS, [".env", ".env.*", ".mcp.json", ".codex/config.toml", ".codex/auth.json", ".git/**", ".agents/**"]);
});

test("every always-off-limits pattern is also in the project default, which is longer", () => {
  const missing = HARDCODED_OFF_LIMITS.filter((p) => !OFF_LIMITS_DEFAULT.includes(p));
  assert.deepEqual(missing, [], "a path refused before a contract exists must stay refused once one does");
  assert.ok(OFF_LIMITS_DEFAULT.length > HARDCODED_OFF_LIMITS.length);
});

test("build output, other tools' rules and .sdlc/local stay in the project default only", () => {
  for (const p of ["node_modules/**", "dist/**", "build/**", ".next/**", ".sdlc/local/**", ".cursor/rules/**"]) {
    assert.ok(!HARDCODED_OFF_LIMITS.includes(p), `${p} is not refused in every session`);
    assert.ok(OFF_LIMITS_DEFAULT.includes(p), `${p} stays off-limits for a contracted run`);
  }
});

test("the harness's own output directory is not off-limits — the run writes its artifacts there", () => {
  assert.ok(!OFF_LIMITS_DEFAULT.includes(".sdlc/**"));
});

test("matching at any depth ignores case", () => {
  assert.ok(matchesAtAnyDepth("a/.ENV", ".env"));
  assert.ok(matchesAtAnyDepth("x/.Git/config", ".git/**"));
  assert.ok(matchesAtAnyDepth("/home/u/proj/.codex/Auth.json", ".codex/auth.json"));
  assert.equal(hardcodedHit("src/a.ts"), null);
  assert.equal(hardcodedHit("pkg/.Env.Production"), ".env.*");
  assert.equal(hardcodedHit(".venv/lib/site.py"), null);
});

test("a folder pattern also takes the folder's own name, so a linked worktree's .git file is refused", () => {
  assert.equal(hardcodedHit(".git"), ".git/**");
  assert.equal(hardcodedHit("pkg/.GIT"), ".git/**");
  assert.equal(hardcodedHit(".agents"), ".agents/**");
  assert.equal(hardcodedHit(".gitignore"), null);
  assert.equal(hardcodedHit(".github/workflows/ci.yml"), null);
  assert.equal(hardcodedHit("src/.gitkeep"), null);
});

test("the glob dialect: ** crosses folders, * and ? do not; case only when asked", () => {
  assert.ok(matchGlob("src/a/b.ts", "src/**"));
  assert.ok(!matchGlob("src/a/b.ts", "src/*"));
  assert.ok(matchGlob("docs/a.md", "docs/?.md"));
  assert.ok(!matchGlob("SRC/a.ts", "src/**"));
  assert.ok(matchGlob("SRC/a.ts", "src/**", { ci: true }));
  assert.ok(matchGlob("Secret Files/x", "Secret Files/**"));
  assert.equal(firstMatch("src/SECRETS/k.pem", ["docs/**", "src/secrets/**"], { ci: true }), "src/secrets/**");
  assert.equal(firstMatch("src/a.ts", "not-a-list"), null);
});

test("only the .env fixtures a fresh project needs may be created without a contract", () => {
  assert.deepEqual(CREATABLE_WHEN_ABSENT, [".env", ".env.example", ".env.test"]);
});
