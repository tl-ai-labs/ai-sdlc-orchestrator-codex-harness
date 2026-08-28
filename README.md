# AI-SDLC Orchestrator — Codex Harness

Codex CLI port of the [Claude Code harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness). Same SDLC pipeline, the same job types, the same briefs — driven by the Codex CLI instead of Claude Code.

## Status

This repository is under active construction. It tracks the source repository's `main` branch and ports its full current functionality — the SDLC pipeline, greenfield and brownfield modes, the policy system, telemetry and provenance, and the policy console.

## Model cast

| Role | Model |
|---|---|
| Driver / conductor | GPT (pin recorded once verification settles on a model and reasoning-effort pin) |
| Judgment worker | GPT, via a new OpenAI adapter in the model-dispatch bridge |
| Mechanical worker | Gemini 3.7 Flash |

No Anthropic model or credential appears anywhere in this harness's official execution path. The carried Anthropic adapters remain compiled and tested but dormant, and are excluded from the policy picker.

## Documentation

Setup, architecture, and usage documentation lands as each phase of the port completes.
