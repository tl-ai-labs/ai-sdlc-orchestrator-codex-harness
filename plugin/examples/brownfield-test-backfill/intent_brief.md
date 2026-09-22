# Intent Brief — test — Backfill payments-service tests

## Context

`src/payments.js` has three exported functions (`charge`, `refund`, `getBalance`) and no test
file. Adding a new caller has been risky because there's no safety net. Backfill unit tests
before we touch it again.

## Goal

Achieve reasonable line + branch coverage on `src/payments.js`. "Reasonable" = happy path per
function, plus every documented error case (insufficient funds, unknown account, invalid
amount). Idempotency check on refund (calling twice with same ref = one refund).

## Files in scope

- `src/payments.spec.js` (create)
- `src/payments.js` — treat as read-only reference; do NOT modify to make tests easier
- `src/db.js` — mock or stub as needed inside the test file

## Files off-limits

- `src/payments.js` (read-only — this is a test-backfill, not a refactor)
- `src/db.js` (read-only)
- Standard set

## Acceptance criteria

- `npm test` runs > 0 test files
- All three exported functions have at least one happy-path test
- Every thrown Error has a matching test asserting the thrown message
- Refund idempotency verified (two calls, one net refund)
- Test file uses `node:test` + `node:assert/strict` (already in package.json, no new deps)

## Non-goals

- Not adding new features to payments.js
- Not switching to a "real" DB or integration tests — unit only, in-process
- Not adding a coverage-report tool — line-count is enough for this exercise
