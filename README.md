# AI-SDLC Orchestrator — Codex Harness

Codex CLI port of the [Claude Code harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness). Same SDLC pipeline, the same job types, the same briefs — driven by the Codex CLI instead of Claude Code, and reporting what every phase actually cost.

Give it a project brief. It runs requirements → design → task packets → codegen → tests → senior review → security review, routing each phase to the model its policy names, pausing at four human approval gates, and recording per-phase cost as it goes.

## Model cast

| Role | Model | Billed to |
|---|---|---|
| Driver / conductor | `gpt-5.6-terra`, reasoning effort `high` | ChatGPT seat, or `OPENAI_API_KEY` |
| Judgment worker | `gpt-5.6-terra`, via the OpenAI adapter in the bridge | `OPENAI_API_KEY` |
| Mechanical worker | Gemini 3.7 Flash | Vertex project, or `GEMINI_API_KEY` |

No Anthropic model or credential appears anywhere in this harness's execution path. The carried Anthropic adapters remain compiled and tested but dormant, and the policies that name them are non-selectable replay fixtures, excluded from the policy picker.

The driver and judgment legs are both GPT but are **not** the same credential: the conductor runs on the CLI's own login, while judgment work dispatches through the bridge as ordinary metered API calls. That separation is deliberate — it is what keeps per-phase cost attribution honest.

### Running without an API key

If you have a ChatGPT subscription but no `OPENAI_API_KEY`, select the subscription policy:

```bash
node plugin/codex/run.mjs --policy=gpt-seat-plus-flash --brief=./brief.md ...
```

It routes judgment work through a local `codex exec` subprocess on your seat instead of the metered API. Same model, same effort pin, same routing rules.

**The trade-off is in the cost figures, not the output.** Codex reports token counts but no cost, so judgment-tier cost becomes modeled rather than metered — telemetry labels those events `modeled`, and the run report keeps them out of the vendor total. Use `gpt-plus-flash` for anything whose cost numbers get published; use `gpt-seat-plus-flash` to develop, or to run at all without a key. Note that a full run then draws judgment work from the same monthly seat allowance as the conductor.

## Requirements

| | |
|---|---|
| Node.js | ≥ 20 |
| Codex CLI | ≥ 0.151.0, logged in (`codex login`) |
| git | ≥ 2.30 |
| Python | 3.10+ — only for the optional Antigravity agent door |

## Setup

Install it as a plugin and the skills are available in every repository you work in:

```bash
codex plugin marketplace add https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness
codex plugin add mmo-codex@tilicho-ai-labs
```

Or work inside a clone, which is what you want if you are changing the harness itself:

```bash
git clone https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness
cd ai-sdlc-orchestrator-codex-harness
node tools/setup.mjs
```

The wizard checks prerequisites, builds the bundled MCP server, and registers it with codex. Re-check any time without the questions:

```bash
node plugin/codex/verify-setup.mjs
```

Full instructions, including credentials and choosing a policy, are in [SETUP.md](SETUP.md).

## Commands

The workflow ships as Codex skills. In a codex session, type `$` to mention one, or `/skills` to browse:

| Skill | What it does |
|---|---|
| `$mmo-codex:greenfield` | Generate a new application from a brief, in an empty folder |
| `$mmo-codex:brownfield` | Work on an existing repository — docs, bugfix, feature, refactor, tests, deps |
| `$mmo-codex:policy` | Show or change which routing policy this project uses |
| `$mmo-codex:setup` | Verify or re-configure the harness for this project |
| `$mmo-codex:revert` | Undo the file changes a specific brownfield run made |
| `$mmo-codex:pass` | Headless, flag-driven run for CI or scripted replays |

Seven job aliases — `bugfix`, `docs`, `test`, `refactor`, `deps`, `feature-new`, `feature-extend` — skip straight to that job type. They and `pass` are invoke-only: they start a full billable run, so they never fire on their own from a matching phrase.

