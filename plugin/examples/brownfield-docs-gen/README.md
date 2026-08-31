# Example — `docs` intent

A tiny 3-file Express app with no documentation. Demonstrates the `docs` intent producing a
README and JSDoc for the auth module.

## What's here

```
package.json          — Express + minimal deps
src/
├── index.js         — app bootstrap + route wiring
├── auth.js          — login / logout / verify handlers
└── errors.js        — the AppError class
```

Nothing has a docstring. There's no README explaining what the app does or how to use `auth.js`.
The `docs` intent turns that into: a project README and JSDoc-annotated `auth.js`.

## Try it

```bash
cd plugin/examples/brownfield-docs-gen
# In Claude Code, in this directory:
/mmo:brownfield
# Pick intent: docs
# Confirm scope at Gate 0: src/auth.js + README.md
# The pipeline writes docs/auth.md, adds JSDoc to src/auth.js, updates README.md
```

## Intent brief

See [intent_brief.md](intent_brief.md) for the pre-written brief. In an interactive run, the
plugin would interview you; this file demonstrates the shape it produces.

## Expected outputs

- `README.md` — new, describes the app and links to the auth module doc
- `docs/auth.md` — new, describes the auth module's API
- `src/auth.js` — edited, JSDoc annotations added to each exported function
- `.sdlc/runs/<run-id>/` — provenance, telemetry, final report

Nothing else in the repo should be touched.
