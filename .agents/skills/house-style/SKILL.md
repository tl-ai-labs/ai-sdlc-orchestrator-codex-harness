---
name: house-style
description: Enforce this repo's writing conventions on docs prose and source comments. Invoke on "$house-style", "style sweep", "check docs style", "clean up comments", or after substantial edits to user-facing docs or to plugin/ and tools/ source. Sweeps the in-scope file set, applies the fixes, and confirms npm test still passes.
---

The conventions live in [AGENTS.md](../../../AGENTS.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md). The enforcement gate is [tools/test/style.test.mjs](../../../tools/test/style.test.mjs). This skill turns those rules into an actionable sweep.

Work through the sections in order. Do not skip the baseline check or the final `npm test`.

## Scope

Two regimes, different rules. Both are taken from what `style.test.mjs` actually scans — not from a wider guess.

| Regime | In-scope paths |
|---|---|
| **Docs prose** | `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and `docs/*.md` — top-level files only |
| **Source comments** | `plugin/**` and `tools/**` matching `\.(ts\|mjs\|py)$` |

Excluded — do not touch and do not scan:

- `SETUP.md` and `INSTALL.md` — Codex-instruction files where third-person `the user` is correct.
- `plugin/skills/**` — same reason. These are read by a model at run time.
- `docs/verification/**` — a historical record. `style.test.mjs` scans `docs/` one level deep, so this subdirectory is outside the gate by construction.
- `.agents/skills/**` — this skill and its siblings, same reason as `plugin/skills/**`.
- `examples/**`, `plugin/examples/**` — fixtures and briefs.
- `node_modules/`, `dist/`, `.venv/`, `__pycache__/`, `.sdlc/`, `src/`
- `*.test.mjs`

## Docs prose rules

**Second person, present tense.**

- `the user should X` becomes `you X`.
- `if user does X` becomes `if you do X` — the missing article is flagged separately.
- No `we`, `our`, or `let's` in the reader-facing voice. State the fact instead: `we found that X is slow` becomes `X is slow`. The test catches `we|our` followed by `detect|tell|append|write|check|plan|see|found|do|read|run|wrote`.

Possessive `the user's` and compound `the user-facing` are allowed — the test's `(?!['-])` lookahead excludes them.

**Banned terms**, verbatim from `SLOP_TERMS` in the test. Whole-word, case-insensitive.

| Term | Replace with |
|---|---|
| `seamless`, `seamlessly` | Delete, or name the mechanism ("no config required") |
| `powerful` | Delete, or state what it does |
| `leverage`, `leverages`, `leveraging` | `use`, `uses`, `using` |
| `unlock`, `unlocks` | `enable`, or delete |
| `elegant`, `elegantly` | Delete |
| `production-grade` | Delete, or state the property ("handles retries") |
| `battle-tested` | Delete, or cite the usage evidence |
| `robust`, `robustly` | Delete, or state the failure mode it handles |
| `thoughtful`, `thoughtfully` | Delete |
| `graceful`, `gracefully` | Delete, or name the fallback |
| `as demonstrated` | Delete |
| `in summary` | Delete |

Inline-code spans are stripped before matching, so quoting a banned term as an anti-example is fine when it is backtick-wrapped.

**No throat-clearing intros.** Not caught by the test, required by AGENTS.md. Flag lines opening with:

- `^This (document|page|guide|section|README)`
- `^In this (document|section|guide)`
- `^Here('s| is) how`
- `^We('re| will|'ll)? (going to|now|about to)`

Rewrite by deleting the line and opening with the concrete claim.

**No trailing summaries.** Delete `## Summary`, `## In summary`, and paragraphs that recap what was just said.

**Tables over prose for reference material.** Config keys, env vars, failure modes, phases, CLI flags — table first.

**Copy-paste-runnable code.** Real paths, real commands, real env vars. A `<placeholder>` is allowed only when labelled and explained.

## Source-comment rules

**Default to no comment.** If the identifier and structure carry the intent, delete it. This is the strongest rule.

**Comment only for non-obvious WHY:**

- A hidden constraint a reader would otherwise violate.
- A subtle invariant.
- A workaround for a specific bug, with the reference.

**No essay-length blocks.** More than ~3 lines, or reads as narrative: compress to one WHY line, move the reasoning to [docs/architecture.md](../../../docs/architecture.md) and leave a pointer, or delete.

**No incident narratives.** `This broke on 2026-08-04 because…` belongs in the commit message and the PR description.

**Same banned-term list** applies to comments and docstrings.

## Sweep workflow

Run these in order. Do not batch or reorder.

**1. Baseline.**

```bash
npm test 2>&1 | tail -20
```

Record the pass/fail count. Every fix must reduce failures or leave them unchanged. As of this writing the suite is fully green, so any failure you see is either yours or a genuine regression.

**2. Grep banned terms.**

```bash
grep -rniE '\b(seamless(ly)?|powerful|leverage(s|ing)?|unlock(s)?|elegant(ly)?|production-grade|battle-tested|robust(ly)?|thoughtful(ly)?|graceful(ly)?|as demonstrated|in summary)\b' \
  README.md CONTRIBUTING.md AGENTS.md docs/*.md plugin/ tools/ \
  --include='*.ts' --include='*.mjs' --include='*.py' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.venv \
  --exclude-dir=__pycache__ --exclude-dir=examples --exclude-dir=skills \
  --exclude='*.test.mjs'
```

**3. Grep third-person and first-person plural in docs.**

```bash
grep -rniE "\bthe user\b[^'-]|\bif user\b|\b(we|our)\s+(detect|tell|append|write|check|plan|see|found|do|read|run|wrote)\b" \
  README.md CONTRIBUTING.md AGENTS.md docs/*.md
```

**4. Grep meta-intros.**

```bash
grep -rniE "^(This (document|page|guide|section|README)|In this (document|section|guide)|Here('s| is) how|We('re| will|'ll)? (going to|now|about to))" \
  README.md CONTRIBUTING.md AGENTS.md docs/*.md
```

**5. Fix each hit.** Read the surrounding paragraph, not just the line, so you know what the sentence is trying to say. Apply the recipe from the tables above. Edit in place, one file at a time.

**6. Scan comment density.** Not grep-friendly. List source files by comment-line count and read the top ten:

```bash
for f in $(find plugin/ tools/ -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.py' \) \
  | grep -v node_modules | grep -v dist | grep -v '\.venv' | grep -v __pycache__ \
  | grep -v '/examples/' | grep -v '\.test\.mjs'); do
  echo "$(grep -cE '^\s*(//|#)' "$f") $f"
done | sort -rn | head -20
```

Apply the source-comment rules to each: delete comments stating the WHAT, compress essays, remove incident narratives.

**7. Re-run the full suite.**

```bash
npm test
```

Every previously passing test must still pass, and the three style tests must be clean.

**8. Report.** Per file: which lines changed and which rule they violated. Name anything you left alone, with the reason.

## Do not

- Do not touch `SETUP.md`, `INSTALL.md`, `plugin/skills/**`, `.agents/skills/**`, `docs/verification/**`, or `examples/**`. Those are instruction surfaces or historical records, excluded by design.
- Do not widen the test's globs in the same pass. If the sweep shows the gate should also cover `docs/**` recursively or `examples/**`, that is a separate PR.
- Do not remove a comment you do not understand. If it names a bug, an invariant, or a workaround, keep it — the rule bans essays, not signal.
- Do not `git commit` when the sweep finishes. Leave the diff for review.

## Related

- [.agents/skills/contribution-flow/SKILL.md](../contribution-flow/SKILL.md) — the sibling maintainer skill for branching, commits, and PRs.
