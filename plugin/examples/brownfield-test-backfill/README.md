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

```bash
cd plugin/examples/brownfield-test-backfill
npm install
npm test    # exits 0 with "no test files found" — no tests to run yet

# /mmo:brownfield  →  test
```

## Expected outputs

- `src/payments.spec.js` — new: unit tests for charge / refund / getBalance
- Coverage includes: happy paths, insufficient-funds error, unknown-account error, idempotency

See [intent_brief.md](intent_brief.md).
