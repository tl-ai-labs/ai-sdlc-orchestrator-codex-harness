# Policy console

A local web page for choosing and customizing an AI-SDLC routing policy — which model runs each
phase, and thinking capacity per phase. Reads and writes real files in
[plugin/config/policies/](../config/policies/).

## What is this

One HTML page + a ~350-line Node http server. No framework, no build step, one npm dep (`yaml`).

| File | Role |
|---|---|
| `index.html` | The entire UI. Inline CSS + vanilla JS. Renders a gallery of existing policies and an editor that customizes any base policy into a new saved one. |
| `policy-server.mjs` | Tiny http server. Serves the HTML, exposes `GET /api/policies`, `POST /api/preview`, `POST /api/save`. Bound to 127.0.0.1 on a caller-chosen port. |
| `package.json` | One dep: `yaml`. First-time only `npm install` is ~1 second. |

## Run it

You do not normally run this directly. `plugin/scripts/setup-policy.mjs` (called by the shepherd
during setup, and by the `$mmo-codex:policy change` command later) starts the server on the first free
port ≥3000, opens your browser, and writes the picked/authored policy name to
`.sdlc/project.json.default_policy` in the current project.

Direct invocation for local development:

```bash
cd plugin/policy-console
npm install
node policy-server.mjs --port 3000
```

Open `http://127.0.0.1:3000`.

## Thinking tiers are per model

Each phase's model dropdown and thinking-tier picker sit side by side, and the tier options change
with the model — grounded in the vendors' own docs, not SDK guesswork:

| Adapter | Picker shows | Real request field | Source |
|---|---|---|---|
| `mcp:model-dispatch` (`flash-completion`) | `off`, `minimal`, `low`, `medium`, `high` | `thinking.thinkingLevel`, written here as `reasoning.tier` | `@google/genai` (Node) / `google-genai` (Python) `ThinkingLevel` enum |
| `antigravity-worker` (`flash-agsdk-worker`) | `off`, `minimal`, `low`, `medium`, `high` | same as above | same enum, both packages agree |
| `openai`, `codex-cli` (`gpt`) | `Not available` | the model entry's `reasoning.effort`, carried over from the base policy unchanged | `OpenAIAdapter.ts`, `CodexCliAdapter.ts` |

A GPT model's effort is one value for every phase it serves, set on its `models[]` entry. The GPT
adapters read no per-rule `reasoning`, so the console offers no per-phase picker for them.

## Known gap: thinking capacity isn't wired to every adapter yet

The console writes the chosen tier into the saved policy as `rules[].reasoning.tier`. Today that
value has **no effect on a real run** for either Gemini door:

| Routing option | Adapter | Reads `rules[].reasoning`? |
|---|---|---|
| `flash-completion` | `GeminiFlashAdapter` | No — not read anywhere in that adapter or `geminiTransports.ts`, despite the vendor SDK supporting `thinkingLevel` |
| `flash-agsdk-worker` | `AntigravityWorkerAdapter` | No — it reads its model entry's `reasoning.tier`, not the rule's |
| `gpt` | `OpenAIAdapter`, `CodexCliAdapter` | No — they read their model entry's `reasoning.effort` |

So the tiers shown are honest about what each vendor's API allows, but a run does not act on a
per-phase choice yet. Wiring it through is backend work, not a console change, and is tracked as
an open item.
