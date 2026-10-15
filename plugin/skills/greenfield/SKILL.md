---
name: greenfield
description: "Generate a whole new application from a project brief into an empty folder, routing each SDLC phase to the model its policy names and reporting what every phase cost."
---

Run one full AI-SDLC pass against a brief. This skill takes no arguments. Everything it needs it
asks for.

Work through the steps in order. Do not skip a step because the answer seems obvious, and do not
start the run until step 5 is confirmed.

**Paths.** `<plugin-root>` in the commands below is this plugin's own folder. Codex gave you this
skill's file path with the skill; it ends in `/skills/greenfield/SKILL.md`, and the plugin root is
that path with the ending removed (two folders above this file). Put it in each command in place of
`<plugin-root>` and keep the single quotes: the path can contain spaces. If no path came with the
skill, `ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/mmo-codex/*/` lists the installed
copies; use the newest version.

# 0. Mode-detection guard — greenfield only

**Before anything else,** check the current directory. This is the **greenfield** entry point — it
generates a whole new application from a brief into `src/` under the current directory (the code
directory). If the user is standing in an **existing repo** (any of the signals below), they almost
certainly want `$mmo-codex:brownfield` instead, and running greenfield here would treat their real
code as an empty canvas.

Signals of an existing repo:
- the code directory (`src/`, or the one the user named) exists and is non-empty
- `.git/` exists with any tracked files (`git ls-files | head -1` returns a file)
- `package.json`, `pyproject.toml`, `go.mod`, or another stack manifest exists at repo root
- `README.md` exists and is longer than a stub (>200 bytes)

If any of these hold, **stop and offer the choice** before continuing:

> This looks like an existing repo, not an empty folder.
>
> - **`$mmo-codex:brownfield`** is for extending an existing project — pick one of seven job types
>   (docs / bugfix / feature-extend / feature-new / refactor / test / deps), confirm scope at
>   Gate 0, and run with a write contract that keeps your existing files untouched.
> - **`$mmo-codex:greenfield`** (this skill) will treat this folder as the target for a fresh generated
>   application. That may not be what you want.
>
> Which do you want to run? (`brownfield` / `force-greenfield` / `abort`)

Only proceed if the user replies `force-greenfield` or explicitly confirms they want greenfield in
this folder. If they reply `brownfield`, stop and tell them to invoke `$mmo-codex:brownfield`.

# 1. Check the setup before anything else

```bash
node '<plugin-root>/codex/verify-setup.mjs' --project-root "$(pwd)"
```

Read its exit code, not just its output.

- **Exit 1** — the harness cannot run. Show the user the reported problems and their fixes. If the
  problem is a missing dependency or an unbuilt bridge, offer to re-run the same script with
  `--fix`, which repairs both. **Stop here.** Do not start a run that will fail partway through and
  bill the user for the phases before the failure.
- **Exit 0 with warnings** — the run can proceed, but some policies cannot. Carry the warnings into
  step 4, where they decide which models are actually reachable.
- **Exit 0, clean** — continue.

# 2. Find the brief, or write one

The pipeline builds what a brief describes. Look for one in this order and stop at the first hit.

**a. A brief in the current directory.** Search for markdown files whose first heading begins
`# Project Brief`. If exactly one exists, name it and ask the user to confirm it is the right one.
If several exist, list them and ask which.

**b. A brief the user names.** If the user has a brief elsewhere, ask for the path and read it.

**c. A brief that ships with the harness.** Offer the three shipped examples, described in one line
each so the choice is meaningful. Say plainly how long each takes, because the difference is
minutes versus hours and the user is paying for it. All three paths are inside the installed
plugin, not the working directory — the user is typically standing in an empty folder, where no
repository file exists:
- `<plugin-root>/examples/quick-demo/brief.md` — a one-endpoint ping service on Express, no
  database. The one to pick to see the pipeline end to end: minutes, not hours, and a fraction of
  the cost.
- `<plugin-root>/examples/workforce-ops/brief.md` — HR and workforce operations: employees, time
  entries, leave approval, reporting, with encrypted PII and role-based masking. Five modules;
  expect an hour or more.
- `<plugin-root>/examples/travel-ops/brief.md` — travel booking operations: fare rules, holds,
  cancellation and refund computation, an append-only ledger, with encrypted traveller PII. Five
  modules; expect an hour or more.

Copy the chosen file to `brief.md` in the current directory before running, so the run record sits
beside the brief it was built from and the user can edit it for a second pass.

