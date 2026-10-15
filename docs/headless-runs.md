# Check the cost with a headless run

You use the harness in a codex session ([tutorial-first-run.md](tutorial-first-run.md)). There,
the conductor's cost comes from one source: codex's session file, read at the run's end. A
headless run checks that reading. `run.mjs` drives the same pipeline from a shell with
`codex exec --json`, so codex reports every turn's tokens twice, once on the event stream and
once in its session file. At the run's end the harness compares the two, token for token. When
they agree, the session-file reader that prices every interactive run is proven on a real run.

> **For:** checking the cost figures, from a clone. **Also see:** [running.md](running.md) for
> every `run.mjs` flag · [understanding-output.md](understanding-output.md) for each line of the
> report · [methodology.md](methodology.md) for how a figure is derived

---

## What you need

| Need | Check | Why |
|---|---|---|
| Node 20 or newer | `node --version` | The driver and the bridge |
| codex CLI 0.151.0 or newer | `codex --version` | The conductor runs in `codex exec` |
| git | `git --version` | A brownfield run refuses a folder that is not a repository |
| `OPENAI_API_KEY` | `test -n "$OPENAI_API_KEY" && echo set` | `gpt-plus-flash` sends the judgment tier to the OpenAI API |
| `GEMINI_API_KEY`, or Google Cloud application-default credentials | `test -n "$GEMINI_API_KEY" && echo set` | The mechanical tier |
| A codex login | `codex login status` | The conductor's own session. Step 2 signs it in with your API key |

## 1. Get the harness and build the bridge

```bash
git clone https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness.git ~/mmo-codex
cd ~/mmo-codex
node plugin/codex/verify-setup.mjs --fix
git rev-parse --short HEAD
```

`--fix` installs the bridge's dependencies in `plugin/mcp/model-dispatch/` and builds it.
`run.mjs` needs nothing else from the clone: no root `npm ci`, no `tools/setup.mjs`, and no
`codex mcp add`. Check out the branch or tag you are checking before `--fix`, and note the
commit the last line prints: it goes in your record of the run. After a `git pull`, run `--fix`
again; `run.mjs` warns when the build is older than the bridge's source.

## 2. Use an API-key policy, and sign the conductor in with the key

`gpt-plus-flash` is the policy every published figure comes from. Pass it on every command, so no
project default changes what runs:

```bash
export OPENAI_API_KEY='your OpenAI API key'
export GEMINI_API_KEY='your AI Studio key'
unset MMO_SELECT
```

`unset MMO_SELECT` keeps the mechanical tier on the model door (one call per packet). A
`MMO_SELECT` left in your shell can move it to the agent door, which needs application-default
credentials and spends several times the tokens.

Then give the conductor a codex home of its own and sign it in with the same key, so OpenAI bills
the conductor's tokens and your own `~/.codex` login stays as it is:

```bash
export CODEX_HOME="$HOME/.codex-mmo-check"
mkdir -p "$CODEX_HOME"
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

`codex login status` should say you are logged in using an API key. `run.mjs` records that as
`driver_auth: "api_key"` in `driver-manifest.json`, and the report then tells you to compare the
conductor's tokens with the OpenAI usage dashboard (step 8). Keep `CODEX_HOME` exported in every
shell that runs or reads the run: codex writes the session files the check reads under
`$CODEX_HOME/sessions/`.

On a ChatGPT login instead, the run and the token check work the same way. Only the dashboard step
changes: OpenAI does not bill a seat's tokens, so the dashboard shows the judgment tier alone.

## 3. Check before you spend

From the project folder, once step 4 or 5 has created it, and before its `run.mjs` command:

```bash
node ~/mmo-codex/plugin/codex/verify-setup.mjs --project-root="$PWD"
```

Expect no `✗`. Ignore the `skills-discoverable` warning: a headless run renders the playbooks it
needs into its own folder. Add `--dry-run` to the run command in step 4 or 5 first: it prints the
resolved policy, the pin, the driver's price card, the run folder and the exact `codex exec` argv,
and exits without spawning codex.

## 4. A greenfield run

```bash
mkdir -p ~/mmo-runs/ping && cd ~/mmo-runs/ping
cp ~/mmo-codex/examples/quick-demo/brief.md brief.md
RUN="ping-$(date +%Y%m%d-%H%M%S)"
node ~/mmo-codex/plugin/codex/run.mjs \
  --brief=brief.md \
  --project-root="$PWD" \
  --mode=greenfield \
  --policy=gpt-plus-flash \
  --gates=auto-approve \
  --run-id="$RUN"
