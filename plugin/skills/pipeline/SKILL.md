---
name: pipeline
description: "The conductor's playbook: state machine, TaskPacket schema, HITL gates and telemetry contract. A run reads the copy rendered into .sdlc/runs/<run-id>/skills/pipeline.md; this file is not runnable as is. Start a run with $mmo-codex:greenfield or $mmo-codex:brownfield."
---

# AI-SDLC Workflow — Conductor Playbook

**Follow only the rendered copy.** If the file you opened ends in `/skills/pipeline/SKILL.md`, it is
the plugin's unrendered source: its commands hold double-brace markers where real paths belong,
and none of them runs. Do not follow it. Follow the `greenfield` skill (a new app) or the
`brownfield` skill (an existing repository) instead, at `<plugin-root>/skills/greenfield/SKILL.md`
or `<plugin-root>/skills/brownfield/SKILL.md`, where `<plugin-root>` is two folders above this file.
Ask the user which one if the request does not say. Its start script renders a runnable copy of
this playbook into `.sdlc/runs/<run-id>/skills/pipeline.md`.

This skill is the source of truth for the conductor. When invoked under `$mmo-codex:pass`, the conductor follows the state machine below.

---

## State machine

```
-1. preflight                       → prove every model this run dispatches to is reachable (free, no API call)
0. read_brief
1. requirements_analysis           → requirements.md
   ── GATE 1 ─────────────────────────────────────
2. architecture_design             → design.md
   ── GATE 2 ─────────────────────────────────────
3. (mixed policy only) cache_project_header  → prime the mechanical-tier model's cache
4. plan_task_packets                  → packets.json (list of TaskPackets)
5. execute_packets                    → for each: route → execute → validate → integrate → retry on failure
6. senior_code_review                 → review.json + refinement packets
   re-execute refinement packets
7. test_run                           → npm install && npm test; debug failures (route via policy)
8. security_review                    → security_review.md
   ── GATE 3 ─────────────────────────────────────
9. generate_final_report              → write-manifest.mjs writes manifest.json + SUMMARY.md
   ── GATE 4 (final acceptance) ───────────────────  → write-manifest.mjs again, --status=accepted
```

---

## How you dispatch

You cannot call the dispatch bridge as a tool. It is registered as an MCP server, but a model in
this runtime has no per-tool binding for it. Every model call in this playbook goes through a
shell command instead:

```
node '{{PLUGIN_ROOT}}/codex/dispatch.mjs' \
  --packet=<path-to-packet.json> \
  --out=<path-for-result.json> \
  --policy={{POLICY}} \
  --project-root='{{PROJECT_ROOT}}' \
  --telemetry='{{OUTPUT_DIR}}/telemetry.jsonl'
```

Write the TaskPacket to a JSON file first, run the command, then **read the result from the
`--out` file**. Stdout carries only a one-line summary — do not parse it for anything beyond a
quick success check. A non-zero exit means the dispatch failed.

If stderr contains `COST_CAP_EXCEEDED`, the run has spent its policy's `hard_cost_cap_usd`.
Do not retry and do not dispatch anything else: the bridge refuses every further call this run.
Stop, print the message verbatim, and do not go on to Phase 9 — the run did not finish.

Keep the single quotes around paths. They can contain spaces, and an unquoted one splits into
separate arguments.

---

## The tools a run uses

The commands in this playbook are the run's whole tool set. Do not fetch a toolchain, runtime or
package manager yourself (a Node or Python download, `curl … | sh`, `npm install -g`), and do not
write an executable helper (a `.py`, `.sh` or `.mjs` script) into the run folder or the code
directory to drive the pipeline for you. A helper runs outside the cost record and the gate
record, and a fetched toolchain makes the run depend on whatever you downloaded. Phase 7's
`npm install` of the app's own dependencies in the code directory is part of the playbook; the
tools that run it are not yours to provide. When a step needs a tool this machine lacks, stop:
tell the user what is missing and how to install it, and end the run with outcome `stopped`.

---

## Phase -1 — preflight (MANDATORY, before anything else)

```
node '{{PLUGIN_ROOT}}/codex/dispatch.mjs' --preflight --auth-mode=vendor \
  --policy={{POLICY}} --project-root='{{PROJECT_ROOT}}' --out='{{OUTPUT_DIR}}/preflight.json'
```

Read the result before doing anything else.

**If `ok` is false, STOP.** Print the `halt_reason` verbatim, print the failing model's `error`, and end
the run. Do not read the brief, do not start phase 1, do not "try the mechanical tier and see". A policy
whose cheap tier cannot be reached does not degrade into a slightly-more-expensive run — every packet
falls back to the premium tier, and the result costs *more* than a single-model baseline while appearing
to succeed. That is the one outcome this harness exists to disprove, so it is worth refusing to start.

**If `warnings` is non-empty, print each one and keep going.** A warning is a model this run will not
dispatch to, so its failure cannot affect this run. Print them because they are true and the operator
should know. Do not treat a warning as a halt: refusing to start a viable run is not the safe error, it
is the one that teaches the operator to override a gate that exists to protect them.

**`not_selected` is not a warning and not a problem.** A policy may hold more than one way of reaching a
tier — `gpt-plus-flash` reaches its mechanical tier either as a Gemini model call or as an Antigravity
agent — and only the one this install selected can be dispatched to. The other is listed here, unchecked,
because its prerequisites are irrelevant to a run that will never call it. Do not report it as a failure,
do not try to "fix" it, and do not offer to install anything on its behalf.

**If `ok` is true**, report the configuration to the user in one line before phase 1 — the policy name,
each model, and on the Google Cloud path the resolved project and region — then continue. This is the only point in
the run where the operator can see what is about to be billed and to which project, while it is still
free to stop.

