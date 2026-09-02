---
name: pipeline
description: The end-to-end AI-SDLC workflow definition consumed by the conductor. Defines the state machine, TaskPacket schema, HITL gates, telemetry contract, and the prompts/templates for each phase. The conductor reads this skill to know exactly what to do at each step.
---

# AI-SDLC Workflow — Conductor Playbook

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
9. generate_final_report              → updates manifest.json with artifacts + rollups
   ── GATE 4 (final acceptance) ───────────────────
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

Keep the single quotes around paths. They can contain spaces, and an unquoted one splits into
separate arguments.

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

From `design.md`, emit `<output_dir>/packets.json` — a list of TaskPackets, one per file-sized unit of work.

Suggested packet types and one packet per:

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

When the app uses a validating `ConfigModule` (or Joi / Zod / envalid equivalent), packets for `env_docs` and `env_test_fixture` are **required** — omitting either is a senior-review blocker. The two files must be internally consistent: every key listed in `.env.example` must appear in `.env.test` with a schema-valid value.

### Brownfield-mode task types (v1)

The table above is greenfield-Nest-centric. In brownfield mode (`mode: brownfield`), packets use a **stack-agnostic** base set of primitives plus an optional `subtype` hint that the loaded stack adapter (`plugin/skills/pipeline/stacks/*.md`) resolves to concrete codegen guidance.

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
include_router). Emit these as **paired packets** with the same `pass_id` — atomic per-pair:
if the wiring edit fails, roll back the new-file packet within the same pair.

**Every brownfield packet MUST set `artifact_path`** (§7.1) so the write-contract validator can
reject off-limits paths at dispatch time. Missing `artifact_path` is a planner bug.

**`doc_addition` vs `doc_update` — read from the brief, don't infer.** When `intent_brief.md`
carries a "## Task type" heading (only present when the chosen intent declares `task_types` in
`intents.json` — currently just `docs`), every packet you plan for this run uses that exact
`task_type` value. Do not infer `doc_addition` vs `doc_update` from file existence or context —
the user already chose it at brief-collection time (`brownfield-guide/SKILL.md` step 4b), and a
per-project policy may route the two differently (an update is a smaller edit than fresh
authoring, and might reasonably go to a cheaper model). When the heading is absent — every
non-docs intent, and `docs` runs from before this existed — infer as before.

### TaskPacket initial output-ceiling budgets

Set `budget.maxOutputTokens` per phase type. The adapter automatically doubles this ceiling on any attempt that terminates with the vendor's max-tokens stop reason (OpenAI `incomplete_details.reason: "max_output_tokens"`, Gemini `finishReason: "MAX_TOKENS"`), up to 3 doublings or the model's absolute output limit declared in the policy YAML (`max_output_tokens_absolute`), whichever comes first. Cached input keeps retry cost low.

- **Codegen packets:** `3000` (services, controllers, DTOs, tests). Most files fit first-shot; a few large service files double once or twice.
- **Premium packets (design, senior_code_review, security_review):** `5000`. Design and review artifacts are the ones that historically hit the ceiling.
- **Docs, ADR, README:** `3000`. Same doubling behavior.
- **Debug packets:** inherit from the packet they refine.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"` — all sharing the packet's `task_id`. The report collapses them into one row per packet.

### Phase 5 — execute_packets

Emit `phase.start` before the first packet and `phase.end` after the last — see "Run logging" in
the conductor prompt. This is the phase with the most silence between pre-flight and Gate 1 otherwise:
every dispatch inside the loop below already logs itself via the bridge (`route.decide`,
`dispatch.start`/`.end`), but nothing marks the loop's own boundaries without this call.

For each packet, in dependency order:

Dispatch it with the command above. The bridge routes per policy — you do not choose the model.
Validate the returned structured output against the schema; if invalid, construct a *refined*
packet (new id, `retry_count+1`, with the validation error appended to instruction) and
re-dispatch. After 2 mechanical-tier retries fail, the policy escalates to the premium tier
automatically (rule with `retry_count: { gte: 2 }`) — the routing decision is the policy's, and
the escalated packet dispatches exactly like every other one.

Write the returned file content to disk at the packet's stated `artifact_path`.

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

```bash
cd <output_dir>
# Only copy .env.test → .env when neither exists. Never overwrite an existing .env —
# a real .env holds real secrets and belongs to the user.
if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test .env; fi
npm install --silent && npm test
```

**Brownfield mode.** The greenfield env-copy above is refused entirely — the repo already has an `.env` (or an equivalent secrets manager) that the user manages, and copying a codegen-produced fixture would either overwrite real secrets or drop the run into a schema-invalid state. Instead:

```bash
cd <repo-root>   # NOT <output_dir> — the app-under-test is the user's actual repo
# Do NOT touch .env under any circumstances. Do NOT copy .env.test → .env.
```

If codegen introduced new required env vars (via `existing_file_edit` on `.env.example`):
1. Append the new keys to `.env.example` (this IS a permitted write — .env.example is in the allowlist by default and holds no values, only key names).
2. Print the list of new keys to the operator with a mini-gate: *"Codegen introduced N new required env vars: X, Y, Z. Populate them in your .env before Phase 7 continues, or say `skip` to run Phase 7 anyway (tests requiring these keys will fail)."*
3. Wait for the user's response before invoking the test command.

The test command in brownfield is `baseline.test_command` (confirmed at Gate 0), not hardcoded `npm test`. Working directory is the repo root (not `<output_dir>`); in monorepos, use the per-package scope from `baseline.monorepo.packages[].test_command` for whichever package the changed files belong to.

**Both modes:**

On failure:
- If the error is `Config validation error: "X" is required` or equivalent → the codegen phase missed keys. In greenfield build a debug TaskPacket routed to codegen to add the missing keys with schema-valid values. In brownfield, ask the user via the mini-gate above; do NOT patch `.env` from the harness.
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

