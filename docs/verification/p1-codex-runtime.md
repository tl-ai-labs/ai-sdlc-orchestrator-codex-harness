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

## Check 1/6 follow-up — `apply_patch` is a SEPARATE matcher with a DIFFERENT payload shape (2026-08-31)

While building the write-contract hook for P3, checked whether the guard above actually covers
the model's native file-editing tool, not just Bash. On `0.151.0` the model's default behavior
for creating/editing a file is a `file_change` item backed by an `apply_patch` tool call, not a
Bash shell redirect — and the model outright refuses a shell-based write when told its
"workspace rules require file edits via the patch mechanism." A hook registered only on
`matcher="Bash"` never sees this at all, so a write-contract guard written for Bash alone would
provide close to no real coverage against ordinary model behavior.

**A first attempt appeared to show `apply_patch` bypasses PreToolUse hooks entirely** — six
different matcher-name guesses, all silent. That result was **wrong, and the cause was a bug in
the disposable test hook script**, not codex: it called `require("fs")` inside a `.mjs` file,
which throws immediately in native ESM (`require` is undefined), so the script died before
writing anything or replying — codex correctly fail-opened on a broken hook, and the "did the
sidecar file appear" check naturally read false. Recorded here because it is exactly the kind of
wrong conclusion the "test it, don't assume" instruction exists to catch, including catching
one's own tooling bugs before writing them up as a runtime finding.

