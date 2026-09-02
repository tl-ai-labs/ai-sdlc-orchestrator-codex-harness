# Running

Two ways to run the pipeline, what the gates ask you, and what lands on disk.

> **For:** running the harness once it is set up. **Also see:** [../SETUP.md](../SETUP.md) · [tutorial-first-run.md](tutorial-first-run.md) · [methodology.md](methodology.md) · [brief-template.md](brief-template.md)

---

## Two shapes

**Interactive — inside a codex session.** Type `$` to mention a skill, or `/skills` to browse:

```
$mmo-codex:greenfield     a new app from a brief, in an empty folder
$mmo-codex:brownfield     work on an existing repo
$mmo-codex:policy         show or change this project's policy
$mmo-codex:revert         undo a brownfield run
```

The skill asks for what it needs, checks the setup before spending anything, and stops at each
gate for your answer.

**Headless — from a shell.** The driver spawns its own conductor and exits when the run
finishes:

```bash
node plugin/codex/run.mjs \
  --brief='path/to/brief.md' \
  --project-root=. \
  --output-dir=.sdlc \
  --policy=gpt-plus-flash \
  --run-id=pass1
```

### Which to use

Interactive when you want to answer the gates and steer. Headless for CI, for a replay of a
known-good run, or when you want the whole thing logged to files and nothing else.

They are not interchangeable in one respect: if you are **already inside a codex session** and
invoke `$mmo-codex:pass`, it does the work itself rather than shelling out to `run.mjs`. Spawning
the driver from inside a session would bill the same work twice.

## Start with `--dry-run`

```bash
node plugin/codex/run.mjs --brief='path/to/brief.md' --output-dir=.sdlc --dry-run
```

This renders the conductor prompt and the exact `codex exec` argv, prints them, and exits without
spawning anything or spending anything. It is the cheapest way to confirm a CI invocation is
shaped correctly. Drop the flag to run for real.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--brief=<path>` | — | The brief the run builds from. Greenfield takes a project brief; brownfield takes an intent brief. |
| `--project-root=<path>` | current directory | The repo the run works against. |
| `--output-dir=<path>` | `<project-root>/.sdlc` | Where artifacts and telemetry land. |
| `--policy=<name>` | `gpt-plus-flash` | Routing policy for this run. A per-run override; it does not rewrite the project default. |
| `--code-dir=<path>` | `<project-root>/src` | Where generated code goes. In brownfield this is the repo root, since edits land across the existing tree. |
| `--gates=<mode>` | `prompt` | `prompt`, `auto-approve`, or `auto-abort`. See below. |
| `--mode=<mode>` | inferred | `greenfield` or `brownfield`. Omit to let the conductor work it out from the brief and the repo. |
| `--intent=<id>` | — | Brownfield job type: `docs`, `bugfix`, `feature-extend`, `feature-new`, `refactor`, `test`, `deps`. Rejected with `--mode=greenfield`, which has no intents. |
| `--seed=<text>` | — | The job in the user's own words; answers the interview's first question. |
| `--max-turns=<n>` | 12 | How many `codex exec` invocations one run may use. A single turn hits the session context ceiling partway through a real project, so the driver resumes until the pipeline writes `SUMMARY.md`. |
| `--run-id=<id>` | generated timestamp | Run identifier; also names the run's directory under `.sdlc/runs/`. |
| `--prompt-file=<path>` | the bundled conductor prompt | Use a different conductor prompt. |
| `--codex-bin=<path>` | `codex` on PATH | For a non-global codex install. |
| `--dry-run` | off | Render and exit. |

If `--output-dir` already exists its contents are overwritten. Use a fresh `--run-id` and a fresh
output directory to keep prior data.

## Gates

A run pauses at human-in-the-loop gates. Four in a greenfield run, plus Gate 0 for brownfield:

| Gate | When | What it shows |
|---|---|---|
| **Gate 0** | Brownfield only, before Gate 1 | The scope: intent, file allowlist, and what is off-limits. Approve before anything is written. |
| **Gate 1** | After requirements | `requirements.md` |
| **Gate 2** | After architecture | `design.md` |
| **Gate 3** | After security review | `security_review.md` |
| **Gate 4** | At the end | Final acceptance — total cost, file count, test results |

Gates 1–3 take `approved`, `revise: <comments>`, or `abort`. Gate 4 takes `accept` or
`reject: <comments>`.

`--gates` decides what happens when there is nobody to ask:

| Mode | Behaviour |
|---|---|
| `prompt` | Stop and wait for an answer. The default. |
| `auto-approve` | Print what was produced, record the decision as `auto-approved`, continue. What CI usually wants for a known-good replay. |
| `auto-abort` | Print the gate and stop. A run that drifts into needing a human never quietly proceeds. |

`auto-approve` is the one to think twice about: it accepts a security review nobody read. Use it
for replays of runs you have already reviewed, not for new work.

Gate decisions are recorded in `gates.jsonl` either way, so an unattended run leaves the same
audit trail as an attended one.

## Brownfield

Brownfield runs work against an existing repository and are the reason the write contract exists.

Entry points: `$mmo-codex:brownfield`, or one of seven aliases that pre-select the job type —
`bugfix`, `docs`, `test`, `refactor`, `deps`, `feature-new`, `feature-extend`. All of them
delegate to the same operating manual, so the alias only saves you a question.

What differs from greenfield:

- **A git repository is required.** Discovery stops with git-init guidance outside one.
- **Discovery runs first**, producing `discovery.md` and a baseline snapshot.
- **Gate 0 confirms scope** before anything is written. The file allowlist and the off-limits set
  are agreed there, and `.sdlc/local/write-contract.json` is written from that approval.
- **Every write is checked against the contract** by a hook, before it happens.
- **Touched files are backed up** if untracked or uncommitted, so `$mmo-codex:revert` can restore
  them. The record is `provenance.json`.

**Running brownfield unattended.** The operating manual asks which job type to run and interviews
you about it. Under `--gates=auto-approve` there is nobody to answer and stdin is closed, so
supply the answers up front:

```bash
node plugin/codex/run.mjs \
  --brief=intent-brief.md --project-root=. --output-dir=.sdlc \
  --mode=brownfield --intent=bugfix \
  --seed='login returns 500 on empty password' \
  --gates=auto-approve
