---
name: policy
description: "Show or change which model routing policy this project uses for SDLC runs. Bare shows the current one; 'change' opens a terminal picker."
---

Show or change the project's active model policy.

Three shapes, one script (`plugin/scripts/setup-policy.mjs`) does all three.

# Shape 1 — no argument: print the current policy

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --print-only --project-root '{{PROJECT_ROOT}}'
```

This reads `.sdlc/project.json.default_policy` and prints the policy name (or an empty line if none
is set). Also read `.sdlc/project.json.last_updated_at` and include it in the message:

- If a policy is set: `Current policy: <name>   (set <last_updated_at>, change with $mmo-codex:policy change)`.
- If no policy is set: `No policy set yet — run $mmo-codex:policy change to pick one.`

Do not open the browser here. Do not error. This shape is purely read.

# Shape 2 — `change`: terminal picker (browser only for authoring)

Picking one of the shipped presets is a one-line terminal question. Only "Author a new policy"
opens the browser.

## 2a — Guard mid-run

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --guard-active-run --project-root '{{PROJECT_ROOT}}'
```

Parse the JSON. If `active: true`, print:

```
A brownfield run is in progress (run_id: <run_id>, phase: <phase>). Finish it, or revert it with
$mmo-codex:revert <run-id>, before changing the policy.
```

and STOP. Do not proceed to 2b.

## 2b — List available policies

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --list-json --project-root '{{PROJECT_ROOT}}'
```

Parse the JSON — one entry per policy in `plugin/config/policies/`. Malformed YAMLs surface as
`{ name, error }` and should still appear in the list (the user can skip past them).

**Only offer the selectable ones.** Two policies are meant to be chosen here:

- **`gpt-plus-flash`** — the default and the one of record. Judgment work goes to the vendor API,
  mechanical work to Gemini Flash. Every figure on the cost report is vendor-metered.
- **`gpt-seat-plus-flash`** — the same routing, but judgment work goes through the local
  `codex exec` binary on a ChatGPT subscription seat. No API key needed for that tier; the
  trade-off is that the seat reports token counts and no money, so its judgment cost is **modeled**
  from those counts rather than metered, and the report labels it that way.

The `opus-*` files in the same directory are replay fixtures kept for comparison against the
earlier harness. They are not selectable here and must not be offered.

## 2c — Ask which policy

Ask the user which policy they want as this project's default. Offer the two selectable policies
above with their one-line summaries, plus a final `Author a new policy (opens browser)` option
described as `Opens the local policy console to create a custom YAML.`.

Do not suggest "type a name" as a hidden option — a typed name that does not match a file on disk
fails downstream. The choices above cover every real path.

## 2d — Handle the pick

- If the user picked a policy name → go to 2e.
- If the user picked `Author a new policy (opens browser)` → run:

  ```bash
  node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --project-root '{{PROJECT_ROOT}}'
  ```

  This starts the local policy console, opens the browser, and detects the save via `fs.watch`.
  When it returns, print the one-liner it emitted and STOP.

## 2e — Credential check

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --check-creds --policy=<chosen> --project-root '{{PROJECT_ROOT}}'
```

Parse the JSON.

- If `ok: true` → persist:

  ```bash
  node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --policy=<chosen> --project-root '{{PROJECT_ROOT}}'
  ```

  Print `Policy set: <chosen>` and STOP.

- If `ok: false` → print each entry in `missing` with its `fix` string:

  ```
  Missing credentials for policy "<chosen>":
    • <kind>: <name or "">
      fix: <fix>
  ```

  Then ask whether to fix and retry, or pick a different policy. Retry re-runs `--check-creds` with
  the same policy; picking different loops back to 2b.

  When the missing credential is the judgment tier's API key and the user is on a ChatGPT
  subscription, say so plainly: `gpt-seat-plus-flash` reaches the same model through the seat and
  needs no key, at the cost of a modeled rather than metered judgment figure.

# Shape 3 — `--policy=<name>`: silent set

```bash
node '{{PLUGIN_ROOT}}/scripts/setup-policy.mjs' --policy=<name> --project-root '{{PROJECT_ROOT}}'
```

No browser. The script validates `<name>` against files in `plugin/config/policies/`, writes it to
`.sdlc/project.json.default_policy`, and exits. It fails if `<name>` does not exist on disk — offer
`$mmo-codex:policy change` to author it, or name the two selectable presets.

# Notes

- The change is per-project. Once written to `.sdlc/project.json`, every subsequent
  `$mmo-codex:greenfield` or `$mmo-codex:brownfield` in this folder uses the new policy. Prior runs'
  `provenance.json` records the policy that was in effect at run time — those do not get rewritten.
- To change the policy for a single ticket without touching the project's default:
  - **Interactive** (`$mmo-codex:brownfield`): type a different policy name at Gate 0's Policy bullet
    when reviewing the discovery summary. Accepted for that run only.
  - **Headless** (`$mmo-codex:pass`): pass `--policy=<name>`. Same one-run scope.

  Neither path writes to `.sdlc/project.json`.
- The browser opens only when the user picks `Author a new policy` under `change` (or the same
  option during first-time `$mmo-codex:setup`). Picking a shipped preset stays in the terminal.
