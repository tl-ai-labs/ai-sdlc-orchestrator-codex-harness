# Project Brief — Workforce Operations Service

## One-line summary
A fully functional website that combines enterprise-grade leave and workforce management capabilities inspired by platforms like Workday and SAP SuccessFactors with advanced time, attendance, and productivity tracking similar to UKG and Time Doctor for mid-sized enterprises — featuring first-class PII protection, granular RBAC, comprehensive audit logging, and enterprise security/compliance standards.

## Business context
Target customer: 200–2,000 employee organizations that today juggle a leave tracker (Keka, Darwinbox), a time tracker (Clockify, Toggl), and a homemade payroll spreadsheet. We are building both the unified backend service and the React web UI that sits on top — a single end-to-end product that an HR / operations team can use day-to-day without bolting on a separate front-end stack.

## Scope (vertical slice — five modules)

### 1. Employees
- CRUD over employee records with PII fields: `full_name`, `email`, `phone`, `address`, `government_id` (e.g., PAN / SSN), `bank_account`, `salary_base`.
- **PII protection:** `government_id`, `bank_account`, `salary_base` encrypted at rest (AES-256-GCM via a per-record DEK wrapped by an env-supplied KEK).
- **Field-level masking** in responses based on caller role: `employee` sees only their own un-masked record; `manager` sees their reports masked except `phone` and `address`; `admin` sees everything; `auditor` sees masked.
- Soft delete (`deleted_at`).

### 2. Time Entries
- Clock-in / clock-out per project tag.
- Day aggregation, weekly summary.
- Edits require manager approval if older than 24h.
- Overlap detection (cannot clock-in on two projects simultaneously).

### 3. Leave Requests
- Submit → manager-approve / reject workflow with optional comments.
- Leave types: `annual`, `sick`, `unpaid`, `comp_off` with per-type balance tracking.
- Overlap validation with existing approved leaves.
- Automatic balance debit on approval; credit-back on rejection-after-approval.

### 4. Reports
- `GET /reports/utilization?from=&to=&team=` — % billable hours per employee.
- `GET /reports/leave-balance?team=` — current balances by leave_type per employee.
- `GET /reports/headcount?as_of=&team=` — point-in-time headcount.
- Cached with 60s TTL; cache busted on any write to underlying data.

### 5. Auth, RBAC, & Audit
- Local username/password + JWT (no SSO in POC).
- Roles: `admin`, `manager`, `employee`, `auditor`. Roles enforced via NestJS guards on every controller route.
- Managers have an implicit `reports_to` relationship granting access to their direct/indirect reports' data only.
- **Audit log**: every read or write of PII or salary data emits `{actor, action, target_employee, fields, ts, request_id}` to an append-only audit table. Auditor role can query audit_log; no role can mutate it.

## Cross-cutting requirements
- Input validation via `class-validator` DTOs.
- Structured JSON logging via Pino (request_id correlation across logs).
- Global error filter; never leak stack traces in responses.
- OpenAPI (Swagger) spec auto-generated.
- Helmet security headers; rate limiting on auth routes.
- `.env`-driven config (no secrets in code).
- README + architecture decision records (ADRs) for: encryption choice, audit log immutability, role model.

## Tech stack (fixed)
- **NestJS** (TypeScript) + **Prisma ORM** + **SQLite** (POC; would be Postgres in prod).
- **Jest** for unit + integration tests.
- **class-validator** for DTOs, **Pino** for logs, **Helmet** + `@nestjs/throttler` for security.
- Node 20+.

## Non-functional
- Tests must cover happy path + at least one auth-denied path + at least one PII-masking case per module.
- README must include `npm install && npm test && npm run start:dev` flow and an example `curl` per resource.
- `npm test` must be green on a clean clone.

## Explicitly OUT of scope (this POC)
- SSO / OAuth / SAML.
- Background workers, queues, cron jobs.
- File uploads (employee photos, documents).
- Multi-tenant isolation.
- Production deployment artifacts (Dockerfile, k8s manifests).
- Real KMS — env-supplied KEK is acceptable for POC.
- Migrations beyond initial Prisma `db push`.

## Acceptance criteria for both passes
1. `npm install` succeeds without warnings.
2. `npm test` is green.
3. `npm run start:dev` boots and serves the documented endpoints.
4. Swagger UI accessible at `/docs`.
5. A round-trip curl example for each module returns plausible JSON.
6. `eslint .` returns zero errors.
7. PII masking demonstrable: same `GET /employees/:id` returns different field sets for `admin` vs `manager-of-different-team` JWT.
8. Audit log accumulates entries that match the PII access pattern.
