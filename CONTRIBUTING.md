# Contributing

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

1. Branch off `develop`.
2. Make your change. Keep the diff focused; one topic per PR.
3. Run `npm test` from the repo root. It runs the tooling suite and then the MCP server's own, and every one of them is offline and free — no credential is read and no API call is made, so there is no reason not to run it.
4. Open a pull request. Describe what changed and why in one or two paragraphs.

## Commit messages

Sentence case, present tense, no emojis. The body wraps at 72 characters and explains *why*, not *what* — the diff shows the what. Keep them short and readable.

Do not add `Co-Authored-By:` trailers for AI assistants. The committer identity is a bot on purpose; AI-attribution trailers add noise on a public repo. This applies to all commits, whether or not a Claude Code / Codex CLI / other AI session helped author the change.

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
