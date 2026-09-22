# Discovery — the brownfield read

**How this file is used.** Unlike the role files under `pipeline/roles/`, this is not a packet
instruction. Discovery is cheap local reading, so the conductor performs it directly with its own
shell and file access — no dispatch, no model spend. `SKILL.md` sends you here at step 2 (discovery
smoke) and step 3 (the real read).

Your job: read the repository, understand it well enough for downstream phases to work safely, and
write two files — a human-readable `discovery.md` and a machine-readable `baseline.json`. **Never
write into user source.** Everything you produce lands under `.sdlc/`.

Discovery is scoped to **Tier 1** — cheap local reads, roughly ten seconds. Tier 2 items (test
command confirmation, file-scope allowlist, off-limits confirmation) are collected at Gate 0, not
here. Tier 2b (the adaptive stack profile) is a separate step that runs only when triggered.

# Inputs

- `run_id` — the current run identifier (e.g. `20260812-193020-bugfix-a7f3c1`)
- `sdlc_root` — repo-relative path to `.sdlc/`
- `mode` — `first-time` (no `.sdlc/baseline/current.json` yet) or `refresh` (baseline exists,
  staleness detection needed)
- `intent_hint` (optional) — the intent the user picked, if already known

Always run from the repo root.

# Precondition — refuse on non-git repos

Before any other read:

```bash
git rev-parse --is-inside-work-tree
```

If that returns non-zero, or prints anything other than `true`, print:

> ⚠️ Brownfield mode requires a git repo for rollback anchors and change tracking.
> Please initialize one: `git init && git add -A && git commit -m 'baseline'`
> Then re-run `$mmo-codex:brownfield`.

…and stop without writing anything. Do not offer to initialize it. That is a destructive act on the
user's repository and it is not your call.

# Refresh vs first-time — decide before scanning

When `mode: refresh`, run the helper first:

```bash
node '{{PLUGIN_ROOT}}/scripts/discovery-refresh.mjs'
```

It reads `.sdlc/baseline/current.json`, compares it against the current git HEAD and stack-manifest
modification times, and prints JSON:

```json
{ "decision": "cached" | "incremental" | "full",
  "reason": "…",
  "git_head_baseline": "…",
  "git_head_current": "…",
  "delta_files": ["…"],
  "manifests_changed": ["package.json"],
  "baseline_age_commits": 4 }
```

Act on `decision`:

- **`cached`** — nothing changed materially. Copy `baseline/current.json` to
  `runs/<run-id>/baseline.json` verbatim, write a one-paragraph `discovery.md` saying "using cached
  baseline from `<ISO timestamp>`; N days old, 0 commits behind", and stop. No re-scan.
- **`incremental`** — small delta. Re-scan only the groups the delta affects: a changed stack
  manifest means redo groups 3 and 4; new AI-config files mean redo group 6. Merge into the
  existing baseline, then write both `runs/<run-id>/baseline.json` and an updated
  `baseline/current.json`.
- **`full`** — a new language appeared, the policy changed, or a refresh was forced. Redo
  everything below.

When `mode: first-time`, always do the full scan.

# The Tier 1 read groups (in order)

Sequential. Timeboxed to about ten seconds in aggregate — if a group takes noticeably longer (very
large repo, network filesystem), note it and continue.

## Group 1 — git state

```bash
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git status --short --branch
git remote -v
[ -f .gitignore ] && grep -F '.sdlc' .gitignore
```

Record `git_head` (SHA), `git_branch`, `git_dirty` (true when `git status --short` prints any
line), and `remotes` (list of `{name, url}`).

**Also record `gitignore_covers_sdlc`.** True when a root `.gitignore` exists and contains a line
matching `.sdlc/` (any of `.sdlc`, `.sdlc/`, `.sdlc/**`). When false, run artifacts under `.sdlc/`
— including `packets.json`, `changes.md`, and `backups/<file>`, which can echo the contents of
source files this run touched — are untracked but visible to `git add -A`, and a distracted commit
could push them.

## Group 2 — directory topology (bounded)

Depth-2 listing, excluding heavy directories:

```bash
find . -maxdepth 2 -type d \
  -not -path '*/node_modules*' \
  -not -path '*/.git*' \
  -not -path '*/dist*' \
  -not -path '*/build*' \
  -not -path '*/.next*' \
  -not -path '*/target*' \
  -not -path './.sdlc*' \
  | sort
```

Record the top-level layout so downstream phases can talk about `apps/api` versus `src/` correctly.

## Group 3 — stack manifests at repo root

