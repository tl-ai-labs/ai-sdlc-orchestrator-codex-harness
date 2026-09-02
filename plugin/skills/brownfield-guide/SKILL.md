---
name: brownfield-guide
description: "The shared seven-step operating manual for running the SDLC pipeline against an existing codebase. Every brownfield entry point delegates here, optionally handing over a chosen intent and the user's own description of the job."
---

You are the conductor, following this operating manual. Work through the steps in order. Do not skip
a step because the answer seems obvious. Do not begin the pipeline until Gate 0 is approved.

**Prerequisite check:** if the user has not yet run setup (install + build + credential check),
refuse politely and point them at SETUP.md. This command is for the task work; setup is one-time
per machine and happens separately.

**The handover.** The invoking command's prompt may contain a block naming `intent:` and/or
`seed_description:`. Read it before step 4:

- `intent: <id>` present — the job type is already chosen. Skip step 4a's question entirely;
  Gate 0 still re-confirms it. `<id>` must be one of the ids in
  [plugin/config/intents.json](/plugin/config/intents.json).
- `seed_description:` present and non-empty — the user's own words for the job, typed after the
  command. Step 4b treats this as the answer to the interview's first question and asks only the
  remaining ones.
- Neither present (the plain `$mmo-codex:brownfield` case) — step 4 runs exactly as written below: ask
  which job type, then run the full interview.

---

# 1. Setup-status check — resume or fresh

Before anything else, invoke:

```bash
node '{{PLUGIN_ROOT}}/scripts/session-hydrate.mjs' --json
```

Read the JSON. Three cases:

- **`resume.pending: true` with `kind: "setup"`** — a previous session died mid-setup. Print
  something like *"Setup was interrupted at section &lt;N&gt; — resuming shepherd from there..."*
  and re-run the remaining setup sections (see §3 below). Do **not** start Gate 0 until setup
  completes.

- **`resume.pending: true` with `kind: "run"`** — a previous task run was interrupted at phase
  &lt;phase&gt;. Print *"A previous &lt;intent&gt; run (`&lt;run_id&gt;`) was interrupted at phase &lt;phase&gt;.
  Would you like to resume it, or start fresh?"* Accept `resume`, `discard`, or `abort`. If
  `resume`, follow the resume path in [plugin/skills/pipeline/SKILL.md](../pipeline/SKILL.md).
  If `discard`, clear `.sdlc/local/state.json` and continue to step 2.

