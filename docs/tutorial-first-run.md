# Your first run

You run the harness in a codex session: you install the plugin once, set up each project, start
a run with a skill, and answer its gates in the chat. This page walks through a greenfield run and
a brownfield run. About twenty minutes for the greenfield one, most of it waiting.

> **Also see:** [running.md](running.md) for the full surface · [understanding-output.md](understanding-output.md) for the report ·
> [headless-runs.md](headless-runs.md) to check the cost figures with a headless run

---

## What you need

| Need | Check |
|---|---|
| Node 20 or newer | `node --version` |
| codex CLI 0.151.0 or newer, logged in | `codex --version`, `codex login status` |
| A way to pay for the judgment tier: an `OPENAI_API_KEY`, or a ChatGPT seat with the `gpt-seat-plus-flash` policy | [running.md](running.md#policies) says which to pick |
| A Gemini door for the mechanical tier: a `GEMINI_API_KEY` from [AI Studio](https://aistudio.google.com/app/apikey), or Google Cloud application-default credentials (`gcloud auth application-default login`) | The setup check accepts either |
| git, for a brownfield run | `git --version` |

## 1. Install the plugin

Paste this into a codex session, and approve the commands it asks to run:

```
Set up this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness
```

Codex follows [INSTALL.md](../INSTALL.md). To do the same by hand:

```bash
codex plugin marketplace add https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness.git
codex plugin add mmo-codex@tilicho-ai-labs
node "$(ls -d ~/.codex/plugins/cache/tilicho-ai-labs/mmo-codex/*/codex/verify-setup.mjs | tail -1)" --fix
```

`--fix` builds the dispatch bridge inside the installed copy. To run a branch that is not released
yet, install it from a checkout instead: [CONTRIBUTING.md](../CONTRIBUTING.md#test-a-branch-in-a-codex-session).

## 2. Start codex the way a run needs it

```bash
mkdir ~/ping-service && cd ~/ping-service
codex -s danger-full-access -m gpt-5.6-terra -c model_reasoning_effort="high"
```

| Flag | Why |
|---|---|
| `-s danger-full-access` | Every dispatch spawns the bridge and talks to it over pipes, which codex's default and `workspace-write` sandboxes deny. Without it, the first dispatch fails with `MCP error -32000: Connection closed`. |
| `-m gpt-5.6-terra -c model_reasoning_effort="high"` | The conductor's pin. A run starts only in a session on that model at that effort, so every cost figure is the pin's. In a session already open, `/model` switches it. |

The first time codex starts with the plugin installed, it asks about the plugin's write hook.
"Trust all and continue" trusts it; `/hooks` in a session does the same. A brownfield run needs it.

## 3. Set up the project

```
$mmo-codex:setup
```

It rebuilds the bridge if needed, checks the credentials, picks the Gemini door, and asks which
policy this project uses, then writes it to `.sdlc/project.json`. It pauses only for a decision
that is yours. `$mmo-codex:greenfield` stops before spending when the project has no policy yet.

## 4. Start a greenfield run

```
$mmo-codex:greenfield
```

It takes no arguments and asks for what it needs, in this order:

| Step | It asks | Your answer for this walkthrough |
|---|---|---|
| Brief | Which brief to build from: one in the folder, one you name, a shipped example, or an interview that writes one | The shipped `quick-demo` brief, a one-endpoint ping service |
| Output | Where code and the run record go: `src/` and `.sdlc/runs/<run-id>/` | Keep both |
| Plan | Which model takes the judgment phases and which the mechanical ones, at the rates the bridge bills today | Read it |
| Start | A yes before anything is spent | `yes` |

Then it starts the run with `start-run.mjs`, which checks the session's model and effort, creates
the run folder, and prints the run id. A session on another model gets
`no run started: this session must run gpt-5.6-terra at effort high` and the two ways to fix it,
and nothing is created.

## 5. Answer the gates

The run stops four times and waits for you in the chat. Between gates it works without stopping:
it plans task packets, generates the code, writes tests, runs them, and reviews what it produced.

| Gate | When | You read | You reply |
|---|---|---|---|
| Gate 1 | After requirements | `.sdlc/runs/<run-id>/requirements.md` | `approved`, `revise: <what to change>`, or `abort` |
| Gate 2 | After the design | `design.md` in the run folder | the same |
| Gate 3 | After the security review | `security_review.md` in the run folder | the same |
| Gate 4 | At the end | `SUMMARY.md`: dispatched cost, file count, test results | `accept`, or `reject: <what to change>` |

`<run-id>` is the id the start step printed, such as `20261014-091500-greenfield-3f9a1c`. Each
answer is a line in `gates.jsonl` in the run folder. After `accept`, the run records its end:
the conductor's own cost, `manifest.json`, `SUMMARY.md` and `report.md`.

## 6. Look at what it built

```bash
ls -R src
cd src && npm install && npm test
npm start &
curl -i localhost:3000/ping     # 200, JSON with a status and a timestamp
curl -i localhost:3000/nope     # 404, JSON error
```

## 7. Find the record and the cost

Everything a run leaves is in the project:

| What | Where |
|---|---|
| Generated code | `src/` |
| The run's folder | `.sdlc/runs/<run-id>/` |
| What the run produced, gated | `requirements.md`, `design.md`, `security_review.md`, `SUMMARY.md` in the run folder |
| Gate answers | `gates.jsonl` in the run folder |
| The cost report | `report.md` in the run folder; the run's last message also prints a `Cost report:` command that renders it again |
| The conductor's own cost | `driver-usage.json` in the run folder, read from codex's session file |
| How the run started and ended | `run.json` and `orchestrator.log` in the run folder |
| The write guard's decisions (brownfield) | `.sdlc/local/guard-decisions.jsonl` |

The report's bottom lines:

| Line | What it is |
|---|---|
| `Dispatched total` | Every model call the bridge made for this run |
| `Driver loop — modeled` | The conductor's own tokens at the dated price list's rates |
| `Run total = dispatched + driver` | The two added |
| `Vendor-metered total` | What vendors bill per token |
| `Modeled (seat) total` | Token counts at API rates that no vendor billed per token, such as a conductor on a ChatGPT seat |

The run's end runs inside the conductor's last turn, so its own figure is marked `PROVISIONAL`.
Once the session has moved on, read it again from a shell in the project folder (with your run
id in place of `<run-id>`):

```bash
PLUGIN="$(ls -d ~/.codex/plugins/cache/tilicho-ai-labs/mmo-codex/*/ | tail -1)"
node "${PLUGIN}scripts/collect-driver-usage.mjs" .sdlc/runs/<run-id>
node "${PLUGIN}scripts/report.mjs" .sdlc/runs/<run-id> --markdown > .sdlc/runs/<run-id>/report.md
```

[understanding-output.md](understanding-output.md) explains every line, and
[headless-runs.md](headless-runs.md) checks the conductor's figure against codex's own token count.

## 8. A brownfield run

Brownfield works on a repository you already have. The plugin ships a small one with a known bug:
`POST /login` returns 500 when the password is missing. Copy it out and make it a repository:

```bash
cp -R "$(ls -d ~/.codex/plugins/cache/tilicho-ai-labs/mmo-codex/*/ | tail -1)examples/brownfield-bugfix" ~/login-bug
cd ~/login-bug && printf 'node_modules/\n.sdlc/\n' > .gitignore
git init -q && git add -A && git commit -qm 'fixture'
codex -s danger-full-access -m gpt-5.6-terra -c model_reasoning_effort="high"
```

Run `$mmo-codex:setup` once in the new session, then start the job with its alias and the bug in
one line:

```
$mmo-codex:bugfix POST /login returns 500 when the password is missing
```

`$mmo-codex:brownfield` does the same and asks for the job type first. The seven aliases:

| Skill | Job |
|---|---|
| `$mmo-codex:bugfix` | Reproduce, diagnose and fix a defect, with a regression test |
| `$mmo-codex:docs` | API docs, README, ADRs, docstrings |
| `$mmo-codex:feature-extend` | A capability added to an existing endpoint or module |
| `$mmo-codex:feature-new` | A new subsystem: endpoint, storage, tests |
| `$mmo-codex:refactor` | Extract shared logic, with the full test suite as the check |
| `$mmo-codex:test` | Backfill tests to a coverage target |
| `$mmo-codex:deps` | Upgrade a dependency and patch what breaks |

On the first brownfield run in a repository it runs a pre-check, including one small paid
dispatch to each tier, recorded in `.sdlc/pre-check/telemetry.jsonl`. Then it reads the
repository (discovery), asks the remaining interview questions, and stops at Gate 0, before
anything in the repository is written:

| Gate 0 asks | What to check |
|---|---|
| Stack and test command | What discovery detected; correct either |
| Policy | The policy every dispatch in this run uses |
| Existing AI setup | Other agents' config files; off-limits unless you move one into scope |
| Intent | The job type |
| File scope | The allowlist the run may write, and what is off-limits |
| Cost | A typical range for this job on a repository this size |

Reply `approved`, `revise: <what to change>`, or `abort`. On `approved` the run freezes its write
contract and checks that the write hook ran. If you did not trust the hook in step 2, the run stops
here with `The write guard did not run in this session`: trust it with `/hooks`, then start the job
again. From Gate 0 on, a write outside the allowlist is refused, and each decision is a line in
`.sdlc/local/guard-decisions.jsonl` with `wired_by: "plugin"`.

Gates 1 to 4 follow, as in step 5, with the phases the job type needs: a bugfix run skips the
design phase and its gate unless the fix changes the design. After `accept`, the run ends its
write contract and prints `$mmo-codex:revert <run-id>`, which undoes every file the run changed,
from `.sdlc/runs/<run-id>/provenance.json`.

## What next

- A brief of your own: [brief-template.md](brief-template.md)
- Every option and what lands in the run folder: [running.md](running.md)
- Check the cost figures against codex's own count: [headless-runs.md](headless-runs.md)
- Something went wrong: [troubleshooting.md](troubleshooting.md)
