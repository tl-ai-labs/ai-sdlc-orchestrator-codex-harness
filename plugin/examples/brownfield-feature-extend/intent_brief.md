# Intent Brief — feature-extend — Add ?role= filter to GET /users

## Context

`GET /users` currently returns every user. As the list has grown, callers want to filter by
role (`admin`, `member`, `guest`) without pulling everything client-side.

## Goal

Add an optional `?role=<value>` query parameter to `GET /users`. When absent, behavior is
unchanged (returns all). When present, returns only users with that role. An unknown role
returns an empty array (not 400).

## Files in scope

- `src/index.js` — read query param, pass to store
- `src/users.js` — extend `getUsers` to accept an optional role filter
- `src/users.spec.js` — add tests for the new parameter

## Files off-limits

- `package.json`, `.env*`, standard off-limits apply
- The user-store data model itself doesn't change — no new fields

## Acceptance criteria

- `GET /users` (no query) still returns all users — existing test passes
- `GET /users?role=admin` returns only admin users
- `GET /users?role=unknown` returns `[]`, status 200
- New tests cover: with-role, unknown-role, no-role
- No schema migration, no new dependencies

## Non-goals

- Not adding pagination — separate concern
- Not adding auth to the endpoint — out of scope
- Not switching to a real DB — the in-memory store is fine
