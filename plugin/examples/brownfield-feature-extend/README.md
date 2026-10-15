# Example — `feature-extend` intent

Existing `GET /users` endpoint returns all users. Task: extend it to accept a `?role=<value>`
query param and filter results server-side.

## What's here

```
package.json
src/
├── index.js       — GET /users endpoint (returns all)
├── users.js       — in-memory user store
└── users.spec.js  — one passing test asserting the current shape
```

## Try it

A brownfield run works on the git repository that holds the folder it starts in, so copy this
folder out of the harness and make it a repository of its own first. Then start codex there as
[docs/tutorial-first-run.md](../../../docs/tutorial-first-run.md) shows.

```bash
cp -R plugin/examples/brownfield-feature-extend ~/brownfield-feature-extend && cd ~/brownfield-feature-extend
printf 'node_modules/\n.sdlc/\n' > .gitignore
git init -q && git add -A && git commit -qm 'fixture'
npm install && npm test
# In a codex session started in this folder:
$mmo-codex:brownfield
# Pick intent: feature-extend
```

## Expected outputs

- `src/index.js` — edited: read `req.query.role`, pass to `getUsers`
- `src/users.js` — edited: `getUsers(role?)` filters when provided
- `src/users.spec.js` — new tests for the filter param (with role, with unknown role, no role)
- Existing test still passes (no regression)

See [intent_brief.md](intent_brief.md).
