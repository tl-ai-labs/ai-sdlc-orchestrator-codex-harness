# Running

Two ways to run the pipeline, what the gates ask you, and what lands on disk.

> **For:** running the harness once it is set up. **Also see:** [../SETUP.md](../SETUP.md) · [tutorial-first-run.md](tutorial-first-run.md) · [headless-runs.md](headless-runs.md) · [methodology.md](methodology.md) · [brief-template.md](brief-template.md)

---

## Policies

A policy decides which model each phase is routed to, and what the run costs. Four ship, and
each one runs on this harness. `$mmo-codex:policy` prints the current one; `$mmo-codex:policy
change` swaps it.

### Which policy a run uses

The first match wins, for the driver and the bridge alike:

| Order | Source | Set by |
|---|---|---|
| 1 | `<project-root>/routing-policy.yaml` | A complete policy file you keep in the project. It beats `--policy`, and `run.mjs` prints a notice when it does. |
| 2 | `--policy=<name>` | The flag, for one run. |
| 3 | `.sdlc/project.json` `default_policy` | `$mmo-codex:policy` or `setup-policy.mjs --policy=<name>`. |
| 4 | `gpt-plus-flash` | Nothing chosen. |

The pin, the driver's rates and the cost cap all come from the file that won. `--dry-run`, each
`invocation_start` line of `driver-events.jsonl`, `driver-manifest.json` and a session run's
`run.json` record it as `policy_source`, `policy_path` and `policy_sha256`, and `--resume` on
either route refuses a different policy than the one the run started on.

Every runnable policy carries the same `driver:` block: the conductor runs on `gpt-5.6-terra` at
effort `high` whatever the policy routes dispatches to, so comparisons between policies hold the
driver constant. A policy of your own without one falls back to its `gpt` model entry, with a
warning. In a codex session, `start-run.mjs` reads the session's model and effort before it
creates the run folder, and starts no run unless they match the pin: switch with `/model`, or
start codex with `codex -s danger-full-access -m gpt-5.6-terra -c model_reasoning_effort="high"`.

### `gpt-plus-flash` — the policy of record

Judgment phases (requirements, design, packet planning, senior review, security review) run on
`gpt-5.6-terra` at reasoning effort `high`, dispatched through the OpenAI adapter as metered API
calls. Mechanical phases (codegen, tests, docs) drop to Gemini 3.7 Flash.

**Credentials:** `OPENAI_API_KEY`, plus a Gemini door — `GEMINI_API_KEY` or Google Cloud
application-default credentials.

**Cost reporting:** every dispatch vendor-metered. The conductor's own line is modeled from its token
counts, as on every policy.

**When to pick it:** anything whose cost figures get published or compared. This is the default,
and every published number for this harness comes from it.

### `gpt-plus-flash-38` — the policy of record, on Gemini 3.8 Flash

Identical to `gpt-plus-flash` except that mechanical phases name `gemini-3.8-flash`. Google
deprecated `gemini-3.7-flash` on 2026-10-08 and serves requests for it from 3.8, so this policy
records the model that actually ran. The rates are the same.

**Credentials:** the same as `gpt-plus-flash`.

**When to pick it:** you want telemetry and reports to name the Gemini model that ran.

### `gpt-seat-plus-flash` — the same models, without an API key

Identical routing and the same effort pin. Judgment work reaches GPT through a local `codex exec`
subprocess on a ChatGPT seat instead of the metered API.

**Credentials:** a logged-in codex (`codex login`), plus the same Gemini door. No `OPENAI_API_KEY`
— the setup check will not ask for one under this policy.

**Cost reporting:** judgment-tier cost is modeled from token counts rather than metered, because
codex reports tokens but no money. Telemetry labels those events `modeled`, and the report keeps
them out of the vendor total. See [methodology.md](methodology.md).

**When to pick it:** developing against the harness, or running at all without a key. A full run
then draws judgment work from the same monthly seat allowance as the conductor, so a long
reference run is where a seat is most likely to run out mid-run.

### `flash-agsdk-only` — the mechanical tier alone

Every dispatched phase routes to Gemini 3.7 Flash through the Antigravity SDK agent worker. The
conductor still runs on the GPT driver pin, and its turns are modeled at GPT rates.

**Credentials:** Vertex application-default credentials — the agent path is ADC-only and has no
API-key door — plus Python 3.10+ and a logged-in codex for the conductor. No `OPENAI_API_KEY`.

**When to pick it:** exercising the agent door, or measuring what the mechanical tier does
unaided.

