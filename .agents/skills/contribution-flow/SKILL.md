---
name: contribution-flow
description: Follow this repo's contribution rules — branching (main/develop, feat/fix/docs/chore branches), conventional commits, PR flow, squash-merge policy, post-merge develop sync, and agent-alone guardrails. Invoke on "$contribution-flow", "before I commit", "before I push", "before I PR", "how do I merge this", or before any git operation that touches a branch, a shared commit, or a PR.
---

This repo publishes an open-source Codex CLI plugin. Every commit on `main` reaches end users the next time they run `codex plugin marketplace upgrade`. Sloppy history on `main` is a shipped defect — that is why the rules below matter.

You are the coding agent working on this repo, and you are the enforcement layer for these rules. GitHub checks the PR title and runs the tests; everything else below is on you. Read the whole file before your first git action of a task.

## Branching model

Two long-lived branches, one direction. The human-readable version is [CONTRIBUTING.md](../../../CONTRIBUTING.md#branching-model).

| Branch | Role | Accepts merges from |
|---|---|---|
| **`main`** | Release. Every commit is assumed to be a working release. | `develop` only, one PR per release cut. Never a feature branch directly. |
| **`develop`** | Integration. Point-in-time snapshots may be broken; that is what develop is for. | Any feature/fix/docs/chore branch. |

Feature branches:

| Prefix | Use for |
|---|---|
| `feat/<short-name>` | New features, new adapters, new policies. |
| `fix/<short-name>` | Bug fixes. |
| `docs/<short-name>` | Doc-only changes. |
| `chore/<short-name>` | Plumbing, tooling, refactors with no user impact. |

Names are kebab-case, two to four words, descriptive. `feat/policy-picker`, not `feat/PolicyPickerFinalV2Attempt3`.

Rules:

- Feature, fix, docs and chore branches always target **`develop`**. Never `main`.
- The only PR that targets `main` is a `develop → main` promotion, opened when cutting a release.
- Never `git push` directly to `main` or `develop`. Every change arrives through a merged PR.
- Never `git push --force` on `main` or `develop`. Force-push on your own feature branch is fine before review starts.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks. Fix the underlying issue.

## Conventional commits

Commit subjects and PR titles must parse as `type(scope): subject`. `.github/workflows/pr-title.yml` rejects a PR whose title does not.

| Type | Use for |
|---|---|
| `feat` | New feature or capability. |
| `fix` | Bug fix. |
| `docs` | Documentation-only change. |
| `chore` | Plumbing, tooling, dependency bump, config. |
| `refactor` | Restructure without changing behavior. |
| `test` | Tests only. |
| `perf` | Performance. |
| `build` | Build system or packaging. |
| `ci` | CI configuration. |
| `style` | Formatting only. |
| `revert` | Revert a previous commit. |

`scope` is optional but preferred — the module or area touched. From this repo's history: `fix(telemetry)`, `docs(verification)`, `feat(p3)`, `fix(setup)`, `feat(commands)`.

Subject rules, matching the workflow's `subjectPattern` (`^(?![A-Z]).+[^.]$`):

- Lowercase first word after the `type(scope):` prefix. The workflow rejects a capital.
- No trailing period. The workflow rejects one.
- Present tense, imperative: `add X`, `fix Y`, `document Z`. Not `added`, `adds`.
- 72 characters or fewer where possible.
- Breaking change: append `!` to the type or scope.

Body rules, from [CONTRIBUTING.md](../../../CONTRIBUTING.md#commit-messages):

- Blank line after the subject, wrap at 72 columns.
- Explain *why*, not *what* — the diff shows the what.
- Reference issues in the body (`Refs #123`), not the subject.

**No AI attribution trailers.** CONTRIBUTING.md forbids `Co-Authored-By:` for AI assistants, and AGENTS.md repeats it. The committer identity is a bot on purpose; attribution trailers add noise on a public repo. This holds whether or not an agent session helped author the change, and it applies to PR bodies too.

## PR flow

**Before opening:**

1. `git status` — nothing accidentally staged, no stray run output (`.sdlc/`, `src/`).
2. `npm test` from the repo root. It is offline and free, so there is no reason not to run it. The suite is green; a failure is yours until proven otherwise.
3. `git diff <target-branch>...HEAD` — read what is actually in the PR. Look for staged secrets, `.env` files, and lockfile churn.

**Opening:**

- **Target is `develop`** for `feat/`, `fix/`, `docs/`, `chore/`. Only a release cut targets `main`.
- **The PR title becomes the squash-merge commit subject**, verbatim. Get it right at open time — a malformed title produces a malformed commit on the target branch even after CI passes.
- **One topic per PR.** Work touching two unrelated areas splits into two.
- **Body** uses two sections:

  ```markdown
  ## Summary
  - One to three bullets: what changed and why.

  ## Test plan
  - [x] `npm test`
  - [x] Manually verified <specific behavior>.
  ```

**During review:**

- Push follow-up commits to the same branch. Do not rebase-and-force-push once review has started — reviewers lose their comment anchors.
- Resolve a conversation only after acting on it, or after replying with why not.

## Squash-merge policy

**Every PR merges with "Squash and merge" — one clean commit per PR on the target branch.**

- Never "Create a merge commit" — adds a merge node and the feature branch's per-commit noise to `git log`.
- Never "Rebase and merge" — spreads the PR's commits across the target branch and loses the PR boundary.

From the CLI:

```bash
gh pr merge <number> --squash --delete-branch
```

## Post-merge cleanup

**Every merge:** delete the source branch, then move off it locally.

```bash
git checkout develop && git pull origin develop
```

**After a `develop → main` release cut,** sync `develop` back to the new `main` tip so the next feature branch starts from an up-to-date base:

```bash
git checkout develop
git fetch origin
git merge --ff-only origin/main
git push origin develop
```

Fast-forward only. If `--ff-only` refuses, someone pushed to `develop` between the cut and now — investigate rather than forcing.

## Guardrails

Before any action that touches shared state:

- **`git push origin <branch>`** — confirm the prefix is right and that you are pushing your own feature branch, not `main` or `develop`.
- **`gh pr create`** — confirm `--base develop` for feature work; `--base main` only for a release cut the user has asked for. Confirm the title parses as a conventional commit.
- **`gh pr merge`** — confirm `--squash --delete-branch`, and confirm the user authorized this specific PR. A prior yes does not carry to a new one.
- **`git push --force`** — refuse on `main` and `develop`. On a feature branch, only when asked and only before review starts.
- **`git reset --hard`, `git clean -fd`, `rm -rf` in the repo** — run `git status` first and stash anything present, `-u` included.

Never do any of these silently as part of another task:

- Delete a branch, local or remote.
- Merge a PR.
- Push to `main` or `develop`.
- Amend or force-push a branch under review.
- Commit anything matching `.env`, `*.pem`, `id_rsa*`, `credentials*`, or anything shaped like a secret — even when the user staged it. Ask.

## Recipes

**Start a task:**

```bash
git checkout develop
git pull origin develop
git checkout -b <type>/<short-name>
```

**Open the PR:**

```bash
gh pr create --base develop \
  --title "<type>(<scope>): <subject>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet>

## Test plan
- [x] npm test
EOF
)"
```

**Merge, once the user confirms:**

```bash
gh pr merge <number> --squash --delete-branch
```

**Release cut:**

```bash
git checkout develop && git pull origin develop
gh pr create --base main --head develop --title "release: <summary>" --body "..."
# after it merges:
git checkout develop && git fetch origin && git merge --ff-only origin/main && git push origin develop
```

## Related

- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — the human-readable version of these rules.
- [.agents/skills/house-style/SKILL.md](../house-style/SKILL.md) — the sibling maintainer skill for writing conventions.
- [.github/workflows/pr-title.yml](../../../.github/workflows/pr-title.yml) — the check that enforces the title format.
