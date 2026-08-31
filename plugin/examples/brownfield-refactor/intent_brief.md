# Intent Brief — refactor — Extract duplicated email validation

## Context

`src/signup.js` and `src/invite.js` both contain the same email-validation regex + helper
inline. Adding a third caller would triple the duplication. Extract it once to a shared util.

## Goal

- Create `src/validators/email.js` exporting `isValidEmail(email: string): boolean`
- Update `src/signup.js` and `src/invite.js` to import from the util instead
- Behavior must not change — the same regex, the same true/false answers

## Files in scope

- `src/validators/email.js` (create)
- `src/signup.js` (edit — imports change, delete inline definition)
- `src/invite.js` (edit — same)

## Files off-limits

- Standard set. Everything else in the repo untouched.

## Acceptance criteria

- New util exists and exports `isValidEmail`
- Both callers use the util (no inline regex remaining in either)
- Existing `validators.spec.js` tests still pass unchanged — this is the invariant proof
- No new dependencies

## Non-goals

- Not switching to a proper email-validation library (validator.js etc.) — separate concern
- Not adding new validation rules (allow-list domains, MX checks) — separate concerns
- Not refactoring anything else in signup.js / invite.js
