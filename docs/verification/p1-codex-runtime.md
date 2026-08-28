# P1 — Codex runtime verification

Document B, section 7. Run before implementation begins. This machine's checks are dated
2026-08-28, split across two sessions: an offline pass before Codex login, and a live pass
after. Check 8 (Gemini dispatch) and check 11 (pricing) remain pending — the first needs Vertex
or Gemini credentials, the second only gates P5.

## This machine

| Item | Value |
|---|---|
| Codex CLI | `0.150.1` (via `npx @openai/codex`; no global install) |
| Node.js | v24.19.0 |
| Python | 3.14.4 |
| Platform | WSL2 (Linux 6.18, Windows host) |
| `codex login status` | Logged in using ChatGPT (free tier) |

The port track document's baseline is `0.147.0` (Sriram's probe machine, 2026-08-21/27). This
machine runs `0.150.1` — newer, not older. `codex features list` reproduces the same
stable/enabled flags the track doc recorded (`plugins`, `plugin_sharing`, `hooks`,
`multi_agent`, `skill_search`), and every live check below reconfirms the inherited findings on
this newer version rather than just trusting them.

**WSL2 note:** device-code login initially failed instantly (`error sending request for url`)
on every attempt. Root cause: this WSL2 instance has no working IPv6 route (`eth0` carries only
a link-local address), while DNS still returns `AAAA` records for `auth.openai.com`. Codex's
HTTP client doesn't fall back to IPv4 the way `curl` does. Fix: `sudo sysctl -w
net.ipv6.conf.all.disable_ipv6=1`, then login succeeded on the next attempt. Worth a line in
the eventual setup docs for other WSL2 contributors.

## Checks

| # | Check | Result | Confirms |
|---|---|---|---|
| 1 | Wire a hook that exits non-zero on a write, attempt the write | **PASS — live, this session** | Hooks CAN block. Gates brownfield scope |
| 2 | `codex doctor`, `codex --version` | **PASS** — `codex-cli 0.150.1`; doctor now reports auth mode `ChatGPT`, all reachability checks ok | Install health |
| 3 | `codex login status` | **PASS** — `Logged in using ChatGPT`; `~/.codex/auth.json` present (never printed) | Driver auth |
| 4 | Register a stdio MCP server, list its tools | **PASS (config half)** — `codex mcp add`/`list`/`get` round-trip correctly through `config.toml`. Tool-name namespacing under a live session is deferred to P3, when the actual `model-dispatch` server is wired — needs a real MCP server with real tools to observe naming, not a stub | Bridge connectivity, namespacing |
| 5 | `codex exec --json`, capture JSONL | **PASS — live.** Event sequence: `thread.started` → `turn.started` → `item.completed` (`agent_message`) → `turn.completed` (with `usage`). No event carries a timestamp | Telemetry event shape |
| 6 | Repeat check 1 while capturing `--json` | **PASS — live.** The denied call produced zero items in the JSON stream — no `command_execution`, no error item, nothing. The only evidence was a `stderr` log line and the model's own narration in its final `agent_message` | Denied-call record is mandatory, not optional |
| 7 | Set reasoning effort explicitly | **PASS — live.** `-c model_reasoning_effort="high"` accepted cleanly for `gpt-5.6-terra`. An invalid value (`"not-a-real-level"`) was rejected with a structured `turn.failed` error naming the valid enum: `none, minimal, low, medium, high, xhigh, max`. **Caveat:** a successful turn's `--json` output never echoes back which model or effort actually answered — enforceability is "the CLI rejects an invalid pin outright," not "the stream proves the correct pin was used." The fairness-pin assertion has to rely on the CLI's own validation, not on reading the effort back out of telemetry | Fairness pin is settable; only partially observable |
| 8 | Dispatch one Gemini packet through the bridge | **PENDING** — needs Vertex ADC or `GEMINI_API_KEY` (Q13(c) in the track doc) | Mechanical tier |
| 9 | Spawn a subagent | **INCONCLUSIVE — live.** `multi_agent` is wired: a `collab_tool_call` item type exists and fired (`tool: "wait"`). But the spawn itself failed in headless `exec` mode — `stderr`: `collab spawn failed: no thread with id: <thread_id>` — and the model answered the test question directly rather than proving real delegation. Native subagent hosting is not provably usable from `codex exec` on this version; the fallback (fold agent roles into the driver prompt, dispatch every model call through the bridge) is the safer default, consistent with the track doc's D1 note that bridge-dispatch is required regardless | Role hosting mechanism |
| 10 | Fresh session vs. install session registration | **PASS — reasoned, not a live re-test.** `codex doctor` reports the background app-server as "not running (ephemeral mode)" — there is no long-lived daemon in the default setup. Every `codex`/`codex exec` invocation is a fresh process that reads `config.toml` at start. This is structurally the opposite of the source Claude Code harness's failure mode (where a running interactive session doesn't pick up plugin registration until restarted) — there is no "install session vs. fresh session" distinction to fail here, because there is no persistent session to begin with | No silent premium-model cost failure from stale registration |
| 11 | Compare driver pricing against published rates | **PENDING** (gates P5 only) | Pricing pins |

## Check 1 / 6 — hooks can block, denials leave no trace (confirmed live, this session)

Registered via:

```
codex exec --dangerously-bypass-hook-trust \
  -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="node <guard.mjs>"}]}]' \
  ...
