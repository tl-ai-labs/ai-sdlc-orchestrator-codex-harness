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

```bash
cd plugin/examples/brownfield-refactor
npm install && npm test
# /mmo:brownfield  →  refactor
```

## Expected outputs

- `src/validators/email.js` — new: single source of truth for `isValidEmail`
- `src/signup.js` — edited: imports from validators
- `src/invite.js` — edited: imports from validators
- Existing tests still pass (no behavior change)

See [intent_brief.md](intent_brief.md).
