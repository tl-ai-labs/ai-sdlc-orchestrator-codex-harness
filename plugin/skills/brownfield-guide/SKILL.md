---
name: brownfield-guide
description: "The shared seven-step operating manual for SDLC work on an existing codebase. Every brownfield entry point renders a copy into .sdlc/runs/<run-id>/skills/brownfield-guide.md and follows that; this file is not runnable as is. Start with $mmo-codex:brownfield or a job type's own skill."
---

**Follow only the rendered copy.** If the file you opened ends in
`/skills/brownfield-guide/SKILL.md`, it is the plugin's unrendered source: its commands hold
double-brace markers where real paths belong, and none of them runs. Do not follow it. Follow the
`brownfield` skill at `<plugin-root>/skills/brownfield/SKILL.md` instead, where `<plugin-root>` is two
folders above this file, or the job type's own skill (`<plugin-root>/skills/bugfix/SKILL.md` and so
on) when the user already named one. Its start script renders a runnable copy of this manual into
`.sdlc/runs/<run-id>/skills/brownfield-guide.md`.

You are the conductor, following this operating manual. Work through the steps in order. Do not skip
a step because the answer seems obvious. Do not begin the pipeline until Gate 0 is approved.

**Prerequisite check:** if the user has not yet run setup (install + build + credential check),
refuse politely and point them at SETUP.md. This command is for the task work; setup is one-time
per machine and happens separately.

**Every stop ends the run's record.** Wherever this manual stops — setup not done, a failed
pre-check, a Gate 0 `abort` — and once the run completes, record the end with the end command in
the pipeline playbook's "Run logging" section (`{{OUTPUT_DIR}}/skills/pipeline.md`) and the
outcome it lists. On the `run.mjs` route the driver records it instead.

**The handover.** The invoking command's prompt may contain a block naming `intent:` and/or
`seed_description:`. Read it before step 4:

- `intent: <id>` present — the job type is already chosen. Skip step 4a's question entirely;
  Gate 0 still re-confirms it. `<id>` must be one of the ids in
  `{{PLUGIN_ROOT}}/config/intents.json`.
- `seed_description:` present and non-empty — the user's own words for the job, typed after the
  command. Step 4b treats this as the answer to the interview's first question and asks only the
  remaining ones.
- Neither present (the plain `$mmo-codex:brownfield` case) — step 4 runs exactly as written below: ask
  which job type, then run the full interview.

---

# 1. Setup-status check — resume or fresh

Before anything else, invoke:

```bash
node '{{PLUGIN_ROOT}}/scripts/session-hydrate.mjs' --json --sdlc='{{PROJECT_ROOT}}/.sdlc' --run-id={{RUN_ID}}
```

`--run-id` is this run, so it is never offered as its own resume. Read the JSON. Three cases:

- **`resume.pending: true` with `kind: "setup"`** — a previous session died mid-setup. Print
  something like *"Setup was interrupted at section &lt;N&gt; — resuming shepherd from there..."*
  and re-run the remaining setup sections (see §3 below). Do **not** start Gate 0 until setup
  completes.

