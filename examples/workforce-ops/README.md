# Workforce Ops — reference case

The brief in [brief.md](brief.md) describes a mid-sized-enterprise leave and
workforce-management service (five modules: employees, time entries, leave
requests, reports, auth/RBAC/audit) built on NestJS + Prisma + SQLite. It is
the reference brief shipped with the repo — the case the pipeline was tuned
against.

## Reproducing the reference pass

From the repo root, headless:

```bash
node plugin/codex/run.mjs \
  --brief=examples/workforce-ops/brief.md \
  --project-root="$(pwd)" \
  --output-dir="$(pwd)/examples/workforce-ops/passes/pass1" \
  --run-id=pass1
```

Add `--dry-run` first to see the pinned invocation without spending anything.
Inside a codex session, `$mmo-codex:greenfield` runs the same pipeline and
asks for what it needs instead of taking flags.

Then read what it cost:

```bash
node tools/report.mjs examples/workforce-ops/passes/pass1 --markdown
```

See the top-level [README.md](../../README.md) and
[docs/running.md](../../docs/running.md) for every flag and the policy options.

## Recorded passes

Pass output directories are gitignored — each user generates their own
locally. Nothing under `passes/` is committed.

## Running a different brief

The pipeline is not coupled to this case. Copy
[../../docs/brief-template.md](../../docs/brief-template.md), fill it in, and
point `--brief` at it with an `--output-dir` of its own. See
[docs/running.md](../../docs/running.md#bring-your-own-brief).
