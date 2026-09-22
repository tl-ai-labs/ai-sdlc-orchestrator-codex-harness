---
name: docs
description: "Write or update documentation in an existing repository — API docs, README, ADRs, docstrings. Example, document the auth module."
---

Docs job on an existing repository — a brownfield run with the job type already chosen. Free text typed after the skill
name is optional (what to document, in one line); supplying it removes one interview round-trip, but Gate 0 always
fires and always re-confirms scope before anything is written.

Follow the operating manual in
[plugin/skills/brownfield-guide/SKILL.md](../brownfield-guide/SKILL.md),
with this handover:

- `intent: docs` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the user's text after the skill name, verbatim, if non-empty.
  Empty means run the normal step-4b interview.
