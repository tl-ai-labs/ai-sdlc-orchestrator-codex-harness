# Methodology

How this harness arrives at the cost and token numbers it reports, and which of them are
measurements rather than calculations.

> **For:** anyone reading a run report and deciding how much to trust a figure.
> **Also see:** [running.md](running.md) · [tutorial-first-run.md](tutorial-first-run.md) · [../SETUP.md](../SETUP.md)

---

## Every cost event carries a provenance label

A number that says `$0.53` is useless without knowing where it came from. Each cost event the
harness records is stamped with one of three values:

| Provenance | Meaning | Produced by |
|---|---|---|
| `vendor` | A metered figure the vendor's own API returned for that call. Real usage, real money. | The OpenAI adapter and the Gemini Flash adapter — everything `gpt-plus-flash` dispatches |
| `modeled` | Computed from token counts against a pricing table, because the vendor reported tokens but no money. | The `codex-cli` adapter (`gpt-seat-plus-flash`), and the conductor's own driver loop |
| `estimated` | Token counts the vendor did not report, derived from the text with `estimateTokens`. | Any metered adapter on a call that came back with no `usage` block, and every priced failure path |

The stamp is applied centrally, in `plugin/mcp/model-dispatch/src/server.ts`:

```ts
provenance: result.cost_provenance ?? adapter.costProvenance ?? ("vendor" as const),
```

Three levels, and the order matters.

`ModelAdapter.costProvenance` describes an adapter's *normal* case. An adapter that can only ever
calculate declares it once — `CodexCliAdapter` has `readonly costProvenance = "modeled"`.

`ExecutionResult.cost_provenance` describes *one call*, and takes precedence. It exists because an
adapter that normally meters can still fail to get usage for a given call: the response arrives
with no `usage` block, or the call fails and is priced from the prompt. Those tokens come from
`estimateTokens`, and consulting only the adapter's static declaration would stamp them `vendor` —
publishing a guess as a measured bill, the one outcome this taxonomy exists to prevent. Both
`OpenAIAdapter` and `GeminiFlashAdapter` track whether any attempt had to estimate and label the
result accordingly.

The final default is `vendor`, so the burden falls on the adapter that is *not* metered. A new
adapter author who forgets the field gets events labelled as metered — wrong in the noisy
direction rather than the silent one, and visible in every report.

## Why modeled figures are never added to metered ones

This is the point of the whole scheme.

Two files come out of a run, and `tools/report.mjs` keeps them apart:

| File | What it holds |
|---|---|
| `telemetry.jsonl` | Every dispatched model call, metered through the bridge |
| `driver-cost-modeled.jsonl` | The conductor's own token usage, priced from `codex exec --json` turn counts |

Codex reports no wallet figures whatsoever, so the driver leg's cost can only ever be modeled.
And a driver running on a ChatGPT seat may have cost **nothing in actual money** while still
showing a modeled figure. Adding the two together would produce a number that is neither the API
bill nor the seat usage — a total that answers no question anyone has.

So the report prints them as separate sections:

```
## Dispatched work — vendor-metered
## Driver loop — modeled, not measured
```

with the modeled figure labelled and **excluded from the vendor total**. When someone asks what
a run cost, the answer is the vendor total; the modeled line tells you what the driver leg would
have cost at API rates, which is a different question.

## Where the numbers come from

`plugin/mcp/model-dispatch/src/pricing.ts` holds `computeCostUsd`. Rates come from each policy's
own `pricing:` block, so a policy file is the single place a rate is stated.

```ts
const inputFreshCost  = (tokens.input        / 1_000_000) * pricing.input;
const inputCachedCost = (tokens.input_cached / 1_000_000) * pricing.input_cached;
const outputCost      = (tokens.output       / 1_000_000) * pricing.output;
```

## The cached-token convention — read this before writing an adapter

`computeCostUsd` expects the fresh and cached input counts to be **disjoint** and adds them.
`tokens.input` is the fresh-priced count; `tokens.input_cached` is the discounted cache-read
count.

Every vendor this harness talks to reports the opposite convention: `input_tokens` is
**inclusive** of the cached subset. So every caller must subtract before pricing:

```js
input = input_tokens - cached_input_tokens
```

Four places in this repo do that, and any new adapter must too:

| Site | Vendor field it corrects |
|---|---|
| `plugin/codex/telemetry/event-reader.mjs` | `cached_input_tokens` within `input_tokens` |
| `adapters/OpenAIAdapter.ts` | `cached_tokens` within `input_tokens` |
| `adapters/CodexCliAdapter.ts` | `cached_input_tokens` within `input_tokens` |
| `adapters/GeminiFlashAdapter.ts` | `cachedContentTokenCount` within `promptTokenCount` |

Getting this wrong does not fail loudly — it silently multiplies the bill, because the cached
tokens get charged twice and at the wrong rate. It happened here before it was caught: a run
that actually cost **$1.6867** was reported as **$12.0071**, a sevenfold overstatement, and the
report looked entirely normal. The comment in `pricing.ts` states the convention at the point of
use for exactly this reason.

## Output-ceiling doubling

A judgment-tier call can come back truncated because it hit its output ceiling. The OpenAI
adapter detects this specifically — `incomplete_details.reason === "max_output_tokens"` — and
retries with the ceiling doubled:

```ts
const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
```

Doubling stops at the model's absolute ceiling rather than looping. The starting ceiling is the
packet's own `budget.maxOutputTokens`, capped by the policy's `max_output_tokens_absolute`.

This matters for cost reading: **a packet that hit the cap was paid for more than once**. The
report surfaces those separately under `## Packets that hit the output cap`, so a run whose cost
looks high for its output volume can be explained rather than guessed at.

## The mechanical tier has two doors

Gemini Flash work can arrive by two routes, and the report distinguishes them because their cost
evidence differs:

1. **The model path** — `GeminiFlashAdapter`, calling the API directly. It reads
   `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`,
   `cachedContentTokenCount`) and prices from those, so its events are `vendor`.
2. **The agent worker** — `AntigravityWorkerAdapter`, delegating to a local Python worker.
   Delegations are recorded as `worker-delegation-*.json` files and reported under
   `## Delegated to an agent worker`.

The model path itself has two backends, chosen by `selectGeminiBackend`: an API key
(`GEMINI_API_KEY`) or Vertex AI with application-default credentials, which bills a Google Cloud
project instead. `GEMINI_BACKEND` overrides the choice explicitly. Which backend served a run
changes who gets billed, not how the tokens are counted.

## What a report tells you

`node tools/report.mjs <output-dir> [--markdown]` prints the policy, the model pin and its
effort setting, the sandbox and approval pins, duration, then the sections above. Its provenance
key is:

```
V vendor-metered · E estimated · M modeled · ~ mixed · ? unlabelled
```

A `~` on a row means events of more than one provenance were rolled into it — treat that row's
total as a mixture and look at the underlying events before quoting it.

## Reproducibility

Every run records the pins it ran under in `driver-manifest.json`: the model, the reasoning
effort, the sandbox mode, and the approval policy. A cost comparison between two runs is only
meaningful if those pins match, which is why the report prints them in its header rather than
leaving them in a file.
