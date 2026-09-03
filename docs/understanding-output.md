# Understanding the output

> **For:** reading the cost report and the raw files a run leaves behind. **Also see:** [methodology.md](methodology.md) · [running.md](running.md) · [architecture.md](architecture.md)

Everything a run produces lands under the output directory — `.sdlc/` unless `--output-dir` says otherwise. Nothing is uploaded off the machine.

Render the report:

```bash
node tools/report.mjs .sdlc              # terminal
node tools/report.mjs .sdlc --markdown   # pasteable
```

## The report, section by section

### Header

Run id, policy, the model and effort pin, sandbox and approval policy, start time, duration.

The pin matters more than it looks. Cost figures are only comparable between runs that used the same model at the same reasoning effort, so the report states which, and a run whose pin was rejected mid-flight says so under the table rather than presenting the numbers as if nothing happened.

### Dispatched work — vendor-metered

One row per phase, in pipeline order: calls, tokens in and out, cost. These are packets that went through `execute_with_model` and came back with vendor-reported token counts.

The `Prov` column is the provenance of that phase's events:

| Tag | Meaning |
|---|---|
| `V` | vendor-metered — the vendor reported these tokens |
| `E` | estimated — counted locally, not vendor-confirmed |
| `M` | modeled — derived from token counts at the policy's pinned rates |
| `~` | mixed within the phase |
| `?` | unlabelled |

### Driver loop — modeled, not measured

The conductor's own token consumption, one row per `codex exec` turn.

This is a separate section, not a line in the table above, and the two totals are never added together. Codex reports token counts but no money at all, so this figure is derived rather than measured — and a driver running on a ChatGPT seat may have cost nothing in money. A combined number would be neither metered nor modeled. [methodology.md](methodology.md) is the long form.

### Packets that hit the output cap

Only appears when a packet's output was truncated at the model's ceiling and the doubling loop retried it. Worth reading — a packet that hit the cap may have produced less than the phase needed.

### Delegated to an agent worker

Only appears on runs that used the agent door. Names every delegated packet, its tool calls, and what changed on disk while it ran.

### Footer

The provenance key, a per-provenance count of dispatched events, and a note if the fairness pin was rejected during the run.

## The raw files

| File | Contents |
|---|---|
| `telemetry.jsonl` | One JSON line per model call. The source of everything in the report. |
| `manifest.json` | Rollup of the telemetry — totals, per-phase, per-module, per-task-type — plus the run's artifacts. |
| `SUMMARY.md` | Written only by the final phase, which is what makes it the completion signal the driver watches for. |
| `runs/<run-id>/provenance.json` | Every file the run touched, with its pre-run hash. The input `$mmo-codex:revert` reads. |
| `local/guard-decisions.jsonl` | One line per write-contract decision, allow or deny, with the reason. |
| `local/state.json` | The pipeline's current state, including a gate that was pending when a session died. |
| `gates.jsonl` | One line per gate decision, including `auto-approved` ones, so an unattended run leaves the same audit trail as an attended one. |
| `delegation/` | Agent-path runs only. Per delegated packet: the task brief, the worker's usage sidecar, and a receipt. |

### `telemetry.jsonl`

One event per line. The fields that matter when reading by hand:

| Field | What it holds |
|---|---|
| `phase` | Pipeline phase — `requirements_analysis`, `codegen`, and so on. `driver_loop` marks a conductor turn rather than a dispatched packet. |
| `model` / `model_id` | Which model ran, and through which door. On Gemini events this is what distinguishes the model door from the agent door. |
| `provenance` | `vendor`, `estimated`, or `modeled`. Decides which report total the event lands in. |
| `input_tokens` / `input_tokens_cached` / `output_tokens` | Token counts. Input is **exclusive** of cached input — see below. |
| `output_tokens_reasoning` | Reasoning tokens, where the vendor reports them separately. |
| `cost_usd` | Derived at the pricing in the policy that ran. |
| `routing` | The policy name and version, which rule index matched, and why. Makes a routing decision auditable after the fact. |
| `retry_count` | Which attempt this was. A packet at `retry_count: 2` is the one escalation fires on. |

**The cached-token convention.** Codex reports `input_tokens` inclusive of `cached_input_tokens`; this harness stores them exclusive, so `input_tokens + input_tokens_cached` is the true total. An adapter that gets this wrong double-counts cached input and inflates cost. The convention is enforced in `plugin/codex/telemetry/event-reader.mjs`, and [methodology.md](methodology.md) explains why it was chosen.

### `provenance.json`

Written per run under `runs/<run-id>/`. For each touched file: path, whether it was tracked and committed before the run, and its pre-run hash. `$mmo-codex:revert` restores tracked files with git and untracked ones from a per-run backup, and refuses when a later run has touched the same file — printing a three-way diff instead of guessing.

### `guard-decisions.jsonl`

Brownfield only, and the only record of a refused write. A denied call leaves no trace in the Codex event stream, so a write that silently did not happen is explained here and nowhere else. Each line carries its own timestamp, the path, the decision, and the reason.

## What is not here

No transcript of the conductor session is stored in the output directory — codex keeps its own session history under `~/.codex/`. If a run needs explaining after the fact, `telemetry.jsonl` plus `gates.jsonl` plus `guard-decisions.jsonl` is the audit trail this harness guarantees.