The Claude harness's `opus-*` policies do not ship with this plugin. A policy of your own that
names an Anthropic adapter (`builtin-anthropic`, `claude-cli`), or pins `driver:` to a model that
is not GPT, does not run here: `run.mjs` and `start-run.mjs` refuse it before anything is spent.

**The mechanical tier has two doors, and the policy file does not choose between them.** Gemini
can be called as a model — one completion per packet — or as an agent that opens the working
directory itself. Which one a run uses is a property of the *install*, picked once at setup, so
the policy file stays a faithful record of how a run was priced and routed. Both doors reach the
same model at the same rates; the `model_id` on each telemetry event is what says which ran.
Details in [methodology.md](methodology.md#the-mechanical-tier-has-two-doors).

## Two routes

**Interactive — inside a codex session.** This is how you use the harness. Start codex on the
conductor's pin, with the sandbox dispatch needs:

```bash
codex -s danger-full-access -m gpt-5.6-terra -c model_reasoning_effort="high"
```

Then type `$` to mention a skill, or `/skills` to browse:

```
$mmo-codex:setup          check the install and pick this project's policy
$mmo-codex:greenfield     a new app from a brief, in an empty folder
$mmo-codex:brownfield     work on an existing repo
$mmo-codex:bugfix         a brownfield job with its type chosen (also docs, test, refactor,
                          deps, feature-new, feature-extend)
$mmo-codex:policy         show or change this project's policy
$mmo-codex:revert         undo a brownfield run
```

The skill asks for what it needs, checks the setup before spending anything, starts the run with
`start-run.mjs`, and stops at each gate for your answer in the chat. The run's end
(`end-run.mjs`) reads the conductor's cost from codex's session file. The walkthrough is
[tutorial-first-run.md](tutorial-first-run.md).

**Keep the session on the pin until the run ends.** `start-run.mjs` checks the session's model
and effort when a run starts and when it resumes, and at no other point. Switching model with
`/model` mid-run does not stop the run: every later turn on the other model is listed as unpriced
in the conductor's figure, not priced at the pin's rates. Those turns add nothing to the cost cap,
and the run total reads `at least`. To work on another model, start a new codex session.

**Headless — from a shell.** `plugin/codex/run.mjs` spawns its own `codex exec` conductor and
exits when the run ends. It exists to check the cost figures: codex reports the conductor's tokens
on its `--json` stream as well as in its session file, and the run's end compares the two token
for token. [headless-runs.md](headless-runs.md) is the procedure. From the project folder, with the
harness cloned at `~/mmo-codex` as that page's step 1 does:

```bash
node ~/mmo-codex/plugin/codex/run.mjs \
  --brief='path/to/brief.md' \
  --project-root=. \
  --mode=greenfield \
  --gates=auto-approve \
  --policy=gpt-plus-flash \
  --run-id=pass1
```

The run's record lands in `.sdlc/runs/pass1/`.

### Which to use

Interactive for real work: you answer the gates and steer. Headless to check the cost figures
against codex's own count, for CI, or for a replay of a known-good run.

They are not interchangeable in one respect: if you are **already inside a codex session** and
invoke `$mmo-codex:pass`, it does the work itself rather than shelling out to `run.mjs`. Spawning
the driver from inside a session would bill the same work twice.

The rest of this page describes both routes. Where a section says `run.mjs`, or names a flag, it
is the headless route; a session run takes its settings from the skill's questions.

## Start with `--dry-run`

```bash
node ~/mmo-codex/plugin/codex/run.mjs --brief='path/to/brief.md' --mode=greenfield --gates=auto-approve --dry-run
```

This renders the conductor prompt and the exact `codex exec` argv, prints them, and exits without
spawning anything or spending anything. It is the cheapest way to confirm a CI invocation is
shaped correctly. Drop the flag to run for real.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--brief=<path>` | — | The brief the run builds from. Greenfield takes a project brief; brownfield takes an intent brief. |
| `--project-root=<path>` | current directory | The repo the run works against. A brownfield run, or one with no `--mode`, takes the repository's root, the folder that holds `.git`; a subfolder exits 2 before anything is spent. |
| `--output-dir=<path>` | `<project-root>/.sdlc/runs/<run-id>` | Greenfield only: a different run folder inside the project. It may not be the project root, a folder inside `.sdlc` other than the run's own, or a folder that overlaps the code directory. Pass it again on `--resume`. |
| `--policy=<name>` | `.sdlc/project.json` default, else `gpt-plus-flash` | Routing policy for this run. A per-run override; it does not rewrite the project default. A `routing-policy.yaml` at the project root beats it — see [Which policy a run uses](#which-policy-a-run-uses). |
| `--code-dir=<path>` | `<project-root>/src` (greenfield), `<project-root>` (brownfield, or no `--mode`) | Where generated code goes. It must stay inside the project and outside `.sdlc`. A resumed run keeps its own. |
| `--gates=<mode>` | `prompt` | `prompt`, `auto-approve`, or `auto-abort`. See below. `prompt` needs a terminal. |
| `--mode=<mode>` | inferred | `greenfield` or `brownfield`. Omit to let the conductor work it out from the brief and the repo; the driver then handles the run as brownfield: it needs git, and the code goes to the project root. A folder that is not a git repository needs `--mode=greenfield`. |
| `--intent=<id>` | — | Brownfield job type: `docs`, `bugfix`, `feature-extend`, `feature-new`, `refactor`, `test`, `deps`. Rejected with `--mode=greenfield`, which has no intents. |
| `--seed=<text>` | — | The job in the user's own words; answers the interview's first question. |
| `--max-turns=<n>` | 12 | How many `codex exec` invocations one driver process may use. A single turn hits the session context ceiling partway through a real project, so the driver resumes until the run ends. A gate answer's invocation does not count. |
| `--run-id=<id>` | `YYYYMMDD-HHMMSS-<intent or mode>-<6 hex>` | Run identifier; also names the run's folder under `.sdlc/runs/`. |
| `--resume=<id>` | — | Continue a stopped run, by run id or by the codex thread id it recorded. See below. |
| `--prompt-file=<path>` | the bundled conductor prompt | Use a different conductor prompt. |
| `--codex-bin=<path>` | `codex` on PATH | For a non-global codex install. |
| `--dry-run` | off | Render and exit. |

Flags take `--name=value` or `--name value`. An unknown flag or a flag with no value exits 2.
`--output-dir` and `--code-dir` resolve against `--project-root`; `--brief`, `--prompt-file` and
`--codex-bin` resolve against the directory you run the command from.

Every run gets its own folder. A `--run-id` that already has a record is refused rather than
overwritten; continue that run with `--resume`, or pick a new id.

## Gates

A run pauses at human-in-the-loop gates. Four in a greenfield run, plus Gate 0 for brownfield:

| Gate | When | What it shows |
|---|---|---|
| **Gate 0** | Brownfield only, before Gate 1 | The scope: intent, file allowlist, and what is off-limits. Approve before anything is written. |
| **Gate 1** | After requirements | `requirements.md` |
| **Gate 2** | After architecture | `design.md` |
| **Gate 3** | After security review | `security_review.md` |
| **Gate 4** | At the end | Final acceptance — dispatched cost, file count, test results |

Gates 1–3 take `approved`, `revise: <comments>`, or `abort`. Gate 4 takes `accept` or
`reject: <comments>`.

`--gates` decides what happens when there is nobody to ask:

| Mode | Behaviour |
|---|---|
| `prompt` | Ask you at the terminal. The conductor records the gate as pending and ends its turn; the driver prints the gate, reads your answer, and resumes the session with it. Its other questions (the brownfield job type and interview, the Phase 7 environment check) reach you the same way. Only a line you type after the question answers it; anything typed earlier is ignored. `abort`, an empty answer, or end of input aborts the run at that gate. The default. Refused (exit 2) when stdin is not a terminal. |
| `auto-approve` | Print what was produced, record the decision as `auto-approved`, continue. What CI usually wants for a known-good replay. A question the run cannot go on without stops it (exit 4) with the question in `stop.json`. |
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

- **A git repository is required.** `start-run.mjs` in a session, and `run.mjs` from a shell, refuse
  a folder that is not one before anything is spent.
- **Discovery runs first**, producing `discovery.md` and a baseline snapshot.
- **Gate 0 confirms scope** before anything is written. The file allowlist and the off-limits set
  are agreed there, and `.sdlc/local/write-contract.json` is written from that approval.
- **Every write is checked against the contract** by a hook, before it happens.
- **The run's end switches the contract off**, whatever the outcome, so your own edits are not
  refused after a run stops. `--resume` puts the frozen contract back; a run that ended
  `completed` or `aborted` does not resume.
- **Every file the run changes is recorded** in `.sdlc/runs/<run-id>/provenance.json`. The write
  hook snapshots a file before the run's first write to it, backing up one that held uncommitted
  or untracked content, and the end of the run reconciles the record against `git status` and the
  run's commits.
  `$mmo-codex:revert <run-id>` restores from it.

**Running brownfield unattended.** The operating manual asks which job type to run and interviews
you about it. Under `--gates=auto-approve` there is nobody to answer and stdin is closed, so
supply the answers up front:

```bash
node ~/mmo-codex/plugin/codex/run.mjs \
  --brief=intent-brief.md --project-root=. \
  --mode=brownfield --intent=bugfix \
  --seed='login returns 500 on empty password' \
  --gates=auto-approve
```

`--intent` skips the job-type question; `--seed` answers the interview's first one. The rest of
the interview is not asked: the brief is drafted from the seed. Gate 0 still re-confirms the scope,
and under `auto-approve` it is answered rather than skipped.

## Bring your own brief

Write a brief following [brief-template.md](brief-template.md) — the requirements and
architecture phases expect its section headings — save it anywhere, and point `--brief` at it.

For a brownfield run in a codex session you can skip writing one: the interview builds an intent
brief from your answers and writes it to `intent_brief.md` in the run folder. A `run.mjs` run has
nobody to interview, so it needs `--brief`, or a `brief.md` at the project root.

## What lands in the run folder

Each run writes to `.sdlc/runs/<run-id>/`. Project-level state — `project.json`, the write
contract and its decision log under `local/`, the baseline, the ledger — stays in `.sdlc/`.

| File | Written by | Contents |
|---|---|---|
| `requirements.md` | Phase 1 | Requirements, gated at Gate 1 |
| `design.md` | Phase 2 | Data model, API contract, module boundaries |
| `packets.json` | Phase 4 | The TaskPackets the run planned |
| `review.json` | Phase 6 | Senior review findings and refinement packets |
| `security_review.md` | Phase 8 | Security findings, gated at Gate 3 |
| `telemetry.jsonl` | every dispatch | One record per model call, with its cost and that cost's provenance |
| `manifest.json` | `write-manifest.mjs`: Phase 9, Gate 4, and every run end | Rollup of the whole run, written by code |
| `SUMMARY.md` | `write-manifest.mjs`: Phase 9, Gate 4, and a completed run's end | Dispatched cost and its split, the conductor's cost, phases, gates, links to artifacts |
| `gates.jsonl` | each gate | Gate decisions |
| `preflight.json` | Phase -1 | Whether every model the run dispatches to is reachable |
| `state.json` | each gate | The gate that is waiting for an answer |
| `stop.json` | the conductor | Why it stopped the run, when no other record says so |
| `question.json` | the conductor | `--gates=prompt`: a question for you that is not a gate |
| `orchestrator.log` | the driver or the start and end scripts, the conductor, the bridge | `run.start` and `run.end`; the conductor's `phase.start`, `phase.end`, `phase.skip`, `gate.open` and `gate.resolved`; each dispatch |
| `run.json` | the start and end scripts | Session runs: the route (`interactive`), mode, intent, policy, each start, and how the run ended |
| `skills/` | the driver or the start script | The playbooks rendered with this run's paths: `pipeline.md`, `brownfield-guide.md`, `discovery.md`, `roles/*.md`. The conductor reads these, never the plugin's own `SKILL.md` files |
| `driver-events.jsonl` | the driver | Every `codex exec` invocation's start and end, and each codex event as it arrived |
| `driver-stderr.log` | the driver | What codex wrote to stderr, per invocation |
| `driver-cost-modeled.jsonl` | the driver | The conductor's own token usage, priced per turn |
| `driver-manifest.json` | the driver | The pins, how the run ended, its exit code, and the driver cost |
| `driver-session.jsonl` | `start-run.mjs` and every dispatch from a codex shell | The codex thread each call ran in, which names the conductor's session file |
| `driver-usage.json` | every run end | The conductor's tokens and modeled cost from codex's session file; on a `run.mjs` run, the token-for-token check against the exec stream |
| `report.md` | every run end | The cost report |

Brownfield adds `discovery.md`, `intent_brief.md`, and `provenance.json`.

## Reading the cost

Every run end writes `report.md` in the run folder. To render it again from the project folder,
with the harness cloned at `~/mmo-codex` (an installed plugin keeps the script at
`scripts/report.mjs` in its own folder, and the run's end prints the full command as
`Cost report:`):

```bash
node ~/mmo-codex/plugin/scripts/report.mjs .sdlc/runs/<run-id> --markdown
```

The report lists dispatched work by phase and the driver loop (modeled), adds them into
`Run total = dispatched + driver`, keeps modeled figures out of the vendor-metered total, flags any
packet that hit its output cap, and prints the pins the run used. [methodology.md](methodology.md)
explains why those totals are kept apart and how far to trust each one.

## Running again

Each run gets its own folder under `.sdlc/runs/`, so a second run never touches the first. Runs
are not incremental: a new run starts from the brief again.

## How a run ends

The driver resumes the session until something in the run folder says the run ended, and its
exit code says how:

| Exit | Outcome | What happened |
|---|---|---|
| 0 | `completed` | Gate 4 was accepted, and `write-manifest.mjs` wrote `SUMMARY.md` after it |
| 1 | `codex_failed`, `pin_rejected` | codex exited non-zero (its stderr is printed and kept in `driver-stderr.log`), or rejected the pinned model or effort |
| 2 | — | A usage error, or a refusal before anything was spent |
| 3 | `max_turns` | `--max-turns` invocations ran out before the run finished |
| 4 | `aborted`, `halted`, `refused`, `stopped`, `cost_cap` | A stop on purpose: an aborted gate, a preflight halt, a refused write, the conductor's `stop.json`, or the cost cap |
| 128+n | `interrupted` | The driver received signal n before the run finished: 130 for Ctrl-C, 143 for `kill`, 129 when its terminal closes. A signal that arrives after Gate 4 was accepted and the final `SUMMARY.md` written leaves the run `completed`, exit 0 |

The cost cap is checked before every `codex exec` and after each one, before a waiting gate is put to
you: a run over its cap stops at exit 4 without asking.

## Resuming a partial run

Two different things are called resuming here, and only one of them is something you do.

**Within a run, automatically.** One `codex exec` turn cannot finish a real project — it ends when
the session hits its context ceiling, with exit 0 and no error. The driver resumes the same
session until the run ends or `--max-turns` (default 12) is reached. Nothing to do; a run that
takes several turns is the normal case, not a fault.

**After a stop, by hand.** Continue a run that did not complete with its run id. The driver
prints the exact command as `Continue:` when it stops. A brownfield run whose write contract ended
`completed` or `aborted` does not resume, and its `Continue:` line says so instead:

```bash
node ~/mmo-codex/plugin/codex/run.mjs --resume=pass1 --project-root=.
```

The driver finds `.sdlc/runs/pass1/`, resumes the codex thread recorded there, and appends to the
same record. The run keeps its policy, mode, intent, code directory and brief, and `--brief` is not
needed; a `--code-dir` or `--brief` that names another path exits 2. `--gates`
may change between invocations; without it the run keeps the last gate mode. A completed run is
not resumed, and neither is a run whose driver is still running (mid-turn, or waiting at a gate in
another terminal). A run in a custom `--output-dir` needs the same `--output-dir` again.

Resuming a run that stopped on purpose (an aborted gate, a preflight halt, a refused write,
`stop.json`, the cost cap) continues past that stop: the conductor is told you chose to go on and
takes up the step again under the new `--gates`. For example, `--gates=auto-abort` stops at
Gate 1 so you can read `requirements.md`, and `--resume=pass1 --gates=auto-approve` then goes on.

A resumed run keeps the playbooks in its `skills/` folder unless the plugin changed since they
were rendered. Then the driver renders them again and tells the conductor which ones changed, so a
run that stopped on an older plugin takes up its step under the current playbook.

`--resume` also takes the codex thread id from the run's `driver-events.jsonl`. A thread id that
no folder under `.sdlc/runs/` (or the `--output-dir` you pass) records starts a new run folder,
and every resume tells the conductor that folder and its run id, since its first prompt named
another one. Its first turn is priced from the thread's earlier total in codex's session file under
`$CODEX_HOME/sessions/` when that file is there, and otherwise at the thread's whole running
total, flagged `baseline_unknown`.

**Stopping a run.** Press Ctrl-C, `kill <pid>` the driver, or close its terminal. It forwards the
signal to codex, kills codex after 10 seconds if it has not stopped, records the interrupted turn,
and exits. Do not use `kill -9` on the driver: it cannot forward that. If you did, stop codex with
`kill -- -<pgid>`, using the `pgid` in the last `invocation_start` line of `driver-events.jsonl`.

Telemetry and the driver record are written as the run goes, so an interrupted run leaves valid
partial data in its folder.