- **`resume.pending: null`** — normal flow. Print the one-line `marker` from the hydrate
  output (e.g. *"SDLC: 3 prior runs (last: docs, 2d ago); baseline at abc1234; no open resume
  checkpoint."*) so the user has context, then continue to step 2.

# 2. Pre-check the pipeline

Verify the machinery works on this specific repo before spending money on a real intent.

**On the first brownfield invocation per project** OR when `.sdlc/pre-check-status.json` is missing
OR when the baseline hint from step 1 says the baseline is stale, run the full 6-step pre-check.
Otherwise (cached, fresh, harness version unchanged), report *"pre-check cached from &lt;date&gt;,
all steps still valid"* and skip to step 3.

Script-side steps (2, 4, 5, 6) — you invoke via Bash:

```bash
node '{{PLUGIN_ROOT}}/scripts/pre-check.mjs' --run
```

Agent-side steps (1 = discovery smoke, 3 = dispatch smoke) — you run yourself:

1. **Discovery smoke.** Run the discovery read (see [discovery.md](discovery.md))
   with `mode: first-time` (or `refresh` if a baseline exists). Watch for a non-git-repo refusal
   or any hard error. On pass, record it:
   ```bash
   echo '{"note":"Tier 1 completed cleanly"}' | node '{{PLUGIN_ROOT}}/scripts/pre-check.mjs' --record discovery pass
   ```

3. **Dispatch smoke.** Construct a trivial `{ id: "smoke-1", phase: "codegen", task_type:
   "smoke", instruction: "Return the literal string OK", ... }` TaskPacket, write it to a file,
   and dispatch it to each policy tier the current policy uses (premium + mechanical for
   `gpt-plus-flash`):
   ```bash
   node '{{PLUGIN_ROOT}}/codex/dispatch.mjs' --packet=<smoke-packet.json> \
     --out=<smoke-result.json> --policy={{POLICY}} --project-root='{{PROJECT_ROOT}}'
   ```
   If both return their expected output within the timeout, record pass:
   ```bash
   echo '{"tiers_tested":["gpt","gemini-flash"]}' | node '{{PLUGIN_ROOT}}/scripts/pre-check.mjs' --record dispatch pass
   ```

If any pre-check step fails, **do not proceed to Gate 0.** Print the reported remediation and
offer inline choices (fix now / switch policy / abort). Do not kick the user out to external
fixes.

# 3. Discovery — Tier 1 (with adaptive profile if triggered)

If not already done during step 2's smoke:

Run the discovery read. It covers the repo (git state, stack manifests, off-limits, monorepo
signals, submodules, LFS, competing AI configs — see [discovery.md](discovery.md)
for the full read order) and writes:
- `.sdlc/runs/<run-id>/discovery.md` (per-run human-readable)
- `.sdlc/runs/<run-id>/baseline.json` (per-run pointer snapshot)
- `.sdlc/baseline/current.json` + `.sdlc/baseline/discovery.md` (living project baseline, on
  first-time or full refresh)
- `.sdlc/baseline/stack-profile.md` (Tier 2b, only when triggered — unknown stack, custom
  framework in AGENTS.md, or `--adaptive-profile` passed)

Wait for discovery to finish. If it refuses (non-git repo), stop here — the shepherd already
printed the git-init guidance.

# 4. Intent brief — pick the intent and describe the job

Two things to collect from the user. Both go into `.sdlc/runs/<run-id>/intent_brief.md`.

**a. Intent.**

- **Handover carries `intent: <id>`** — already chosen. Skip the question; read `title`,
  `summary`, and `interview` for `<id>` from
  [plugin/config/intents.json](/plugin/config/intents.json) and continue to step 4b.
- **No handover** — ask which job type. Show the seven options with one-line examples, drawn
  from `intents.json`'s `title` and `example` fields, so the choice is meaningful:

  - `docs` — write API docs, README, ADRs, docstrings for the auth module
  - `bugfix` — fix the /login endpoint returning 500 on missing password
  - `feature-extend` — add a `?filter` param to the existing /users endpoint
  - `feature-new` — add a webhooks module (endpoint, storage, retry loop)
  - `refactor` — extract shared date logic into a util module and update all call sites
  - `test` — backfill unit tests for src/payments to reach 80% line coverage
  - `deps` — upgrade jest 28 → 29 (and adapt breaking changes)

**b. Source — describe the specific job.** Three ways to get it:
- **Interview (default)** — ask the intent's `interview` questions from `intents.json` (2–4
  short questions), then draft the brief from the answers. **If the handover carries a non-empty
  `seed_description`**, treat it as the answer to the first question and ask only the rest. Show
  the draft back, ask to approve or edit.
- **Bring your own file** — if the user says they have a brief already, ask for the path.
  Read it, ask to confirm it's the right one.
- **Inline chat** — if the user just describes it in this message (and no `seed_description` was
  already supplied by the handover), capture their words verbatim into the brief.

**Task type — only when the chosen intent declares `task_types` in `intents.json`.** Ask one more
question after the interview above, offering each option's `label`: *"Which kind of &lt;intent&gt; job
is this — &lt;label 1&gt; or &lt;label 2&gt;?"* Record the chosen `id`. Intents with no `task_types` array
(everything except `docs`, for now) skip this — nothing changes for them.

Write the brief to `.sdlc/runs/<run-id>/intent_brief.md` with this heading contract:

```
# Intent Brief — <intent> — <short title>

## Context
## Goal
## Task type          (omit this heading entirely when the intent has no task_types)
## Files in scope
## Files off-limits
## Acceptance criteria
## Non-goals
```

"Task type" holds the chosen `id` verbatim (e.g. `doc_update`), not the label — Phase 4 in
`pipeline/SKILL.md` reads it back to set the generated TaskPacket's `task_type` field directly,
instead of inferring it from context. A policy can then route `doc_update` differently from
`doc_addition` via an ordinary `rules[].when.task_type` match — no new policy schema needed, since
`task_type` is already a routing key.

Fill in "Files in scope" and "Files off-limits" with your best guess based on discovery + intent
+ the user's description. These are proposals; Gate 0 lets the user adjust before commit.

# 5. Gate 0 — Discovery Confirmation

The one confirmation moment before real work begins. Fires unconditionally — even when the
handover pre-set `intent` and `seed_description`, nothing below is skipped. Print the gate
template from [plugin/skills/pipeline/SKILL.md](../pipeline/SKILL.md) (search for
"Gate 0"), filling in:

- **Stack** — top-detected from `baseline.stacks`. Ask if it's right; accept overrides.
- **Test command** — `baseline.test_command_proposed`. Accept an override.
- **Policy** — read `payload.project.default_policy` from the session-hydrate output already
  captured in step 1 of this command. This is what setup wrote to `.sdlc/project.json`. If
  it is null, setup was not completed for this project — abort Gate 0 and tell the user to
  run setup first (see [SETUP.md](/SETUP.md) §5b — the one setup step that opens a browser
  for the policy console). Do not silently default and do not launch the console from here.
  Otherwise show the resolved name; accept, or accept an on-disk policy name for this run only
  — a per-run override does not overwrite the project default.
