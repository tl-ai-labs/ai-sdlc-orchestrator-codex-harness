# Contributing

## In scope

- **Bug fixes** in the setup wizard, report tool, or plugin code.
- **Documentation improvements** — typos, unclear phrasing, additional troubleshooting entries.
- **Additional policies** under `plugin/config/policies/`. Include a short comment header describing what the policy demonstrates and what keys it needs.
- **Portability fixes** for Windows/WSL, non-mac Linux distributions, or other environments.

## Discuss first

- Wholesale rewrites of the driver/conductor or the state machine.
- New model adapters — review welcome, but the shipped adapters cover the shipped policies. Additional adapters add dependency weight and maintenance surface.
- Changes that add reporting or telemetry surface without a corresponding entry in `docs/methodology.md`.

Open an issue before writing a large PR.

## Branching model

Two long-lived branches, one direction:

- **`main`** — release / stable. Every commit on `main` is assumed to be a working release. Direct pushes are not allowed. `main` only receives merges from `develop` — one PR per release cut.
- **`develop`** — integration. Every feature branch lands here first. Point-in-time snapshots may be broken; that is what `develop` is for. When a batch of features is ready to ship, a single `develop → main` PR promotes them.

Feature and fix branches:

- `feat/<short-name>` — new features, new adapters, new policies.
- `fix/<short-name>` — bug fixes.
- `docs/<short-name>` — doc-only changes.
- `chore/<short-name>` — plumbing, tooling, refactors with no user impact.

All of the above open PRs targeting **`develop`**, never `main` directly.

## How to submit

1. Fork the repo (or branch directly if you have write access), create a feature branch off `develop`.
2. Make your change. Keep the diff focused; one topic per PR.
3. Run `npm test` from the repo root. It runs the tooling suite and then the MCP server's own, and both are offline and free: no credential is read and no API call is made. The tooling suite needs root `npm ci` and the server built once (`npm ci && npm run build` in `plugin/mcp/model-dispatch`, the same steps CI runs). The table lists what keeps it off your machine's own state.

   | Piece | What it does |
   |---|---|
   | `tools/test/lib/stand-ins.mjs` | Preloaded by `npm test`. Puts stand-in `codex`, `gcloud` and `npm` first on `PATH` and points `CODEX_HOME` at a temporary directory, so your `~/.codex` is never read or written. |
   | `tools/test/lib/sandbox.mjs` | `codexSandbox()` gives a test its own temporary `HOME` and `CODEX_HOME`. The setup-wizard tests run inside one. |
   | `tools/test/setup.test.mjs` | Runs the wizard's policy checks from a temporary copy of `tools/setup.mjs` and `plugin/`, so the policy a test pins never lands in your checkout's `.sdlc/project.json`. |
   | `tools/test/offline.test.mjs` | Fails when a root test runs `codex`, `gcloud` or a script that does, outside the stand-ins. |
   | `tools/test/node-floor.test.mjs` | Holds every `package.json` to one `engines.node` floor, CI to that Node major, and every locked package to that floor. |