```

where `guard.mjs` reads the hook payload from stdin and always replies
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.

Prompted the model to create `probe.txt` via a shell command. Result: the file was never
created; `stderr` logged `Command blocked by PreToolUse hook: verification probe: all writes
denied by policy. Command: printf 'hello' > probe.txt && cat probe.txt`; the model's final
`agent_message` reported the block back to the user. The `--json` stream carried **no item at
all** for the denied command — no `item.started`, no `command_execution`, no error item. This
independently reproduces the same finding the sibling `ai-studies-console` Codex port recorded
on `0.147.0` (`tools/harness-matrix/sdk-probe/codex/facts.md`, probes #1–#3), now confirmed
live on `0.150.1` with our own guard and our own session.

Two consequences, both already reflected in Document A:

- **The guard must write its own sidecar record of every denial** (`guard-decisions.jsonl`
  pattern) — the event reader cannot reconstruct a denial after the fact, because none of it
  reaches `--json`.
- **The hook dispatcher speaks the Claude-compatible wire**: matcher `"Bash"`, `command` bare
  (not shell-wrapped) in the payload. The shell-wrap (`/bin/zsh -lc '…'`) only appears in
  trajectory `command_execution` items, never in the hook payload — the hook itself needs no
  unwrap step; only the telemetry event reader does.

## Other inherited findings (source: `ai-studies-console` harness-matrix Codex port, CLI 0.147.0)

Reconfirmed where noted; the rest carry forward as design inputs pending a P3/P4 live check
against our own driver script.

| Finding | Detail | Status here |
|---|---|---|
| Commands are shell-wrapped | Every executed command arrives in trajectory items as `/bin/zsh -lc '…'` | Reconfirmed live (check 1 probe's `stderr` line shows the wrap) |
| `---`-leading prompts break the CLI | `clap` parses a prompt starting with `---` as flags; fix is `args.push("--")` | Not yet re-tested; low risk, cheap to verify at P3 |
| Hosted web search is invisible to hooks | `web_search` runs server-side; `tools.web_search=false` / `web_search_mode="disabled"` remove nothing on `0.147.0`. No client-side kill switch | Not yet re-tested on `0.150.1` — scheduled before P4's audit-flag work is called done |
| `codex exec` reads stdin when attached | Spawn with stdin closed (`</dev/null`) or a phase can hang | Reconfirmed — every probe here redirected `</dev/null` and none hung |
| Model catalog is plan-gated | On the source machine, the paid `ChatGPT Go` tier was required to pin `gpt-5.6-terra` explicitly | **Different on this machine**: `gpt-5.6-terra` is listed with `"visibility":"list"`, no `"upgrade"` gate, and the explicit pin (`-m gpt-5.6-terra`) was accepted cleanly on the **free** tier. Plan gating is evidently account/region/tier-specific, not universal — re-check on whichever account ends up driving P5 |
| `--json` event vocabulary | `turn.started` / `turn.completed` / `thread.started` / `item.completed` / `agent_message`; usage fields ride on `turn.completed`; no timestamps | Reconfirmed live, byte-identical shape |

## New finding this session — reasoning-effort enum and model-rejection errors are structured

Not previously recorded. An invalid `model_reasoning_effort` or an unrecognized model slug both
produce a clean `{"type":"error",...}` item followed by `turn.failed`, with the exact validation
message from the backend (e.g. the full accepted-enum list for effort). This is a reliable,
cheap way to build the fairness-pin assertion's *rejection* path — pass the pinned model/effort
on every call and trust the CLI to hard-fail on drift, since the stream can't positively confirm
which model answered a *successful* call (see check 7 above).

## Outstanding before this file is closed out

1. Vertex ADC or `GEMINI_API_KEY` — unblocks check 8.
2. Re-verify the `gpt-5.6-terra` pricing pin against OpenAI's published rates — gates P5 only.
3. Re-test the `---`-frontmatter separator fix and the web-search hook-invisibility finding on `0.150.1` directly, before P4's write contract and audit-flag work are called done.
4. Live MCP tool-namespacing test, once the real `model-dispatch` server is wired in P3.
