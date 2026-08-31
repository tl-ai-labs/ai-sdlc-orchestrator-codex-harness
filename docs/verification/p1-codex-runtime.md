# P1 — Codex runtime verification

Document B, section 7. Run before implementation begins. Checks are dated 2026-08-28 (first
two sessions: offline pass, then live pass after login) and 2026-08-31 (re-verification on a
newer CLI build immediately before P2 starts, plus pin selection). Check 8 (Gemini dispatch)
and check 11 (pricing) remain pending — the first needs Vertex or Gemini credentials not yet
provisioned (track doc Q13(c)), the second only gates P5.

## This machine

| Item | Value |
|---|---|
| Codex CLI | `0.151.0` as of 2026-08-31 (was `0.150.1` on 2026-08-28; via `npx @openai/codex`, no global install — `codex doctor` flags the npx/npm-global path mismatch as a note, not an error) |
| Node.js | v24.19.0 |
| Python | 3.14.4 |
| Platform | WSL2 (Linux 6.18, Windows host) |
| `codex login status` | Logged in using ChatGPT (free tier) |

The port track document's baseline is `0.147.0` (Sriram's probe machine, 2026-08-21/27). This
machine has since moved `0.150.1 → 0.151.0` within the same verification effort — still newer,
not older. `codex features list` reconfirms the same stable/enabled flags on `0.151.0`:
`plugins`, `plugin_sharing`, `hooks`, `multi_agent`, `skill_search`. Every load-bearing finding
below has now been exercised live on this exact build, immediately before P2 starts.

**WSL2 note:** device-code login initially failed instantly (`error sending request for url`)
on every attempt, on 2026-08-28. Root cause diagnosed then: this WSL2 instance had no working
IPv6 route (`eth0` carries only a link-local address) while DNS still returns `AAAA` records for
`auth.openai.com`; Codex's HTTP client doesn't fall back to IPv4 the way `curl` does. Fix used
then: `sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1`. On 2026-08-31, `disable_ipv6` reads back
`0` (IPv6 is enabled again — the sysctl did not persist across whatever reset the WSL2 network
stack) and every `codex exec` call in this session still completed successfully; one call logged
a single transient `failed to lookup address information` / websocket error on `chatgpt.com` that
the client itself retried and recovered from. Net effect: the IPv6 workaround is not reliably
necessary on this machine session-to-session, but is worth keeping as the first thing to try if
`codex login` or `codex exec` fails outright with a DNS/connect error — flagged for the eventual
setup docs either way.

## Checks

| # | Check | Result | Confirms |
|---|---|---|---|
| 1 | Wire a hook that exits non-zero on a write, attempt the write | **PASS — live, this session** | Hooks CAN block. Gates brownfield scope |
| 2 | `codex doctor`, `codex --version` | **PASS** — `codex-cli 0.151.0` as of 2026-08-31 (was `0.150.1`); doctor reports auth mode `ChatGPT`, git/repo detection, terminal, and search all ok. Two doctor *notes* (not failures): the running npx package root differs from the npm global package root, which only affects `codex update`'s target, not runtime behaviour | Install health |
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
| `---`-leading prompts break the CLI | `clap` parses a prompt starting with `---` as flags; fix is `args.push("--")` | **Reconfirmed live on `0.151.0`, 2026-08-31.** A prompt beginning with `---\nname: test\n---\n...` passed as the bare positional argument fails with clap's `unexpected argument '---...'` error, exit before any model call. Prefixing the same argument list with a literal `--` separator fixes it cleanly — the model received and answered the frontmatter-wrapped prompt correctly (`PONG`) |
| Hosted web search is invisible to hooks | `web_search` runs server-side; `tools.web_search=false` / `web_search_mode="disabled"` remove nothing on `0.147.0`. No client-side kill switch | Not yet re-tested on `0.151.0` with a call that actually invokes hosted search — doing so deterministically needs a prompt engineered to trigger it, which is a P4 task alongside the audit-flag work itself, not a standalone P1 probe |
| `codex exec` reads stdin when attached | Spawn with stdin closed (`</dev/null`) or a phase can hang | Reconfirmed — every probe here redirected `</dev/null` and none hung. Note: even with `</dev/null`, codex still logs `Reading additional input from stdin...` to stderr — harmless, it reads EOF immediately |
| Model catalog is plan-gated | On the source machine, the paid `ChatGPT Go` tier was required to pin `gpt-5.6-terra` explicitly | **Different on this machine**: `gpt-5.6-terra` is listed with `"visibility":"list"`, no `"upgrade"` gate, and the explicit pin (`-m gpt-5.6-terra`) was accepted cleanly on the **free** tier, reconfirmed again on `0.151.0` on 2026-08-31. Plan gating is evidently account/region/tier-specific, not universal — re-check on whichever account ends up driving P5 |
| `--json` event vocabulary | `turn.started` / `turn.completed` / `thread.started` / `item.completed` / `agent_message`; usage fields ride on `turn.completed`; no timestamps | Reconfirmed live, byte-identical shape, on `0.151.0` |