**d. No brief anywhere — write one.** This is the normal case in an empty folder. Interview the
user and write the brief for them. Ask, in plain language and one at a time:
1. What are we building, and who uses it?
2. What are the main areas of functionality? Push for concrete capabilities, not categories —
   "approve a leave request and debit the balance" produces better work than "leave management".
3. What must be true everywhere — validation, logging, authentication, audit?
4. What technology stack, if the user has one in mind? If they do not, propose the stack the
   shipped examples use and let them accept it.
5. What is explicitly not in this build?
6. How will they know it worked? Push for checks someone can run.

Write the answers into the section layout below, save it as `brief.md` in the current directory,
show it to the user, and get their approval before continuing. The brief is the single input to
everything downstream — a vague brief produces vague software, and the user cannot tell the
difference until the run has finished and the money is spent.

The requirements phase reads these headings by name. The wording under each is up to the author,
but the set is fixed:

```
# Project Brief — <project name>
## One-line summary
## Business context
## Scope                        (one `### 1. <Module name>` per bounded slice, capabilities bulleted)
## Cross-cutting requirements
## Tech stack (fixed)
## Non-functional
## Explicitly OUT of scope
## Acceptance criteria
```

Either shipped example in step 2c is a filled-in instance of this layout; read one if a section's
expected depth is unclear. [docs/brief-template.md](/docs/brief-template.md) carries the same
layout with per-section notes.

# 3. Confirm where the output goes

Unless the user says otherwise:

- Generated application code → `src/` under the current directory, or the folder the user names
  inside it
- Run record — telemetry, manifest, packets, reports → a new folder `.sdlc/runs/<run-id>/` under
  the current directory, which step 6 creates and names

Tell the user both paths. If the code directory already contains files, say so and ask before
writing into it.

# 4. Show what will run

State the routing plainly, as fact. Read the policy name written by setup:

```bash
node '<plugin-root>/scripts/setup-policy.mjs' --print-only --project-root "$(pwd)"
```

This prints the `default_policy` field setup wrote to `.sdlc/project.json`. If the output is empty,
setup was not run for this project — stop and tell the user to run `$mmo-codex:setup` first. Do not
proceed to spend anything without a policy the user has explicitly picked or explicitly kept as the
shipped default.

Load the policy through the dispatch server, which reports what each model bills today. The run
folder does not exist yet, so the result goes in `.sdlc/local/`:

```bash
node '<plugin-root>/codex/dispatch.mjs' --load-policy --policy=<resolved-name> \
  --project-root="$(pwd)" --out="$(pwd)/.sdlc/local/policy-preview.json"