```

`--intent` skips the job-type question; `--seed` answers the interview's first one. Gate 0 still
re-confirms the scope, and under `auto-approve` it is answered rather than skipped.

## Bring your own brief

Write a brief following [brief-template.md](brief-template.md) — the requirements and
architecture phases expect its section headings — save it anywhere, and point `--brief` at it.

For a brownfield run you can skip writing one: the interview builds an intent brief from your
answers and writes it to `intent_brief.md`.

## What lands in the output directory

| File | Written by | Contents |
|---|---|---|
| `requirements.md` | Phase 1 | Requirements, gated at Gate 1 |
| `design.md` | Phase 2 | Data model, API contract, module boundaries |
| `packets.json` | Phase 4 | The TaskPackets the run planned |
| `review.json` | Phase 6 | Senior review findings and refinement packets |
| `security_review.md` | Phase 8 | Security findings, gated at Gate 3 |
| `telemetry.jsonl` | every dispatch | One record per model call, vendor-metered |
| `manifest.json` | Phase 9 | Rollup of the whole run |
| `SUMMARY.md` | Phase 9 | Total cost, breakdown, links to artifacts |
| `gates.jsonl` | each gate | Gate decisions |
| `driver-events.jsonl` | the driver | The raw `codex exec` event stream |
| `driver-cost-modeled.jsonl` | the driver | The conductor's own token usage, priced |
| `driver-manifest.json` | the driver | The pins the run ran under |

Brownfield adds `discovery.md`, `intent_brief.md`, and `provenance.json`.

## Reading the cost

```bash
node tools/report.mjs .sdlc --markdown
```

The report separates dispatched work (vendor-metered) from the driver loop (modeled, and kept out
of the vendor total), flags any packet that hit its output cap, and prints the pins the run used.
[methodology.md](methodology.md) explains why those are separate numbers and how far to trust
each one.

## Running again

Give each run its own `--run-id` and its own `--output-dir`. Runs are not incremental — a second
run over the same output directory overwrites the first.
