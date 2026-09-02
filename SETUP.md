# Setup

One-time setup per machine, plus a per-project policy choice. Budget ten minutes.

Everything here is checkable: `node plugin/codex/verify-setup.mjs` reports exactly what is
missing and how to fix it, and `--fix` repairs what can be repaired without asking.

---

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| Node 20 or newer | The driver and the bundled MCP server are ESM on modern Node | `node --version` |
| codex CLI 0.151.0 or newer | Every runtime capability this harness depends on was verified against 0.151.0 (`docs/verification/p1-codex-runtime.md`) | `codex --version` |
| A logged-in codex | The driver runs the conductor through `codex exec` | `codex login status` |
| git | Brownfield runs refuse outside a git repo | `git --version` |

Install or upgrade codex with `npm install -g @openai/codex`.

If `codex login status` says you are not logged in, run `codex login` (ChatGPT seat) or export
`OPENAI_API_KEY`, which the CLI also accepts. The harness never reads `~/.codex/auth.json`
itself and never prints its contents.

## 2. Choose a route

There are two ways to use this harness, and they differ in more than convenience.

**Install it as a plugin** (most people). The skills become available in *every* repository you
work in, and you never touch this repo again:

```bash
codex plugin marketplace add https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness
codex plugin add mmo-codex@tilicho-ai-labs
```

A local path works too, if you have already cloned it:

```bash
codex plugin marketplace add /path/to/ai-sdlc-orchestrator-codex-harness
codex plugin add mmo-codex@tilicho-ai-labs
```

Confirm with `codex plugin list --json`; then `$mmo-codex:greenfield` and the rest are available
from any directory. Installed this way you can **skip step 6** — codex loads a plugin's skills
directly, so nothing needs linking.

You still need the credentials in step 4 and a policy in step 5, and the bundled server has to be
built once: run `node plugin/codex/verify-setup.mjs --fix` from the clone the marketplace points
at (the install references that directory rather than copying the built server).

**Work inside a clone** (contributors, or anyone changing the harness itself). Continue below.

## 3. Get the repository and build

```bash
git clone https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness.git
cd ai-sdlc-orchestrator-codex-harness
node tools/setup.mjs
```

The wizard checks Node, the codex CLI and its version pin, and your credentials; builds the
bundled MCP server; optionally builds the Python agent worker; and registers the bridge with
`codex mcp add`. It is safe to re-run, and safe to run non-interactively.

To do the same thing without the wizard's questions:

```bash
node plugin/codex/verify-setup.mjs --fix
```

## 4. Credentials

Two tiers need credentials, for different reasons.

**The judgment tier (GPT) — depends on your policy.** There are two ways to pay for it, and
which one you pick decides whether you need a key at all.

| Policy (see §5) | Judgment tier reaches GPT via | `OPENAI_API_KEY` |
|---|---|---|
| `gpt-plus-flash` (default) | the OpenAI API, metered per call | **required** — runs halt at preflight without it |
| `gpt-seat-plus-flash` | a local `codex exec` on your ChatGPT seat | not used at all |

On the metered path, export the key:

```bash
export OPENAI_API_KEY=sk-...
```

On a ChatGPT subscription with no API key, pick the seat policy instead — same model, same
reasoning-effort pin, same routing rules:

```bash
node plugin/scripts/setup-policy.mjs --policy=gpt-seat-plus-flash
```

The trade-off is in the cost figures, not the output: codex reports token counts but no money,
so judgment-tier cost on the seat is **modeled** from tokens rather than metered, and reports
keep it out of the vendor total. Use `gpt-plus-flash` for anything whose numbers get published.
Note also that a full run then draws judgment work from the same monthly seat allowance as the
conductor.

`verify-setup.mjs` reads the policy this project would actually run before deciding whether a
missing key is a blocker — so if it reports one, the message names the policy responsible.

**The mechanical tier (Gemini Flash) — required by the default policy.** Either a
`GEMINI_API_KEY`, or Vertex credentials (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service
account file, or application-default credentials via `gcloud auth application-default login`,
plus `GOOGLE_CLOUD_PROJECT`).

Put these in your shell profile, not in a file in the repo. `verify-setup.mjs` reports which of
them it can actually see, and distinguishes a missing credential from a broken one — a service
account file with no `private_key` is reported as broken rather than absent, because the two
need different fixes.

The driver leg's own authentication is separate and is whatever `codex login` set up. No
Anthropic credential is used anywhere in this harness.

## 5. Choose this project's policy

A policy decides which model each phase is routed to.

```bash
node plugin/scripts/setup-policy.mjs --list-json      # what is available
node plugin/scripts/setup-policy.mjs --policy=gpt-plus-flash
```