This call constructs each adapter, which is where credential discovery happens and where a missing or
unusable credential throws. It makes no model call and costs nothing. It exists because that
construction used to happen lazily at the first mechanical packet — phase 4 of 9, after the premium
phases were already billed — which is the worst possible moment to discover a setup problem.

`--auth-mode=vendor` is not optional and is not a choice this run makes: every model call, including
judgment work, routes through the bridge so per-phase cost attribution survives. There is no in-session
mode. The bridge still requires the argument, so pass it.

---

## Phase-by-phase prompts

Every phase below produces its artifact by dispatching a TaskPacket. You write the packet, run the
dispatch command, read the result file, and write the returned content to the artifact path. You do
not author the content yourself — a phase that silently becomes your own prose is invisible to the
cost record and defeats the measurement this harness exists for.

### Phase 1 — requirements_analysis

Dispatch a packet (`phase: "requirements_analysis"`, `task_type: "requirements"`) whose inputs carry
`{{BRIEF_PATH}}`. Write the result to `<output_dir>/requirements.md` with sections:

- **In scope** (numbered, testable)
- **Out of scope** (numbered)
- **Functional requirements per module** (FR-1, FR-2, ...)
- **Non-functional requirements** (NFR-1, ...)
- **PII inventory** (table: field, sensitivity, protection)
- **Role matrix** (role × resource × action)
- **Acceptance criteria** (numbered, executable)
- **Open questions for HITL** (if any)

### Phase 2 — architecture_design

Dispatch a packet (`phase: "architecture_design"`, `task_type: "design"`) whose inputs carry
`<output_dir>/requirements.md`. The packet's `instruction` carries the architect role: produce a
design document covering module boundaries, the data model, the API contract, and the key
cross-cutting decisions with ADR-style rationale. Write the result to `<output_dir>/design.md`.

**Use [`roles/architect.md`](roles/architect.md) verbatim as the `instruction` body.** It carries
the full deliverable list — including the environment-variable contract that codegen turns into a
validation schema, `.env.example`, and `.env.test` — and the brownfield variant that produces
`change_plan.md` instead. Do not paraphrase it; the checklist is the value.

### Phase 4 — plan_task_packets

The planner is a dispatched worker: it sees only the packet you send it, so the plan's shape is not
yours to write. `plan-packets.mjs` builds the planner's packet around the shipped plan schema
(`{{PLUGIN_ROOT}}/config/schemas/`), then checks the plan that comes back and writes
`{{OUTPUT_DIR}}/packets.json`, one TaskPacket per file-sized unit of work. You write only the
planner's instruction and the list of files it reads. Never write the planner's packet or its
`outputSchema`, never write or edit `packets.json`, and never add, drop or reshape a packet of the
plan, nor edit a plan the script refused. Phase 5's work on the plan stays yours: copying a packet
out of `packets.json` into its own file to dispatch it, filling its empty inputs, and building a
refined packet when a result fails validation.

