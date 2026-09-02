---
name: brownfield
description: "Run the SDLC pipeline against an existing repository — docs, bugfix, feature, refactor, test, or dependency work — under a write contract that keeps off-limits files untouched."
---

Brownfield entry point. This skill takes no arguments. Everything it needs it asks for.

The seven job types are `docs`, `bugfix`, `feature-extend`, `feature-new`, `refactor`, `test`, and
`deps`. Each also has its own skill (`$mmo-codex:bugfix`, `$mmo-codex:docs`, and so on) that jumps straight to
the same manual with the job type pre-chosen; this one asks first.

Follow the operating manual in
[plugin/skills/brownfield-guide/SKILL.md](../brownfield-guide/SKILL.md),
with this handover:

- `intent:` — not set. Ask which job type at step 4a.
- `seed_description:` — not set. Run the full step 4b interview.