```

A non-zero exit means the policy did not load: print stderr verbatim and stop. Otherwise read the
`--out` file: `rules` and `models` give the routing, and each `models[].effective_price` gives the
rates the dispatch server bills that model at on `effective_prices_on`, from its dated price list.

Report, in a short list:
- which model handles the judgment phases — requirements, design, task planning, senior review,
  security review
- which model handles the mechanical phases — codegen, tests, docs, debug
- the per-million input and output rates each one bills today, from `effective_price.rates`, so the
  user can see where the cost difference comes from. Quote these, never a model's `pricing:` block:
  the block is documentation unless `pricing_override` is set, and from 2027-01-01 a Gemini block
  can lag the list. When `effective_price.tiers` is non-empty, add one sentence: a request whose
  prompt, cached tokens included, is above `above_input_tokens` bills that tier's card for every
  token. When `effective_price.unpriced_reason` is set, say that the run will refuse that model and
  print the reason.

**Say which door the judgment tier goes through, and only if it is the seat one.** Two shipped
policies reach it two different ways. `gpt-plus-flash` calls the vendor API and the numbers on the
report are the vendor's own. `gpt-seat-plus-flash` routes judgment work through the local
`codex exec` binary on a ChatGPT subscription seat, which reports token counts but no money — so
its judgment cost is **modeled** from those counts at the price list's rates, and the report
labels it that way and keeps it out of the metered total. Say this in one sentence when the
resolved policy is the seat one. It is the difference between a bill and a calculation, and the
user should know which they are reading before the run starts, not after.

**Say which door the mechanical tier goes through, and only if it is the unusual one.** That tier
can be reached two ways: as a model call, which is the default, or as an Antigravity agent that
works in the folder directly. If `MMO_SELECT` names `flash-agsdk-worker`, this install has chosen
the agent — say so in one sentence, and say that it costs several times more per task than the same
model called directly, because an agent re-sends the conversation on every tool call. The rates
above are unchanged and still true; what changes is the token count. Add one more sentence, because
it is the thing that makes the extra spend inspectable rather than merely claimed: the run will
leave a `delegation/` directory beside the telemetry, holding the brief each worker was given and a
receipt for what it did, and the end-of-run report will carry a **Delegated to an agent worker**
section naming every delegated packet. Do not raise any of this when `MMO_SELECT` is unset, which
is the normal case — an unexplained aside about a path they are not on is noise, not transparency.

**Offer the two-cent probe, on that path only, and only if they have not run it.** Preflight
constructs the agent's adapter but never calls it, so three things stay unknown until the first
delegated packet: whether the project carries the Antigravity entitlement, whether the region
serves the model, and whether the credentials are still valid. All three fail *after* requirements,
design and task planning are billed to the judgment tier. Say that in one sentence and offer to run
`node '<plugin-root>/scripts/probe-agent-worker.mjs'` first — one trivial delegation, about two
cents, and it exits 0 or names the cause in words. If they decline, continue; the run is not
blocked on it.

This skill runs whatever `project.default_policy` resolves to. To change it for this project, the
user runs `$mmo-codex:policy change`. Do not launch the policy console from this flow; that skill owns it.

If step 1 reported missing Gemini credentials, say so here and explain the consequence in one
sentence: the mechanical phases cannot dispatch, so the run would fail at the first codegen packet.
Do not offer to route every phase to the judgment tier as a workaround — the cost saving this
harness exists to measure comes precisely from the phases that would have gone to the cheaper
model, so a run without them measures nothing. Fix the credential instead.

# 5. Confirm the plan, then start

Confirm the whole plan in one short summary — brief, output paths, policy, and which tier is
metered versus modeled — and get a yes before starting. This is the last free moment; everything
after it costs money.

There is no telemetry-mode choice to make. Every model call in this harness, judgment work
included, routes through the dispatch bridge so per-phase cost attribution survives; the bridge
reports whatever the vendor reports, and labels as `modeled` anything it had to derive.

# 6. Run

Start the run. Pass the brief from step 2 and the policy from step 4; add `--code-dir='<dir>'`
only when the user chose a code directory other than `src/`:

```bash
node '<plugin-root>/codex/start-run.mjs' --mode=greenfield --brief='<brief from step 2>' --policy=<policy from step 4>
```

It creates the run folder `.sdlc/runs/<run-id>/`, renders this run's playbooks into its `skills/`
folder with the real paths filled in, records the run in `run.json`, and prints the run id, the
folder, the `playbook` to follow, and the `end_run` command. If it exits non-zero, show the user
its message and stop. Show the user any `warning:` line it prints before you go on.

Read the `playbook` file it printed (`<run folder>/skills/pipeline.md`) and follow it from phase -1
(preflight) through phase 9, with this handover from the start script's output:

- `mode: greenfield`
- `run_id:` the printed `run_id`. Do not generate another; every packet's `pass_id` uses it.
- `output_dir:` the printed `run_dir`. Wherever the playbook says `<output_dir>`, it means this
  folder.
- `code_dir:` the printed `code_dir`. Generated code goes here, and Phase 7 runs the tests here.
- `brief_path:` the printed `brief`.
- `policy:` the printed `policy`.
- `telemetry_path:` `telemetry.jsonl` in the run folder.

Read only the rendered copies in `<run folder>/skills/`: the plugin's own
`skills/pipeline/SKILL.md` and `skills/brownfield-guide/SKILL.md` carry unfilled placeholders and
are not runnable as written.

There are four approval gates: after requirements, after design, after the security review, and
before final acceptance. Print each gate as it arrives and wait for the user; do not answer them on
the user's behalf. Record each decision as a new line in `gates.jsonl` in the run folder, as the
`gates:` line the start script printed shows.

When the run ends, record how it ended with the `end_run` command the start script printed (the
playbook's "Run logging" section lists the outcomes): `--outcome=completed` once Gate 4 is
accepted and the playbook's Phase 9 command has run again with `--status=accepted`, or the outcome and a one-line `--reason` when the run stops early — an aborted gate, a
preflight halt, a refused write, the cost cap. Run it before the report in step 7.

# 7. Report

When the run finishes, show:
- tokens per phase, split into cached input, fresh input, and output
- cost per phase and the `Run total = dispatched + driver` line, with its vendor-metered and
  modeled parts on their own lines
- which model each phase ran on, so the routing is visible rather than asserted
- where the generated code and the run record were written

The `end_run` command reads your own token usage from this session's codex session file into
`driver-usage.json`, writes `report.md` in the run folder, and prints the conductor's figure, the
run total, and a `Cost report:` line with the command that gives the same breakdown from the
records the run wrote:

```bash
node '<plugin-root>/scripts/report.mjs' '<run folder>' --markdown
```

Then stop. Do not propose follow-up runs.