- **Existing AI setup** — verbatim list from `baseline.ai_configs_detected`. Default is
  **OFF-LIMITS** for all of them. User can move any into the allowlist by naming it explicitly.
- **Intent** — from step 4a. Re-confirm, even when the handover pre-set it.
- **File scope** — the allowlist and off-limits proposed from step 4b. Let the user edit.

Reply options: `approved` / `revise: <comments>` / `abort`.

**Cost projection (single line at the bottom, before the reply prompt).** From a rough
per-intent × baseline-size table, print *"Typical cost for a &lt;intent&gt; run on a repo this size:
$X–$Y. Approve or abort."* No dedicated mini-gate; the projection is informational and part
of Gate 0's approve/revise/abort.

**Repo-state risks (surface here, don't defer).** If discovery found LFS, submodules,
encrypted secrets, failing tests before we started, or an aggressive .gitignore, list them as
extra confirmation lines with the harness's default behavior. Example:
> ⚠ `.gitmodules` present — submodules will be treated as opaque; the harness will never write
>   into them. Continue? [assumed yes unless you say otherwise]

On `approved`:
1. Freeze the confirmed allowlist + off-limits into `.sdlc/local/write-contract.json`
   ({ schema_version:1, active:true, mode:"brownfield", run_id, strict:true, allowlist,
   off_limits }). The PreToolUse hook (plugin/codex/hooks/write-contract-check.mjs) reads this
   file before every write and refuses off-limits or not-in-allowlist paths at the tool
   boundary.
2. Update `.sdlc/runs/<run-id>/intent_brief.md` with the final scope.
3. Continue to step 6.

On `revise: <comments>` — rewrite the affected parts and re-show Gate 0.

On `abort` — clear `.sdlc/local/write-contract.json` (set active:false), do not delete the
run directory (leave it as a partial record), and stop.

# 6. Run the pipeline

Follow [plugin/skills/pipeline/SKILL.md](../pipeline/SKILL.md) with:
- `mode: brownfield`
- `intent: <from Gate 0>`
- `run_id: <YYYYMMDD-HHMMSS-<intent>-<slug>>`
- `intent_brief_path: .sdlc/runs/<run-id>/intent_brief.md`
- `baseline_path: .sdlc/baseline/current.json`
- `policy: <as configured by setup — see the Policy bullet of Gate 0>`
- `code_dir: <the project's working directory — the repo root, since edits land across the
  existing tree, not into one generated folder>`
- `output_dir: .sdlc/runs/<run-id>` — where `requirements.md`, `design.md`,
  `security_review.md`, `packets.json`, `telemetry.jsonl`, `manifest.json`, and the final report
  land for this run.

Drive phases 1 through 9 with gates 1, 2, 3, 4 as usual — but branched by intent (see the Intent
matrix in SKILL.md). At each gate, print the gate prompt and wait for the user; do not answer on
their behalf.

# 7. Close out

After the final report:

1. Append a row to `.sdlc/ledger.md` (human-readable) and `.sdlc/ledger.json` (machine mirror).
2. Update the project fingerprint record with a link to the ledger.
3. Clear the write-contract state: set `.sdlc/local/write-contract.json` active:false.
4. Print the report to the user with cost breakdown, files touched, and (if applicable) the
   `git reset` command the report provides as the escape hatch.

Do not propose a follow-up run.

# Flag surface (headless / repeat runs)

`$mmo-codex:pass` is the flag-driven twin of every brownfield entry point for scripted / CI invocations:

```bash
node plugin/codex/run.mjs \
  --brief=<intent-brief.md> --project-root=<path> --output-dir=<path> \
  --mode=brownfield \
  --intent=<docs|bugfix|feature-extend|feature-new|refactor|test|deps> \
  --seed='<the job in one line>' \
  --gates=<prompt|auto-approve|auto-abort> \
  --policy=<name>
```

Flags take the `--name=value` form. `--name value` is not parsed — the value is dropped and the
flag reads as a bare `true`.

`--mode`, `--intent` and `--seed` supply the handover described at the top of this file, so
step 4 does not ask what it has already been told. **An unattended run needs at least
`--intent`**: under `--gates=auto-approve` there is no user to answer step 4a's question and
stdin is closed.

See [the pass skill](../pass/SKILL.md) for the full flag contract.