echo "exit $?"
```

The quick-demo brief takes about twenty minutes.

| Flag | Why it is there |
|---|---|
| `--mode=greenfield` | The folder is not a git repository. Greenfield passes codex `--skip-git-repo-check`; any other mode refuses a folder without git (exit 2). |
| `--policy=gpt-plus-flash` | The API-key policy, named on the command so a `.sdlc/project.json` default cannot change it. A `routing-policy.yaml` in the folder still wins, and `run.mjs` prints a notice when it does. |
| `--gates=auto-approve` | Nobody answers the gates. Each one is recorded as `auto-approved` in `gates.jsonl`. Without the flag, `run.mjs` asks you at the terminal, and refuses to start (exit 2) when stdin is not one. Use it on throwaway projects: it accepts a security review nobody read. |
| `--run-id="$RUN"` | Names the run folder, `.sdlc/runs/$RUN/`, so the commands below can find it. Each run gets its own folder, its own telemetry and its own $50 cost cap. |

## 5. A brownfield run

The plugin ships a small repository with a known bug. Copy it out, make it a repository, and
record the project's policy, which Gate 0 reads:

```bash
cp -R ~/mmo-codex/plugin/examples/brownfield-bugfix ~/mmo-runs/login-bug && cd ~/mmo-runs/login-bug
printf 'node_modules/\n.sdlc/\n' > .gitignore
git init -q && git add -A && git commit -qm 'fixture'
node ~/mmo-codex/plugin/scripts/setup-policy.mjs --policy=gpt-plus-flash --project-root="$PWD"
RUN="login-$(date +%Y%m%d-%H%M%S)"
node ~/mmo-codex/plugin/codex/run.mjs \
  --brief=intent_brief.md \
  --project-root="$PWD" \
  --mode=brownfield \
  --intent=bugfix \
  --seed='POST /login returns 500 when the password is missing' \
  --policy=gpt-plus-flash \
  --gates=auto-approve \
  --run-id="$RUN"