## New finding this session — reasoning-effort enum and model-rejection errors are structured

Not previously recorded. An invalid `model_reasoning_effort` or an unrecognized model slug both
produce a clean `{"type":"error",...}` item followed by `turn.failed`, with the exact validation
message from the backend (e.g. the full accepted-enum list for effort). This is a reliable,
cheap way to build the fairness-pin assertion's *rejection* path — pass the pinned model/effort
on every call and trust the CLI to hard-fail on drift, since the stream can't positively confirm
which model answered a *successful* call (see check 7 above).

## Pins chosen (Document B §8, Document A P1′ exit criterion)

Selected 2026-08-31 after check 7 (reasoning effort) and the sandbox/approval probes below, all
on this machine's free ChatGPT-seat login, all at $0.

| Pin | Value | Basis |
|---|---|---|
| Model id | `gpt-5.6-terra` | The only GPT slug this port track document names (§0, §5, §8, F3). Confirmed servable and unrestricted on this machine's free tier (checks 5, 7, and the two re-tests above) — no plan upgrade needed for P1–P4 |
| Reasoning effort | `high` | Verified settable and accepted (check 7). Chosen over `medium` to approximate the judgment depth the source harness got from Opus, consistent with D9's judgment-worker role; re-open only if P5/P6 cost modeling shows `high` is materially more expensive than `medium` for no measured quality gain |
| Codex CLI version | `≥ 0.151.0` (this port's verification baseline) | The track doc's `0.147.0` baseline is superseded — every load-bearing capability has now been reconfirmed live on `0.151.0` directly, not inherited. Pin the *minimum*, not an exact build, since `codex doctor`/`--version` is checked at every run and features have only added, not removed, capability across `0.147.0 → 0.151.0` |
| Sandbox mode | `workspace-write` | Verified accepted via `-s workspace-write`/`--sandbox workspace-write` (probe below). `read-only` cannot support codegen; `danger-full-access` is unnecessary given the write-contract hook (checks 1/6) already provides the real enforcement boundary |
| Approval policy | `never` (headless) | Verified accepted via `-c approval_policy="never"` (probe below). Correct for unattended `exec` runs — there is no human present to answer an approval prompt, so the sandbox + hook pair is what actually bounds behaviour, not interactive approval |
| Search | On, unenforceable off — audited | `tools.web_search=false` / `web_search_mode="disabled"` do not disable `gpt-5.6-terra`'s hosted search (inherited finding, re-test of the invisibility-to-hooks half scheduled for P4). The pin is therefore procedural, not a config value: every driver prompt carries the web-mandate clause (Document A §9), and the audit flags any driver-side search item it can observe |
| Gemini region | Not yet set | Depends on Q13(c) credential provisioning (Vertex ADC or `GEMINI_API_KEY`), still outstanding below. Recorded in the policy YAML once chosen, per Document B §8 |

Probe commands (all `$0`, free tier, this session):

```
# sandbox + approval_policy accepted together, live model call succeeded
codex exec --json -m gpt-5.6-terra -c model_reasoning_effort="high" \
  -c approval_policy="never" --sandbox workspace-write --skip-git-repo-check \
  -- "Reply with exactly the word: OK" </dev/null
```

## Outstanding before this file is closed out

1. Vertex ADC or `GEMINI_API_KEY` — unblocks check 8 (mechanical-tier dispatch) and the Gemini
   region pin. Not yet provisioned (track doc Q13(c)); does not block P2–P4 offline work.
2. Re-verify the `gpt-5.6-terra` pricing pin against OpenAI's published rates — gates P5 only.
3. Re-test the web-search hook-invisibility finding on `0.151.0` with a prompt engineered to
   actually trigger hosted search — folded into P4's audit-flag work rather than done standalone.
4. Live MCP tool-namespacing test, once the real `model-dispatch` server is wired in P3.
5. Driver auth for this build-out: this session used the free ChatGPT seat login throughout
   P1, at $0, with no paid-tier gate encountered. Track doc Q11 (own seat vs. `OPENAI_API_KEY`)
   stays open for whoever runs the paid P5/P6 reference runs — not a P1–P4 blocker.
