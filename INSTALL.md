# Install instructions

This file is written for Codex to follow. Someone who says

> Set up this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness

expects the install to happen for them. Work through the steps below in order and report the
result. The person asking should not have to type any command.

Requirements: Node 20 or newer, and the Codex CLI 0.151.0 or newer, logged in. Step 3 checks
both and says what to do if either is missing.

**Two things about this environment before you start.** Both will bite silently otherwise.

- **Network is blocked inside the sandbox.** Steps 1 and 2 need it. `codex plugin` subcommands
  run as Codex itself rather than as sandboxed shell, so they work — but a `curl` or `git clone`
  to fetch this repo will fail with an empty response under the default sandbox. Prefer the
  `codex plugin` route below over fetching anything by hand.
- **Piped stdio to a child process is blocked inside the sandbox.** That does not affect
  installing, but it does affect *running*, so mention it at the hand-off in step 6.

---

## 1. Register the marketplace

```bash
codex plugin marketplace add https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness.git
```

Use the full `.git` URL rather than the `owner/repo` shorthand. Shorthand sources clone over SSH
by default, which fails for anyone without a GitHub SSH key loaded — a public repo does not need
one, so do not introduce the requirement.

The marketplace registers under the name `tilicho-ai-labs`.

**If it reports that the marketplace already exists, that command did nothing — and the next
step will install a stale version.** Codex caches the marketplace on disk and keys the install
off that cache, so re-adding an already-registered marketplace is a no-op that leaves the cached
copy exactly as it was, however old. Refresh it explicitly:

```bash
codex plugin marketplace upgrade
```

That re-fetches every configured Git marketplace. It is harmless when the cache is already
current, and it does nothing at all for a marketplace added from a local path — those resolve to
the working tree and are always live.

## 2. Install the plugin

```bash
codex plugin add mmo-codex@tilicho-ai-labs
```

Confirm it landed:

```bash
codex plugin list
```

The row should read `mmo-codex@tilicho-ai-labs  installed, enabled`. The `PATH` column is where
the plugin resolves to — remember it, step 3 needs it.

## 3. Hand off to the shipped setup skill

Everything after installation — building the bridge, checking credentials, the Gemini door, the
policy pick, the closing banner — is already written down inside the plugin you just installed,
at `skills/setup/SKILL.md`. Follow that rather than repeating it here; it ships with the plugin,
so it is always the version that matches the code on disk.

Invoke it:

```
$mmo-codex:setup
```

**If that skill is not offered yet in this session,** the plugin landed after the session started.
Do not stop and do not ask for a restart — read the file directly and follow it:

```bash
cat "$(ls -d ~/.codex/plugins/cache/tilicho-ai-labs/mmo-codex/*/skills/setup/SKILL.md | tail -1)"
```

Substitute the real paths for its `{{PLUGIN_ROOT}}` and `{{PROJECT_ROOT}}` placeholders —
`PLUGIN_ROOT` is the `PATH` column from step 2, `PROJECT_ROOT` is the current directory.

### The one command that matters most

If anything above goes wrong, this is the step that cannot be skipped. `dist/` and
`node_modules/` are not tracked in git, so a fresh install carries source only and the dispatch
bridge cannot start until it is built:

```bash
node "$(ls -d ~/.codex/plugins/cache/tilicho-ai-labs/mmo-codex/*/codex/verify-setup.mjs | tail -1)" --fix --project-root "$(pwd)"
```

If `codex plugin list` showed a local path instead of a cache path, use that path's
`codex/verify-setup.mjs` instead. `--fix` is idempotent — safe to re-run at any time.

## 4. Two findings to handle with judgment, not a relay

The check prints `✗` for blocking findings, `!` for warnings, `✓` for a pass, and each finding
carries its own `fix:` line. Report them as written rather than paraphrasing, and do not describe
the install as complete while a `✗` is outstanding. Two are worth knowing about in advance:

- **`skills-discoverable` (warning), listing every skill.** Ignore it on this route. It looks for
  symlinks under `.agents/skills`, which only the clone route needs; a plugin install loads skills
  from the manifest, and the `$mmo-codex:*` skills already work. Say so rather than "re-run with
  `--fix`", which will not clear it.
- **`openai-key` (blocking).** Do not tell anyone to go and buy an API key before asking which
  policy they want. On a ChatGPT subscription, `gpt-seat-plus-flash` runs the same model at the
  same reasoning-effort pin and needs no key at all — what it gives up is cost *precision*, not
  output, because Codex reports token counts but no money. The finding disappears once that
  policy is selected. The same caution applies to `GEMINI_API_KEY`: it is one of two doors, and
  Google Cloud application-default credentials open the other. Never send someone to buy a key
  for a tier whose other door is already open.

Never print the contents of `~/.codex/auth.json`, and never echo a credential back into the
transcript or a log. Report presence or absence, nothing more.

## 5. Hand over

Report the closing banner the setup skill prints, including which policy this project ended up on.

**Then say this, in your own words — it is the first thing a run hits otherwise.** Dispatch
reaches the bundled bridge by spawning it and talking over pipes, and Codex's sandbox denies piped
stdio under both its default and `workspace-write` modes. A run started in an ordinary session
fails at the pre-check with `MCP error -32000: Connection closed`, which reads like a broken
server and is not one. Two ways to avoid it:

- start Codex with `codex -s danger-full-access`, or
- run the pipeline headlessly, where the driver spawns the bridge outside Codex:
  `node <plugin-path>/codex/run.mjs --brief=<file> --project-root="$(pwd)" --output-dir="$(pwd)/.sdlc"`

No new session is needed for the skills themselves. Codex reads its configuration fresh on every
invocation, so the plugin installed above is already live.

## Verifying later

The same check repairs as well as reports, and is the right response to a plugin update — which
replaces the source and removes the build:

```bash
node "$(ls -d ~/.codex/plugins/cache/tilicho-ai-labs/mmo-codex/*/codex/verify-setup.mjs | tail -1)" --fix --project-root "$(pwd)"
```

`$mmo-codex:setup` does the same from inside a session. Both are idempotent.

## If someone wants the clone route instead

For working on the harness itself rather than using it, [SETUP.md](SETUP.md) documents cloning
and `node tools/setup.mjs`. That route needs the skills linked onto Codex's scan path, which is
where the `skills-discoverable` warning in step 4 genuinely applies.
