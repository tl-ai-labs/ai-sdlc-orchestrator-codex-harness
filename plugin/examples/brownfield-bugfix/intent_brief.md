# Intent Brief — bugfix — /login 500 on missing password

## Context

The `POST /login` endpoint (in `src/auth.js`) throws an unhandled exception when the request
body is missing the `password` field, which surfaces to the client as HTTP 500 "internal
error." The seeded test at `src/auth.spec.js` reproduces this behavior — see the failing
"returns 400 when password missing" case.

Observed:
```
$ curl -s -X POST http://localhost:3000/login -H 'content-type: application/json' -d '{"username":"foo"}'
{"error":"internal error"}   # HTTP 500
```

## Goal

Return HTTP 400 with a structured error naming the missing field:
```
{"error":"validation failed","field":"password"}
```

Same for a missing `username`. Same status, same shape.

## Files in scope

- `src/auth.js` — add input validation before the credential check
- `src/auth.spec.js` — the failing test should pass unchanged; a new test for `username`
  missing is welcome

## Files off-limits

- `src/index.js`, `package.json`, `node_modules/` — untouched unless the fix genuinely needs
  a route-level change (the fix belongs in the handler, not the middleware)
- Standard off-limits apply

## Acceptance criteria

- Existing failing test `returns 400 when password missing` passes
- New test `returns 400 when username missing` exists and passes
- HTTP status is 400, not 500
- Response body has both `error` and `field` fields
- No changes to the credential check itself — that's still `admin`/`hunter2`

## Non-goals

- Not switching validation library (no adding zod, joi, etc.)
- Not refactoring the whole auth module — smallest change that satisfies the acceptance
- Not adding rate limiting or other hardening — a separate concern
