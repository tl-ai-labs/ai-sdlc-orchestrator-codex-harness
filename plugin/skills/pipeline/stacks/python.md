# Stack adapter — Python (Django + FastAPI + Flask)

Detected by: `pyproject.toml`, `requirements.txt`, `Pipfile`, or `setup.py` at repo root, with
one of these dependency signals:
- `django` → Django adapter branch (below)
- `fastapi` → FastAPI adapter branch (below)
- `flask` → Flask adapter branch (light — fewer conventions)
- None of the above → falls back to the generic adapter; adaptive stack profile is authoritative

The three frameworks have very different conventions. This file describes each branch; the
packet planner picks the branch based on which dependency was detected. If multiple are present
(e.g. a Django project with an internal FastAPI service), the packet planner uses the framework
of the file being edited (via the file's imports) or asks the user at Gate 0 for cross-cutting
work.

Brownfield use still defers to the adaptive stack profile as ground truth — snippets in the
profile override anything below when they disagree.

---

## Django branch

### Placement rules (§15)

```
<project>/                              ← contains manage.py, settings/
├── manage.py                           ← existing, never touched
├── <project>/                          ← project package (settings, urls)
│   ├── settings.py OR settings/        ← env-driven config
│   └── urls.py                         ← root URL conf — REGISTER new app URLs here
└── apps/                               ← common convention; may also be flat
    └── <app_name>/                     ← one Django app per feature
        ├── __init__.py
        ├── apps.py                     ← AppConfig
        ├── models.py                   ← @dataclass-like Model classes
        ├── views.py                    ← view functions or class-based views
        ├── urls.py                     ← app-local URL conf
        ├── serializers.py              ← DRF, if detected
        ├── admin.py
        ├── migrations/                 ← auto-generated; never hand-edit
        └── tests/
            ├── __init__.py
            ├── test_views.py
            └── test_models.py
```

### Framework-owned wiring (Django)

Every new view must be registered in the app's `urls.py`, AND the app's URL conf must be
included in the project's root `urls.py`. Paired packets:

- Packet A: `existing_file_edit` on `<app>/views.py` (or `new_file_add` if new file)
- Packet B: `existing_file_edit` on `<app>/urls.py` (add the URL pattern)
- Packet C: `existing_file_edit` on `<project>/urls.py` (only if the app itself is new — one-shot
  registration)

Also: new models require migrations. Emit a `new_file_add` packet with subtype `django_migration`
pointed at `<app>/migrations/NNNN_<name>.py` — but let Django's `makemigrations` produce the
content; the packet writes a placeholder and prints the exact command for the user to run.

### Task-type subtypes (Django)

| Base task_type | Django subtype | Produces |
|---|---|---|
| `new_file_add` | `django_view` | Function-based or class-based view |
| `new_file_add` | `django_model` | `models.Model` subclass |
| `new_file_add` | `django_serializer` | DRF serializer (if DRF detected) |
| `existing_file_edit` | `url_registration` | Add path/pattern to urls.py |
| `existing_file_edit` | `django_settings` | Add app to INSTALLED_APPS, middleware to MIDDLEWARE, etc. |
| `test_add` | `django_view_test` | pytest-django or Django `TestCase` |
| `new_file_add` | `django_migration` | Migration stub; user runs `makemigrations` |

### Django-specific test-runner

Django projects almost always use pytest-django or `python manage.py test`. Discovery detected
which. Packet's job is to produce a test file compatible with the detected runner.

---

## FastAPI branch

### Placement rules (§15)

FastAPI has weaker file-layout conventions than Django. The stack profile is especially
important here. Common shapes:

```
src/OR app/                             ← package root
├── main.py                             ← FastAPI app instance + include_router() calls
├── routers/                            ← one file per router group
│   └── <feature>.py                    ← APIRouter with endpoints
├── models/                             ← Pydantic BaseModel classes
├── services/                           ← business logic
├── db/                                 ← SQLAlchemy models / session
└── tests/
    └── test_<feature>.py               ← pytest + httpx TestClient
```

Alternative shapes to detect from the profile:
- **Domain-driven**: `src/<domain>/{router,service,model}.py`
- **Flat**: everything in one package with `routes.py`, `models.py`, `services.py`

### Framework-owned wiring (FastAPI)

Every new router must be `include_router`'d in `main.py` (or wherever the FastAPI app instance
is constructed). Paired packets:

- Packet A: `new_file_add` on `routers/<feature>.py` (or `existing_file_edit`)
- Packet B: `existing_file_edit` on `main.py` — add `from routers import <feature>` and
  `app.include_router(<feature>.router, prefix="/<x>")`

### Task-type subtypes (FastAPI)

| Base task_type | FastAPI subtype | Produces |
|---|---|---|
| `new_file_add` | `fastapi_router` | APIRouter with @router.get/@router.post handlers |
| `new_file_add` | `fastapi_pydantic_model` | BaseModel subclass |
| `new_file_add` | `fastapi_service` | Plain function or class; injected via Depends() |
| `existing_file_edit` | `router_wiring` | Add include_router() call in main.py |
| `test_add` | `fastapi_test` | pytest + httpx.AsyncClient or TestClient |

---

## Flask branch

Flask is deliberately unopinionated. This adapter is thin — it relies almost entirely on the
adaptive stack profile. Common patterns detected:

- **Single-file app** — everything in `app.py`. Packets edit `app.py` directly.
- **Application factory** — `create_app()` function; blueprints registered inside.
- **Blueprints** — one folder per blueprint under `blueprints/` or similar.

### Framework-owned wiring (Flask)

When blueprints are in use: new blueprint requires `app.register_blueprint(<bp>)` in the factory.
Paired packet emitted only in that case.

### Task-type subtypes (Flask)

Minimal — the base primitives cover most Flask work. `subtype: flask_route` on `new_file_add`
or `existing_file_edit` hints codegen to use `@bp.route` or `@app.route`. `test_add` produces
files compatible with pytest + `app.test_client()`.

---

## Common to all Python branches

### Config & env

Python apps typically use one of:
- `python-dotenv` + `os.getenv(...)` — env-driven
- `pydantic-settings` (formerly `pydantic.BaseSettings`) — validated at import
- `envalid` (rare in Python; more common in Node)
- `dynaconf`, `viper`, etc.

Discovery recorded which via `baseline.env_keys_referenced_in_code`. When a codegen packet
introduces a new required env var:
1. Append to `.env.example` if present
2. **Never** modify `.env`
3. If `pydantic-settings` is used, add the field to the Settings class (via `existing_file_edit`
   on the settings module) — that's a code change, not just an env change

### Test-runner

Almost always `pytest` (with or without pytest-django). Discovery detected the exact command.
Packets produce test files compatible with the runner Gate 0 confirmed. When `pytest-django`
is present, use `django_db` fixture in tests that touch the DB.

### Type hints

Detect via profile: is the codebase using type hints (`def foo(x: int) -> str:`)? If yes, ALL
new code adds them. If not, don't introduce them (mismatched style).
