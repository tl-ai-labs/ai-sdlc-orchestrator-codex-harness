# AGENTS.md

Rules for Codex CLI sessions editing this repo. The full contributor guide is [CONTRIBUTING.md](CONTRIBUTING.md); this file states the writing conventions plainly so you don't have to fetch it.

## Writing style — user-facing docs (`README.md`, `docs/*.md`, `CONTRIBUTING.md`)

- **Second person, present tense.** `You configure X in Y.` Never `the user should configure X in Y.`
- **Statement of fact.** No `we explored`, no `as demonstrated by`, no `here's how we proved it`.
- **No AI slop.** Never use: `seamless`, `powerful`, `leverage`, `unlock`, `elegant`, `production-grade`, `battle-tested`, `robust`, `thoughtful`, `graceful`, `as demonstrated`, `in summary`.
- **No throat-clearing intros or trailing summaries.** Say the thing, stop.
- **Tables over prose for reference material.** Config keys, env vars, failure modes, phases — table first, prose only when a table can't carry the meaning.
- **Copy-paste-runnable code.** Real paths, real commands, real env vars. No `<placeholder>` unless labelled and explained.

## Writing style — source comments and docstrings (`plugin/**`, `tools/**`)

- **Default to no comment.** Only write one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.
- **Don't explain WHAT the code does** — well-named identifiers already do that.
- **No essay-length block comments.** If you're writing a "WHY THIS EXISTS / WHAT IT BROKE / THE FIX" narrative, that belongs in `docs/architecture.md`, not above a function.
- **No incident narratives.** "This broke on 2026-08-04…" belongs in the commit message and PR description, not in the code forever.
- **Same slop rules as above.**

## Enforcement

`npm test` runs `tools/test/style.test.mjs` which greps for the slop terms and third-person patterns above. Regressions fail the test.

**Do-not-touch surfaces.** `SETUP.md` and everything under `plugin/{commands,agents,skills}/` are Codex-instruction files where `the user` is the correct third-person reference — the style test excludes them. Historical records (`docs/walkthroughs/`, `examples/*/passes/`) are also excluded.

## Codex runtime notes

- **Model cast:** GPT driver/conductor, GPT judgment worker (via the `openai` model-dispatch adapter), Gemini 3.7 Flash mechanical worker. No Anthropic model or credential appears anywhere in this harness's official execution path — see `docs/verification/p1-codex-runtime.md` for the pinned model, reasoning effort, sandbox mode, and approval policy.
- **Every model call goes through the bridge** (`plugin/mcp/model-dispatch`), including judgment work, so per-phase cost attribution survives. The driver itself authors no shipped content.
- **A denied tool call leaves no trace in `codex exec --json`.** Any write-contract guard must record its own decision — the event stream cannot reconstruct a denial after the fact.
- **Commands executed by Codex arrive shell-wrapped** (`/bin/zsh -lc '…'` on this platform). Unwrap before start-anchored classification.
- **A prompt beginning with `---`** (for example, skill frontmatter) is parsed as CLI flags by `clap` unless preceded by a literal `--` separator.
- **`codex exec --json` events carry no timestamps.** The telemetry event reader stamps its own.
- **No wallet or usage figures are reported for the driver.** Driver cost is modeled from token counts at the pinned rates and labelled `modeled`, never presented as actual spend.

## Other conventions

- **No `Co-Authored-By:` trailers for AI assistants** in commit messages. See CONTRIBUTING.md.
- **One topic per PR**, focused diff.
- **Run `npm test` before you submit.** It is offline and free.
