# In scope

- Validate presence of `username` and `password` for `POST /login` before credential checking.
- Map validation failures in the `/login` route to HTTP 400 with `{"error":"validation failed","field":"<field>"}`.
- Preserve the existing `admin` / `hunter2` credential check and its valid- and invalid-credential behavior.
- Update `src/auth.js`, `src/index.js`, and `src/auth.spec.js` only as specified in the brief.

# Out of scope

- Changes to `package.json`, `node_modules/`, credential rules, validation libraries, rate limiting, or broader auth refactoring.
- Defining behavior for malformed JSON, empty strings, `null`, non-string values, or requests missing both fields unless existing behavior already defines it.

# Functional requirements per module (FR IDs)

- **FR-AUTH-001 (`src/auth.js`):** Before the credential check, detect when `password` is absent and raise/return a validation result identifying `password`.
- **FR-AUTH-002 (`src/auth.js`):** Before the credential check, detect when `username` is absent and raise/return a validation result identifying `username`.
- **FR-ROUTE-001 (`src/index.js`):** When the auth module indicates a missing credential field, respond with HTTP 400 and exactly the structured fields `error: "validation failed"` and `field: "password"` or `field: "username"`.
- **FR-ROUTE-002 (`src/index.js`):** Continue mapping non-validation errors through the existing HTTP 500 behavior.
- **FR-AUTH-003 (`src/auth.js`):** Requests containing both credential fields must continue using the unchanged `admin` / `hunter2` credential rule; valid and invalid credential outcomes remain unchanged.
- **FR-TEST-001 (`src/auth.spec.js`):** The existing missing-password test must pass unchanged.
- **FR-TEST-002 (`src/auth.spec.js`):** Add and pass a test for a request with missing `username`, asserting HTTP 400 and both required response fields.

# Non-functional requirements (NFR IDs)

- **NFR-001:** Make the smallest targeted change; do not introduce a validation dependency or refactor unrelated authentication behavior.
- **NFR-002:** Validation failures must be deterministic and must not surface as HTTP 500 responses.
- **NFR-003:** Error responses for missing fields must use the stated stable JSON shape.
- **NFR-004:** Do not log, return, or otherwise expose supplied credential values as part of the validation response.

# PII inventory table

| Data element | PII/sensitive classification | Source | Use | Response/logging requirement |
|---|---|---|---|---|
| `username` | Potential identifier / sensitive credential data | `POST /login` JSON body | Credential validation and authentication | Return only the literal field name when absent; do not echo a supplied value. |
| `password` | Authentication secret | `POST /login` JSON body | Credential validation and authentication | Never return or log its value; return only the literal field name when absent. |

# Role matrix

| Role | Allowed behavior |
|---|---|
| Unauthenticated client | May submit `POST /login`; receives HTTP 400 validation responses for an absent credential field. |
| Client with valid credentials | Retains the existing successful authentication behavior for `admin` / `hunter2`. |
| Client with invalid credentials | Retains the existing invalid-credential behavior. |
| Service/route handler | Converts recognized validation failures to the required HTTP 400 response; preserves existing handling for other errors. |

# Acceptance criteria

- A `POST /login` body containing `{"username":"foo"}` returns HTTP 400, not 500, with `{"error":"validation failed","field":"password"}`.
- A `POST /login` body containing `{"password":"hunter2"}` returns HTTP 400, not 500, with `{"error":"validation failed","field":"username"}`.
- The existing missing-password test passes unchanged.
- A new missing-username test exists and passes.
- Requests with both fields retain the existing `admin` / `hunter2` credential behavior, including existing outcomes for valid and invalid credentials.
- Only `src/auth.js`, `src/index.js`, and `src/auth.spec.js` are changed for this bug fix.

# Open questions for HITL

- Does “missing” mean only an absent JSON property, or should `null`, an empty string, `undefined`, and non-string values also be validation failures? The authoritative brief explicitly specifies a missing field only.
- If both `username` and `password` are absent, which single field should be reported first? The required response shape supports one `field` value and the brief does not define precedence.
- Should malformed JSON retain its current behavior, or should it receive a separate HTTP 400 response? This is not part of the stated bugfix scope.
