# Stack adapter — generic

**Fallback adapter.** Used when Tier 1 discovery detects a stack we don't ship a first-class
adapter for (React/Next.js, Go, Rails, Java, Rust, Vue, Svelte, custom in-house, unknown). In
brownfield mode, this generic fragment is paired with the **adaptive stack profile** (Tier 2b,
written to `.sdlc/baseline/stack-profile.md`) — the profile wins on conflict because it reflects
the actual repo. This file is the baseline; the profile is the ground truth.

Also used for greenfield when no other adapter matches, though greenfield rarely reaches here
because the pipeline's default is Nest.

## When this adapter is loaded

The packet planner picks this adapter when:
- The detected stack manifest maps to a stack with no dedicated adapter, OR
- The stack is unknown, OR
- Discovery's adaptive-profile trigger fired but no matching pre-authored fragment exists

## Placement rules (§15)

Because the generic adapter can be pointed at any repo, placement is **entirely** inferred from
the adaptive stack profile + existing repo layout. The packet planner:

1. Reads `.sdlc/baseline/stack-profile.md` for the learned file-naming convention, folder
   structure, and framework-owned wiring pattern.
2. Reads `.sdlc/baseline/current.json` for `topology.top_level_dirs` and existing entry points.
3. Proposes new-file locations that MIRROR the sampled patterns. Never invent a new layout
   convention.
4. Reads `.sdlc/local/write-contract.json`'s allowlist to confirm the proposed path is in scope
   before emitting the packet.

If no stack profile exists (adaptive-profile step was skipped), fall back to these defaults:
- **Source files** — under `src/` if it exists; otherwise sibling to the entry point file
- **Test files** — mirror the existing test-file location convention if any; else `tests/` at
  repo root
- **Doc files** — under `docs/` if it exists; else at repo root with a `.md` extension
- **Config files** — repo root (env, editorconfig, lint rules)

## Task-type primitives (stack-agnostic)

Every brownfield packet uses these base types. Optional `subtype` on the packet carries
framework-specific hints when they matter.

| task_type | Purpose | Uses `subtype` |
|---|---|---|
| `new_file_add` | Create a file that didn't exist | Yes — subtype = shape hint (e.g. "controller", "service", "test") |
| `existing_file_edit` | Modify a file that existed at discovery time | Rarely — the file's own shape drives the edit |
| `patch_apply` | Apply a specific diff to a file | No |
| `doc_addition` | New doc under docs/ or module README | Yes — subtype = doc kind ("readme", "adr", "runbook", "api") |
| `doc_update` | Update an existing doc | No |
| `test_add` | New test file for new source | Yes — subtype = "unit" / "integration" / "e2e" |
| `test_backfill` | Add tests for existing untested code | Yes — subtype same as `test_add` |
| `bug_reproduce` | Write a failing test that captures a bug | No |
| `bug_diagnose` | Analyze diagnose the root cause; emit a note, not code | No |
| `bug_fix_apply` | Apply the fix identified by `bug_diagnose` | No |
| `refactor_extract` | Extract shared logic into a new utility | No |
| `dependency_add` | Add a dep + adjacent-code adjustments | Yes — subtype = "patch" / "minor" / "major" |

## Framework-owned wiring — the generic case

The generic adapter DOES NOT emit `module_wiring`, `url_registration`, or `router_wiring` packets
by default — those are framework-specific. If the stack profile identified a framework-owned
wiring pattern, the packet planner emits paired packets: `new_file_add` + `existing_file_edit`
(the wiring), executed atomically (fail one → rollback both within the packet).

## Codegen hints

When dispatching a codegen packet with this adapter, include in the packet's `instruction`:

- The relevant stack-profile snippet showing the file-kind's shape in this repo
- The proposed target path (already validated against the allowlist)
- The existing file's content (for `existing_file_edit` / `patch_apply`)
- Any framework-specific constraints from the profile

**Do not include** a general framework tutorial — the profile snippets are the authoritative
"how this repo does X" reference.

## Test-runner idioms

Discovery already detected the test command. The adapter itself doesn't need to know the runner
— the packet planner passes `baseline.test_command_proposed` (confirmed at Gate 0) to
`test_add` and `test_backfill` packets. Whatever the runner is, the packet's job is to produce a
test file that runs successfully under it.

## What NOT to do in this adapter

- Don't emit `prisma_schema`, `nest_controller`, `django_view`, or any subtype that references a
  specific framework — those live in the framework-specific adapters.
- Don't assume ESM vs CJS, TypeScript vs JavaScript, or any language feature beyond what the
  profile confirmed. The profile is authoritative.
- Don't propose paths outside the confirmed allowlist. The write-contract hook will refuse them
  anyway, but a well-planned packet never asks.