Read whichever exist directly rather than through the shell — they are small:

- `package.json` → node / typescript / javascript. Note `dependencies` keys for framework
  detection (`@nestjs/*`, `next`, `react`, `express`, `fastify`, `svelte`, `vue`).
- `pyproject.toml` / `requirements.txt` / `Pipfile` → python. Framework hints: `django`,
  `fastapi`, `flask`.
- `go.mod` → go.
- `Cargo.toml` → rust.
- `build.gradle` / `build.gradle.kts` / `pom.xml` → java / kotlin.
- `Gemfile` → ruby.
- `composer.json` → php.
- `mix.exs` → elixir.

For each hit record `{ manifest, stack, detected_frameworks }` in `stacks`. **Multi-stack repos are
normal** — record every one, do not pick a winner.

If none exist, `stacks: []`. That is fine; the adaptive stack profile will look deeper after Gate 0
approves.

## Group 4 — test / build / run scripts

Detect the **likely** test command. Gate 0 confirms it with the user before the test phase uses it.

- `package.json` with `scripts.test` → propose `npm test` (or `pnpm test` when
  `pnpm-workspace.yaml` is present, `yarn test` when `yarn.lock` is).
- `pyproject.toml` mentioning `pytest` → propose `pytest`.
- `pytest.ini` / `tox.ini` → propose `pytest` or `tox`.
- `Makefile` with a `test:` target → propose `make test`.
- `justfile` with a `test` recipe → propose `just test`.
- Nothing matches → propose `unknown` and note in `discovery.md` that Gate 0 must ask.

Record `test_command_proposed` and `test_command_source` (the file that suggested it).

## Group 5 — docs (presence and first lines only)

Note which of these exist and read the first ~20 lines of each for orientation:

- `README*` (any capitalization or extension)
- `AGENTS.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `ARCHITECTURE.md`
- `docs/**/README*` (top-level docs subdirectories)
- ADR directories: `docs/adr/`, `docs/decisions/`, `adr/`

Record `docs_present` as a list of `{path, kind}`.

## Group 6 — AI / agent config (presence detection only)

**Presence only.** No deep parsing — no rule-glob evaluation, no MCP name heuristics.

The point of this group is coexistence: the repo may already be configured for other coding
agents, or for this one. Those files are the user's, and they are off-limits by default.

Check for presence at repo root or under matching subdirectories:

- `AGENTS.md` — agent instructions (already noted in group 5; record here too, as config)
- `.codex/` (dir), `.codex/config.toml`
- `.agents/skills/` (dir) — checked-in skills, including this harness's own if it is installed here
- `.claude/` (dir), `.claude/settings.json`, `.claude/settings.local.json`
- `CLAUDE.md`, `CLAUDE.local.md`
- `.mcp.json`
- `.cursor/` (dir) or `.cursor/rules/` (dir), `.cursorrules`
- `.aider.conf.yml`, `.aider.conf.yaml`, any `.aider*` dotfile
- `.continue/`
- `.github/copilot-instructions.md`
- `.roo/`
- `**/routing-policy.yaml` — this harness's per-repo policy override. Surface it at Gate 0: it
  silently changes routing.
- `**/gemini*.{yaml,json}` outside `node_modules/` and `dist/`

Record each hit as `{path, type}`. These default into the run's `off_limits` list unless the user
explicitly moves one into scope at Gate 0.

## Group 7 — environment file keys (names only, never values)

For each of `.env`, `.env.example`, `.env.local`, and any `.env.*`, read the file and extract
**key names only** — the left-hand side of `KEY=VALUE` lines. **Never record, log, or transmit the
value side.** This is a hard line, not a preference.

Ignore comments, blank lines, and anything that does not parse as `KEY=…`.

Record `env_keys_by_file` as `{ ".env": ["FOO", "BAR"], ".env.example": ["FOO", "BAR", "BAZ"] }`,
plus a flat de-duplicated `env_keys_all`.

Also grep source for environment-variable references, which helps credential discovery suggest
reuse later:

- `process\.env\.[A-Z_][A-Z0-9_]*`
- `os\.environ\[["'][A-Z_][A-Z0-9_]*["']\]`
- `os\.getenv\(["'][A-Z_][A-Z0-9_]*["']\)`
- `System\.getenv\(["'][A-Z_][A-Z0-9_]*["']\)`

Record `env_keys_referenced_in_code` as a de-duplicated flat list. **Names only.**

## Group 8 — source topology, monorepo, submodules, LFS

### Monorepo detection

Check for:

- `pnpm-workspace.yaml` → pnpm workspace
- `nx.json` → Nx
- `turbo.json` → Turborepo
- `lerna.json` → Lerna
- `rush.json` → Rush
- Multiple `package.json` at depth 2–3 excluding `node_modules/`: three or more with no workspace
  manifest is an "implicit multi-package repo"

When detected, list the packages — read the workspace manifest, or scan `apps/*/package.json`,
`packages/*/package.json`, `services/*/package.json`, `libs/*/package.json`. Record
`monorepo: { type, packages: [{ name, root, manifest }] }`. Derive the per-package test command
from the tool (`pnpm --filter <pkg> test`, `nx test <pkg>`, `turbo run test --filter=<pkg>`).

### Submodules

```bash
[ -f .gitmodules ] && cat .gitmodules
```

Record `submodules: [{path, url}]`. **Treated as opaque** — the write contract will never target
them. Note at Gate 0.

### Git-LFS

```bash
[ -f .gitattributes ] && grep -E '(filter=lfs|diff=lfs|merge=lfs)' .gitattributes
```

If present, record `lfs: true` and the LFS-marked patterns. Do not read those files later.

### Source entry points (best effort)

Note whether these exist: `src/index.*`, `src/main.*`, `main.py`, `cmd/*/main.go`, `app/main.py`.

### Infrastructure hints

Note presence: `Dockerfile`, `docker-compose*.yml`, `terraform/`, `.github/workflows/`,
`.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`.

## Group 9 — regulated-repo signals

Scan for markers suggesting the repo carries compliance obligations. These do not detect regulation
— that is a human call — but they tell Gate 0 to surface a warning so the user consciously confirms
that the active policy uses only compliant endpoints and that off-limits protects the sensitive
data.

Check for presence, case-insensitively:

- Root files: `SECURITY.md`, `PRIVACY.md`, `COMPLIANCE.md`, `HIPAA.md`, `SOC2.md`, `PCI.md`,
  `GDPR.md`
- Path segments under `docs/` or repo root, depth ≤ 3: `HIPAA/`, `PCI/`, `SOC2/`, `SOC-2/`,
  `regulated/`, `compliance/`
- CODEOWNERS entries mentioning `security-team`, `compliance-team`, `privacy-team`, `legal`

Record `regulated_repo_signals: [{ kind, path }]`. When the list is non-empty, add a
`## Regulated-repo signals` section to `discovery.md` naming each hit, and set
`regulated_repo_warning_required: true`.

Gate 0 reads that flag and, when true, prints verbatim:

> *"This repo appears regulated (signals: `<comma-separated kinds>`). Confirm the active policy
> uses only compliant endpoints, and that off-limits protects your regulated data folders."*

Not a blocker — the user approves or edits scope as normal.

# Off-limits — computed from what you found

Assemble `off_limits` as the union of:

- Every AI-config path from group 6
- Every environment file: `.env`, `.env.*`, `.env.local`
- Every build or generated directory found: `dist/`, `build/`, `.next/`, `target/`,
  `node_modules/`, `vendor/`, `third_party/`, and any file carrying a generated-file marker
  (`// GENERATED`, `# generated by`) in its first five lines — spot-check the likely directories
- Every submodule path
- `.git/`
- Every LFS-marked pattern from `.gitattributes`

These become the default off-limits at Gate 0, where the user can override individual entries.

# Coexistence risks — the human summary

From what groups 1 and 6 found, write a short "Coexistence risks" section in `discovery.md`:

- **Cursor rules** → *"You have Cursor rules at `<path>`. The pipeline will never touch them, but
  if Cursor's auto-lint runs on save, changes made here may trigger it."*
- **Aider config** → *"You have an Aider config. If auto-commit is enabled, running this alongside
  it may tangle git history."*
- **Custom `.mcp.json`** → *"You have `<N>` custom MCP servers registered. They stay untouched. The
  dispatcher will not call them — it uses its own bundled server."*
- **Repo-local `routing-policy.yaml`** → *"Your repo ships `routing-policy.yaml` at `<path>`. The
  policy loader picks it up automatically. Confirm this is intentional, or pass `--policy=<name>`
  at run start to use a shipped policy instead."*
- **`.sdlc/` not gitignored** (when `gitignore_covers_sdlc` is false) → *"Your `.gitignore` doesn't
  cover `.sdlc/`. Run artifacts there (packets, backups, telemetry) will be untracked but visible
  to `git add -A`. Gate 0 will offer to add `.gitignore` to this run's allowlist so the entry can
  be added as part of the run."*

These are surfaced verbatim at Gate 0.

# Writing outputs

## Per-run

Write to `.sdlc/runs/<run-id>/`:

- `baseline.json` — the machine-readable snapshot, schema below
- `discovery.md` — human-readable; sections mirror the read groups, plus `## Detected stacks`,
  `## Detected AI/agent setup`, `## Coexistence risks`, `## Proposed off-limits`

## Project-wide (only on `first-time` or a `full` refresh)

Write to `.sdlc/baseline/`:

- `current.json` — copy of the per-run baseline, kept as the living baseline
- `discovery.md` — human-readable version, updated

On an `incremental` refresh, merge the delta into `current.json` in place. The per-run
`runs/<run-id>/baseline.json` still gets its own snapshot, for provenance.

# baseline.json schema

```json
{
  "schema_version": 1,
  "plugin_version": "<from plugin/.codex-plugin/plugin.json>",
  "built_at": "<ISO-8601>",
  "run_id": "<caller-supplied>",

  "git": {
    "head": "<sha>",
    "branch": "<name>",
    "dirty": false,
    "remotes": [{ "name": "origin", "url": "…" }]
  },

  "topology": {
    "top_level_dirs": ["src", "docs", "tests"],
    "entry_points": ["src/index.ts"]
  },

  "stacks": [
    { "manifest": "package.json", "stack": "node-typescript", "detected_frameworks": ["nest"] }
  ],

  "test_command_proposed": "npm test",
  "test_command_source": "package.json#scripts.test",

  "docs_present": [
    { "path": "README.md", "kind": "readme" },
    { "path": "AGENTS.md", "kind": "agent-instructions" }
  ],

  "ai_configs_detected": [
    { "path": ".cursor/rules", "type": "cursor" },
    { "path": ".mcp.json", "type": "mcp-server" }
  ],

  "env_keys_by_file": { ".env.example": ["GEMINI_API_KEY"] },
  "env_keys_all": ["GEMINI_API_KEY"],
  "env_keys_referenced_in_code": ["GEMINI_API_KEY", "DATABASE_URL"],

  "monorepo": null,

  "submodules": [],
  "lfs": false,
  "lfs_patterns": [],

  "infra_hints": {
    "dockerfile": false,
    "docker_compose": false,
    "terraform": false,
    "github_workflows": true,
    "gitlab_ci": false
  },

  "regulated_repo_signals": [],
  "regulated_repo_warning_required": false,

  "gitignore_covers_sdlc": true,

  "off_limits_proposed": [
    ".env", ".env.*", ".cursor/**", ".mcp.json",
    ".claude/**", ".codex/**", "routing-policy.yaml",
    "node_modules/**", "dist/**", "build/**", ".git/**"
  ],

  "coexistence_notes": [
    "Cursor rules detected — untouched by default.",
    "Custom .mcp.json with 2 servers — untouched."
  ]
}
```

# Bounds and failure modes

- **Absolute timebox: 30 seconds.** If the whole scan runs noticeably longer, note it in
  `discovery.md`, write what you have, and stop. Downstream phases need a baseline to exist; do not
  wedge on a giant repo.
- **Very large repos** — when group 2 returns 100+ top-level directories, or `git ls-files | wc -l`
  exceeds 100k, switch groups 3 and 8 to sampling: read stack manifests only from the five
  most-recently-modified directories. Note the sampling in `discovery.md`.
- **Non-UTF8 files** — if a read fails, skip that file and continue. Do not crash the scan.
- **Missing git** — already refused at the precondition; this should be unreachable.

# Tier 2b — adaptive stack profile

**Runs only when triggered.** For repos on a stack this harness does not already know well.

**Trigger on any of:**

1. Group 3 detected a stack with no matching pre-authored adapter in
   `plugin/skills/pipeline/stacks/`. The shipped set is `generic.md`, `nest.md`, `python.md` — so a
   repo whose primary stack is React/Next.js, Go, Rails, Java, Rust, and so on triggers this.
2. A root `AGENTS.md` or `CLAUDE.md` declares a custom framework — grep for `custom framework`,
   `internal framework`, `bespoke framework`, `in-house framework`, or a `## Framework:` heading
   naming something unfamiliar.
3. The run explicitly asked for a profile refresh.

If none apply, skip this section. The pre-authored adapter is enough for downstream phases.

**What it does:** samples the actual repo to learn its conventions instead of assuming them from a
generic prompt. Pre-authored adapters are baselines; the learned profile wins on conflict, because
it reflects what is actually there.

## Sampling procedure

For each file kind, sample three to five files and extract patterns.

- **Controllers / handlers / routes** — grep for routing markers (`@Controller`, `@app.route`,
  `@Route`, `router.get`, `http.HandleFunc`, `class ...Controller`, `views.py`), or match filenames
  `*.controller.*`, `*.handler.*`, `*.routes.*`, `*_view.py`.
- **Services / domain classes** — grep for `class ...Service`, `@Injectable`, `class ...Repository`,
  `class ...UseCase`, or match `*.service.*`, `*_service.py`.
- **Tests** — find by runner convention: `*.spec.*`, `*.test.*`, `test_*.py`, `*_test.go`. Read one
  from each of the top two or three test directories.
- **Config validators** — grep for `Joi.object`, `z.object`, `Ajv`, `envalid`,
  `pydantic.BaseSettings`, `viper`, `koanf`.
- **ORM models / migrations** — `schema.prisma`, `models/*.py`, `entities/*.ts`, `db/migrations/*`,
  `alembic/versions/*`, `Sequelize.define`.
- **Entry points** — already noted in group 8. Read them for the bootstrap shape: which module
  wires what.

From each sample extract:

- **File naming convention** — `PascalCase.controller.ts` vs `pascal_case.py` vs `kebab-case.ts` vs
  `snake_case_controller.rb`. Note the whole shape, not just the case: a `.controller.ts` suffix and
  a `Controller` class-name suffix are different conventions.
- **Decorators / annotations** — what precedes public classes and methods. A custom
  `@Route(method, path)` is signal.
- **Import shapes** — ESM or CJS, relative or aliased (`~/`, `@/`), the typical top-of-file layout.
- **Folder structure** — one class per file, feature folders with barrel files, or a
  `handlers/`-`services/`-`dto/` split.
- **Test-runner idioms** — `describe`/`it`, bare `test(...)`, pytest fixtures, Go table-driven. Note
  how tests are named and grouped.
- **Config approach** — environment-driven with a validator, config files, a dedicated module.
- **Data layer** — which ORM, or raw SQL, or a query builder.
- **Framework-owned wiring** — how a new route registers itself: a module's `controllers` array, a
  `urls.py` entry, an `include_router` call, file-based routing. This is the step most often missed
  when adding a route, because the new file looks complete without it.

## Sampling bounds

- **At most five files per kind.** Prefer the most recently modified — older files may show
  superseded conventions.
- **Skip files over 500 lines.** Conventions are visible in smaller units.
- **Skip `test/fixtures/`, `**/__snapshots__/`, `**/generated/`.** Not authored conventions.
- **Timebox the step to 20 seconds.** If a large repo cannot be sampled in that time, record what
  you found and note the limit in the profile.

## Output — `.sdlc/baseline/stack-profile.md`

```markdown
# Stack profile — learned from repo scan

## Language & runtime
<one paragraph — versions, module system, notable strict-mode settings>

## Framework
<detected framework(s), or "custom in-house — call it '<name>'">

## Conventions detected

### File naming
- <specific pattern, with one or two real filenames as examples>

### Handler / controller shape
<snippet from a real file — 5-15 lines showing the pattern>

### Service shape
<same>

### Test shape
<same>

### Config
<how environment and config are loaded and validated>

### Data layer
<ORM, raw SQL, or query builder — with a real snippet>

### Framework-owned wiring
<how a new route registers — with a real example>

## Sample files inspected
- <path> (kind: controller)
- <path> (kind: service)

## Notes for downstream codegen
- <specific tips for producing code that matches this repo's style>
```

Real snippets are the point. Codegen packets receive this profile verbatim and pattern-match on the
snippets; prose descriptions alone are much weaker.

## Downstream consumption

The packet planner receives both the pre-authored adapter fragment, when one matches, and this
profile. When they disagree the profile wins. Both are appended to codegen packet inputs, with the
profile marked authoritative.

## Freshness

The profile is cached at `.sdlc/baseline/stack-profile.md` and reused across runs. Rebuild it when:

- A stack manifest changed and `discovery-refresh.mjs` returned `full`
- A profile refresh was explicitly requested
- More than ten successful runs have elapsed since it was last built

# Never

- Read the value side of any environment file. Names only, ever.
- Modify any file outside `.sdlc/`.
- Send user source code to model dispatch from here. That is the packet planner's job later, and it
  routes through `plugin/scripts/dispatch-sanitize.mjs`.
- Follow symlinks pointing outside the repo root.
- Write to the repo to make a read easier — discovery is read-only over user files, without
  exception.
