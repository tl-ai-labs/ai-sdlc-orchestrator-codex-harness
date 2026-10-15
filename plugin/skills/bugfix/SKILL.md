---
name: bugfix
description: "Fix a defect in an existing repository — reproduce, diagnose, fix, add a regression test. Example, the /login endpoint returns 500 on a missing password."
---

Bug-fix job on an existing repository — a brownfield run with the job type already chosen. Free text typed after the skill
name is optional (the bug, in one line); supplying it removes one interview round-trip, but Gate 0 always
fires and always re-confirms scope before anything is written.

# 1. Start the run

`<plugin-root>` below is this plugin's own folder. Codex gave you this skill's file path with the
skill; it ends in `/skills/bugfix/SKILL.md`, and the plugin root is that path with the ending
removed (two folders above this file). Keep the single quotes: the path can contain spaces. If no
path came with the skill, `ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/mmo-codex/*/` lists the
installed copies; use the newest version.

```bash
node '<plugin-root>/codex/start-run.mjs' --mode=brownfield --intent=bugfix
```

It creates this run's folder under `.sdlc/runs/`, renders the operating manual and the pipeline
playbook into it with the run's real paths, records the run in `run.json`, and prints where they
are. If it exits non-zero, show the user its message and stop. Show the user any `warning:` line
it prints before you go on.

The `gates:` line it prints is your gate instruction for this run. Follow it at every gate, Gate 0
included, and record each decision as a new line in `gates.jsonl` in the run folder, in the shape
that line gives. The run's end record counts the run as completed only after an accepted Gate 4
line there.

# 2. Follow the operating manual

Read the `brownfield_guide` file the start script printed (`<run folder>/skills/brownfield-guide.md`)
and follow it, with this handover:

- `intent: bugfix` — already chosen. Skip step 4a; Gate 0 re-confirms it.
- `seed_description:` — the user's text after the skill name, verbatim, if non-empty.
  Empty means run the normal step-4b interview.

Read only the rendered copies in `<run folder>/skills/`. The plugin's own
`skills/brownfield-guide/SKILL.md` and `skills/pipeline/SKILL.md` carry unfilled placeholders and
are not runnable as written.
