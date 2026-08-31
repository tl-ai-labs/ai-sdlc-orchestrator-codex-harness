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

```bash
cd plugin/examples/brownfield-feature-extend
npm install && npm test
# In Claude Code:
/mmo:brownfield
# Pick intent: feature-extend
```

## Expected outputs

- `src/index.js` — edited: read `req.query.role`, pass to `getUsers`
- `src/users.js` — edited: `getUsers(role?)` filters when provided
- `src/users.spec.js` — new tests for the filter param (with role, with unknown role, no role)
- Existing test still passes (no regression)

See [intent_brief.md](intent_brief.md).
