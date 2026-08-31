# Project Brief — Ping Service

## One-line summary
An HTTP service with one endpoint that answers `GET /ping`.

## Business context
This brief exists to exercise the pipeline, not to solve a business problem.
Pick it to watch a full run — every phase, both model tiers, all four gates — in
the least wall-clock time and the least money. The other shipped briefs describe
five modules and produce dozens of files; this one describes one endpoint and
produces a handful.

## Scope

### 1. Ping
- `GET /ping` returns HTTP 200 and `{ "status": "ok", "time": "<ISO-8601 UTC>" }`.
- Any other path returns HTTP 404 and `{ "error": "not found" }`.

## Cross-cutting requirements
- Errors return JSON, never an HTML page or a stack trace.

Nothing else. No auth, no logging, no validation, no rate limiting, no API
documentation — every cross-cutting concern is work repeated in every phase, and
this brief is here to be fast.

## Tech stack (fixed)
- **Express** (JavaScript, CommonJS) on **Node 20+**.
- **Jest** with **supertest** for tests.
- No database, no ORM, no build step.

## Non-functional
- One test file: the 200 case and the 404 case.
- README documents `npm install`, `npm test`, `npm start`, and one `curl`.
- `npm test` is green on a clean clone.

## Explicitly OUT of scope
1. Any database or persistence.
2. Authentication, users, and roles.
3. Any endpoint other than `GET /ping`.
4. Logging, rate limiting, security headers, and Swagger.
5. Docker, CI configuration, and any frontend.

## Acceptance criteria
1. `npm install` succeeds.
2. `npm test` is green.
3. `npm start` boots and listens on port 3000.
4. `curl localhost:3000/ping` returns 200 with `status` set to `ok` and a
   parseable ISO-8601 `time`.
5. `curl localhost:3000/nope` returns 404 with a JSON body, not HTML.