- **`resume.pending: true` with `kind: "run"`** — a previous task run was interrupted at phase
  &lt;phase&gt;. Print *"A previous &lt;intent&gt; run (`&lt;run_id&gt;`) was interrupted at phase &lt;phase&gt;.
  Would you like to resume it, or start fresh?"* Accept `resume`, `discard`, or `abort`. If
  `resume` in a session: end this session's new run (`--outcome=stopped`, reason `resumed run
  <run_id>`), run `node '{{PLUGIN_ROOT}}/codex/start-run.mjs' --resume=<run_id>`, and follow the
  playbooks it prints from the first incomplete phase. When it prints a `guard_check:` line, run
  that command first, in a shell call of its own, before any write: this session may not run the
  write hook (a hook the user has not trusted, or one an update changed). If it exits non-zero,
  print its message and stop; it has ended the run and switched its contract off. When
  `resume.route` is `headless`, that run was started by `run.mjs` and resumes only there
  (`run.mjs --resume=<run_id>`), so offer `discard` and `abort` only. If `discard`, end that run
  first, so its write contract stops binding:
  ```bash
  node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --abandon --run-id=<run_id> --reason='discarded at resume' --project-root='{{PROJECT_ROOT}}'
  ```
  An exit 2 saying the run holds no write contract means it never reached Gate 0; carry on. Then
  record that run's end, so it is not offered again. When `.sdlc/runs/<run_id>/run.json` exists:
  ```bash
  node '{{PLUGIN_ROOT}}/codex/end-run.mjs' --run-dir='{{PROJECT_ROOT}}/.sdlc/runs/<run_id>' --outcome=stopped --reason='discarded at resume'
  ```
  Otherwise delete that run's gate-pending state (`.sdlc/runs/<run_id>/state.json`). Then continue
  to step 2.

  When `resume.write_contract` is `"live"`, that run never ended: its write contract still binds
  this repository in every Codex session, and `phase` may be `null`. Say so in the question:
  *"Run `<run_id>` still holds this repository's write contract, so every write outside its scope
  is refused until you resume or discard it."*

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
   `gpt-plus-flash`). Give every smoke packet `"budget": { "maxInputTokens": 1000,
   "maxOutputTokens": 3000 }`, and no smaller output cap: Gemini Flash spends its thinking from the
   output budget, about 2,900 tokens even for this one-word answer, so a cap of a few hundred
   fails the smoke on a healthy tier.
   ```bash
   node '{{PLUGIN_ROOT}}/codex/dispatch.mjs' --packet=<smoke-packet.json> \
     --out=<smoke-result.json> --policy={{POLICY}} --project-root='{{PROJECT_ROOT}}' \
     --telemetry='{{PROJECT_ROOT}}/.sdlc/pre-check/telemetry.jsonl'
   ```
   The smoke calls are paid, so they are recorded like any other dispatch. They check this
   project, not this run: the result is cached in `.sdlc/pre-check-status.json` for later runs, so
   their cost goes to the pre-check's own telemetry file and stays out of this run's total and its
   cost cap.
   If both return their expected output within the timeout, record pass:
   ```bash
   echo '{"tiers_tested":["gpt","gemini-flash"]}' | node '{{PLUGIN_ROOT}}/scripts/pre-check.mjs' --record dispatch pass
   ```

**Dispatch needs an unsandboxed session.** `dispatch.mjs` reaches the bundled bridge by spawning
it and talking over pipes, and codex's sandbox denies piped stdio under both its default and
`workspace-write` modes. Under those, step 3 fails with `MCP error -32000: Connection closed` —
which is not a crashed or unbuilt server. The bridge prints the two ways out when it detects this;
relay them rather than debugging the server:

- start codex with `codex -s danger-full-access`, or
- run the pipeline headlessly from a shell, where the driver spawns the bridge outside codex:
  `node '{{PLUGIN_ROOT}}/codex/run.mjs' --brief=<intent brief file> --project-root='{{PROJECT_ROOT}}' --mode=brownfield --intent=<intent>`
  (it asks at the terminal at each gate)

If any pre-check step fails, **do not proceed to Gate 0.** Print the reported remediation and
offer inline choices (fix now / switch policy / abort). Switching policy restarts the run, as
Gate 0's Policy line describes. Do not kick the user out to external fixes.

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

Two things to collect from the user. Both go into `.sdlc/runs/<run-id>/intent_brief.md`. On the
`run.mjs` route, every question in this step goes to the user the way your gate instruction says:
under `--gates=prompt` through `question.json`, one question per turn; under the unattended modes
it is not asked, and a question the run cannot go on without stops the run with the question in
`stop.json`'s `needs` field.

**a. Intent.**

- **Handover carries `intent: <id>`** — already chosen. Skip the question; read `title`,
  `summary`, and `interview` for `<id>` from
  `{{PLUGIN_ROOT}}/config/intents.json` and continue to step 4b.
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

"Task type" holds the chosen `id` verbatim (e.g. `doc_update`), not the label — at Phase 4,
`plan-packets.mjs` reads it back, gives it to the planner, and refuses a plan whose packets carry
any other `task_type`, instead of leaving it to inference. A policy can then route `doc_update`
differently from `doc_addition` via an ordinary `rules[].when.task_type` match — no new policy
schema needed, since `task_type` is already a routing key.

Fill in "Files in scope" and "Files off-limits" with your best guess based on discovery + intent
+ the user's description. These are proposals; Gate 0 lets the user adjust before commit.

# 5. Gate 0 — Discovery Confirmation

The one confirmation moment before real work begins. Fires unconditionally — even when the
handover pre-set `intent` and `seed_description`, nothing below is skipped. Print the gate
template from the pipeline playbook, `{{OUTPUT_DIR}}/skills/pipeline.md` (search for
"Gate 0"), filling in:

- **Stack** — top-detected from `baseline.stacks`. Ask if it's right; accept overrides.
- **Test command** — `baseline.test_command_proposed`. Accept an override.
- **Policy** — read `project.default_policy` from the session-hydrate output already
  captured in step 1 of this command. This is what setup wrote to `.sdlc/project.json`. If
  it is null, setup was not completed for this project — abort Gate 0 and tell the user to
  run `$mmo-codex:setup` first, or, from a shell,
  `node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --policy=<name> --project-root='{{PROJECT_ROOT}}'`.
  Do not silently default and do not launch the policy console from here.
  Otherwise show `{{POLICY}}`, the policy this run dispatches with. It was resolved when the run
  started and every dispatch command in the playbook already carries it, so it cannot change
  mid-run. If the user names another on-disk policy, restart the run with it: in a session, end
  this run (`--outcome=aborted`, reason `restart with policy <name>`), run
  `node '{{PLUGIN_ROOT}}/codex/start-run.mjs' --mode=brownfield --intent=<confirmed intent> --policy=<name>`,
  and follow the guide it prints from step 1, reusing the answers the user already gave. On the
  `run.mjs` route, record Gate 0 as `aborted` with that note and tell the user to rerun with
  `--policy=<name>`. A `routing-policy.yaml` at the project root outranks `--policy`; when the
  start script printed `(from routing-policy.yaml)`, say that file decides the policy instead of
  restarting. Neither way changes the project default.
- **Existing AI setup** — verbatim list from `baseline.ai_configs_detected`. Default is
  **OFF-LIMITS** for all of them. User can move any into the allowlist by naming it explicitly.
- **Intent** — from step 4a. Re-confirm, even when the handover pre-set it.
- **File scope** — the allowlist and off-limits proposed from step 4b. Let the user edit.

Reply options: `approved` / `revise: <comments>` / `abort`. Record the answer as a Gate 0 line in
`{{OUTPUT_DIR}}/gates.jsonl`, in the shape the pipeline playbook's "Gate record" paragraph gives,
and log the gate (`--gate=0`) as its "Run logging" section says.

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
1. Freeze the write contract with the lists confirmed above, each as a JSON array of path globs:
   ```bash
   node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --freeze --run-id={{RUN_ID}} \
     --allowlist='<allowlist JSON>' --off-limits='<extra off-limits JSON>' \
     --intent=<intent> --project-root='{{PROJECT_ROOT}}'
   ```
   `{{RUN_ID}}` is this run's folder name under `.sdlc/runs/`; the run's end and its resume find
   the contract by it. `<intent>` is the intent confirmed above (`bugfix`, `docs`, ...).
   `--off-limits` carries only what this run adds: the AI configs from discovery and the paths
   the user named. The script merges the project defaults from `.sdlc/project.json` itself.
   Add `--strict-write=off` only when the user asked for out-of-scope writes to be warned about
   rather than refused. Never write `.sdlc/local/write-contract.json` yourself: the write hook
   ({{PLUGIN_ROOT}}/codex/hooks/write-contract-check.mjs) refuses it while the run is live, and a
   contract whose bytes change after the freeze makes the hook refuse every write. If the script
   exits non-zero, print its message to the user and stop.
2. Update `.sdlc/runs/<run-id>/intent_brief.md` with the final scope.
3. Prove the write hook runs in this session, with a command of its own:
   ```bash
   node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --assert-guard-live --run-id={{RUN_ID}} --project-root='{{PROJECT_ROOT}}'
   ```
   Never put this check in the same shell call as the freeze: the hook judges a call once,
   before it runs, so that call leaves no hook record after the freeze and the check fails.
   If it exits non-zero, print its message and stop. A message that says the write guard did not
   run means no hook decision was recorded for this run since the freeze: Codex skips an
   untrusted or changed plugin hook without a word. The script has already ended the run and
   switched its contract off, and its message tells the user how to trust the hook.
4. Continue to step 6.

From here until close-out the run writes freely inside `.sdlc/runs/<run-id>/` (except the
contract's lock, its frozen copy, the rendered `skills/`, `provenance.json` and `backups/`) and
elsewhere only inside the allowlist.

The freeze also opens the run's provenance record, `.sdlc/runs/<run-id>/provenance.json`, the
input `$mmo-codex:revert` reads. The write hook snapshots each file before the first write to it
lands, backing up a file that held uncommitted or untracked content, and close-out reconciles the
record against `git status` and the run's commits. Do not run `write-provenance.mjs` yourself,
and do not write under `.sdlc/runs/<run-id>/backups/`.

On `revise: <comments>` — rewrite the affected parts and re-show Gate 0.

On `abort` — nothing is frozen yet. Do not delete the run directory (leave it as a partial
record), record the end (`--outcome=aborted`), and stop.

# 6. Run the pipeline

Follow the pipeline playbook, `{{OUTPUT_DIR}}/skills/pipeline.md`, with:
- `mode: brownfield`
- `intent: <from Gate 0>`
- `run_id: {{RUN_ID}}` — the id the invoking route handed over. Do not generate another; the
  write contract and every packet's `pass_id` use this one.
- `intent_brief_path: .sdlc/runs/<run-id>/intent_brief.md`
- `baseline_path: .sdlc/baseline/current.json`
- `policy: <as configured by setup — see the Policy bullet of Gate 0>`
- `code_dir: <the project's working directory — the repo root, since edits land across the
  existing tree, not into one generated folder>`
- `output_dir: {{OUTPUT_DIR}}` (that is, `.sdlc/runs/<run-id>`) — where `requirements.md`,
  `design.md`, `security_review.md`, `packets.json`, `telemetry.jsonl`, `gates.jsonl`,
  `state.json`, `manifest.json`, and the final report land for this run. Every
  `.sdlc/runs/<run-id>/` path in this guide is this folder.

Drive phases 1 through 9 with gates 1, 2, 3, 4 as usual — but branched by intent (see the Intent
matrix in the pipeline playbook). At each gate, print the gate prompt and follow the gate
instruction you were given (in a session, the `gates:` line the start script printed), and append
the decision to `{{OUTPUT_DIR}}/gates.jsonl` as the playbook's "Gate record" paragraph says. Never
answer a gate on the user's behalf. Phase 7 runs the test command from the repo root.

# 7. Close out

When the user replies `accept` at Gate 4, record it in `.sdlc/runs/<run-id>/gates.jsonl` as
`accepted`, one line:

```json
{"gate": 4, "artifact": "SUMMARY.md", "decision": "accepted", "note": "<one line>", "ts": "<ISO 8601 time>"}
```

Then, in the same turn:

1. End the run and switch its write contract off:
   ```bash
   node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --close --run-id={{RUN_ID}} --project-root='{{PROJECT_ROOT}}'
   ```
   It also closes the run's provenance record and prints how many files it holds and the
   `$mmo-codex:revert <run-id>` command that undoes the run. It refuses while `gates.jsonl`
   records neither an accepted Gate 4 nor an abort. If it exits non-zero, print its message and
   stop: the message names the `--abandon` command the user runs to end the run. The ledger
   below sits outside the run's folder, so it is written only after this step.
2. Append a row to `.sdlc/ledger.md` (human-readable) and `.sdlc/ledger.json` (machine mirror).
3. Update the project fingerprint record with a link to the ledger.
4. Run Phase 9's write-manifest command again with `--status=accepted` (or
   `--status=auto-approved`), as the pipeline's Gate 4 says. The run counts as finished from
   that write, so it comes after steps 1-3.
5. Record the end (`--outcome=completed`, after Gate 4 is accepted), once step 4 has run. It
   reads your own token usage from this session's codex session file into `driver-usage.json`,
   writes `report.md` in the run folder, and prints the conductor's figure, the run total and a
   `Cost report:` line with the cost report command for this run folder.
6. Print the report to the user with cost breakdown, files touched (from
   `.sdlc/runs/<run-id>/provenance.json`), and the `$mmo-codex:revert <run-id>` line `--close`
   printed as the way to undo the run. The breakdown is the one this command prints:

   ```bash
   node '{{PLUGIN_ROOT}}/scripts/report.mjs' '{{OUTPUT_DIR}}' --markdown
   ```

**An abort at Gate 1, 2, 3 or 4** ends the run too. Append the gate's `aborted` line, with that
gate's number and artifact (here, an abort at Gate 2):

```json
{"gate": 2, "artifact": "design.md", "decision": "aborted", "note": "<one line>", "ts": "<ISO 8601 time>"}
```

then run
`node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --abandon --run-id={{RUN_ID}} --reason='aborted at gate <N>' --project-root='{{PROJECT_ROOT}}'`,
record the end (`--outcome=aborted`), and stop. Keep the reason plain words. `--abandon` closes
the provenance record as well.

**Any other stop after Gate 0** (a halt, a refusal, a cost cap, a failure) needs no contract
command: recording the end with that outcome ends the run's contract and closes its provenance
record, and `start-run.mjs --resume={{RUN_ID}}` puts the contract back and prints a `guard_check:`
command, which the resumed session runs in a shell call of its own before any write. On the
`run.mjs` route the driver does both.

Do not propose a follow-up run.

# Flag surface (headless / repeat runs)

`$mmo-codex:pass` is the flag-driven twin of every brownfield entry point for scripted / CI invocations:

```bash
node '{{PLUGIN_ROOT}}/codex/run.mjs' \
  --brief=<intent-brief.md> --project-root=<path> \
  --mode=brownfield \
  --intent=<docs|bugfix|feature-extend|feature-new|refactor|test|deps> \
  --seed='<the job in one line>' \
  --gates=<prompt|auto-approve|auto-abort> \
  --policy=<name>
```

A brownfield run's record always lands in `.sdlc/runs/<run-id>/` under the project root; there is
no `--output-dir` for brownfield. The project must be a git repository. `--gates=prompt` needs a
person at the terminal; an unattended run passes `--gates=auto-approve` or `--gates=auto-abort`.

`--mode`, `--intent` and `--seed` supply the handover described at the top of this file, so
step 4 does not ask what it has already been told. **An unattended run needs at least
`--intent`**: under `--gates=auto-approve` there is no user to answer step 4a's question and
stdin is closed.

See the `$mmo-codex:pass` skill for the full flag contract.