4. Run `node tools/setup.mjs` on a clean clone to verify it still passes. Unlike `npm test`, it uses your real `codex`: its last step registers the bridge in `~/.codex/config.toml`.
5. If you touched the plugin code, run a full pass locally and confirm the report still renders sensibly. For a run in a codex session, install your branch first: [Test a branch in a codex session](#test-a-branch-in-a-codex-session).
6. Open a pull request. Describe what changed and why in one or two paragraphs.

## Test a branch in a codex session

A codex session never runs your checkout. `codex plugin add` copies `plugin/` (with whatever `dist/` and `node_modules/` it holds) into `$CODEX_HOME/plugins/cache/tilicho-ai-labs/mmo-codex/<version>/`, and the session runs that copy until you add the plugin again. A copy installed before your branch runs the older code: the 0.1.0 install from the public marketplace predates the cost cap, the write hook and the session-model check.

From the root of your checkout, on the branch under test, build the bridge and look at the
registered marketplaces:

```bash
node plugin/codex/verify-setup.mjs --fix --project-root "$(pwd)"
codex plugin marketplace list
```

When `tilicho-ai-labs` is listed with a root other than this checkout (the GitHub URL, or another
clone), remove it first: `marketplace add` refuses a second source under the same name.

```bash
codex plugin marketplace remove tilicho-ai-labs
```

Then install from the checkout:

```bash
codex plugin marketplace add "$(pwd)"
codex plugin add mmo-codex@tilicho-ai-labs
```

| Step | Why |
|---|---|
| `verify-setup.mjs --fix` | Builds the bridge in the checkout, so the copy `codex plugin add` makes carries a current `dist/` and its `node_modules/`. |
| `marketplace add "$(pwd)"` | Registers this checkout as the marketplace, from `.agents/plugins/marketplace.json`. |
| `plugin add` | Replaces the cached copy with this branch's `plugin/`. |

Check the copy, then start codex on the driver pin, with the sandbox the bridge's pipes need:

```bash
codex plugin list
node "$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/tilicho-ai-labs/mmo-codex/*/ | tail -1)codex/verify-setup.mjs" --project-root "$(pwd)"
codex -s danger-full-access -m gpt-5.6-terra -c model_reasoning_effort="high"
```

`codex plugin list` shows `mmo-codex@tilicho-ai-labs` with the branch's version and this checkout's `plugin/` as its source. The copy's check reports no `mcp-build-stale` warning. At startup, codex asks about the plugin's write hook: "Trust all and continue" trusts it, and brownfield runs need that.

After every pull or edit, run `verify-setup.mjs --fix` and `codex plugin add mmo-codex@tilicho-ai-labs` again: nothing else refreshes the copy. To go back to the released plugin, remove the marketplace and add the GitHub one again, as [INSTALL.md](INSTALL.md) shows.

## Commit messages

Sentence case, present tense, no emojis. The body wraps at 72 characters and explains *why*, not *what* — the diff shows the what. Keep them short and readable.

Do not add `Co-Authored-By:` trailers for AI assistants. The committer identity is a bot on purpose; AI-attribution trailers add noise on a public repo. This applies to all commits, whether or not a Codex CLI / other AI session helped author the change.

## Code style

The tooling scripts under `tools/` (`setup.mjs`, the `report.mjs` wrapper, and the tests beside them in `tools/test/`) are plain ES modules. No TypeScript there, no build step; keep them that way so someone can read and modify them without a compiler.

The same goes for `plugin/scripts/` and `plugin/codex/`, and there the reason is stronger than preference: they have to run from an installed plugin, whose cache is a copy of `./plugin` with no `tools/` directory and no root `node_modules/`. Anything they import has to be a Node builtin, another file inside the plugin, or the bridge's build in `plugin/mcp/model-dispatch/dist/`, which `verify-setup.mjs --fix` builds inside the installed copy. `report.mjs` and the `lib/` files it imports use builtins only, so a report renders even before the bridge is built. `run.mjs`, `start-run.mjs`, `dispatch.mjs`, `write-manifest.mjs` and `collect-driver-usage.mjs` import the built bridge, so they need that build. Their tests still live in `tools/test/`, where `npm test` picks them up — a test file may import from `plugin/scripts/`, but not the other way round.

The MCP server (`plugin/mcp/model-dispatch/`) is TypeScript with a build step. Follow the existing conventions in that directory.

There is one Python file, `plugin/mcp/model-dispatch/worker/gemini_worker.py`, because the Antigravity SDK it drives is a Python package and there is no other way to reach it. It is deliberately the only one, and it is only ever installed on machines that opted into the agent path — a harness that quietly required Python of everyone would be a worse trade than the feature is worth. Keep it that way: new work belongs in TypeScript unless it, too, can only be done from Python.

## Writing style

The user-facing docs (`README.md`, `docs/*.md`, this file) and the source comments and docstrings under `plugin/` and `tools/` follow the same voice conventions. They are held by `tools/test/style.test.mjs`, which runs as part of `npm test`.

**User-facing docs**

- Second person, present tense. `You configure X in Y`, never `the user should configure X in Y`.
- Statement of fact. Not narrative. Not `we explored`, not `as demonstrated by`, not `here's how`.
- No AI-slop vocabulary. The banned set is `seamless`, `powerful`, `leverage`, `unlock`, `elegant`, `production-grade`, `battle-tested`, `robust`, `thoughtful`, `graceful`, `as demonstrated`, `in summary` (plus their common inflections). The style test greps for every one of them.
- Tables over prose for reference material. Config keys, env vars, failure modes, phase lists — table first; use prose only where a table cannot carry the meaning.
- Any code block a reader might run has a real command, real path, real env var. No `<placeholder>` unless it is labelled and immediately explained.

**Source comments and docstrings**

- Default to no comment. Only write one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.
- Do not explain what the code does — a well-named identifier already does that.
- Do not write essay-length block comments. If you find yourself typing "WHY THIS EXISTS / WHAT IT BROKE / THE FIX", that belongs in `docs/architecture.md`, not above a function.
- Do not embed incident narratives ("this broke on 2026-08-04…") in the code. They belong in the commit message and the PR description.
- The slop-word ban applies to comments and docstrings too.

**Do-not-touch surfaces.** `SETUP.md` and everything under `plugin/{commands,agents,skills}/` are Codex-instruction files where `the user` is the correct third-person reference — those files describe what the user's experience should be to another agent that will drive it. The style test excludes these paths on purpose. Historical records (`docs/walkthroughs/`, `examples/*/passes/`) are also excluded.

Codex CLI sessions see the same rules in [AGENTS.md](AGENTS.md), which lives at the repo root so it loads automatically at session start.

## Maintainer skills

Two Codex skills live under `.agents/skills/` for whoever works on this repo. They are not packaged with the plugin and never reach an install.

| Skill | Invoke | What it does |
|---|---|---|
| `house-style` | `$house-style` | Sweeps the writing conventions above across the in-scope files, applies the fixes, re-runs `npm test`. |
| `contribution-flow` | `$contribution-flow` | The branching model, commit and PR-title rules, squash-merge policy, and the release-cut recipe, in the form an agent follows before touching a branch. |

That directory is also where `verify-setup.mjs --fix` writes symlinks to the shipped skills in `plugin/skills/`. Those links are generated and gitignored; the two directories above are tracked source. `uninstall-cleanup.mjs` removes only the symlinks, so cleaning up after the plugin leaves them in place.
