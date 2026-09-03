# Troubleshooting

> **For:** hitting an error and needing symptom → cause → fix. **Also see:** [../SETUP.md](../SETUP.md) · [running.md](running.md) · [architecture.md](architecture.md)

Symptom → cause → fix. Where the fix is a command, it is copy-paste-runnable.

## How to inspect what is happening

| Command | What it tells you |
|---|---|
| `node plugin/codex/verify-setup.mjs` | Full offline check. Reports blocking (`✗`) and warning (`!`) findings, each with the fix. The first thing to reach for. |
| `node plugin/codex/verify-setup.mjs --fix` | The same, then repairs what can be repaired without asking — installs and builds the bridge, links skills onto codex's scan path. |
| `$mmo-codex:setup` | The same check from inside a codex session, pausing only when a human decision is genuinely needed. |
| `$mmo-codex:policy` | Which policy this project uses. `$mmo-codex:policy change` swaps it. |
| `node plugin/scripts/setup-policy.mjs --check-creds --policy=<name>` | Whether this machine has what a specific policy needs, as JSON. |
| `node plugin/codex/run.mjs --dry-run --brief=<path> --output-dir=.sdlc` | Renders the conductor prompt and the exact `codex exec` argv, then exits without spending. |
| `codex plugin list` | Whether the plugin is installed and enabled, and which directory it resolves to. |
| `node plugin/scripts/probe-agent-worker.mjs` | One real Antigravity delegation, about two cents. The only cheap way to confirm entitlement, region, and credential liveness. |

## Install and prerequisites