Read all events in `<telemetry_path>`. Build rollup manifest using the `buildManifest` shape (see `plugin/mcp/model-dispatch/src/telemetry.ts`). Write `<output_dir>/manifest.json`. Also write a brief `<output_dir>/SUMMARY.md` with: total cost, breakdown, links to key artifacts.

The driver's own loop cost is recorded separately and automatically — see the telemetry contract below. Do not try to account for it yourself.

---

## TaskPacket schema (canonical)

```ts
{
  id: "tp_<phase>_<seq>",
  phase: "codegen" | "tests" | "docs" | "debug" | "refactor" | ...,
  task_type: "controller_handler" | "service_method" | ...,
  module: "employees" | "leave" | ...,
  instruction: "<imperative, <300 tokens>",
  inputs: [ { path, content, reason } ],  // SLICED — never full files unless necessary
  outputSchema: { /* JSON schema */ },
  acceptance: ["<testable bullet>", ...],
  budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },  // codegen initial; adapter doubles on max_tokens truncation up to 3× (see below)
  retry_count: 0,
  pass_id: "pass1" | "pass2",
  intent: "docs" | "bugfix" | "feature-extend" | "feature-new" | "refactor" | "test" | "deps"  // brownfield only — omit entirely on greenfield packets
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

**Gate delivery.** You print the gate block yourself and wait for the user's reply. Every gate is
a fenced `> ⏸ **HITL Gate <N> — <Title>**` block (templates below), printed verbatim. **Persist
the gate-pending state to `.sdlc/local/state.json` before printing** — if the session dies
mid-gate, session-hydrate detects a non-terminal state and re-prompts on the next
`$mmo-codex:brownfield` invocation. No new command needed.

### Gate 0 — Brownfield only, before Gate 1

> ⏸ **HITL Gate 0 — Discovery Confirmation**
>
> I read your repo and produced `<sdlc_root>/runs/<run-id>/discovery.md`. Confirm:
>
> - **Stack:** `<top-detected stacks>` — correct? add/override?
> - **Test command:** `<detected>` — enter to accept, or paste the command.
> - **Policy:** `<the default_policy field setup wrote to .sdlc/project.json>` — accept, or
>   name another on-disk policy for this run only (e.g. `gpt-plus-flash`). To change the project's
>   persistent default, re-run setup (`node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs'`
>   — this is the one command that opens a browser; every other setup step is terminal-only).
> - **Existing AI setup:** `<verbatim list from Tier 1 group 6>` — is any of this
>   authoritative and off-limits? **(default: OFF-LIMITS, do not touch)**
> - **Intent:** `<intent picked in step 4a of $mmo-codex:brownfield>`
> - **File scope:**
>   - allowlist: `<paths proposed by the intent brief>` — accept / edit
>   - off-limits: **project defaults from `.sdlc/project.json.off_limits_default`** apply
>     (`.env*`, `.mcp.json`, `node_modules/**`, `.cursor/rules/**`, `.codex/config.toml`,
>     `.codex/auth.json`, `dist/**`, `.sdlc/**`, `.git/**`) — add anything else this ticket must not touch
>   - AI configs detected in the repo are added on top (see previous bullet)
> - **Repo-state risks (if any):** `<LFS / submodules / failing tests / encrypted secrets>`
> - **Regulated-repo warning (when `baseline.regulated_repo_warning_required`):** *"This repo appears regulated (signals: `<kinds>`). Confirm the active policy uses only compliant endpoints, and that off-limits protects your regulated data folders."*
> - **`.gitignore` needs `.sdlc/` entry (when `baseline.gitignore_covers_sdlc: false`):** *"Your .gitignore doesn't cover .sdlc/. Add `.sdlc/` to .gitignore as part of this run? [Y/n]"*  On yes, add `.gitignore` to the allowlist so the codegen phase can create-or-append it (a codegen packet or a small helper write, per intent). On no, note in the final report so the user gets the same follow-up prompt that surfaced in the docs-gen v1 run.
>
> Typical cost for a `<intent>` run on a repo this size: `$X.XX–$Y.YY`.
>
> Reply: `approved`, `revise: <comments>`, or `abort`.

On `approved`, freeze the write contract to `.sdlc/local/write-contract.json`
(schema: `{schema_version:1, active:true, mode:"brownfield", run_id, strict:true, allowlist,
off_limits}`). Build `off_limits` by concatenating `.sdlc/project.json.off_limits_default`
(the project-level constants — `.env*`, `.mcp.json`, `node_modules/**`, etc., written by setup)
with the AI-configs from `baseline.ai_configs_detected` and any ticket-specific paths the user
added at Gate 0. The PreToolUse hook and the packet validator both read the merged list — the
UX shrinks (Gate 0 doesn't re-ask about constants each ticket), the enforcement is unchanged.
See `plugin/codex/hooks/write-contract-check.mjs` for the hook.

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
> The full SDLC pass is complete.
> Total cost: $X.XX  ·  Files: N  ·  Tests: passing/total
> Reply `accept` to finalize the manifest, or `reject: <comments>` to revise.

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
  "phase": "<state>",
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

**Your own loop cost is recorded for you.** The driver reads the `codex exec --json` event stream
after the run and derives the conductor's token usage from it, writing those events with
`provenance: "modeled"` — modeled from token counts at the pinned rates, because this runtime
reports no wallet figures. You do not log telemetry by hand, and you must not try to: there is no
CLI subcommand for it, and any figure you invented would be a guess sitting next to measured ones.

**Pricing constants come from the loaded policy YAML's `pricing:` block for the current model — never from your trained knowledge, never hardcoded.** If the policy's pricing block is missing, abort the run.
