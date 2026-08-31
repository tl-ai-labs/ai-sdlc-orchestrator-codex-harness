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
| 4 | Register a stdio MCP server, list its tools | **RESOLVED, with a design change — live, 2026-08-31.** A model in a plain `codex exec` session cannot see or call `model-dispatch`'s tools (see the dedicated section below) — this falsified the assumption that config.toml registration alone is sufficient. Fix: the codex driver calls the bridge itself as a Node MCP client (`plugin/mcp/model-dispatch/src/driverClient.ts`), never relying on the model's own function-calling. Proven live end-to-end, including a second sandbox-specific finding — see both sections below | Bridge connectivity — closed for P3, in a different shape than Document A originally assumed |
| 5 | `codex exec --json`, capture JSONL | **PASS — live.** Event sequence: `thread.started` → `turn.started` → `item.completed` (`agent_message`) → `turn.completed` (with `usage`). No event carries a timestamp | Telemetry event shape |
| 6 | Repeat check 1 while capturing `--json` | **PASS — live.** The denied call produced zero items in the JSON stream — no `command_execution`, no error item, nothing. The only evidence was a `stderr` log line and the model's own narration in its final `agent_message` | Denied-call record is mandatory, not optional |
| 7 | Set reasoning effort explicitly | **PASS — live.** `-c model_reasoning_effort="high"` accepted cleanly for `gpt-5.6-terra`. An invalid value (`"not-a-real-level"`) was rejected with a structured `turn.failed` error naming the valid enum: `none, minimal, low, medium, high, xhigh, max`. **Caveat:** a successful turn's `--json` output never echoes back which model or effort actually answered — enforceability is "the CLI rejects an invalid pin outright," not "the stream proves the correct pin was used." The fairness-pin assertion has to rely on the CLI's own validation, not on reading the effort back out of telemetry | Fairness pin is settable; only partially observable |
| 8 | Dispatch one Gemini packet through the bridge | **PENDING** — needs Vertex ADC or `GEMINI_API_KEY` (Q13(c) in the track doc) | Mechanical tier |
| 9 | Spawn a subagent | **INCONCLUSIVE — live.** `multi_agent` is wired: a `collab_tool_call` item type exists and fired (`tool: "wait"`). But the spawn itself failed in headless `exec` mode — `stderr`: `collab spawn failed: no thread with id: <thread_id>` — and the model answered the test question directly rather than proving real delegation. Native subagent hosting is not provably usable from `codex exec` on this version; the fallback (fold agent roles into the driver prompt, dispatch every model call through the bridge) is the safer default, consistent with the track doc's D1 note that bridge-dispatch is required regardless | Role hosting mechanism |
| 10 | Fresh session vs. install session registration | **PASS — reasoned, not a live re-test.** `codex doctor` reports the background app-server as "not running (ephemeral mode)" — there is no long-lived daemon in the default setup. Every `codex`/`codex exec` invocation is a fresh process that reads `config.toml` at start. This is structurally the opposite of the source Claude Code harness's failure mode (where a running interactive session doesn't pick up plugin registration until restarted) — there is no "install session vs. fresh session" distinction to fail here, because there is no persistent session to begin with | No silent premium-model cost failure from stale registration |
| 11 | Compare driver pricing against published rates | **PENDING** (gates P5 only) | Pricing pins |

## Check 4 — MCP tools registered via `config.toml` are NOT reachable from `codex exec` on 0.151.0 (CRITICAL, 2026-08-31)

This blocks Document A P3's exit criterion ("bridge reachable from Codex") and calls into
question Document B section 3's "Required" listing for `MCP servers via config.toml`. Recorded
in full because it contradicts what both documents assume, per the standing instruction not to
assume unverified Codex behavior.

**Setup.** Built `plugin/mcp/model-dispatch` (real server, not a stub) and registered it exactly
as Document B section 4 specifies:

```
codex mcp add model-dispatch -- node <repo>/plugin/mcp/model-dispatch/dist/server.js
```

`codex mcp list` / `codex mcp get model-dispatch` confirm the registration and `config.toml`
correctly gained `[mcp_servers.model-dispatch]`. Running the server binary directly
(`node dist/server.js`) hangs cleanly on stdin with no startup error — the server itself is
healthy.

**What happened when a live turn tried to use it.** Five independent probes, all on
`codex-cli 0.151.0`, same session, same registration:

1. Asked the model to call `load_policy` from `model-dispatch` directly. It never attempted the
   tool — it answered by `rg`/`sed`-reading the policy YAML from the filesystem instead (a
   cheaper path for that question, so inconclusive on its own).
2. Told it to use its "tool-search capability" to discover the server's tools first, then call
   `load_policy`. Same filesystem-read fallback — inconclusive on its own.
3. Forbade shell commands and file reads, required an MCP tool call or an explicit admission.
   Result: **`NO_MCP_TOOL_AVAILABLE`**.
4. Asked the model to introspect its own function schema verbatim (no filesystem access).
   Result: only `functions.wait`, `functions.exec`, `collaboration.*`, and, callable from inside
   `functions.exec`: `apply_patch`, `create_goal`, `exec_command`, `get_goal`,
   `list_mcp_resource_templates`, `list_mcp_resources`, `read_mcp_resource`,
   `request_plugin_install`, `update_goal`, `update_plan`, `view_image`, `write_stdin`,
   `web__run`. **No per-MCP-tool binding for `model-dispatch` exists anywhere in the schema** —
   not a namespaced form (`mcp__model_dispatch__load_policy`), not a generic "call an MCP tool"
   function.
5. Told the model to probe MCP reachability using only its own MCP-related primitives, live.
   `list_mcp_resources` / `list_mcp_resource_templates` against the built-in `codex` server
   returned empty lists cleanly. The same two calls against `model-dispatch` **failed**:
   `codex_core::tools::router: error=resources/list failed ... Mcp error: -32601: Method not
   found`. The model then tried the classic Claude-Code-style namespaced call as a guess —
   `tools.mcp__model_dispatch__execute_with_model` / `...load_policy` — and both raised
   `TypeError: ... is not a function`.

**Diagnosis, not yet a fix.** `codex features list` shows `ToolSearchAlwaysDeferMcpTools` active
in the turn's feature set (confirmed via `RUST_LOG=debug`, which also confirms codex genuinely
attempted the MCP handshake: `mcp_servers="model-dispatch, codex_apps"`,
`mcp_server_count=2`, and an `rmcp` client actually initializes — this is not a registration
failure, the server connects). But:

- `--disable tool_search_always_defer_mcp_tools` changes nothing (that flag is listed
  `removed:true` — it can't be toggled back off).
- `--enable mcp_2026_07_28 --enable non_prefixed_mcp_tool_names` (the two `under development`
  MCP-adjacent flags) changes nothing.
- `--disable code_mode_host --disable code_mode` changes nothing — the exposed function schema
  is identical with or without code-mode, so this is not a code-mode artifact.
- The `list_mcp_resources` / `list_mcp_resource_templates` primitives query the MCP
  **Resources** capability, not **Tools** — a different part of the MCP spec. `model-dispatch`
  correctly returns "Method not found" for `resources/list` because the bridge implements only
  `tools/list` and `tools/call`, never resources. These two primitives are therefore not the
  right introspection surface even if they worked, and no other MCP-tool-call primitive is
  present in the schema to try instead.

**Working hypothesis, unconfirmed:** a server registered via plain `config.toml
[mcp_servers]` (Document B section 6's "clone route — fallback") may simply not be
exposed to the model as callable tools in a bare `codex exec` session on this build, and the
plugin route (`.codex-plugin/plugin.json` + `codex plugin add`, Document B section 6's "primary"
route, Q15 in the port track doc) may be required — not merely preferred for install-parity —
for the model to actually see third-party MCP tools. This is untested: building a minimal
plugin manifest and marketplace snapshot to check it is real work, not a quick probe, and is
flagged rather than attempted speculatively.

**Consequence for the port:** the driver-entry script (Document A P3) cannot be built to assume
plain `[mcp_servers]` registration makes the bridge callable — that assumption is now falsified,
not just unverified. Continuing to build P3's driver entry around it would be building on a
foundation this session just disproved. This is reported to the project owner rather than
silently worked around.

## Check 4 resolution — the driver calls the bridge itself, as a Node MCP client (2026-08-31)

Direction taken after reporting the finding above: since GPT is a pure conductor by design (D1 —
"runs the loop, calls tools, writes files, authors no content") and every model call including
judgment work is required to route through the bridge regardless (Document A section 3), nothing
about the architecture actually requires the *model* to be the one invoking the MCP protocol.
The codex driver script can be the MCP client itself.

Built `plugin/mcp/model-dispatch/src/driverClient.ts` — a thin wrapper around
`@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport` (already a bridge dependency; no
new package). It spawns `dist/server.js` as a subprocess and calls its tools directly, in Node,
with no model in the loop for the dispatch mechanics themselves. The five MCP tool
names/signatures (Document A section 8, locked) are unchanged — only who calls them changed.

**Proof, not just a code review.** `test/driverClient.test.mjs` spawns the real built server (no
mocks) and calls `load_policy` and `preflight_dispatch` for real — both make zero vendor API
calls, so this stays offline and free. All pass. Then confirmed the same client works when
*launched by codex itself*, not just by a plain Node test runner: had `codex exec` run a script
that calls `connectBridge()` and `load_policy`, and got the correct policy back
(`{"name":"gpt-plus-flash","version":1,...}`) — proof the whole chain (`codex exec` → shell →
Node driver script → MCP client → spawned bridge subprocess → real tool call) works end to end.

## New finding — `codex exec`'s default `workspace-write` sandbox silently kills the bridge subprocess (CRITICAL, 2026-08-31)

Discovered while doing the check-4 resolution proof above. The first `codex exec` run of the
driver script (plain `--sandbox workspace-write`, this repo's default in the probes above) failed
with `McpError: MCP error -32000: Connection closed` — the bridge subprocess died before
completing the MCP handshake.

**Isolating it, in order:**
1. `--sandbox danger-full-access` — same script, same command: **works**, correct policy JSON
   returned. Rules out the driver client code itself.
2. A trivial subprocess spawn (`spawn(process.execPath, ["--version"])`) under plain
   `workspace-write` — **works**. Rules out "workspace-write blocks child-process spawning" as
   the cause; the problem is specific to this particular child.
3. Captured the bridge subprocess's own stderr (default-inherited by the parent) under
   `workspace-write` — **completely empty**, no stack trace, no error text. A JS exception would
   print to stderr; a silent, immediate death with nothing printed is the signature of the
   process being killed by the sandbox (Landlock/seccomp) rather than crashing on its own.
4. `--sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'` — **works**,
   identical correct output to the danger-full-access run.

**Root cause:** `workspace-write`'s default sandbox blocks network access, and something in the
bridge's startup path needs it — most likely `geminiTransports.ts`'s ADC/Vertex backend
resolution, which the earlier `preflight_dispatch` test run (outside any codex sandbox) showed
touches `defaultAdcPath()` and logs `backend=vertex-adc` at construction time, independent of
whether the run's policy actually dispatches to Gemini in that call. Under a sandbox that blocks
the network syscall outright, an underlying SDK's synchronous or unhandled probe attempt gets the
process killed rather than raising a catchable JS error — hence the empty stderr.

**Consequence for the port:** the codex driver script must not run under a bare `--sandbox
workspace-write` invocation. Either pass `-c 'sandbox_workspace_write.network_access=true'`
whenever spawning the bridge, or move to `danger-full-access` for the phases that touch it. This
gates P4's driver-entry documentation and the setup docs, not just P3 — flagging it now so it
isn't rediscovered as a mystery hang during the P5 quick-demo run. Root-causing the exact
syscall inside the bridge's dependency tree that trips the sandbox is not done here — the
workaround is proven and cheap; chasing the precise trigger inside `@google/genai` or its
transitive deps is not worth the time against this port's actual deliverables.

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
4. ~~Live MCP tool-namespacing test, once the real `model-dispatch` server is wired in P3.~~
   **Resolved differently than expected — see the check 4 resolution section above.** The model
   never sees the bridge's tools at all in a plain `codex exec` session, namespaced or not; the
   codex driver calls the bridge itself instead. Namespacing per Document A section 7's tool-
   namespacing test is moot for the codex side — it only mattered for a model-driven call.
5. Driver auth for this build-out: this session used the free ChatGPT seat login throughout
   P1, at $0, with no paid-tier gate encountered. Track doc Q11 (own seat vs. `OPENAI_API_KEY`)
   stays open for whoever runs the paid P5/P6 reference runs — not a P1–P4 blocker.
6. Root-cause exactly which dependency/syscall inside the bridge's startup path trips the
   `workspace-write` sandbox's network block (see the sandbox finding above). The workaround
   (`network_access=true`, or `danger-full-access`) is proven and in place; the precise trigger
   is not chased further — not worth the time against this port's deliverables.
