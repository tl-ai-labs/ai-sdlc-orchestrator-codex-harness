# Stack adapter — NestJS + TypeScript

Detected by: `package.json` with `@nestjs/core` (or `@nestjs/common`) in `dependencies`. Usually
paired with Prisma, TypeORM, or Sequelize; those are detected separately and produce hints
below.

Carries over the existing greenfield NestJS expertise the plugin ships with. Brownfield use
still relies on the adaptive stack profile as ground truth — the snippets and conventions in
that profile OVERRIDE what's in this file when they disagree (the profile reflects the actual
repo; this adapter reflects idiomatic Nest in general).

## Placement rules (§15)

Nest projects follow strong conventions but with variations. Precedence:
1. **Stack profile** — mirror what the profile sampled from real files.
2. **Detected layout** — if the profile is absent, look at how existing modules are laid out
   in `baseline.topology.top_level_dirs` and the existing `src/` structure.
3. **Fallback** — if nothing to sample, use the conventions below.

### Fallback conventions (Nest idiom)

```
src/
├── main.ts                           ← app bootstrap; existing, never touched
├── app.module.ts                     ← root module; register new modules HERE
└── modules/
    └── <feature>/                    ← one folder per feature (bounded context)
        ├── <feature>.module.ts       ← @Module — declares controllers, providers, imports
        ├── <feature>.controller.ts   ← @Controller — one per resource
        ├── <feature>.service.ts      ← @Injectable — business logic
        ├── dto/
        │   ├── create-<x>.dto.ts     ← @IsString, @IsNotEmpty etc.
        │   └── update-<x>.dto.ts
        ├── entities/                 ← Prisma/TypeORM entity types (if not Prisma-inferred)
        └── __tests__/
            ├── <feature>.controller.spec.ts   ← @nestjs/testing + supertest
            └── <feature>.service.spec.ts     ← @nestjs/testing
```

**Framework-owned wiring** — Nest requires every new `@Controller` and `@Injectable` to be
declared in a `@Module`'s `controllers: [...]` and `providers: [...]` arrays. A file that isn't
wired does nothing. The packet planner MUST emit paired packets for any new controller/service:

- Packet A: `new_file_add` for `<feature>.controller.ts`
- Packet B: `new_file_add` for `<feature>.module.ts` (or `existing_file_edit` if the feature's
  module already exists, adding to its `controllers: [...]` array)
- Packet C: `existing_file_edit` for `app.module.ts` — add the feature module to `imports: [...]`

All three are one atomic unit — if any fails, roll back the others within the packet execution
(the write-contract hook + provenance recording handle this at the file layer).

## Task-type subtypes

Nest-specific hints that the packet planner attaches as `subtype` on stack-agnostic packets:

| Base task_type | Nest subtype | What the packet produces |
|---|---|---|
| `new_file_add` | `nest_controller` | Class annotated `@Controller('<path>')` with `@Get`/`@Post`/etc. handler methods |
| `new_file_add` | `nest_service` | Class annotated `@Injectable()`, injected into controller/other services |
| `new_file_add` | `nest_module` | `@Module({...})` class wiring controllers + providers + imports |
| `new_file_add` | `nest_guard` | `@Injectable()` implementing `CanActivate` |
| `new_file_add` | `nest_interceptor` | `@Injectable()` implementing `NestInterceptor` |
| `new_file_add` | `nest_filter` | `@Catch(...)` implementing `ExceptionFilter` |
| `new_file_add` | `nest_dto` | Class with `class-validator` decorators (`@IsString`, `@MinLength`, etc.) |
| `existing_file_edit` | `module_wiring` | Add a controller / service to a `@Module`'s arrays |
| `new_file_add` | `prisma_schema_addition` | Add a Prisma model to `schema.prisma` (if Prisma detected) |
| `new_file_add` | `prisma_migration` | New migration file under `prisma/migrations/<timestamp>_<name>/` |
| `test_add` | `nest_unit_test` | `@nestjs/testing`'s `Test.createTestingModule` with mocked deps |
| `test_add` | `nest_integration_test` | Same + supertest against a `NestFactory.create()` app instance |

## Codegen packet hints

When packing a Nest packet, include in `instruction`:
- The relevant profile snippet (or a Nest idiom snippet if no profile)
- The `@Module` file the new class will be registered in
- The DTO files if the packet is a controller (so parameter types resolve)
- The service interface if the packet is a controller/service pair
- Any existing base classes / interfaces the file will implement

Don't include the entire `app.module.ts` file if it's just being edited to add one line — use
`patch_apply` with a small diff instead.

## Config & env handling (Nest specifics)

Nest apps that use `ConfigModule.forRoot({ validationSchema })` require every referenced env
var to be present at boot. Discovery already recorded env-var references in
`baseline.env_keys_by_file` and `baseline.env_keys_referenced_in_code`. When a codegen packet
introduces a new required env var:

1. Add it to `.env.example` (via `existing_file_edit` with append semantics — never overwrite)
2. **Never** modify `.env` — that's off-limits and belongs to the user
3. Add it to `.env.test` if that file exists in the repo AND `intent ∈ (feature-new,
   feature-extend)`. Otherwise the test-runner probe (§7.4 step 2) will report the missing key
   and Gate 0 informs the user.

## Test-runner (Nest)

Discovery detected the test command. Nest projects almost always use Jest via `npm test` or
`pnpm test`. The `test_add` and `test_backfill` packets produce files compatible with the
runner the Gate 0 confirmed test command uses; the adapter itself doesn't override that
choice.
