---
name: setup
description: "Verify or re-configure the SDLC harness for this project — build the dispatch bridge, check credentials, pick a routing policy. Idempotent; safe to re-run any time."
---

Re-verify the SDLC harness for this project. Auto by default: run the mechanical steps silently and
pause only when a human decision is genuinely required.

Print one line per completed step so the user can see progress. Pause only when a step actually
needs a human answer.

# Scope

This is the RE-VERIFY / RE-CONFIGURE flow. First-time install (getting the plugin onto the machine)
happens before this skill can exist. From there on, this covers everything: bridge build,
environment check, credential probe, mechanical-tier door, policy pick, and the hand-over banner.

A clone-route install has a wizard that does the same work from a plain shell, before any session
exists:

```bash
node tools/setup.mjs --project-root=<path>
```

Use that when there is no session to run a skill in. Everything below is the in-session equivalent.

# 1. Build / rebuild the dispatch bridge (silent)

```bash
node '{{PLUGIN_ROOT}}/codex/verify-setup.mjs' --fix --project-root '{{PROJECT_ROOT}}'
```

`--fix` installs the bridge's npm dependencies and TypeScript-compiles it. Idempotent — a no-op if
the build is already current. Report the one-line result and continue.

If the script exits non-zero, print the error, its `fix:` field, and STOP. Blocking findings are
things nothing downstream can work around: Node below the supported version, a codex CLI older than
the pinned minimum, a missing `OPENAI_API_KEY` on a metered policy, or a build error.

# 2. Read the result and pause only for what needs a human

The script reports three kinds of finding:

- `✗` **blocking** — already handled by step 1 (STOP).
- `!` **warning** — usually a credential that only some policies need. **Pause here.** For each
  warning, print the finding and ask the user for the value. Do not fabricate; do not proceed until
  the credential is either supplied or explicitly skipped.
  - **Gemini access** — required by any policy that routes mechanical phases to Gemini, which is
    both shipped policies. Either Google Cloud application-default credentials
    (`gcloud auth application-default login`, no key) or `GEMINI_API_KEY` for AI Studio.
  - **`OPENAI_API_KEY`** — required by `gpt-plus-flash`, the metered default. A user on a ChatGPT
    subscription with no API key is not stuck: `gpt-seat-plus-flash` reaches the same judgment
    model through the local `codex exec` seat. Say what that costs them in precision — the seat
    reports token counts but no money, so the judgment figure becomes modeled rather than metered
    — and let them choose.
- `✓` **ok** — no action, continue.

Never print the contents of `~/.codex/auth.json`, and never echo a credential back to the user or
into a log. Report presence or absence, nothing more.

# 3. Mechanical-tier door — auto-pick if only one works, ask only if both are available

The mechanical tier has two doors to the same model:

- **Gemini API** — signs with `GEMINI_API_KEY` or Google Cloud application-default credentials.
  This is what an untouched install already uses. No flag needed.
- **Antigravity SDK worker** — signs with Google Cloud credentials only (no API-key door). Enables
  agentic delegation with a working directory, at several times the token count per task.

Decision matrix:

| Door named by the user? | Google Cloud creds present? | `GEMINI_API_KEY` present? | Action |
|---|---|---|---|
| yes | any | any | Honor it. If it cannot work (the agent door without Google Cloud creds), print why and STOP. |
| no | no | no | No Gemini credentials at all. Explain both doors in one line, and continue — the policy pick in step 4 can still run. |
| no | no | yes | Silently use the API door (the only one that works). Continue. |
| no | yes | no | Silently use the API door still (default behavior; the user can flip later). Continue. |
| no | yes | yes | Ambiguous — **ask** which door. Two options only, no descriptions: (a) Gemini API, (b) Antigravity SDK worker. |

When switching to the agent door:

```bash
node '{{PLUGIN_ROOT}}/codex/verify-setup.mjs' --enable-agent --project-root '{{PROJECT_ROOT}}'
```

This records the selection and builds the Python environment the agent path needs.
`--disable-agent` reverses it. The selection lives in `.sdlc/local/mmo-select.json`; never hand-edit
it.

# 4. Policy pick

Read the current default:

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --print-only --project-root '{{PROJECT_ROOT}}'
```

If it prints a policy name, the project already has one — print `current policy: <name>` and skip
to step 5.

If the user named a policy when invoking this skill, honor it silently — no prompt, no browser:

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --policy=<name> --project-root '{{PROJECT_ROOT}}'
```

Otherwise use the same terminal picker as `$mmo-codex:policy change` shape 2. Skip its mid-run guard here
(no run has started yet in setup); everything else applies — enumerate with `--list-json`, offer
only the two selectable policies plus `Author a new policy (opens browser)`, then `--check-creds`
the pick before persisting it. See
[plugin/skills/policy/SKILL.md](../policy/SKILL.md) for the full picker.

# 5. Print the next-steps banner

The script from step 1 already prints this at the end of a successful run. If for any reason it did
not (the run stopped short earlier), print it explicitly:

```
✓ Setup complete for this project.

  Try one of these:

    $mmo-codex:greenfield  — generate a new app from a brief (empty folder)
    $mmo-codex:brownfield  — work on this existing repo (docs, bugfix, feature, refactor, …)
    $mmo-codex:policy      — show / change this project's model policy
    $mmo-codex:pass        — headless/scripted run (for CI or replays)

  Current policy: <policyName>   (change: $mmo-codex:policy change)
```

Type `$` to mention a skill, or run `/skills` for the picker.

# Idempotency

Every step is safe to re-run:
- The bridge build is a no-op if nothing changed.
- The credential probe reads the environment and the codex config; it never writes.
- The mechanical-door flip is a plain state-file write.
- The policy pick reads `.sdlc/project.json` first and skips the browser if a policy is already set.

Re-run this skill after a plugin update (which wipes `dist/`; `--fix` restores it), or whenever a
credential changes.

# Undoing setup

If the user asks to uninstall or to clean up what this harness left behind, run the cleanup
script rather than deleting anything by hand — setup's footprint includes a machine-level MCP
registration that is not obvious from the project directory:

```bash
node '{{PLUGIN_ROOT}}/scripts/uninstall-cleanup.mjs' --repo '{{PROJECT_ROOT}}' --dry-run
```

Show the user what it found, then re-run without `--dry-run` to act on it. It prompts before each
deletion and defaults to keeping `.sdlc/`, which may hold committed run history. Removing the
plugin itself is `codex plugin remove mmo-codex`, which the script prints at the end.
