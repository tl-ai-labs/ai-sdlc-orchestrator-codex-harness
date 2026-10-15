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
| `vendor` | A metered figure the vendor's own API returned for that call. Real usage, real money. | The OpenAI adapter, the Gemini Flash adapter and the agent worker — everything `gpt-plus-flash` dispatches — on a call that reported usage, and a failed call the vendor's billing rule makes $0 |
| `modeled` | Computed from token counts against a pricing table, because the vendor reported tokens but no money. | The `codex-cli` adapter (`gpt-seat-plus-flash`) when codex reported the turn's usage, and the conductor's own driver loop |
| `estimated` | Token counts the vendor did not report, derived from the text with `estimateTokens`. | A call that came back with no `usage` block, and a failed or abandoned call that may still have been billed (see [Failed and abandoned calls](#failed-and-abandoned-calls)) |

Every attempt of a dispatch carries its own label, and the bridge stamps each telemetry event from
it, in `plugin/mcp/model-dispatch/src/dispatchEvents.ts`:

```ts
att.cost_provenance ?? result.cost_provenance ?? adapter.costProvenance ?? "vendor"
```

Four levels, and the order matters. The result's label is consulted only when no attempt of that
result carries one.

`ModelAdapter.costProvenance` describes an adapter's *normal* case. An adapter that can only ever
calculate declares it once — `CodexCliAdapter` has `readonly costProvenance = "modeled"`.

`AttemptRecord.cost_provenance` describes *one attempt*, and takes precedence. An adapter that
normally meters can still fail to get usage for an attempt: the response arrives with no `usage`
block, or the call fails and is priced from the prompt. Those tokens come from `estimateTokens`,
and consulting only the adapter's static declaration would stamp them `vendor` — publishing a
guess as a measured bill, the one outcome this taxonomy exists to prevent. Labelling the attempt
rather than the packet keeps a measured first attempt `vendor` when a later output-cap doubling
had to be estimated.

`ExecutionResult.cost_provenance` summarises the call for readers of the MCP result: `estimated`
when any attempt was.

The final default is `vendor`, so the burden falls on the adapter that is *not* metered. A new
adapter author who forgets the field gets events labelled as metered — wrong in the noisy
direction rather than the silent one, and visible in every report.

## Why modeled figures stay out of the vendor-metered total

This is the point of the whole scheme.

Two kinds of file come out of a run, and the report (`plugin/scripts/report.mjs`) reads them separately:

| File | What it holds |
|---|---|
| `telemetry.jsonl` | Every dispatched model call, recorded by the bridge with its provenance |
| `driver-cost-modeled.jsonl`, or `driver-usage.json` when present | The conductor's own token usage, priced at the pin |

Codex reports no wallet figures whatsoever, so the driver leg's cost can only ever be modeled.
And a driver running on a ChatGPT seat may have cost **nothing in actual money** while still
showing a modeled figure. A seat-backed judgment dispatch (`gpt-seat-plus-flash`) is modeled for
the same reason.

So the report keeps one total for figures a vendor bills per token and one for figures computed
from token counts, and gives the run total with both parts shown:

```
Dispatched total                         $0.1608
Driver loop — modeled           at least $0.3220
Run total = dispatched + driver at least $0.4828

Vendor-metered total                     $0.0073
Modeled (seat) total            at least $0.4755
```

The vendor-metered total holds only `vendor` and `estimated` events from metered adapters: it is
what the API vendors bill. The modeled total holds `modeled` dispatches, the `estimated` floors of
a seat adapter (`adapter_provenance: "modeled"`), and the driver loop: it is what that work would
cost at API rates, which on a seat is not money anyone paid. The run total answers "what did this
run cost at API rates", and the split beneath it says how much of that is a bill. `at least` marks
a total that is missing cost (an incomplete or unpriced driver turn, or part of a dispatched call's
usage), `at most` one that can include cost from before the run (a resumed thread priced at its
whole running total), and `about` one with reasons of both kinds.
[understanding-output.md](understanding-output.md#run-total) lists every reason.

## Where the numbers come from

`plugin/mcp/model-dispatch/src/prices.ts` is the dated price list, the one place a rate is stated.
Every adapter prices a dispatch from the list entry that covers the dispatch's UTC day, and
`plugin/mcp/model-dispatch/src/pricing.ts` turns tokens and that card into dollars with
`computeCostUsd`. The `claude-cli` adapter reports its own cost and uses the list only to refuse a
model it cannot price. The conductor is priced from the same list
(`plugin/mcp/model-dispatch/src/driverPricing.ts`), on the UTC day each turn or response was spent:
`driver-cost-modeled.jsonl` per turn from the exec stream, `driver-usage.json` per response from the
codex session file, and the cost cap from whichever of the two the report books. A turn the exec
stream reports only as a sum is priced response by response when the session file holds its
responses; without them, a sum above 272,000 input tokens bills the standard card and is labelled
`TIER UNVERIFIED`. The `pricing:` card in the policy's `driver:` block is documentation unless it
sets `pricing_override: true`, and a test holds it equal to the list. USD per 1M tokens, `from` and
`to` inclusive:

| Model | From | To | Input | Cached input | Output |
|---|---|---|---|---|---|
| `gpt-5.6-terra` | 2026-08-09 | open | 2.00 | 0.20 | 12.00 |
| `gpt-5.6-terra`, a request over 272,000 input tokens | 2026-08-09 | open | 4.00 | 0.40 | 18.00 |
| `gemini-3.7-flash` | 2026-08-13 | 2026-12-31 | 0.75 | 0.075 | 3.75 |
| `gemini-3.8-flash` | 2026-09-02 | 2026-12-31 | 0.75 | 0.075 | 3.75 |
| `gemini-3.7-flash`, `gemini-3.8-flash` | 2027-01-01 | open | 1.50 | 0.15 | 7.50 |
| `gemini-3.5-flash` | 2026-05-19 | open | 1.50 | 0.15 | 9.00 |
| `claude-opus-5`, `claude-opus-4-7` | 2026-01-01 | open | 5.00 | 0.50 | 25.00 |
| `claude-sonnet-5` | 2026-01-01 | open | 2.00 | 0.20 | 10.00 |

| Rule | What happens |
|---|---|
| A request's whole prompt, cached tokens included, is over 272,000 tokens | Every token of that request bills the long-context card. 272,000 exactly bills standard. |
| Usage covers several requests (a `codex-cli` turn) and sums to more than 272,000 | The standard card is billed and the event carries `price_tier: "unverified"`: a sum cannot show whether one request crossed the line. |
| The vendor reports no input count, so the prompt is estimated at 3.8 characters per token | The estimate picks the card, and the event carries `price_tier: "unverified"`: an estimate proves neither tier. |
| A policy model sets `pricing_override: true` | Its `pricing:` block is billed instead of the list, and the event carries `price_basis: "custom"`. |
| A policy `pricing:` block differs from the list by more than 0.5% | The list is billed and `pricing.policy_mismatch` is logged. Without an override a block is documentation. |
| A policy names a model the list does not | The policy is refused at load, unless that model sets `pricing_override: true`. |
| No entry covers the day | `preflight_dispatch` halts, and a dispatch is refused with `unpriced: ...` before any vendor call, at $0. |

The Vertex regional surcharge (x1.10 on Gemini 3+ at a non-global endpoint) applies on top of the
list card at dispatch, and `simulate_policy` applies it for the endpoint the current environment
dispatches to. `simulate_policy` prices each event on the day in its `ts`.

```ts
const inputFreshCost  = (tokens.input        / 1_000_000) * pricing.input;
const inputCachedCost = (tokens.input_cached / 1_000_000) * pricing.input_cached;
const outputCost      = (tokens.output       / 1_000_000) * pricing.output;
```

### The conductor's tokens, read twice

The conductor's cost is read from codex's session file
(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread id>.jsonl`), one usage record per model
response. That is the only reading a run in a codex session has. A `run.mjs` run has a second
one: the `turn.completed` events of `codex exec --json`, which report the thread's running total.
At the run's end, `collect-driver-usage.mjs` compares the two per thread and per invocation, in
codex's own buckets (input with cached input inside it, cached input, output with reasoning inside
it, reasoning):

| Verdict | Booked figure | Label |
|---|---|---|
| Every bucket equal (`equal`, or `equal_with_explained_gap` when the session file also holds compaction calls or turns the stream never reported) | The session file | `verified` |
| A bucket differs, or a turn cannot be matched (`mismatch`) | The session file | `UNVERIFIED`, with the bucket and the difference |
| The totals cannot be matched (`unexplained_gap`, `reset`, `no_exec_usage`, `unchecked`) | The session file | `UNVERIFIED` |
| No readable session file (`no_session_file`) | The exec stream | `UNVERIFIED` |

Token counts are what the check proves; the dollars then follow from the price list.
[headless-runs.md](headless-runs.md) is the procedure, and how to read the result.

### Failed and abandoned calls

Each attempt reaches `telemetry.jsonl` as it returns, so a call the client stops waiting for keeps
the attempts that finished. Every dispatch is bounded by a deadline that stays below the driver
client's 900-second call timeout:

| Leaf `adapter:` | Deadline |
|---|---|
| `openai`, `mcp:model-dispatch` (Gemini completion), `codex-cli` | The leaf's `worker_timeout_sec`, 840 s when unset. No shipped policy sets it on these leaves, so 840 s applies, and it covers the whole output-cap doubling chain. |
| `antigravity-worker` (agent door) | The leaf's `worker_timeout_sec`, 540 s in every shipped policy and when unset, plus a 30-second kill grace. |

| What happened | Booked as |
|---|---|
| Gemini answered with an error status (4xx, 5xx) | $0, `vendor`. Google bills only a request it answered with 200 ([Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/pricing), [Gemini API](https://ai.google.dev/gemini-api/docs/billing)). |
| OpenAI answered with an error status | The prompt as input, `estimated`. OpenAI publishes no statement that an answered error is free. |
| A request never left this machine (`ENOTFOUND`, `ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`, `EAI_AGAIN`) | $0 |
| A Gemini or OpenAI connection failed with no answer, or the dispatch deadline cut it off | The prompt as input, `estimated`, `usage_complete: false`: the request may have been served. |
| `codex-cli` reported warnings or a reconnect (`Reconnecting... 1/5`) and then `turn.completed` | A success, billed on the turn's usage, `modeled`. |
| A `codex-cli` turn completed but wrote no answer | The turn's usage, `modeled`. |
| A `codex-cli` turn failed, or was killed at its deadline (with its whole process group, so the native binary behind the npm wrapper stops too) | The prompt as input, `estimated`, `usage_complete: false`, `adapter_provenance: "modeled"`. |
| `codex` never started | $0 |
| An agent session failed or timed out and its sidecar recorded usage | That usage, `vendor`. |
| An agent session ran but no usage survived (killed at its deadline) | The brief as input, `estimated`, `usage_complete: false`. |
| The agent worker failed before its session started | $0 |
| The client stopped waiting for an attempt still in flight | The packet's prompt as input, `estimated`, `usage_complete: false`, with an `error` that starts `abandoned`. |

`usage_complete: false` marks a lower bound: the call spent at least that much.

`adapter_provenance: "modeled"` marks every event from a seat adapter (`codex-cli`). Its `estimated`
rows are seat floors priced at the price list's rates, not metered spend, so they belong with the modeled
figures rather than the vendor-metered total.

An OpenAI request that got no answer, or an answer of 408, 409, 429 or 5xx, is sent again up to
twice, after the vendor's `retry-after` when it asks for under a minute, else after about 0.5 s and
then 1 s. Each request is its own attempt, billed by the table above for its own outcome, and a
resent one carries `retry_reason: "transient"`. The report lists those packets under
`## Packets resent after a transient failure`, apart from the packets that hit the output cap. The
OpenAI SDK's own retries are off: a request it resent would be billed with no attempt on record.

## The cached-token convention — read this before writing an adapter

`computeCostUsd` expects the fresh and cached input counts to be **disjoint** and adds them.
`tokens.input` is the fresh-priced count; `tokens.input_cached` is the discounted cache-read
count.

Most vendor fields this harness reads report the opposite convention: `input_tokens` is
**inclusive** of the cached subset. So those callers must subtract before pricing:

```js
input = input_tokens - cached_input_tokens
```

These places do that, and any new adapter must check which convention its vendor uses:

| Site | Vendor field it corrects |
|---|---|
| `plugin/codex/telemetry/event-reader.mjs` | `cached_input_tokens` within `input_tokens` |
| `adapters/OpenAIAdapter.ts` | `cached_tokens` within `input_tokens` |
| `adapters/CodexCliAdapter.ts` | `cached_input_tokens` within `input_tokens` |
| `adapters/GeminiFlashAdapter.ts` | `cachedContentTokenCount` within `promptTokenCount` |
| `delegation/workerProcess.ts` | `cached_content_token_count` within `prompt_token_count`, on Antigravity SDK versions that count it inside (0.1.9). 0.1.16 counts it on top, so nothing is subtracted. |

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
   `## Delegated to an agent worker`. The worker's usage sidecar records the
   `google-antigravity` version, and that version decides how its input is read
   (`AGY_USAGE_SEMANTICS` in `delegation/workerProcess.ts`): 0.1.9 counts cached input inside
   `prompt_token_count`, 0.1.16 on top of it. A version not listed there bills the larger
   reading and logs `agsdk.usage_semantics_unverified`, so it can over-report but not
   under-report. The worker pins `google-antigravity==0.1.16`. Agent-door costs recorded on
   0.1.16 before this reading was ported are low by the whole fresh input.

The model path itself has two backends, chosen by `selectGeminiBackend`: an API key
(`GEMINI_API_KEY`) or Vertex AI with application-default credentials, which bills a Google Cloud
project instead. `GEMINI_BACKEND` overrides the choice explicitly. Which backend served a run
changes who gets billed, not how the tokens are counted.

## What a report tells you

`node plugin/scripts/report.mjs <run-folder> [--markdown | --json]` prints the policy, the model
pin and its effort setting, the sandbox and approval pins, duration, then the sections above. Its
provenance key is:

```
V vendor-metered · E estimated · M modeled · – no model call · ~ mixed · ? unlabelled
```

A `~` on a row means events of more than one provenance were rolled into it — treat that row's
total as a mixture and look at the underlying events before quoting it.

## Reproducibility

A `run.mjs` run records the pins it ran under in `driver-manifest.json`: the model, the
reasoning effort, the sandbox mode, and the approval policy, plus the policy file that won
(`policy_source`, `policy_path`, `policy_sha256`). A run in a codex session records the pin, the
same policy fields, and the model and effort the session ran on at each start
(`starts[].session_model`) in `run.json`. A cost comparison between two runs is only
meaningful if those pins match, which is why the report prints them in its header rather than
leaving them in a file.
