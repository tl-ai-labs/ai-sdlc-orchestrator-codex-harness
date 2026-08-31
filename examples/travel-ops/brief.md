# Project Brief — Travel Booking Operations Service

## One-line summary
A back-office service and operator console for an online travel agency, covering fare search, booking, cancellation and refund handling, and payment reconciliation — with traveller PII encrypted at rest, role-scoped masking for support agents, and an immutable audit trail over every record that touches a passport number or a payment instrument.

## Business context
Target customer: an online travel agency selling flights and hotels, whose support desk today works across a booking engine, a separate refunds spreadsheet, and a payment gateway dashboard that nobody reconciles until month-end. Refund disputes are the expensive failure: an agent cannot see, in one place, what a traveller paid, what the fare rules entitle them to, and what was actually returned to the card.

We are building the backend service and the operator console that sits on it — one product a support supervisor can run a shift from. "Done" for a stakeholder who does not read code: an agent can find a booking, cancel it, see the refund the fare rules produce, approve it, and have the ledger agree with the gateway.

Traveller data is the constraint that shapes the build. Passport numbers, contact details, and payment instruments sit in the same records agents work in all day, so field-level masking and audit are not a later hardening pass — they are part of every module.

## Scope (vertical slice — five modules)

### 1. Fares & Availability
- Search endpoint over a seeded fare inventory: origin, destination, date, passenger count, cabin class.
- Fare rules attached per fare: `refundable`, `change_fee`, `cancellation_window_hours`, `no_show_penalty_pct`.
- Price quote assembly — base fare, taxes, agency markup — returned as itemised components, never a single opaque total.
- Availability decrement on hold; automatic release when a hold expires.

### 2. Bookings
- Create a booking as a **hold** (inventory reserved, not paid) with a server-set expiry.
- Confirm a hold into a booking on successful payment capture; reject confirmation of an expired hold.
- Traveller records with PII fields: `full_name`, `email`, `phone`, `date_of_birth`, `passport_number`, `nationality`.
- **PII protection:** `passport_number` and `date_of_birth` encrypted at rest (AES-256-GCM, per-record DEK wrapped by an env-supplied KEK).
- **Field-level masking by caller role:** `agent` sees masked `passport_number` (last two characters only); `supervisor` sees it unmasked; `auditor` sees masked and cannot read `email` or `phone`.
- Itinerary retrieval by booking reference for an unauthenticated traveller, returning a strictly reduced field set.

### 3. Cancellations & Refunds
- Cancel a confirmed booking; compute the refund from the fare rules in force at booking time, not the fare rules current today.
- Refund breakdown returned itemised: refundable base, retained taxes, cancellation penalty, agency markup treatment.
- Refunds above a configurable threshold enter `pending_approval` and require a `supervisor` to approve or reject, with a mandatory reason on rejection.
- No-show handling: a booking past its departure with no cancellation follows the `no_show_penalty_pct` path.
- Double-cancellation and cancel-after-refund attempts rejected idempotently, not by throwing.

### 4. Payments & Ledger
- Record payment capture and refund disbursement against a booking through a stubbed gateway adapter — no real gateway calls.
- Append-only ledger: every capture, refund, penalty, and markup posts a signed entry; entries are never updated or deleted.
- `GET /ledger/reconciliation?from=&to=` — per-day totals of captured, refunded and retained amounts, plus a variance line against recorded gateway settlements.
- Currency stored in minor units as integers; no floating-point arithmetic anywhere in money handling.

### 5. Auth, RBAC & Audit
- JWT auth with roles `agent`, `supervisor`, `auditor`, `admin`.
- Route-level and field-level authorisation; a role that may read a record may not automatically read every field of it.
- Immutable audit log capturing actor, action, booking reference, and which PII fields were revealed on every read that unmasks one.
- `GET /audit?actor=&from=&to=` available to `auditor` and `admin` only.

## Cross-cutting requirements
- Input validation via `class-validator` DTOs.
- Structured JSON logging via Pino, with `request_id` correlation across logs.
- Global error filter; never leak stack traces, SQL, or decrypted PII in responses.
- OpenAPI (Swagger) spec auto-generated.
- Helmet security headers; rate limiting on auth and booking-lookup routes.
- `.env`-driven config; no secrets in code, and no PII in log lines.
- README plus architecture decision records for: encryption choice, ledger immutability, and the fare-rules-at-booking-time decision.

## Tech stack (fixed)
- **NestJS** (TypeScript) + **Prisma ORM** + **SQLite** (POC; would be Postgres in production).
- **Jest** for unit and integration tests.
- **class-validator** for DTOs, **Pino** for logs, **Helmet** and `@nestjs/throttler` for security.
- Node 20+.

## Non-functional
- Tests must cover, per module, a happy path, at least one auth-denied path, and at least one PII-masking case.
- Refund computation must have its own test table covering refundable, non-refundable, inside-window, outside-window, and no-show cases.
- README must include the `npm install && npm test && npm run start:dev` flow and an example `curl` per resource.
- `npm test` must be green on a clean clone.

## Explicitly OUT of scope (this POC)
- Real gateway, airline, or GDS integration — the fare inventory is seeded and the gateway is a stub.
- SSO, OAuth, or SAML.
- Background workers, queues, and cron jobs; hold expiry is evaluated on read, not by a scheduler.
- Multi-currency conversion; a single currency throughout.
- Hotel and package products; flights only.
- Production deployment artifacts (Dockerfile, k8s manifests).
- Real KMS — an env-supplied KEK is acceptable for this POC.

## Acceptance criteria
1. `npm install` succeeds without warnings.
2. `npm test` is green.
3. `npm run start:dev` boots and serves the documented endpoints.
4. Swagger UI is reachable at `/docs`.
5. A round-trip `curl` example for each module returns plausible JSON.
6. `eslint .` returns zero errors.
7. Masking is demonstrable: the same `GET /bookings/:ref` returns a masked `passport_number` for an `agent` JWT and an unmasked one for a `supervisor` JWT.
8. A refund above the approval threshold is not disbursed until a `supervisor` approves it, and the rejection path records a reason.
9. The reconciliation endpoint's totals equal the sum of the ledger entries for the same window.
10. The audit log accumulates an entry for every unmasked PII read performed in criteria 7 and 8.