Installed as a plugin, these work everywhere with no extra step. Working **inside a clone** of this repo, codex scans `.agents/skills` rather than the `plugin/skills/` directory they ship in, so run `node plugin/codex/verify-setup.mjs --fix` once to link them.

## Running a pass

```bash
node plugin/codex/run.mjs \
  --brief=./brief.md \
  --project-root="$(pwd)" \
  --output-dir="$(pwd)/.sdlc"
```

Add `--dry-run` to see the pinned invocation without spending anything. Then read what it cost:

```bash
node tools/report.mjs ./.sdlc
```

The report separates **vendor-metered** spend from the **modeled** driver-loop cost, and never sums them. Codex reports no wallet figures at all, so the driver leg's cost can only be derived from token counts at the pinned rates — and a driver running on a seat may have cost nothing in money. Presenting one combined number would be presenting a figure that is neither.

## Brownfield mode: what the write contract actually guarantees

Brownfield runs work against an existing repository, so scope is confirmed at a gate and enforced at the tool boundary. Being precise about the guarantee matters more than making it sound strong.

**What is enforced.** Every file write the model attempts is intercepted before it reaches the filesystem, by a hook registered on both the native patch tool and shell commands. A write outside the confirmed allowlist, or matching an off-limits pattern, is refused — the model is told why, and the write does not happen. This covers the patch mechanism the model uses by default, shell redirects, `tee`, `touch`, and `cp` / `mv` destinations. Every decision, allow or deny, is recorded to `.sdlc/local/guard-decisions.jsonl` with its own timestamp, because a denied call leaves no trace in the Codex event stream.

**The contract protects itself.** The write-contract file is not in its own allowlist, so an attempt to widen scope by editing it is refused like any other out-of-scope write. That was verified live, against a model that tried exactly that.

**What is not enforced.** The shell-command scan is a heuristic, not a shell parser. A sufficiently indirect construction — a write performed by a script the model invokes, an interpreter one-liner, an unusual redirect form — can fall outside it, and fails open rather than closed. The guarantee is that ordinary writes are gated and recorded, not that the sandbox is escape-proof. Codex's own `workspace-write` sandbox is the outer boundary; this contract is the scope boundary inside it.

## Documentation

- [docs/verification/p1-codex-runtime.md](docs/verification/p1-codex-runtime.md) — the Codex runtime capability checks this port is built on, with the pinned model, effort, sandbox and approval values, and the findings that shaped the architecture
- [docs/brief-template.md](docs/brief-template.md) — the shape a project brief needs
- [CONTRIBUTING.md](CONTRIBUTING.md) — branching model, style rules, how to submit

## Status

Every part of the port is built and tested. What is outstanding is a metered reference run, which needs an API key this machine does not have.

| Phase | Work | Status |
|---|---|---|
| P1′ | Codex runtime verification, model/effort pin selection | Done |
| P2 | Repository skeleton, carried engine and support scripts | Done |
| P3 | OpenAI adapter, Codex policy, driver-bridge client, write-contract enforcement | Done |
| P4 | Telemetry reader, denied-call sidecar, fairness pin, setup rebuild, plugin packaging, cost report | Done |
| P5 | Quick-demo run end to end | Done — 20m 47s, working app, $0.5287 metered |
| P6 | Command surface (13 skills), agent roles, discovery, docs, plugin install | Done |
| P7 | Full Workforce Ops reference run | Running on the seat; **metered** run still needs `OPENAI_API_KEY` |
| P8 | Walkthroughs, console study | Not started |

Findings during the port that changed the design from the original plan, all documented in the verification file: a model inside `codex exec` cannot call the bridge's MCP tools at all, so the driver calls the bridge itself; the write-contract hook must cover the native patch tool, not just shell commands; the default `workspace-write` sandbox blocks the network the bridge needs; custom prompts are deprecated, so the command surface ships as skills; and one `codex exec` turn cannot finish a real project, so the driver resumes the session until the pipeline completes.

## Licence

MIT — see [LICENSE](LICENSE).
