# Example — `refactor` intent

Two files with duplicated email-validation logic. Task: extract to a shared util and update
call sites.

## What's here

```
package.json
src/
├── signup.js        — validates email inline with a regex
├── invite.js        — validates email inline with the SAME regex
└── validators.spec.js — tests for email validity (used by both files today)
```

## Try it

A brownfield run works on the git repository that holds the folder it starts in, so copy this
folder out of the harness and make it a repository of its own first. Then start codex there as
[docs/tutorial-first-run.md](../../../docs/tutorial-first-run.md) shows.

```bash
cp -R plugin/examples/brownfield-refactor ~/brownfield-refactor && cd ~/brownfield-refactor
printf 'node_modules/\n.sdlc/\n' > .gitignore
git init -q && git add -A && git commit -qm 'fixture'
npm install && npm test
# $mmo-codex:brownfield  →  refactor
```

## Expected outputs

- `src/validators/email.js` — new: single source of truth for `isValidEmail`
- `src/signup.js` — edited: imports from validators
- `src/invite.js` — edited: imports from validators
- Existing tests still pass (no behavior change)

See [intent_brief.md](intent_brief.md).