echo "exit $?"
```

| Flag | Why it is there |
|---|---|
| `--mode=brownfield` | Discovery, Gate 0 and the write contract run. The code directory is the repository root. |
| `--brief=intent_brief.md` | The fixture's intent brief. A brownfield run under `run.mjs` needs a brief file; nobody is there to answer the interview. |
| `--intent=bugfix`, `--seed=…` | Answer the job-type question and the interview's first question, which an unattended run cannot ask. A question the run cannot go on without stops it (exit 4) with the question in `stop.json`. |

`run.mjs` registers the write hook for every `codex exec` it starts, so the brownfield run is
guarded without a trust step. Its decisions go to `.sdlc/local/guard-decisions.jsonl` with
`wired_by: "run"`.

## 6. Read the cost

```bash
cat ".sdlc/runs/$RUN/report.md"
```

The run's end writes `report.md`. The same report in the terminal, from the records the run left:

```bash
node ~/mmo-codex/plugin/scripts/report.mjs ".sdlc/runs/$RUN"
```

| Report line | What it is |
|---|---|
| `Outcome` | `completed (exit 0)` only when Gate 4 was accepted and `write-manifest.mjs` wrote `SUMMARY.md` after it. Any other outcome is not a finished run; see the exit codes below. |
| `Dispatched total` | Every model call the bridge made, from `telemetry.jsonl`. On `gpt-plus-flash` these are vendor-metered (`V`), or estimated (`E`) where a call returned no usage. |
| `Driver loop — modeled` | The conductor's own tokens at the dated price list's rates, read from codex's session file. Modeled, because codex reports tokens and no money. |
| `Run total = dispatched + driver` | The two added. `at least`, `at most` or `about` in front means the figure is not exact; the notes under it say why. |
| `Vendor-metered total` | The share vendors bill per token: vendor and estimated dispatches. |
| `Modeled total` | The conductor, plus any modeled dispatch. It reads `Modeled (seat) total` when the conductor was not signed in with an API key. |
| `Window` | The run's start and end in UTC, from `driver-manifest.json`. Step 8 uses it. |

| Exit | Outcome | What to do |
|---|---|---|
| 0 | `completed` | Read the cost. |
| 1 | `codex_failed`, `pin_rejected` | Read the stderr lines the driver printed, kept in `driver-stderr.log`. |
| 2 | — | A usage error or a refusal before anything was spent. The message names the flag or the reason. |
| 3 | `max_turns` | Continue with the `Continue:` command the driver printed. Add `--max-turns=24` for a larger brief. |
| 4 | `aborted`, `halted`, `refused`, `stopped`, `cost_cap` | A stop on purpose. The `run <run-id>: <outcome> — <reason>` line the driver prints, and `outcome_reason` in `driver-manifest.json`, say which. |
| 128+n | `interrupted` | The driver received signal n. Continue with the `Continue:` command. |

## 7. Check the conductor's tokens against codex's own count

This is the check the headless run exists for. The report prints it under the driver figure:

```
  Token cross-check: exec stream / session file (session minus exec)
    thread 019a…a1 — equal: input 100000/100000 (0) · cached input 80000/80000 (0) · output 5000/5000 (0) · reasoning 1300/1300 (0)
    invocation 1 — equal: input 40000/40000 (0) · cached input 30000/30000 (0) · output 2000/2000 (0) · reasoning 500/500 (0)
    invocation 2 — equal: input 60000/60000 (0) · cached input 50000/50000 (0) · output 3000/3000 (0) · reasoning 800/800 (0)
```

Each cell is `exec stream/session file (difference)`, the difference being the session file minus
the exec stream. An invocation's status compares the two figures printed on its line. A thread's
status also counts its invocations, so a thread whose invocations differ in opposite directions
reads `mismatch` beside a difference of `0`. The two sources:

| Source | Where | What it reports |
|---|---|---|
| Exec stream | `driver-events.jsonl`: each `turn.completed` that `codex exec --json` printed | The thread's running total. An invocation's own share is its total minus the one before. |
| Session file | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread id>.jsonl`, named in `driver-usage.json` `threads[].rollout_file` | One usage record per model response. This is the only source an interactive run has. |

The buckets are codex's own. `input` includes `cached input`, and `reasoning` is part of
`output`, so do not add them again.

| Verdict | Meaning | What to do |
|---|---|---|
| `equal` on every thread and invocation, every difference `0` | The session-file reader books exactly the tokens codex reported. `Verification` reads `verified`. | Record the result: the interactive figure is proven on this run. |
| `equal_with_explained_gap` | Equal, and the session file also holds compaction calls or turns that never reported usage on the stream. On an invocation line, the difference is exactly those; the table below says which. | Verified. The booked figure includes those calls. |
| `differs` on an invocation, `mismatch` on its thread | A bucket disagrees by more than the table below explains. The report books the session file and marks the figure `UNVERIFIED`. | Keep the run folder and the session file, and report the bucket and the difference. |
| `unmatched` | No session-file turn falls inside that invocation. | As for `mismatch`. |
| `no_session_file` | No readable session file for the thread. The figure is booked from the exec stream. | Check that `CODEX_HOME` was the same in the shell that ran the run, then collect again (below). |
| `unexplained_gap`, `reset`, `no_exec_usage` | The totals cannot be matched: a gap with nothing to explain it, a running total that dropped, or a stream with no usage. | Keep the records and report the verdict. |

An invocation line's difference can have two explanations. The report and the collector name the
one that applies: after the line in the terminal, and under the table in `report.md`.

