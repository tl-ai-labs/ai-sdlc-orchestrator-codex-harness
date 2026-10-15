# AI-SDLC Codex harness — documentation

Everything the [main README](../README.md) could not fit. Grouped by what you are trying to do — a tutorial to learn, how-to guides to accomplish, reference to look up, concepts to understand.

Start with the tutorial if you have not run the harness before. Skip straight to the how-to guides if you already know what you want to do.

## Tutorial

Learn by doing. Follow along top to bottom, no prior knowledge assumed.

| Doc | For |
|---|---|
| [Your first run](tutorial-first-run.md) | A greenfield run and a brownfield run in a codex session: install, setup, each gate, and where the run folder, the cost report and the guard log are. |

## How-to guides

Direct, imperative. Each guide gets a specific job done.

| Doc | For |
|---|---|
| [Install & credentials](../SETUP.md) | Setting up a fresh install: prerequisites, both install routes, the GPT and Gemini credentials, the per-project policy pick. |
| [Run a pass](running.md) | Both routes, the policies, the gates, every `run.mjs` flag, and what lands in the run folder. |
| [Check the cost with a headless run](headless-runs.md) | A headless run from a clone on an API-key policy, the token cross-check against codex's own count, and the OpenAI usage dashboard check. |
| [Bring your own brief](brief-template.md) | Writing a project brief in the section layout the requirements phase expects. |

## Reference

Look things up. Exact answers, exhaustive.

| Doc | For |
|---|---|
| [Troubleshooting](troubleshooting.md) | Symptom → cause → fix, keyed by the message on screen. |
| [Understanding output](understanding-output.md) | Reading the cost report, `telemetry.jsonl`, `provenance.json`, and `guard-decisions.jsonl`. |
| [Codex runtime verification](verification/p1-codex-runtime.md) | Every runtime capability check this port rests on, with the pinned model, effort, sandbox and approval values, and the measurements behind each finding. |
| [Pipeline state machine](../plugin/skills/pipeline/SKILL.md) | The states, gates, TaskPacket schema, telemetry contract, and per-phase prompts the driver follows. |

## Concepts

Reasoning-forward. Understand why the pieces are shaped the way they are.

| Doc | For |
|---|---|
| [Architecture](architecture.md) | Who calls what, and why the driver calls the bridge rather than the model. Adapters, routing, the write contract, telemetry, install routes. |
| [Methodology](methodology.md) | How tokens and costs are derived; why modeled figures stay out of the vendor-metered total. |

## For maintainers

- [Contributing](../CONTRIBUTING.md) — branching model, style rules, PR process.
- [Agent instructions](../AGENTS.md) — the conventions a coding agent working in this repo has to follow.

## What is not here yet

The [Claude Code harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness) ships three docs this port has not written: `logging.md`, the two-Gemini-paths comparison, and the four brownfield deep-dives. Their subject matter exists here; the write-ups do not.

The two-Gemini-paths comparison is blocked rather than merely unwritten — its whole value is measured numbers from the same brief down both doors, and that pair of runs has not happened on this harness. Writing it from the source's figures would be reporting the Claude harness's measurements as this one's.