| Symptom | Cause | Fix |
|---|---|---|
| `codex: command not found` | Global npm bin not on `PATH`. | `npm install -g @openai/codex`, or add the output of `npm root -g`'s `../bin` to `PATH`. |
| `Node <n> — this repo needs Node 20 or newer` | Older Node on `PATH`. | `nvm install --lts`, or install from [nodejs.org](https://nodejs.org). |
| `verify-setup.mjs`: `mcp-dependencies` or `mcp-build` (blocking) | `dist/` and `node_modules/` are not tracked in git; a fresh checkout carries source only. | Re-run with `--fix` — runs `npm ci` then `npm run build` in the server directory. |
| `verify-setup.mjs`: `skills-discoverable` (warning), listing every skill | Codex scans `.agents/skills`, not `plugin/skills/` where they ship. Only affects the clone route. | `node plugin/codex/verify-setup.mjs --fix` links them once. Installed as a plugin, ignore this — codex loads skills from the manifest and the check is looking in the wrong place. |
| `$mmo-codex:*` skills are not offered in a codex session | The plugin is not installed, or is disabled. | `codex plugin list`. If absent, `codex plugin marketplace add <repo-or-path>` then `codex plugin add mmo-codex@tilicho-ai-labs`. |
| Skills changed on disk but codex runs the old version | The marketplace points at a Git snapshot rather than a local path. | `codex plugin marketplace upgrade` refreshes Git snapshots. A marketplace added from a local path needs no refresh — it resolves to the working tree. |

## Login and credentials

| Symptom | Cause | Fix |
|---|---|---|
| `codex is not logged in` while `codex login status` says otherwise | Fixed. Older builds of this check read stdout only, and codex 0.152.x prints login status to stderr. | Update this harness. The check now reads both streams. |
| `OPENAI_API_KEY is not set, and … routes judgment work through the metered openai adapter` | The selected policy bills the key, and it is not set. | Export a key, **or** switch to a policy that needs none: `node plugin/scripts/setup-policy.mjs --policy=gpt-seat-plus-flash --project-root "$(pwd)"`. See [running.md](running.md#policies). |
| `--check-creds` reports `GEMINI_API_KEY` missing on a machine where Gemini works | Fixed. That key is the AI Studio door to a tier Google Cloud application-default credentials also open; an older check treated it as mandatory. | Update this harness. The key is now reported only when both doors are shut. Do not buy an API key for a tier your ADC is already serving. |
| `gemini-credentials-broken` (blocking) | A Google credential is configured but no auth library can load it — most often a service-account file with no `private_key`. | Point `GOOGLE_APPLICATION_CREDENTIALS` at a complete key, or unset it and run `gcloud auth application-default login`. An explicit `GOOGLE_APPLICATION_CREDENTIALS` takes precedence over the gcloud file, so a broken one hides a working login. |
| `gemini-credentials` (warning) with `GOOGLE_CLOUD_PROJECT` set | A project ID says where to bill, not who is asking. | Fine on a Google-hosted machine, where the credential comes from the metadata server. Anywhere else, run `gcloud auth application-default login`. |

## Dispatch and the bridge

| Symptom | Cause | Fix |
|---|---|---|
| `MCP error -32000: Connection closed` | Codex's sandbox permits child processes but denies the pipes needed to talk to one, and the bridge is reached over exactly those pipes. The server is not crashed, missing, or unbuilt. | Start codex with `codex -s danger-full-access`, or run the pipeline from a plain shell with `node plugin/codex/run.mjs`. Both the default and `workspace-write` sandbox modes fail this way. |
| `this run requires auth_mode=vendor\|estimated` | `preflight_dispatch` called without `auth_mode`. Pre-flight cannot tell which models a run dispatches to without it. | Pass `--auth=vendor` or `--auth=estimated`. |
| `MCP error -32001: Request timed out` at 60 seconds | An MCP client using the SDK default rather than this harness's 900-second timeout. A real dispatch at effort `high` takes far longer. | Use `connectBridge` from `plugin/mcp/model-dispatch/dist/driverClient.js`, which sets the timeout explicitly. |
| A dispatch fails immediately with an adapter construction error | The policy names an adapter whose credential is absent — most often `openai` with no `OPENAI_API_KEY`. | `node plugin/scripts/setup-policy.mjs --check-creds --policy=<name>` names what is missing. |

## Running

| Symptom | Cause | Fix |
|---|---|---|
| A run stops with `stopped after N invocation(s) without SUMMARY.md` | One `codex exec` turn ends at its context ceiling with exit 0 and no error, so the driver resumes; this run hit `--max-turns` first. | Raise `--max-turns`, or continue the same session with `--resume=<session-id>`. See [running.md](running.md#resuming-a-partial-run). |
| A brownfield run asks nothing about the job type | Expected when invoked through one of the seven aliases — `$mmo-codex:refactor` and friends hand over the intent pre-selected. | Use `$mmo-codex:brownfield` for the seven-option menu. |
| A second run overwrote the first run's telemetry | Runs are not incremental; the output directory is overwritten. | Give each run its own `--run-id` and `--output-dir`. |
| The pipeline pauses forever at a gate in CI | `--gates=prompt` is the default and there is nobody to answer. | `--gates=auto-approve` for a replay of a reviewed run, or `--gates=auto-abort` to stop rather than proceed unattended. |
| A write the model attempted did not happen, with no error in the transcript | The write-contract hook refused it as out of scope. A denied call leaves no trace in the Codex event stream. | Read `.sdlc/local/guard-decisions.jsonl` — every decision, allow or deny, is recorded there with its reason. |

## Policy

| Symptom | Cause | Fix |
|---|---|---|
| `policy '<name>' not found` | Typo, or a policy that was never shipped. | `node plugin/scripts/setup-policy.mjs --list-json` prints every policy this install can see. |
| An `opus-*` policy is visible in the files but not the picker | Deliberate. Those are replay fixtures carried from the Claude harness; no run in this harness dispatches to an Anthropic model. | Pick one of `gpt-plus-flash`, `gpt-seat-plus-flash`, or `flash-agsdk-only`. |
| Cost figures for a run are lower than expected, or absent for the judgment tier | The run used `gpt-seat-plus-flash`, where judgment cost is modeled from token counts rather than metered. | Expected. `M` marks those rows in the report, and they are kept out of the vendor total. Use `gpt-plus-flash` for figures that get published. See [methodology.md](methodology.md). |

## Agent path (Antigravity SDK)

| Symptom | Cause | Fix |
|---|---|---|
| `agent-worker-python` (blocking) | The mechanical tier is routed to the agent worker, which has no Python environment. | `node plugin/codex/verify-setup.mjs --fix` builds it. Or set `GEMINI_WORKER_PYTHON` to a Python 3.10+ that already has `google-antigravity`. To go back to the model path, `--disable-agent`. |
| `agent-worker-sdk` (blocking) | The environment exists but cannot import `google.antigravity` — usually built against an interpreter since upgraded or removed. | `--fix` rebuilds it from scratch. |
| `agent-worker-credentials` (blocking) with `GEMINI_API_KEY` set | The agent path reaches Gemini through Vertex and application-default credentials only. There is no API-key door for it. | `gcloud auth application-default login`, plus `GOOGLE_CLOUD_PROJECT` if the account has several projects. |
| Every delegated task fails to authenticate after the judgment phases already billed | A credential that exists but carries no entitlement to the pinned model in that region. Offline checks cannot see this. | `node plugin/scripts/probe-agent-worker.mjs` settles it for about two cents, before a real run. |

## Repair after a plugin update

A plugin update replaces the source and removes the build, so the bridge has no `dist/` until it is rebuilt:

```bash
node plugin/codex/verify-setup.mjs --fix
```

`$mmo-codex:setup` does the same from inside a session. Both are idempotent — safe to run at any time, and a no-op when nothing needs doing.
