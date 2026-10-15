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

A brownfield run works on the git repository that holds the folder it starts in, so copy this
folder out of the harness and make it a repository of its own first. Then start codex there as
[docs/tutorial-first-run.md](../../../docs/tutorial-first-run.md) shows.

```bash
cp -R plugin/examples/brownfield-docs-gen ~/brownfield-docs-gen && cd ~/brownfield-docs-gen
printf 'node_modules/\n.sdlc/\n' > .gitignore
git init -q && git add -A && git commit -qm 'fixture'
# In a codex session started in this folder:
$mmo-codex:brownfield
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