| Policy | Judgment tier | Mechanical tier | Cost reporting |
|---|---|---|---|
| `gpt-plus-flash` | GPT via the OpenAI API | Gemini Flash | Vendor-metered throughout — the policy of record |
| `gpt-seat-plus-flash` | GPT via your local `codex exec` (ChatGPT seat) | Gemini Flash | Judgment cost is **modeled**, not metered |
| `flash-agsdk-only` | — | Gemini Flash via the agent worker | Mechanical only |

`gpt-plus-flash` is the default and the one every published cost figure comes from.

`gpt-seat-plus-flash` bills judgment work against your ChatGPT seat instead of an API key. Codex
reports token counts but no money, so cost for that tier is derived from tokens and labelled
`modeled`. Reports keep modeled figures separate from metered ones and never sum the two.

The `opus-*` files under `plugin/config/policies/` are replay fixtures, not selectable policies.

Store the choice as the project default, or pass `--policy=<name>` per run to override it
without changing the default.

## 6. Make the skills invokable (clone route only)

Codex scans `<repo>/.agents/skills` for skills. It does **not** scan `plugin/skills/`, where
this harness ships them — that path is for people who install the plugin. Working in a clone,
the `$mmo-codex:*` skills are invisible until they are linked:

```bash
node plugin/codex/verify-setup.mjs --fix
```

This symlinks each shipped skill into `.agents/skills/`, which is generated and gitignored. (The
sibling `.agents/plugins/marketplace.json` is a committed source file — it is what makes
`codex plugin marketplace add` work — so only the `skills/` subdirectory is ignored.)

This step only affects the interactive surface. Headless `run.mjs` runs render their own copies
of the skills they need and do not consult `.agents/skills`, which is why the check reports a
warning rather than a failure.

## 7. Verify

```bash
node plugin/codex/verify-setup.mjs
```

Useful flags:

| Flag | Effect |
|---|---|
| `--fix` | Repair what can be repaired: install and build the server, link the skills |
| `--enable-agent` / `--disable-agent` | Route the mechanical tier to the Python agent worker, or back to the model path |
| `--brownfield-check` | Additionally check the prerequisites a brownfield run needs |
| `--project-root=<path>` | Check a project other than the current directory |
| `--headless` | No prompts; for CI |

Blocking problems make the harness unusable and exit non-zero. Warnings do not.

## 8. First run

Interactively, inside codex — type `$` to mention a skill, or `/skills` to browse:

```
$mmo-codex:greenfield     generate a new app from a brief, in an empty folder
$mmo-codex:brownfield     work on an existing repo
$mmo-codex:policy         show or change this project's policy
```

Headless, from a shell:

```bash
node plugin/codex/run.mjs \
  --brief=docs/brief-template.md \
  --project-root=. \
  --output-dir=.sdlc \
  --policy=gpt-plus-flash \
  --dry-run
```

`--dry-run` renders the conductor prompt and the `codex exec` argv and exits without spending
anything. Drop it to run for real. Add `--gates=auto-approve` for an unattended run.

Afterwards:

```bash
node tools/report.mjs .sdlc --markdown
```

## Troubleshooting

**`codex ... is not new enough`** — upgrade with `npm install -g @openai/codex@latest`. The pin
exists because the capability findings this harness relies on were measured against 0.151.0.

**A skill is not offered when you type `$`** — run `node plugin/codex/verify-setup.mjs --fix`
(step 5), then restart codex, which caches the skill list at startup. Note that the eight skills
which start a full billable run are deliberately excluded from implicit matching and so do not
appear in suggestions; invoke them by name.

**A run stops at preflight** — preflight proves the policy's credentials before any billable
phase. Read the reported reason; it names the tier and the missing credential. Do not start a
run on a policy whose mechanical tier cannot be reached.

**Brownfield refuses to start** — it requires a git repository. Discovery stops with git-init
guidance outside one. An uncommitted working tree does not block a run: each file the run is
about to touch is backed up first if it is untracked or has uncommitted changes, so
`$mmo-codex:revert` can restore it from the backup rather than from git.

## Uninstalling

Setup and runs leave three things behind. Clear them before removing the plugin, or the links
and the server registration will point at files that no longer exist:

```bash
node plugin/scripts/uninstall-cleanup.mjs --dry-run   # see what would go
node plugin/scripts/uninstall-cleanup.mjs             # do it, with prompts
```

It removes `.sdlc/` (per-run records and telemetry), `.agents/` (the skill links from step 5),
and the `model-dispatch` MCP registration in `~/.codex/config.toml`. It asks before each, and
defaults to *no* on `.sdlc/` since that one may hold committed history. `--yes` skips the
prompts, `--keep-mcp` leaves the registration alone, and `--repo=<path>` targets another
checkout.

Then remove the plugin itself with `codex plugin remove mmo-codex`.

## Reference

- `docs/brief-template.md` — the section layout a brief needs
- `docs/verification/p1-codex-runtime.md` — what was measured about codex's runtime, and how
- `AGENTS.md` — repository conventions