1. **The instruction.** Write `{{OUTPUT_DIR}}/plan-instruction.md`: what to plan, and from what.
   Name the design sections the work comes from (`design.md`, or in brownfield `change_plan.md` or
   `requirements.md`), each file a packet changes or adds and why, and the packet kinds below that
   this run needs (in brownfield, the intent matrix's Phase 4 cell). Leave out field names, the run
   id and path rules: the script appends the plan rules from the run's own record (dependency order,
   one packet per file, this run's allowlist and off-limits, where notes go). On a resumed run that
   stopped in Phase 4 the file is already there: keep it as it is, since the person may have edited
   it to steer the next plan, and go on to step 2.
2. **What the planner reads.** Write `{{OUTPUT_DIR}}/plan-inputs.json`, a JSON list of
   `{"path": "<path>", "reason": "<why the planner needs it>"}`: the run's records by their absolute
   paths, `{{OUTPUT_DIR}}/requirements.md` and `{{OUTPUT_DIR}}/design.md` or
   `{{OUTPUT_DIR}}/change_plan.md`, and the source files the work touches, relative to the project
   root. In brownfield, add `.sdlc/baseline/stack-profile.md` when discovery wrote one, and the
   detected stack's guide by its absolute path, `{{PLUGIN_ROOT}}/skills/pipeline/stacks/<stack>.md`;
   the profile wins where they disagree. The script reads each file from disk, up to 128 KB, and
   refuses an off-limits one or one that holds a secret-shaped string.
3. **Build the planner's packet.**

   ```bash
   node '{{PLUGIN_ROOT}}/scripts/plan-packets.mjs' --build --run-dir='{{OUTPUT_DIR}}' \
     --instruction='{{OUTPUT_DIR}}/plan-instruction.md' --inputs='{{OUTPUT_DIR}}/plan-inputs.json'
   ```

   It writes the packet and prints three lines: `packet:` (the packet's path), `result:` (where its
   dispatch writes) and `attempt:`. Dispatch it with the dispatch command above, `--packet=` the
   `packet:` path and `--out=` the `result:` path.
4. **Accept the plan.**

   ```bash
   node '{{PLUGIN_ROOT}}/scripts/plan-packets.mjs' --accept='<the result: path>' --run-dir='{{OUTPUT_DIR}}'
   ```

   - **Exit 0.** `packets.json` holds the plan in the canonical shape below, each packet's `id`,
     `pass_id`, `retry_count` and (brownfield) `intent` filled in by the script. Go on to Phase 5.
   - **Exit 1, the plan was refused.** stderr lists each problem, numbered, and nothing was
     written. Run step 3's command again with `--previous='<the result: path>'` added. The new
     packet carries those problems and the refused plan to the planner, and counts the attempt.
     Dispatch it and accept again.
   - **Exit 1, the dispatch failed.** The planner sent no reply (a timeout, a usage limit, a vendor
     error). It is not an attempt, and nothing goes back to the planner. Run step 3's command again
     with the `--previous` the message names, if any, and dispatch the new packet.
   - **Exit 2.** Your command or `plan-inputs.json` is wrong. Fix what the message names and run it
     again; it is not an attempt. Once a plan in this session was refused, step 3 needs
     `--previous='<that result>'`, and exits 2 without it.
5. **Three attempts at most.** A session (one `run.mjs` driver process, or one `start-run.mjs`
   session) builds three planner packets that reach the planner, and stops at its second failed
   dispatch. When the message says the session has had its attempts, or its failed dispatches,
   do not dispatch another plan: stop the run. On the `run.mjs` route, write the `stop.json` the
   message prints, `needs` included, and end your turn. In a session, tell the user what the
   message says and record the end (`--outcome=stopped`, see "Run logging"). A resumed run is a
   new session with three new attempts: start at step 3, adding `--previous='<the last refused
   result>'` from before the stop when there is one, so the planner sees why that plan was refused.

The packet kinds the instruction asks for, one packet per:

| task_type | What |
|---|---|
| `prisma_schema` | full `schema.prisma` |
| `entity` | one Prisma model annotation set (if any custom) |
| `dto` | one DTO file (create/update/query DTOs grouped per resource) |
| `controller_handler` | one controller class (all routes for one resource) |
| `service_method` | one service class |
| `module_wiring` | one NestJS @Module file |
| `guard` | one guard class |
| `interceptor` | one interceptor (e.g. masking, logging) |
| `filter` | global exception filter |
| `migration` | initial migration (or `db push` script) |
| `seed_data` | seed.ts producing demo employees + roles |
| `test_unit` | unit tests per service |
| `test_integration` | integration tests per controller (Supertest) |
| `docstring` | TSDoc on public service methods |
| `readme_section` | one section of the project README |
| `adr_draft` | one ADR file |
| `env_docs` | `.env.example` — every required environment variable from `design.md` §6, no values |
| `env_test_fixture` | `.env.test` — every required environment variable with a value that satisfies the schema declared in `design.md` §6 (e.g., a 32-char string where the schema demands `min(32)`, `file:./test.db` for the DB URL, a hex-encoded fake KEK). This file is what the test runner copies to `.env` before `npm test`. |

These greenfield types are suggestions: the greenfield plan schema takes any snake_case
`task_type`, and a policy routes the codegen ones it names to the mechanical tier. When the app uses
a validating `ConfigModule` (or Joi / Zod / envalid equivalent), the instruction asks for `env_docs`
and `env_test_fixture` packets — omitting either is a senior-review blocker. The two files must be
internally consistent: every key listed in `.env.example` must appear in `.env.test` with a
schema-valid value.

### Brownfield-mode task types (v1)

The table above is greenfield-Nest-centric. In brownfield mode (`mode: brownfield`), packets use a **stack-agnostic** base set of primitives plus an optional `subtype` hint that the loaded stack adapter (`{{PLUGIN_ROOT}}/skills/pipeline/stacks/*.md`) resolves to concrete codegen guidance. The brownfield plan schema takes these task types and no others.

| task_type | Purpose | Common `subtype` values |
|---|---|---|
| `new_file_add` | Create a file that didn't exist at discovery time | `nest_controller` · `nest_service` · `django_view` · `fastapi_router` · `test` (see adapter) |
| `existing_file_edit` | Modify a file that already existed | `module_wiring` · `url_registration` · `router_wiring` · `django_settings` |
| `patch_apply` | Apply a specific unified diff | (rare — usually `existing_file_edit` is enough) |
| `doc_addition` | New doc under docs/ or module README | `readme` · `adr` · `runbook` · `api` |
| `doc_update` | Update an existing doc | — |
| `test_add` | New test file for new source | `unit` · `integration` · `e2e` |
| `test_backfill` | Add tests for existing untested code | Same as `test_add` |
| `bug_reproduce` | Failing test that captures the bug | — |
| `bug_diagnose` | Root-cause analysis — emit a note, not code | — |
| `bug_fix_apply` | Apply the fix identified by `bug_diagnose` | — |
| `refactor_extract` | Extract shared logic into a new utility | — |
| `dependency_add` | Add a dep + adjacent-code adjustments | `patch` · `minor` · `major` |

**Framework-owned wiring** — new controllers/routes/views usually need a corresponding
registration edit in a wiring file (Nest module, Django urls.py, FastAPI main.py's
include_router). Ask for these as **paired packets**, the wiring packet listed right after the new
file it registers and naming it in its `acceptance` — atomic per-pair: if the wiring edit fails,
roll back the new-file packet within the same pair.

**Every brownfield packet sets `artifact_path`** (§7.1). The script refuses a packet without one,
or with a target outside the frozen allowlist, off-limits, or in the run folder outside
`.sdlc/runs/{{RUN_ID}}/notes/` (where a reproduce or diagnose note goes), so the write hook never
meets a target it would refuse.

**`doc_addition` vs `doc_update` — read from the brief, don't infer.** When `intent_brief.md`
carries a "## Task type" heading (only present when the chosen intent declares `task_types` in
`intents.json` — currently just `docs`), every packet for this run uses that exact `task_type`
value: the script reads the heading, tells the planner, and refuses a plan that uses another. The
user already chose it at brief-collection time (`brownfield-guide/SKILL.md` step 4b), and a
per-project policy may route the two differently (an update is a smaller edit than fresh
authoring, and might reasonably go to a cheaper model). When the heading is absent — every
non-docs intent, and `docs` runs from before this existed — the planner chooses.

### TaskPacket initial output-ceiling budgets

Set `budget.maxOutputTokens` per phase type. The adapter automatically doubles this ceiling on any attempt that terminates with the vendor's max-tokens stop reason (OpenAI `incomplete_details.reason: "max_output_tokens"`, Gemini `finishReason: "MAX_TOKENS"`), up to 3 doublings or the model's absolute output limit declared in the policy YAML (`max_output_tokens_absolute`), whichever comes first. Cached input keeps retry cost low.

- **Codegen packets:** `3000` (services, controllers, DTOs, tests). Most files fit first-shot; a few large service files double once or twice.
- **Premium packets (design, senior_code_review, security_review):** `5000`. Design and review artifacts are the ones that historically hit the ceiling.
- **Docs, ADR, README:** `3000`. Same doubling behavior.
- **Debug packets:** inherit from the packet they refine.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"` or, for an OpenAI request sent again after a transient failure, `"transient"` — all sharing the packet's `task_id`. The report collapses them into one row per packet.

### Phase 5 — execute_packets

Emit `phase.start` before the first packet and `phase.end` after the last — see "Run logging"
below. This is the phase with the most silence between pre-flight and Gate 1 otherwise:
every dispatch inside the loop below already logs itself via the bridge (`route.decide`,
`dispatch.start`/`.end`), but nothing marks the loop's own boundaries without this call.

For each packet in `packets.json`, in order (the plan lists them in dependency order):

An input whose `content` is empty names a file an earlier packet wrote; put that file's content in
before you dispatch. Dispatch it with the command above. The bridge routes per policy — you do not
choose the model. Validate the returned structured output against the schema; if invalid,
construct a *refined* packet (new id, `retry_count+1`, with the validation error appended to
instruction) and re-dispatch. After 2 mechanical-tier attempts fail, the policy sends the third (`retry_count: 2`)
to the premium tier automatically (a rule on `phase: [codegen, tests, docs]` with
`retry_count: { gte: 2 }`, and one on `debug`) — the routing decision is the policy's, and the
escalated packet dispatches exactly like every other one.

Write the returned file content to disk at the packet's stated `artifact_path`. In a brownfield
run the write hook snapshots each file before your first write to it lands, for
`$mmo-codex:revert`. Do not run `write-provenance.mjs` yourself, and do not write under
`.sdlc/runs/<run-id>/backups/`.

### Phase 6 — senior_code_review

Dispatch one packet per module (`phase: "senior_code_review"`, `task_type: "review"`) whose inputs
carry the module's generated files. The packet's `instruction` carries the senior-reviewer role:
read the code module by module and emit a structured review, with a refinement TaskPacket for any
defect found. Collect the refinement packets from the results and re-dispatch them via Phase 5
mechanics. Write the collected review to `<output_dir>/review.json`.

**Use [`roles/senior-reviewer.md`](roles/senior-reviewer.md) verbatim as the `instruction` body.**
It carries the eight review criteria and the output schema.

Two obligations on this phase specifically, both spelled out in that file. **Attach whole files,
not slices** — a review packet is the one place where under-filling `inputs` yields a confidently
wrong answer instead of an obviously incomplete one, because every criterion is a search for an
absence and the worker has no tools to go looking. And when a result comes back with a non-empty
`not_verifiable` array, **widen those inputs and re-dispatch that module** before treating its
verdict as final.

### Phase 7 — test_run

**Greenfield mode.** Bootstrap the env fixture first — this is required for any app whose codegen produced a validating `ConfigModule` (or equivalent) at boot. The codegen phase is contractually required (see Phase 5 acceptance criteria and the senior review's env-fixture check) to emit `.env.example` (docs) and `.env.test` (fixture values that satisfy the declared schema).

Run it from the code directory, not the run folder — `<output_dir>` holds the run record and has
no `package.json`.

```bash
cd '<code_dir>'
# Only copy .env.test → .env when neither exists. Never overwrite an existing .env —
# a real .env holds real secrets and belongs to the user.
if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test '<that folder, absolute>/.env'; fi
npm install --silent && npm test
```

Write the `cp` target as the absolute path of the folder you `cd` into, spelled out and in single quotes. The write hook lets a shell command create a missing `.env` only at a literal absolute path: a relative one can land in a folder the hook cannot see.

**Brownfield mode.** The greenfield env-copy above is refused entirely — the repo already has an `.env` (or an equivalent secrets manager) that the user manages, and copying a codegen-produced fixture would either overwrite real secrets or drop the run into a schema-invalid state. Instead:

```bash
cd <repo-root>   # NOT <output_dir> — the app-under-test is the user's actual repo
# Do NOT touch .env under any circumstances. Do NOT copy .env.test → .env.
```

If codegen introduced new required env vars:
1. Do not write `.env.example` or any other `.env*` file: the write hook refuses every one of them while the run's contract is live, whatever the allowlist says.
2. Print the list of new keys to the operator with a mini-gate: *"Codegen introduced N new required env vars: X, Y, Z. Add them to `.env.example` and populate them in your .env before Phase 7 continues, or say `skip` to run Phase 7 anyway (tests requiring these keys will fail)."*
3. Wait for the user's response before invoking the test command. On the `run.mjs` route, put the
   question to them the way your gate instruction says (under `--gates=prompt`, `question.json`).

The test command in brownfield is `baseline.test_command` (confirmed at Gate 0), not hardcoded `npm test`. Working directory is the repo root (not `<output_dir>`); in monorepos, use the per-package scope from `baseline.monorepo.packages[].test_command` for whichever package the changed files belong to.

**Both modes:**

On failure:
- If the error is `Config validation error: "X" is required` or equivalent → the codegen phase missed keys. Do NOT patch `.env`, `.env.test` or any other `.env*` file from the harness, in either mode: the write hook refuses an edit to one that already exists. In greenfield, name the missing keys with schema-valid fixture values for the user and ask them to add those to `.env.test` and `.env.example`, or say `skip`. In brownfield, ask the user via the mini-gate above.
- Any other failure → parse the output, build a `debug` TaskPacket with the failing test name + error + relevant source slice. Route via policy. Retry up to 2 cost-efficient tier attempts; the policy escalates to the premium tier from there.

**Test-command probe (optional Phase 0.5 in brownfield).** The pipeline pre-check (§7.4) already ran the discovered test command with `--collect-only` / `--dry-run` at prompt 1 to prove deps are installed. If pre-check step 2 failed for this run, Phase 7 halts with the recorded error rather than attempting the real run.

### Phase 8 — security_review

Dispatch a packet (`phase: "security_review"`, `task_type: "security_review"`) whose inputs carry the
generated code. The packet's `instruction` carries the security-reviewer role: a threat-model-style
pass over PII handling, authorization coverage, audit completeness, secret leakage, and dependency
risk. Write the result to `<output_dir>/security_review.md`.

**Use [`roles/security-reviewer.md`](roles/security-reviewer.md) verbatim as the `instruction`
body.** It carries the full checklist and the report format.

The dependency-risk check is a shell command, and the dispatched worker cannot run one. **Run the
stack's production-dependency audit yourself and attach its output as a file slice in `inputs`.**
If you do not, that check comes back under `## Could not verify` rather than passing — which is
correct, and is the point: the reviewer is instructed never to pass a check it could not run, and
never to report an absence it could not confirm. Attach whole files here for the same reason as
Phase 6.

### Phase 9 — generate_final_report

Run one command. It builds `<output_dir>/manifest.json` from `telemetry.jsonl`, `gates.jsonl` and
the driver's record with the bridge's own `buildManifest`, and renders `<output_dir>/SUMMARY.md`
from it:

```
node '{{PLUGIN_ROOT}}/scripts/write-manifest.mjs' '{{OUTPUT_DIR}}' \
  --run-id={{RUN_ID}} --policy={{POLICY}} \
  --project-root='{{PROJECT_ROOT}}' --code-dir='{{CODE_DIR}}' --summary
```

**Do not write manifest.json or SUMMARY.md yourself**, and do not edit either file once the
command has written it. `manifest.json` records the hash of the `SUMMARY.md` it rendered: a
hand-written or edited `SUMMARY.md` reads as a run that has not finished.

The command prints the dispatched total, then a `note:` line for anything it left out (telemetry
lines it could not read, file counts it could not make). Print the notes. A non-zero exit means
`manifest.json` was not written, and a `SUMMARY.md` it left behind does not count: fix what its
message names and run it again.

`SUMMARY.md` states the conductor's own cost as the record has it. The run's end reads it from
the conductor's codex session file on both routes (`end-run.mjs` in a session, `run.mjs` on a
headless run, which also checks it against its exec stream) and, for a completed run, renders
`SUMMARY.md` again with that figure. Do not add a figure for it; see the telemetry contract below.

This first `SUMMARY.md` is provisional. The run is finished only once Gate 4 is accepted and the
command has run again with `--status=accepted` (see Gate 4).

---

## TaskPacket schema (canonical)

```ts
{
  id: "tp_<phase>_<seq>",
  phase: "requirements_analysis" | "architecture_design" | "plan_task_packets" | "codegen" | "tests"
       | "docs" | "debug" | "senior_code_review" | "security_review" | "refactor" | "final_report"
       | "discovery" | "change_plan",  // brownfield adds the last two; the bridge refuses any other name
  task_type: "controller_handler" | "service_method" | ...,
  module: "employees" | "leave" | ...,
  instruction: "<imperative, <300 tokens>",
  inputs: [ { path, content, reason } ],  // SLICED — never full files unless necessary
  outputSchema: { /* JSON schema */ },
  acceptance: ["<testable bullet>", ...],
  budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },  // codegen initial; adapter doubles on max_tokens truncation up to 3× (see below)
  retry_count: 0,
  pass_id: "{{RUN_ID}}",  // the run id, on every packet
  intent: "docs" | "bugfix" | "feature-extend" | "feature-new" | "refactor" | "test" | "deps",  // brownfield only — omit entirely on greenfield packets
  subtype: "nest_controller" | ...,  // optional brownfield stack hint
  artifact_path: "src/auth.js"  // the project-relative path the packet writes; required in brownfield
}
```

**Set `intent` on every brownfield packet, from the confirmed value in `intent_brief.md`.** A
policy may route the same `phase` differently per intent (e.g. `refactor`'s Tests phase to a
different model than `docs`'s) via a rule matching on both `phase` and `intent` — the router
falls back to the phase's blanket rule when no intent-specific one exists. Omitting `intent`
silently drops the packet out of every intent-scoped rule and back onto the blanket rule, which
is exactly greenfield's existing behavior — so this is safe to skip on greenfield packets, but
never skip it on brownfield.

---

## Intent matrix — brownfield only

**Applies only when `mode: brownfield`.** Greenfield (`$mmo-codex:greenfield`) runs the full pipeline
described above with no matrix-based branching.

In brownfield, one state machine handles seven intents. Which phases fire — and what shape their
outputs take — depends on the intent picked at Gate 0. Tier assignment (which model runs each
phase) does NOT change per intent; that's fixed by the loaded policy (§11).

| Intent | Phase 1 · requirements | Phase 2 · architecture | Phase 4 · packet plan | Phase 7 · tests | Phase 8 · security review |
|---|---|---|---|---|---|
| **docs** | scoped ("what docs?") | **SKIP** | `doc_addition` / `doc_update` packets | doc-lint only | changed files only |
| **bugfix** | reproduce + diagnose | **SKIP** unless design-affecting | `bug_reproduce` → `bug_diagnose` → `bug_fix_apply` → `test_add` | regression + focused suite | changed files only |
| **feature-extend** | delta requirements | delta `change_plan.md` | mixed `existing_file_edit` + `new_file_add` | affected suites | changed files only |
| **feature-new** | new-feature requirements | full subsystem design (`change_plan.md`) | full mix (`new_file_add`, `test_add`, `doc_addition`, wiring) | affected + new | changed files only |
| **refactor** | delta (what to preserve) | delta refactor plan | `refactor_extract` + `patch_apply` | **full suite** (invariants) | changed files only |
| **test** | coverage target | **SKIP** | `test_backfill` / `test_add` | new tests + full suite | test files only |
| **deps** | upgrade target list | dep-swap plan | `dependency_add` + adjacent-code patches | full suite + smoke | dep-diff + advisory |

**v1 specialization scope (per C6 cut).** Matrix cells are fully specified for the four "known"
intents (docs, bugfix, feature-extend, feature-new) because they map cleanly to the greenfield
behavior we already have. The three "new" intents (refactor, test, deps) route to the closest-
fitting known behavior in v1, with intent-specific prompt overrides landing in v1.5. This means
v1 ships all seven intents (surface-complete) with the last three at ~70% of full-specialized
quality; v1.5 tightens them.

**How the conductor branches.** After Gate 0 approval (which sets `intent` on the run
context), the conductor consults this table before each phase to decide: SKIP the phase, run
its default form, or run its intent-specific form. Skipped phases still emit a TelemetryEvent
with `phase: <name>, task_type: "skipped"` so downstream summaries stay complete.

**Skip semantics.**
- SKIP means the phase does not run at all — no packet dispatched, no artifact written, no gate
  fires for that phase. The gate immediately after a skipped phase is also skipped.
- Docs intent example: Phase 2 (architecture) skips → Gate 2 also skips → conductor goes
  straight from Gate 1 (requirements) to Phase 4 (packet planning).

---

## HITL gate prompt templates

**Gate delivery.** You print the gate block yourself, then follow the gate instruction you were
given: in a session, the `gates:` line the start script printed; on the `run.mjs` route, the
conductor prompt's "Approval gates" section. Never answer a gate on the user's behalf. Every gate
is a fenced `> ⏸ **HITL Gate <N> — <Title>**` block (templates below), printed verbatim.
**Persist the gate-pending state to `<output_dir>/state.json` before printing**, so a session that
dies mid-gate leaves a record of the open gate in the run's own folder. Write the whole file, one
object: `{"run_id": "{{RUN_ID}}", "phase": "<phase>", "gate": N, "status": "gate_pending", "at": "<ISO time>"}`.

**Gate record.** On both routes, append every gate decision, Gate 0 included, as a new line to
`{{OUTPUT_DIR}}/gates.jsonl` before you act on it, with the decision under the key `decision`
(never `status`) and the time you write it under `ts`:

```json
{"gate": 1, "artifact": "requirements.md", "decision": "approved|revise|aborted|accepted|rejected|auto-approved", "note": "<one line>", "ts": "<ISO 8601 time>"}
```

In a session, write the line once the user has replied, or as you continue under
`--gates=auto-approve`. Gate 4 records `accepted`, `auto-approved` or `rejected`. The end command
in "Run logging" refuses `--outcome=completed` until the latest Gate 4 line in this file is
`accepted` or `auto-approved` and Phase 9's command has run again after it. The brownfield close-out (`write-contract.mjs --close`) reads this
file too and refuses while it holds neither an accepted Gate 4 nor an abort. On the `run.mjs`
route the conductor prompt also has you record `pending` before you end your turn on a gate.
Log each gate's opening and resolution as "Run logging" below says.

### Gate 0 — Brownfield only, before Gate 1

> ⏸ **HITL Gate 0 — Discovery Confirmation**
>
> I read your repo and produced `<output_dir>/discovery.md`. Confirm:
>
> - **Stack:** `<top-detected stacks>` — correct? add/override?
> - **Test command:** `<detected>` — enter to accept, or paste the command.
> - **Policy:** `{{POLICY}}`, the policy every dispatch in this run uses — accept, or name
>   another on-disk policy (e.g. `gpt-plus-flash`) and the run restarts with it. To change the
>   project's persistent default, re-run setup (`node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs'`
>   — this is the one command that opens a browser; every other setup step is terminal-only).
> - **Existing AI setup:** `<verbatim list from Tier 1 group 6>` — is any of this
>   authoritative and off-limits? **(default: OFF-LIMITS, do not touch)**
> - **Intent:** `<intent picked in step 4a of $mmo-codex:brownfield>`
> - **File scope:**
>   - allowlist: `<paths proposed by the intent brief>` — accept / edit
>   - off-limits: **project defaults from `.sdlc/project.json.off_limits_default`** apply
>     (`.env`, `.env.*`, `.mcp.json`, `.cursor/rules/**`, `.codex/config.toml`, `.codex/auth.json`,
>     `node_modules/**`, `dist/**`, `build/**`, `.next/**`, `.sdlc/local/**`, `.git/**`,
>     `.agents/**`) — add anything else this ticket must not touch
>   - AI configs detected in the repo are added on top (see previous bullet)
> - **Repo-state risks (if any):** `<LFS / submodules / failing tests / encrypted secrets>`
> - **Regulated-repo warning (when `baseline.regulated_repo_warning_required`):** *"This repo appears regulated (signals: `<kinds>`). Confirm the active policy uses only compliant endpoints, and that off-limits protects your regulated data folders."*
> - **`.gitignore` needs `.sdlc/` entry (when `baseline.gitignore_covers_sdlc: false`):** *"Your .gitignore doesn't cover .sdlc/. Add `.sdlc/` to .gitignore as part of this run? [Y/n]"*  On yes, add `.gitignore` to the allowlist so the codegen phase can create-or-append it (a codegen packet or a small helper write, per intent). On no, note in the final report so the user gets the same follow-up prompt that surfaced in the docs-gen v1 run.
>
> Typical cost for a `<intent>` run on a repo this size: `$X.XX–$Y.YY`.
>
> Reply: `approved`, `revise: <comments>`, or `abort`.

On `approved`, freeze the write contract with `write-contract.mjs`, as step 5 of the brownfield
guide, `{{OUTPUT_DIR}}/skills/brownfield-guide.md`, shows:

```bash
node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --freeze --run-id={{RUN_ID}} \
  --allowlist='<allowlist JSON>' --off-limits='<extra off-limits JSON>' --intent=<intent> \
  --project-root='{{PROJECT_ROOT}}'
```

Then update `intent_brief.md` with the final scope, and prove the write hook runs with a
command of its own:

```bash
node '{{PLUGIN_ROOT}}/scripts/write-contract.mjs' --assert-guard-live --run-id={{RUN_ID}} --project-root='{{PROJECT_ROOT}}'
```

Never put the freeze and the check in one shell call. The hook judges a call once, before it
runs, so a call that freezes and checks leaves no hook record after the freeze, and the check
then ends the run as if the hook were not trusted.

`--off-limits` carries the AI-configs from `baseline.ai_configs_detected` and any ticket-specific
paths the user added at Gate 0; the script merges `.sdlc/project.json.off_limits_default` (the
project-level constants written by setup) into the contract itself, so Gate 0 does not re-ask about
them each ticket. Never write `.sdlc/local/write-contract.json` by hand. The write hook
(`{{PLUGIN_ROOT}}/codex/hooks/write-contract-check.mjs`) refuses it while the run is live, and a
contract changed after its freeze makes the hook refuse every write. If either command exits
non-zero, print its message and stop. While the contract is live the run writes its own
`.sdlc/runs/<run-id>/` folder and, outside it, only the allowlist.

**Ending a brownfield run.** After the user accepts Gate 4 and its `accepted` line is in
`gates.jsonl`, `write-contract.mjs --close --run-id={{RUN_ID}}` ends the run, closes its provenance
record and switches the contract off, before the ledger rows are written. An abort at any gate
appends that gate's `aborted` line, then runs `write-contract.mjs --abandon --run-id={{RUN_ID}}
--reason='aborted at gate <N>'`. When `--close` refuses, print its message and stop: it names the
`--abandon` command the user runs to end the run. Any other stop needs no contract command: the
end record (see "Run logging") ends the contract with that outcome, and a resume puts it back.

**Default the AI-coexistence answer to OFF-LIMITS.** A user who hits `approved` without reading
must not accidentally authorize the harness to rewrite their `.cursor/rules` or their custom
`routing-policy.yaml`. If the user wants a competing AI config in scope, they must move it
explicitly.

### Gate 1
> ⏸ **HITL Gate 1 — Requirements Approval**
> I've written `<output_dir>/requirements.md`. Please review and reply with one of:
> - `approved` — proceed to architecture
> - `revise: <comments>` — I'll revise the requirements file based on your comments
> - `abort` — stop the run

### Gate 2
> ⏸ **HITL Gate 2 — Architecture Approval**
> I've written `<output_dir>/design.md`. Same options as Gate 1.

### Gate 3
> ⏸ **HITL Gate 3 — Security Review**
> Security review at `<output_dir>/security_review.md`. Reply `approved`, `revise: <comments>`, or `abort`.

### Gate 4
> ⏸ **HITL Gate 4 — Final Acceptance**
> The full SDLC pass is complete. The summary is `<output_dir>/SUMMARY.md`.
> Dispatched cost: $X.XXXX  ·  Files: N  ·  Tests: passing/total
> Reply `accept` to finalize the manifest, or `reject: <comments>` to revise.

Take the figures from `manifest.json`: `totals.dispatched_cost_usd`, and `artifacts.files` (print
`—` when the manifest has no `artifacts`).

On `accept`, record the gate, finish any close-out your playbook gives (the brownfield guide's step
7), then run the Phase 9 command again with `--status=accepted` added. When the gate instruction has
you record Gate 4 as `auto-approved`, add `--status=auto-approved` instead. On a run started by
`run.mjs`, that re-run is the run's last record; end your turn after it. On a run started in a
session, record the end next, as "Run logging" below says. On `reject: <comments>`, revise what the
comments name, and run Phase 9 again before you reopen Gate 4.

---

## Run logging

The run's log is `{{OUTPUT_DIR}}/orchestrator.log`. The bridge logs each dispatch there itself; you
add the phase boundaries, the gates, and on a run started in a session, the end of the run.

**Phase boundaries.** At the start and end of each phase you run (`requirements_analysis`,
`architecture_design`, `plan_task_packets`, `execute_packets`, `senior_code_review`, `test_run`,
`security_review`, `generate_final_report`, plus `discovery` and `change_plan` in brownfield):

```bash
node '{{PLUGIN_ROOT}}/scripts/mmo-log.mjs' --event=phase.start --run-dir='{{OUTPUT_DIR}}' --run-id={{RUN_ID}} --phase=<phase>
node '{{PLUGIN_ROOT}}/scripts/mmo-log.mjs' --event=phase.end --run-dir='{{OUTPUT_DIR}}' --run-id={{RUN_ID}} --phase=<phase>
```

A phase the intent matrix marks SKIP gets `--event=phase.skip --phase=<phase> --reason=<matrix
cell>` instead of the pair.

**Gates.** When you print a gate block, and again once its decision line is in `gates.jsonl`:

```bash
node '{{PLUGIN_ROOT}}/scripts/mmo-log.mjs' --event=gate.open --run-dir='{{OUTPUT_DIR}}' --run-id={{RUN_ID}} --gate=<N>
node '{{PLUGIN_ROOT}}/scripts/mmo-log.mjs' --event=gate.resolved --run-dir='{{OUTPUT_DIR}}' --run-id={{RUN_ID}} --gate=<N> --decision=<decision>
```

`<decision>` is the value you wrote under `decision`. A `pending` line is not a resolution: log
`gate.resolved` once the answer is recorded. `gates.jsonl` stays the gate record; these lines put
each gate in the log's timeline.

**The end of the run.** Who records it depends on how the run started:

- **Started by `run.mjs`** (the run folder holds `driver-events.jsonl`): the driver logs `run.start`
  and `run.end` itself. Record why you stopped the way the conductor prompt says; do not run the
  command below.
- **Started from a `$mmo-codex:*` skill in a session** (the run folder holds `run.json`): the start
  script logged `run.start`. Record the end with:

```bash
node '{{PLUGIN_ROOT}}/codex/end-run.mjs' --run-dir='{{OUTPUT_DIR}}' --outcome=<outcome> --reason='<one line>'
```

| Outcome | When |
|---|---|
| `completed` | Gate 4 is recorded as `accepted` in `gates.jsonl`, and Phase 9's command has run again with `--status=accepted` since. The script refuses `completed` otherwise. |
| `aborted` | A gate was answered `abort`, or the user stopped the run. |
| `halted` | Preflight returned `ok: false`, or a pre-check step failed. |
| `refused` | The write guard refused a write, and you stopped as the rules say. |
| `cost_cap` | A dispatch failed with `COST_CAP_EXCEEDED`. |
| `stopped` | Any other deliberate stop, such as setup not done for this project. |
| `failed` | An error the run could not get past. |

Every outcome but `completed` needs `--reason`. Run it once Gate 4 is accepted and Phase 9's command
has run again, before the final report, or right after you tell the user why the run stopped. Its `Cost report:` line gives the
cost report command for the run folder, or says this install has none; then build the breakdown
from `{{OUTPUT_DIR}}/telemetry.jsonl`. Running the same command again keeps the recorded end and
repeats only the run-end steps. A Gate 4 `reject` sends the run back for changes; it does not end
the run.

---

## Telemetry contract (every LLM call)

Every dispatched call writes its own event to `<output_dir>/telemetry.jsonl` — the bridge does
this when you pass `--telemetry`, so you never hand-write a telemetry event.

**Always pass `<output_dir>/telemetry.jsonl`, and nowhere else.** The path is not just where
events land: the agent-worker path anchors its delegation evidence to the same directory,
resolving it as `<dirname of telemetry_path>/delegation` (`AntigravityWorkerAdapter`). Pointing
telemetry somewhere else silently separates each delegation's brief, sidecar and receipt from the
run they document, and the run report then cannot find them. This bites only when the mechanical
tier routes to the agent worker (`--enable-agent`, or a policy selecting `flash-agsdk-worker`),
which is exactly when the evidence matters most.

Event shape:

```json
{
  "ts": "ISO-8601",
  "pass": "pass1|pass2",
  "phase": "<phase>",
  "task_type": "<from packet>",
  "task_id": "<from packet>",
  "module": "<from packet>",
  "model": "<canonical model_name>",
  "provenance": "vendor",
  "routed_by": "orchestrator|fallback|manual",
  "routing": { "policy_name": "...", "policy_version": 1, "rule_index": 3, "rule_reason": "..." },
  "input_tokens": 1840,
  "input_tokens_cached": 1420,
  "output_tokens": 612,
  "cost_usd": 0.00234,
  "latency_ms": 1850,
  "success": true,
  "retry_count": 0,
  "artifact_path": "src/leave/leave.controller.ts"
}
```

**Your own loop cost is recorded for you, on both routes.** On the `run.mjs` route the driver records the
`codex exec --json` event stream as it arrives and derives the conductor's token usage from it. On the
interactive route the run's end step (`end-run.mjs`) reads your token usage from codex's session file
for this session. Either way the figure is `provenance: "modeled"` — token counts at the dated price
list's rates, because this runtime reports no wallet figures — and lands in `driver-usage.json` and the
cost report. Never invent token counts or cost for your own work: a guessed figure sitting beside
measured ones is worse than no figure.

**But a phase that made no model call must still leave a row.** Two cases produce one:

- the intent's phase table says SKIP, or
- you completed the phase yourself, in-session, without dispatching a packet — a senior review
  with no changed modules, a security review over an empty diff.

Record each with a zero-cost event, so that a phase missing from `telemetry.jsonl` always means a
lost event and never an ambiguous one:

```bash
node '{{PLUGIN_ROOT}}/codex/dispatch.mjs' \
  --log-phase=<phase> --task-type=skipped|in_session \
  --module=<module> --reason='<why in one line>' \
  --policy={{POLICY}} --telemetry='{{OUTPUT_DIR}}/telemetry.jsonl' \
  --out='{{OUTPUT_DIR}}/<phase>-skip-receipt.json'
```

These carry `provenance: "none"` and all-zero tokens. That is not an estimate — it is the fact
that no model call was made. Where such a phase did consume tokens, they were yours, and they are
already counted in the driver-loop events; the `--reason` string is what tells a reader so.

A run that writes `review.json` or `security_review.md` without either dispatching a packet or
logging one of these is under-reporting itself.

**Rates come from the dispatch server's dated price list (`plugin/mcp/model-dispatch/src/prices.ts`) — never from your trained knowledge, never hardcoded.** A policy YAML's `pricing:` block records the list's card and is billed only under `pricing_override: true`. `preflight_dispatch` halts on a model the list cannot price; stop the run when it does.