**With the bug fixed, `matcher="apply_patch"` fires correctly** and a `deny` decision genuinely
blocks the write (file never created; same no-trace-in-`--json` behavior as the Bash case,
confirmed again here). The payload shape is real and different from Claude's:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "apply_patch",
  "tool_input": {
    "command": "*** Begin Patch\n*** Add File: probe5.txt\n+hello\n*** End Patch"
  },
  "cwd": "/tmp/hook-test-ws",
  "model": "gpt-5.6-terra",
  "permission_mode": "bypassPermissions"
}
```

There is no `tool_input.file_path` or `tool_input.path` field at all — the target path (or
paths; a single patch can carry `*** Add File:` / `*** Update File:` / `*** Delete File:` /
`*** Move to:` blocks for more than one file) is embedded inside `tool_input.command` as OpenAI's
apply_patch patch-format text. The source's `write-contract-check.mjs` extracts its target from
a structured `file_path` field — that extraction logic does not fire on this shape at all and
needs a real rebuild (parse the patch-format headers), not just a port of the matcher name.

**Consequence for the port:** the codex write-contract hook registers on **both** `Bash` and
`apply_patch` matchers, with two different target-extraction paths — a shell-redirect scan for
`Bash`, a patch-header parse for `apply_patch` — feeding the same allowlist/off-limits decision
logic. Missing either matcher leaves a real gap in brownfield's core safety guarantee, not a
cosmetic one.

**Built and verified live** as `plugin/codex/hooks/write-contract-check.mjs` — 26 offline unit
tests (`tools/test/write-contract-check.test.mjs`), plus two full `codex exec` end-to-end runs
against a real write-contract with a restrictive allowlist:

- First run: the model tried creating an out-of-allowlist file directly (denied), then tried
  *editing `write-contract.json` itself* to add the path to its own allowlist — also denied,
  because the contract file isn't in its own allowlist either (no special-case needed; the same
  mechanism protects itself). It then fell back to a bare `touch` with no redirect, which an
  earlier version of the extractor missed — an empty file landed on disk even though the
  content-write was correctly blocked.
- Extended the Bash extractor to cover `touch`/`cp`/`mv` (destination only), re-ran: the second
  live run left **no artifact at all** — the model attempted the write, was denied, and even
  cleaned up after itself. `write-contract.json` was verified byte-for-byte unchanged.

Every decision (allow and deny) is also confirmed landing in `.sdlc/local/guard-decisions.jsonl`
with its own timestamp, per D3 — checked directly against the sidecar file in both live runs, not
just asserted in the unit tests.

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

## Custom prompts are deprecated — the command surface ships as skills (2026-09-01)

Both port documents assume the 13 `/mmo:*` command files become "Codex prompts" in
`~/.codex/prompts/*.md`. Checked against codex's own official manual before building them
(fetchable via the `openai-docs` system skill; cached at
`/tmp/openai-docs-cache/codex-manual.md`, section "Custom Prompts"):

> Custom prompts are deprecated. Use skills for reusable instructions that Codex can invoke
> explicitly or implicitly.

Three consequences, all favouring skills:

- **Prompts cannot ship in the repository.** The manual: they "live in your local Codex home
  directory… so they're not shared through your repository." A command surface that every user
  has to hand-install into their own `~/.codex/prompts/` is not a command surface this project
  can distribute. Skills ship inside the plugin.
- **Skills are a superset of what prompts did.** "The model first sees skill metadata… It loads
  the complete instructions when the user's request matches the skill **or the user invokes it
  directly**." Direct invocation is preserved; implicit matching is added.
- **The manifest already declares them.** `plugin/.codex-plugin/plugin.json` carries
  `"skills": "./skills/"`, so the command skills are distributed by the existing install route
  with no extra machinery.

Recorded because it changes what Document A section 7's "13 command files → Codex prompts" row
should produce, and because building against a deprecated surface would have shipped a command
layer users could not install from the repo.

For reference, the deprecated format (verified in the same section, not used here):
`~/.codex/prompts/<name>.md`, top-level `.md` only, YAML frontmatter with `description:` and
`argument-hint:`, placeholders `$1`–`$9` / `$ARGUMENTS` / named `$UPPERCASE`, invoked as
`/prompts:<name>`, and requiring a codex restart to load. `codex exec` does not expand slash
commands at all — they are an interactive-surface feature, which is why this could not be
exercised headlessly here.

## How codex discovers and names skills — measured, not assumed (2026-09-01)

Having decided the command surface ships as skills, three things had to be settled before
writing 13 files: where codex looks for them, what the model actually sees, and how they are
addressed. `codex debug prompt-input` renders the model-visible prompt as JSON and costs
nothing, so all of this was measured rather than inferred.

**What the model sees.** A `<skills_instructions>` block listing a "skill roots" table (`r0`,
`r1`, …) and then one flat line per skill:

```
### Available skills
- imagegen: Generate or edit raster images when … (file: r0/imagegen/SKILL.md)
```

Only `name` and `description` reach the model up front; the body is loaded on selection. This
is why descriptions must be short and front-loaded — the manual caps the initial list at 2% of
the context window (8,000 chars when unknown) and "shortens skill descriptions first".

**Roots, at repo root, with nothing installed:**

| Probe | Root | Rendered name |
| --- | --- | --- |
| baseline, `plugin/skills/` only | `r0` = `~/.codex/skills/.system` | our skills absent entirely |
| `.agents/skills/mmoprobe/` | `r1` = `<repo>/.agents/skills` | `mmoprobe` |
| `.agents/skills/pipeline` → symlink into `plugin/skills/pipeline` | `r1` | **`mmo-codex:pipeline`** |

Three findings, each of which would have been wrong if assumed:

1. **`plugin/skills/` is not scanned from a checkout.** The manifest's `"skills": "./skills/"`
   is a packaging declaration; it makes skills available once the plugin is *installed*. Working
   in a clone of this repo — which is how every run in this document was done, and how a
   contributor will work — codex does not see them. `codex plugin list --json` confirmed
   `{"installed": [], "available": []}` throughout.
2. **`.agents/skills` at the repo root is scanned**, and works on this machine's awkward path
   (`/mnt/c/…/TL ai labs/…`, WSL, spaces). Symlinks in it are followed, as the manual states.
3. **Codex namespaces a plugin's skills by the plugin name, automatically.** The symlinked
   skill rendered as `mmo-codex:pipeline` purely because `.codex-plugin/plugin.json` is an
   ancestor of the symlink's target — with the plugin not installed. So the addressable surface
   is `$mmo-codex:greenfield`, and skill `name:` fields stay bare (`name: greenfield`). An
   `mmo-` prefix would render as `mmo-codex:mmo-greenfield`.

Invocation is `$<name>` (or the `/skills` picker), per the manual: "In Codex CLI or the IDE
extension, run `/skills` or type `$` to mention a skill." Not `/mmo:greenfield` — that was the
Claude harness's slash-command surface, and `codex exec` does not expand slash commands at all.

The plugin keeps the name `mmo-codex` rather than being renamed to `mmo` to reproduce the
source's exact `mmo:` namespace: both harnesses' plugins can be installed side by side, and a
shared `mmo` name would collide.

Consequence for setup: finding 1 is a real gap, since the skills are useless to a contributor
working in a clone. Tracked below.

## `allow_implicit_invocation: false` hides a skill from the model entirely (2026-09-01)

The 13 command skills split into two groups. Five are general entry points
(`greenfield`, `brownfield`, `setup`, `policy`, `revert`). Eight each start a full, billable,
multi-phase SDLC run (`pass` plus the seven job aliases `bugfix`, `docs`, `test`, `refactor`,
`deps`, `feature-new`, `feature-extend`), and must never fire because the user happened to say
the word "test" or "docs". Those eight carry `agents/openai.yaml`:

```yaml
policy:
  allow_implicit_invocation: false
```

The manual describes this as suppressing implicit matching, with "explicit `$skill` invocation
still works". Measured effect is stronger than that wording suggests: the flagged skills are
**removed from the model-visible skill list altogether**. `codex debug prompt-input` at repo
root listed 7 of our 15 skills — exactly the 7 without an `openai.yaml`. Confirmed as causation
rather than budget truncation two ways: the whole `<skills_instructions>` block was 4,286 chars
against the 8,000-char floor with no truncation notice, and moving `bugfix/agents/openai.yaml`
aside made `mmo-codex:bugfix` appear immediately.

Kept anyway, because nothing is actually unreachable. `brownfield` stays visible, and
`brownfield-guide` — the manual it delegates to — covers all seven intents itself, so "fix this
bug in my repo" still routes correctly through the visible entry point, which then asks which
job type. The seven aliases are shortcuts for users who already know the name; the flag costs
discoverability of a shortcut and buys immunity from a spend-incurring misfire.

**Resolved — explicit invocation confirmed by measurement (2026-09-01).** This was initially
recorded as the one claim resting on documentation rather than measurement, because `$`-mentions
and `/skills` are interactive-TUI features and `codex exec` expands neither. It turns out the
picker's data source is reachable without the TUI: the app-server protocol exposes a
`skills/list` method (found via `codex app-server generate-json-schema --out <dir>`, which also
lists `skills/config/write` and `skills/extraRoots/set`).

Driving `codex app-server` over stdio with `initialize` then
`skills/list {"cwds": ["<repo>"], "forceReload": true}` returns all 21 skills visible from this
repo, and every one of the 8 flagged skills is present with `"enabled": true`:

```json
{ "name": "mmo-codex:bugfix",
  "description": "Fix a defect in an existing repository — reproduce, diagnose, fix, add a regression test…",
  "path": ".../plugin/skills/bugfix/SKILL.md", "scope": "repo", "enabled": true, "pluginId": null }
```

So the two surfaces genuinely differ, and the manual's wording is exact: `allow_implicit_invocation:
false` removes a skill from the **model's** prompt list while leaving it in the **user's** picker.
Nothing in the command surface is unreachable. Cost: nothing — no model call is involved.

## Two failures a real reference run found that no unit test could (2026-09-01)

Both surfaced only under a full Workforce Ops run on `gpt-seat-plus-flash`, and both presented
as `exit=0` with no error — the most misleading shape this kind of failure can take.

### 1. The MCP client gave up before its own adapter did

Every judgment dispatch failed with `MCP error -32001: Request timed out`, ~60s in. Preflight
passed, the model was answering, nothing was wrong with connectivity.

`driverClient.ts` called `client.callTool({name, arguments})` with no options, so the MCP SDK's
**60-second default request timeout** applied. Meanwhile `gpt-seat-plus-flash` sets
`worker_timeout_sec: 540`, and `CodexCliAdapter` defaults to 600 — the adapter shells out to a
nested `codex exec` at `model_reasoning_effort=high`, which routinely takes minutes. So the
client abandoned each call while the adapter kept working for another eight minutes.

Fixed with an explicit `{ timeout }` on every `callTool`, defaulting to 900s. The invariant is
now tested against the actual `worker_timeout_sec` values in the shipped policy files rather than
a hardcoded number: a client that gives up before its own adapter turns a slow answer into a
phantom vendor failure.

Worth recording separately: the conductor handled this **correctly**. It retried with a narrower
packet, then halted before Gate 1 and reported *"Both requirements-model dispatches timed out and
produced neither an artifact nor telemetry. I did not author a substitute, so no later phase
ran."* The D1 rule — the conductor authors no shipped content — held under exactly the pressure
that would have made fabricating a requirements document the convenient move.

### 2. One `codex exec` turn is not enough for a real project

With the timeout fixed, the run got through requirements, design, both gates and into codegen —
then the turn simply ended. `exit=0`, no error, six phases still to go.

The turn had accumulated **2,908,195 input tokens (2,814,976 of them cached)**. It hit the
session's context ceiling. The driver was built around a single `codex exec` invocation, so
there was nowhere for the work to continue.

`codex exec resume <session-id>` exists and continues the same session. The driver now takes the
`thread_id` from the `thread.started` event and resumes until the pipeline writes `SUMMARY.md`,
capped by `--max-turns` (default 12). Three details that matter:

- **Completion is an artifact, not a phrase.** `SUMMARY.md` is what phase 9 is contractually
  required to write. A model can improvise "the run is complete"; it cannot improvise that file.
- **The accumulated stream is what gets priced.** Reading only the last turn's stdout would
  silently drop the cost and events of every earlier turn.
- **A resumed turn keeps the pin, the sandbox and the write-contract hook.** One that dropped the
  hook would write unguarded; one that dropped the pin would answer on a different model.

The manifest gained `codex_invocations` (how many times the driver called codex, distinct from
`driver_turns`) and `completed` (whether the pipeline actually reached its final phase), because
a run that exhausts its turns still exits 0 with useful artifacts and must not be mistaken for a
finished one.

## The harness forbade a write it also instructs (2026-09-02)

The completed Workforce Ops reference run reported, in its own final summary, that "`eslint`,
build, E2E, and startup verification were not run; copying the test fixture to `.env` was denied
and not retried."

The guard log confirms it — one denial in the whole run, out of 120 decisions:

```
decisions: {'allow': 119, 'deny': 1}
  DENY: /tmp/p6c/.env | .env matches always-off-limits pattern ".env"
```

Both halves of the contradiction shipped:

- `plugin/skills/pipeline/SKILL.md` phase 7 instructs the greenfield test bootstrap
  `if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test .env; fi` — required for any app
  whose codegen emitted a validating config module, or it cannot boot to be tested.
- `OFF_LIMITS_DEFAULT` carries a blanket `.env`, and the pre-contract safety net enforces it
  before any contract exists — which is exactly the greenfield case.

So the run did the right thing (the guard held, the conductor reported the gap honestly) while
the pipeline could not complete its own verification step. The cost is quiet: tests still ran and
passed, so nothing looked broken, but build and E2E were skipped.

Narrowed the pre-contract branch to allow **creating** a bare `.env` that does not exist. What
the rule protects is unchanged, and each part was verified against the real hook:

| Case | Decision |
| --- | --- |
| `cp .env.test .env`, greenfield, no `.env` present | allow |
| same, but `.env` already exists | **deny** — a real `.env` is never overwritten |
| `.env.production`, `.env.local` | **deny** — variants stay blocked |
| `cp .env.test .env` under an active brownfield contract | **deny** |

Brownfield never reaches this branch at all (it has a contract), and its own phase 7 refuses the
copy outright, so the path that guards a user's real secrets is untouched. What is now permitted
is a greenfield run creating a throwaway fixture inside the tree it just generated.

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
