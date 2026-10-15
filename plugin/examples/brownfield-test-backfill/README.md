# Example — `test` intent

A payments service (`src/payments.js`) with no test coverage. Task: backfill unit tests to
reach reasonable coverage on the happy paths and the error cases.

## What's here

```
package.json
src/
├── payments.js   — charge / refund / getBalance functions, no tests
└── db.js         — in-memory store used by payments
```

## Try it

A brownfield run works on the git repository that holds the folder it starts in, so copy this
folder out of the harness and make it a repository of its own first. Then start codex there as
[docs/tutorial-first-run.md](../../../docs/tutorial-first-run.md) shows.

```bash
cp -R plugin/examples/brownfield-test-backfill ~/brownfield-test-backfill && cd ~/brownfield-test-backfill
printf 'node_modules/\n.sdlc/\n' > .gitignore
git init -q && git add -A && git commit -qm 'fixture'
npm install
npm test    # exits 0 with "no test files found" — no tests to run yet

# $mmo-codex:brownfield  →  test
```

## Expected outputs

- `src/payments.spec.js` — new: unit tests for charge / refund / getBalance
- Coverage includes: happy paths, insufficient-funds error, unknown-account error, idempotency

See [intent_brief.md](intent_brief.md).
