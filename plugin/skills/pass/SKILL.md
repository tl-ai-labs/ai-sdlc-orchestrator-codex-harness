---
name: pass
description: "Headless, flag-driven SDLC run for CI or scripted replays. The non-interactive twin of the greenfield and brownfield entry points. Explicit invocation only."
---

The flag-driven twin of `$mmo-codex:greenfield` and `$mmo-codex:brownfield`, for scripted and CI use.

There are two ways to reach it, and they are not interchangeable.

# Shape 1 — from a shell, no session at all

This is what "headless" means here. The driver spawns its own `codex exec` conductor, feeds it the
pipeline, and exits when the run finishes. It is also how the cost figures are checked: the run's
end compares codex's own per-turn token counts with the session-file reading every interactive run
is priced from (`docs/headless-runs.md` in the repository). `<plugin-root>` is this plugin's own
folder, as Shape 2 below explains; from a clone it is `plugin`.

```bash
node '<plugin-root>/codex/run.mjs' \
  --brief=<path-to-brief.md> \
  --project-root=<path> \
  --gates=prompt|auto-approve|auto-abort \
  [--mode=greenfield|brownfield] \
  [--policy=<name>] \
  [--code-dir=<path>] \
  [--intent=<id>] \
  [--seed=<text>] \
  [--run-id=<id>] \
  [--output-dir=<path>] \
  [--max-turns=<n>] \
  [--resume=<run-id>] \
  [--dry-run]
```

| Flag | Purpose |
|---|---|
| `--brief=<path>` | The brief the run builds from. Greenfield takes a project brief; brownfield takes an intent brief. |
| `--project-root=<path>` | The repo the run works against. Defaults to the current directory. |
| `--output-dir=<path>` | Greenfield only: a different run folder, inside the project. Relative paths resolve against `--project-root`. It may not be the project root, a folder inside `.sdlc` other than the run's own, or a folder that overlaps the code directory. By default each run gets `<project-root>/.sdlc/runs/<run-id>/`. A run in a custom folder needs the same `--output-dir` again on `--resume`. |
| `--policy=<name>` | Routing policy for this run. Defaults to the project's `.sdlc/project.json` default, else `gpt-plus-flash`. A per-run override; it does not rewrite the project default. A `routing-policy.yaml` at the project root beats it. |
| `--code-dir=<path>` | Where generated code goes. Defaults to `<project-root>/src` for greenfield and the repo root for brownfield or no `--mode`. Relative paths resolve against `--project-root`; it must stay inside the project and outside `.sdlc`. |
| `--gates=<mode>` | Gate behavior. `prompt` (default) asks the person at the terminal at each gate, and relays the conductor's other questions the same way; it is refused when stdin is not a terminal. `auto-approve` accepts every gate — the one CI usually wants for a known-good replay. `auto-abort` stops at the first gate instead of answering it, so a run that drifts into needing a human never silently proceeds. |
| `--mode=<mode>` | `greenfield` or `brownfield`. Omit to let the conductor infer it from the brief and the repo; the driver then handles the run as brownfield (git required, code at the repo root). A folder that is not a git repository needs `--mode=greenfield`. |
| `--intent=<id>` | Brownfield job type: `docs`, `bugfix`, `feature-extend`, `feature-new`, `refactor`, `test`, or `deps`. Answers the "which job type?" question up front. Rejected alongside `--mode=greenfield`, which has no intents. |
| `--seed=<text>` | The job in the user's own words. Becomes the answer to the interview's first question, so only the remaining ones get asked: at the terminal under `--gates=prompt`, and not at all under an unattended mode, where the brief is drafted from the seed. |
| `--max-turns=<n>` | How many `codex exec` invocations one driver process may use (default 12). One turn is not enough for a real project — the session hits its context ceiling partway through — so the driver resumes the same session until the run ends. A gate answer's invocation does not count. |
| `--run-id=<id>` | Run identifier and run folder name. Defaults to `YYYYMMDD-HHMMSS-<intent or mode>-<6 hex>`. A run id that already has a record is refused; continue it with `--resume`. |
| `--resume=<id>` | Continue a stopped run: its run id, or the codex thread id it recorded. The run keeps its policy, mode, intent, code directory and brief; `--brief` is not needed, and a `--code-dir` or `--brief` naming another path is refused. A completed run is not resumed, and neither is a brownfield run whose write contract ended `aborted`. Resuming a run that stopped on purpose continues past that stop under the `--gates` you pass. The driver prints the exact command as `Continue:` when it stops, or says there is none. |
| `--dry-run` | Render the conductor prompt and the `codex exec` argv, print them, and exit without spawning anything or spending anything. |

`--dry-run` is the cheapest way to check a CI invocation is shaped correctly. Use it first.

**An unattended brownfield run needs `--intent`.** Under `--gates=auto-approve` there is nobody
to answer the guide's "which job type?" question, and stdin is closed. Pass the intent (and
ideally a `--seed`) so the run never reaches that question:

```bash
node '<plugin-root>/codex/run.mjs' --brief=intent-brief.md --project-root=. \
  --mode=brownfield --intent=bugfix --seed='login returns 500 on empty password' \
  --gates=auto-approve
```

Every run gets its own folder, and nothing from an earlier run is overwritten. The driver's exit
code says how the run ended:

| Exit | Meaning |
|---|---|
| 0 | Completed: Gate 4 accepted, and Phase 9's `write-manifest.mjs` re-run wrote `SUMMARY.md` after it |
| 1 | codex failed, or rejected the pinned model or effort |
| 2 | Usage error, or refused before spending anything |
| 3 | `--max-turns` reached before the run finished; continue with `--resume` |
| 4 | Stopped on purpose: an aborted gate, a preflight halt, a refused write, `stop.json`, or the cost cap |
| 128+n | Interrupted by signal n (130 for Ctrl-C); continue with `--resume` |

# Shape 2 — invoked as a skill inside a session

When the user invokes this skill directly with flags in their message, do not shell out to
`run.mjs` — you are already the conductor it would have spawned, and spawning another would bill
the same work twice. Instead, read the flags out of the user's text, resolve them against the
defaults in the table above, and start the run with the start script, which takes the same
spelling for the flags a session run uses:

```bash
node '<plugin-root>/codex/start-run.mjs' --mode=<greenfield|brownfield> [--policy=<name>] [--brief=<path>] [--code-dir=<path>] [--intent=<id>] [--gates=<mode>] [--run-id=<id>] [--resume=<run-id>]
```

`<plugin-root>` is this plugin's own folder: the path codex gave for this skill ends in
`/skills/pass/SKILL.md`, and the plugin root is that path with the ending removed. Pick `--mode`
yourself when the user did not: `greenfield` for a new app in a folder that is not a git
repository, `brownfield` otherwise. `--brief` is greenfield only; a brownfield intent brief goes to
the guide's step 4b. `--output-dir`, `--seed` and `--max-turns` belong to `run.mjs` only. If the
start script exits non-zero, show the user its message and stop. Show the user any `warning:` line
it prints before you go on.

It prints the run folder and the rendered playbooks. Follow the `playbook` it printed
(`<run folder>/skills/pipeline.md`); read only those rendered copies, never the plugin's own
`skills/*/SKILL.md`, which carry unfilled placeholders. For a greenfield run, hand the playbook
this from the start script's output:

- `mode: greenfield`
- `run_id:` the printed `run_id`. Do not generate another; every packet's `pass_id` uses it.
- `output_dir:` the printed `run_dir`. Wherever the playbook says `<output_dir>`, it means this
  folder.
- `code_dir:` the printed `code_dir`. Generated code goes here, and Phase 7 runs the tests here.
- `brief_path:` the printed `brief`.
- `policy:` the printed `policy`.
- `telemetry_path:` `telemetry.jsonl` in the run folder.

Honor `--gates` as written: under `auto-approve` print each gate block and continue without
waiting; under `auto-abort` print the gate and stop the run; under `prompt` (or when the flag is
absent) wait for the user as normal. The `gates:` line the start script printed is your gate
instruction for this run. Follow it at every gate, and record each decision as a new line in
`gates.jsonl` in the run folder, in the shape that line gives. The run's end record counts the run
as completed only after an accepted Gate 4 line there.

For a brownfield run, take the intent from the user's text and follow the `brownfield_guide` it
printed (`<run folder>/skills/brownfield-guide.md`) from step 4 with `intent:` pre-set — Gate 0
still fires, and under `auto-approve` it is answered rather than skipped.

When the run ends, record it with the `end_run` command the start script printed; the playbook's
"Run logging" section lists the outcomes.

# Requirements before starting

- The dispatch bridge must be built. `node '<plugin-root>/codex/verify-setup.mjs' --fix` builds
  it; `$mmo-codex:setup` wraps that with everything else.
- The credentials the resolved policy needs must be present. Preflight (pipeline phase -1) proves
  this before any billable phase runs — do not skip it, and do not start a run on a policy whose
  cheap tier cannot be reached.
- Brownfield additionally requires a git repo. `.sdlc/local/write-contract.json` is written after
  Gate 0 approval, before any packet dispatches; the write-contract hook reads it before every
  write.

# Output paths

- `output_dir`: `<project-root>/.sdlc/runs/<run-id>/` (greenfield may name another folder inside the
  project with `--output-dir`)
- `telemetry_path`: `<output_dir>/telemetry.jsonl`
- `manifest_path`: `<output_dir>/manifest.json`
- Brownfield also writes `<project-root>/.sdlc/runs/<run-id>/provenance.json` (and `backups/`
  beside it), the record `$mmo-codex:revert` reads, whatever `--output-dir` says

# Cost report

After the run:

```bash
node '<plugin-root>/scripts/report.mjs' '<output_dir>' --markdown
```

It prints `Run total = dispatched + driver` and splits that total into its vendor-metered and
modeled parts, so a modeled figure never reaches the vendor-metered total.