| Explanation | Sign of the difference | Why |
|---|---|---|
| `N compaction call(s) only in the session file` | Positive | codex leaves compaction calls out of its running total; the session file records each one. |
| `the running total also counts invocation N, which reported no usage` | Negative | The earlier invocation's turns are inside this invocation's running total, and the session file records them under the earlier invocation. |

For the same numbers as JSON:

```bash
node ~/mmo-codex/plugin/scripts/report.mjs ".sdlc/runs/$RUN" --json \
  | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify(r.driver.token_check, null, 2))'
```

To read the session file again, for example after fixing `CODEX_HOME`, collect it and render the
report again:

```bash
node ~/mmo-codex/plugin/scripts/collect-driver-usage.mjs ".sdlc/runs/$RUN"
node ~/mmo-codex/plugin/scripts/report.mjs ".sdlc/runs/$RUN" --markdown > ".sdlc/runs/$RUN/report.md"
```

The collector rewrites `driver-usage.json` and prints the same comparison, one line per thread and
per invocation. A match proves token counts. The dollars follow from the dated price list
(`plugin/mcp/model-dispatch/src/prices.ts`), whose `gpt-5.6-terra` card matches OpenAI's pricing
page as of 2026-10-13; the report's `Price` line shows the card it used.

## 8. Check against the OpenAI usage dashboard

With the conductor and the judgment tier both on your API key, OpenAI's own usage figures are the
last check. The window:

```bash
node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(m.started_at, "->", m.ended_at, "UTC, driver_auth", m.driver_auth)' ".sdlc/runs/$RUN/driver-manifest.json"
```

The conductor's tokens:

```bash
node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tokens; console.log({ input: t.input_tokens, cached_input: t.cached_input_tokens, output: t.output_tokens })' ".sdlc/runs/$RUN/driver-usage.json"
```

The judgment tier's tokens, from the dispatches to `gpt-5.6-terra` (telemetry stores fresh input
apart from cached input, so the line adds them back):

```bash
node -e 'const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((e) => e.model === "gpt-5.6-terra"); const sum = (k) => rows.reduce((s, e) => s + (e[k] ?? 0), 0); console.log({ calls: rows.length, input: sum("input_tokens") + sum("input_tokens_cached"), cached_input: sum("input_tokens_cached"), output: sum("output_tokens") })' ".sdlc/runs/$RUN/telemetry.jsonl"
```

Open [platform.openai.com/usage](https://platform.openai.com/usage), set the date range to cover
the window, and read the `gpt-5.6-terra` token counts for your key. They should equal the
conductor's tokens plus the judgment tier's. Use a key nothing else uses during the window, or
the dashboard's figure holds other work too.

## If the run stops partway

| What you see | Cause | Do this |
|---|---|---|
| `cost_cap` (exit 4) | Dispatched cost plus the conductor's modeled cost reached the policy's `hard_cost_cap_usd` ($50). | Read the report; the run's figures up to the stop are in the folder. |
| `max_turns` (exit 3) | Twelve `codex exec` invocations were not enough. | Run the `Continue:` command with `--max-turns=24`. |
| `interrupted` (128+n) | You pressed Ctrl-C, or the terminal closed. | Run the `Continue:` command. |

The `Continue:` command is `node ~/mmo-codex/plugin/codex/run.mjs --resume="$RUN" --project-root="$PWD"`.
The run keeps its policy, mode, intent and gate mode, and appends to the same record. A completed
run does not resume, and neither does a brownfield run whose write contract ended `aborted`: its
`Continue:` line says so instead of printing a command.

## What to send back

| Item | Where |
|---|---|
| The run folder | `.sdlc/runs/$RUN/`, whole: `report.md`, `driver-usage.json`, `driver-manifest.json`, `driver-events.jsonl`, `telemetry.jsonl`, `gates.jsonl` |
| The guard log, for a brownfield run | `.sdlc/local/guard-decisions.jsonl` |
| The harness commit | `git -C ~/mmo-codex rev-parse --short HEAD` |
| The codex version | `codex --version` |
| The dashboard figures, on an API key | The token counts from step 8, and the window |
