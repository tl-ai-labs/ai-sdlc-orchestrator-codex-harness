# AI-SDLC Orchestrator — Codex Harness

Codex CLI port of the [Claude Code harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness). Same SDLC pipeline, the same job types, the same briefs — driven by the Codex CLI instead of Claude Code.

## Status

This repository is under active construction. It tracks the source repository's `main` branch and ports its full current functionality — the SDLC pipeline, greenfield and brownfield modes, the policy system, telemetry and provenance, and the policy console.

| Phase | Work | Status |
|---|---|---|
| P1′ | Codex runtime verification, model/effort pin selection | Done — [docs/verification/p1-codex-runtime.md](docs/verification/p1-codex-runtime.md) |
| P2 | Repository skeleton, carried engine and support scripts | In progress |
| P3 | OpenAI adapter, Codex policy, driver entry, write-contract enforcement | Not started |
| P4 | Telemetry reader, denied-call sidecar, setup/verification rebuild, plugin packaging | Not started |
| P5 | Quick-demo run end to end | Not started (paid) |
| P6 | Full Workforce Ops reference run, walkthrough, console study | Not started (paid) |

## Model cast

| Role | Model |
|---|---|
| Driver / conductor | `gpt-5.6-terra`, reasoning effort `high` |
| Judgment worker | `gpt-5.6-terra`, via a new OpenAI adapter in the model-dispatch bridge (P3) |
| Mechanical worker | Gemini 3.7 Flash |

No Anthropic model or credential appears anywhere in this harness's official execution path. The carried Anthropic adapters remain compiled and tested but dormant, and are excluded from the policy picker.

## Documentation

- [docs/verification/p1-codex-runtime.md](docs/verification/p1-codex-runtime.md) — Codex CLI capability checks, live findings, and the pinned model/effort/sandbox/approval values
- Setup, architecture, and usage documentation lands as each remaining phase of the port completes
