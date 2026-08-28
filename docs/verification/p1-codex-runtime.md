# P1 — Codex runtime verification

Document B, section 7. Run before implementation begins. This machine's checks are dated
2026-08-28. Checks 3, 5, 6, 7, 8, 9, and the live half of check 4 need a logged-in Codex
session and are marked pending below — they are re-run and this file is updated once auth
lands.

## This machine

| Item | Value |
|---|---|
| Codex CLI | `0.150.1` (via `npx @openai/codex`; no global install) |
| Node.js | v24.19.0 |
| Python | 3.14.4 |
| Platform | WSL2 (Linux 6.18, Windows host) |
| `codex login status` | Not logged in (pending — see below) |

The port track document's baseline is `0.147.0` (Sriram's probe machine, 2026-08-21/27).
This machine runs `0.150.1` — newer, not older. `codex features list` reproduces the same
stable/enabled flags the track doc recorded (`plugins`, `plugin_sharing`, `hooks`,
`multi_agent`, `skill_search`), so the architecture-level conclusions carry forward. Anything
version-sensitive below is re-confirmed live once this machine has a logged-in session.

## Checks

| # | Check | Result | Confirms |
|---|---|---|---|
| 1 | Wire a hook that exits non-zero on a write, attempt the write | **PASS (inherited)** — see below | Hooks CAN block. Gates brownfield scope |
| 2 | `codex doctor`, `codex --version` | **PASS** — `codex-cli 0.150.1`; doctor reports 15 ok / 1 idle / 4 notes, network and reachability both ok. Login-dependent checks (websocket auth, app-server) fail/warn only because no session is logged in yet | Install health |
| 3 | `codex login status` | **PENDING** — "Not logged in" as of this run | Driver auth |
| 4 | Register a stdio MCP server, list its tools | **PARTIAL PASS** — `codex mcp add probe-server -- node <script>` writes `[mcp_servers.probe-server]` to `config.toml` correctly; `codex mcp list` / `codex mcp get` read it back. The tool-name handshake (what a registered tool resolves to, e.g. namespacing) requires a live session — **PENDING** | Bridge connectivity, namespacing |
| 5 | `codex exec --json`, capture JSONL | **PENDING** (needs auth) | Telemetry event shape |
| 6 | Repeat check 1 with `--json` capture | **PENDING** (needs auth) | Denied-call record |
| 7 | Set reasoning effort explicitly | **PENDING** (needs auth) | Fairness pin |
| 8 | Dispatch one Gemini packet through the bridge | **PENDING** (needs Vertex/Gemini credentials — Q13(c) in the track doc) | Mechanical tier |
| 9 | Spawn a subagent | **PENDING** (needs auth) — `multi_agent` confirmed stable/enabled via `codex features list` | Role hosting |
| 10 | Fresh session vs. install session registration | **PENDING** — see note below | Silent cost failure |
| 11 | Compare driver pricing against published rates | **PENDING** (gates P5 only) | Pricing pins |

## Check 1 — hooks can block (inherited finding, re-confirm before P4 lands)

This exact check was run live, three times, on `codex-cli 0.147.0`, by the sibling port
referenced in the track document (`ai-studies-console`, the harness-matrix Codex port,
2026-08-09). The finding: a `PreToolUse` hook registered via

```
codex exec -c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="<guard-script>"}]}]' \
  --dangerously-bypass-hook-trust ...
```

denies a matching command live — the model's own transcript reports `Command blocked by
PreToolUse hook: <reason>` — and the write never happens. Confirmed three times (probes #1–#3
in that repo's `tools/harness-matrix/sdk-probe/codex/facts.md`), including one run ordering a
tree write that was correctly denied.

Two consequences that shape this port's design, both already reflected in Document A:

- **A denied call leaves no trace in the `--json` event stream.** The engine drops the call
  before creating any item; the only in-stream evidence is the model's own narration. The
  guard must therefore write its own sidecar record of every denial (Document A's
  `guard-decisions.jsonl` pattern) — the event reader cannot reconstruct denials after the
  fact.
- **The hook dispatcher speaks the Claude-compatible wire**, not a Codex-only one: payload
  arrives as `tool_name: "Bash"` with the bare (non-shell-wrapped) command in
  `tool_input.command`. The shell-wrap (`/bin/zsh -lc '…'`) only shows up in the trajectory's
  `command_execution` items, not in the hook payload — so the hook itself needs no unwrap step,
  only the telemetry event reader does.

This is treated as a proven pattern carried into this port's design (not a file import — the
port track document's D2 requires a clean re-implementation). It is re-run on this repository's
own guard implementation once Codex auth is available on this machine, before P4's write
contract is called done.

## Other inherited findings (same source, same CLI baseline, re-confirm at P3/P4)

| Finding | Detail |
|---|---|
| Commands are shell-wrapped | Every executed command arrives in trajectory items as `/bin/zsh -lc '…'`; unwrap before start-anchored classification |
| `---`-leading prompts break the CLI | `clap` parses a prompt starting with `---` (e.g. skill frontmatter) as flags; fix is `args.push("--")` before the prompt |
| Hosted web search is invisible to hooks | `gpt-5.6-terra`'s `web_search` runs server-side in the ChatGPT backend; `tools.web_search=false` and `web_search_mode="disabled"` remove nothing on `0.147.0`. No client-side kill switch exists. The only closure: a web-mandate clause in every prompt, plus an audit flag on any `web_search` item |
| `codex exec` reads stdin when attached | Must spawn with stdin closed (`</dev/null`) or a phase can hang waiting on a pipe that never closes |
| Model catalog is plan-gated | Bare `gpt-5.6` rejects; the actual servable slug was `gpt-5.6-terra` on the source machine's plan. This machine's servable slug is reverified once logged in — plan/tier can differ |
| `--json` event vocabulary | `turn.started` / `turn.completed` / `thread.started` / `item.completed` / `agent_message`; usage (including `cache_write_input_tokens` as of `0.147.0`) rides on `turn.completed`; no event carries a timestamp |

## Check 10 note — session-start registration

Not yet directly tested. What's confirmed so far: `codex mcp add` writes to
`$CODEX_HOME/config.toml`, and `codex exec` / `codex` both read that file fresh at process
start (no long-lived daemon in the default "ephemeral" app-server mode this machine reports).
That suggests each invocation picks up current config rather than an install-time snapshot —
the opposite failure mode from the source Claude Code harness (where prompts/MCP servers
register only once per session start). This needs a direct test — register a server, then run
`codex exec` in a **separate process** without restarting anything else — before it is treated
as settled. Scheduled for P3, alongside driver-entry work.

## Outstanding before this file is closed out

1. Codex login (`codex login --device-auth` or `OPENAI_API_KEY`) — unblocks checks 3, 5, 6, 7, 9, 10, and the tool-listing half of check 4.
2. Vertex ADC or `GEMINI_API_KEY` — unblocks check 8 (Q13(c) in the track doc).
3. Re-verify the `gpt-5.6-terra` pricing pin against OpenAI's published rates — gates P5 only.
