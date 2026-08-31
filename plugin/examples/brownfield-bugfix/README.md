# Example — `bugfix` intent

An Express `/login` endpoint that returns 500 (an unhandled exception) when the request body is
missing the `password` field. Should return 400 with a validation error naming the missing
field.

## What's here

```
package.json
src/
├── index.js            — Express app + /login route
├── auth.js             — login handler that throws on missing password
└── auth.spec.js        — the SEEDED FAILING TEST that captures the bug
```

Run the test suite and you'll see one failing test — the one demonstrating what should happen
but doesn't.

## Try it

```bash
cd plugin/examples/brownfield-bugfix
npm install
npm test    # 1 failing test: "returns 400 when password missing"

# In Claude Code:
/mmo:brownfield
# Pick intent: bugfix
# The pipeline runs reproduce (already reproduced!) → diagnose → fix → regression test
```

## Intent brief

See [intent_brief.md](intent_brief.md).

## Expected outputs

- `src/auth.js` — edited: input validation added; returns 400 with a `{ error, field }` shape
- `src/auth.spec.js` — the seeded failing test now passes (no changes needed)
- Possibly `src/index.js` — edited if error handling was surfaced through the router

Nothing outside `src/auth.js` (and possibly `src/index.js`) should be touched.
