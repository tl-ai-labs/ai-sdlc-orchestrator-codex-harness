# Brief template

> **For:** writing your own project brief in the section layout the pipeline expects. **Also see:** [tutorial-first-run.md](tutorial-first-run.md) · [running.md](running.md).

`/mmo:pass` reads the brief file at the path it is given. The
requirements phase and the `architect` subagent expect the section headings
listed below; the wording under each is up to the author.

Copy this file, fill in the sections, save it anywhere in the repo (or
outside it), and point the command at the new path:

```
/mmo:pass --auth=vendor --study=<your-study-id> --run-id=pass1 path/to/your-brief.md
```

Output lands in `examples/<your-study-id>/passes/<run-id>/`. `--study` groups
telemetry, packets, and manifests for the new project separately from the
Workforce Ops case that ships with the repo.

Related: [running.md](running.md#bring-your-own-brief) for the full workflow,
[methodology.md](methodology.md) for what the pipeline records.

`/mmo:greenfield` runs from wherever you are — usually an empty folder — and
`docs/` is not copied on install, so the wizard carries the same section set
inline in `plugin/commands/greenfield.md`. **A heading changed here must be
changed there too**; `tools/test/command.test.mjs` compares the two and fails
if they drift.

---

## Section set

# Project Brief — <your project name>

## One-line summary
One sentence naming what you're building and who it is for. This becomes the
opening line of `requirements.md`.

## Business context
Who the target user is, what they use today, what "done" means to a stakeholder
who does not read code. Two or three short paragraphs.

## Scope
The features the pipeline should produce, grouped into modules. One numbered
module per bounded slice of behavior. Under each module, bullet the concrete
capabilities — endpoints, workflows, validations, edge cases. The orchestrator
decomposes bullet capabilities into individual TaskPackets, so specific
capabilities ("clock-in / clock-out per project tag") produce cleaner packets
than generic ones ("time tracking").

### 1. <Module name>
- <capability>
- <capability>

### 2. <Module name>
- <capability>

## Cross-cutting requirements
Concerns that apply to every module: input validation, structured logging,
error handling, API documentation, security headers, configuration, rate
limits. The senior-reviewer and security-reviewer subagents check for these.

## Tech stack (fixed)
Runtime, framework, ORM, database, test framework, key libraries, Node/Python
version. State them as fixed. The pipeline does not negotiate stack choices
mid-run; pick before running.

## Non-functional
Test coverage expectations, README expectations, developer-experience commands
that must work on a clean clone (`npm install && npm test && npm run start:dev`
or the equivalent for your stack).

## Explicitly OUT of scope
Numbered list of things the pipeline should NOT build in this pass.
Ambiguity here surfaces at Gate 1 as an "Open question for HITL".

## Acceptance criteria
Numbered, executable checks a reviewer can run to accept the pass. Concrete
commands and observable outputs work better than qualitative descriptions
("`npm test` is green" is testable; "the code should be well-tested" is not).
These become the checklist Gate 4 evaluates against.
