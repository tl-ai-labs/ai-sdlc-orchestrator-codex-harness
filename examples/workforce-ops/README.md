# Workforce Ops — reference case

The brief in [brief.md](brief.md) describes a mid-sized-enterprise leave and
workforce-management service (five modules: employees, time entries, leave
requests, reports, auth/RBAC/audit) built on NestJS + Prisma + SQLite. It is
the reference brief shipped with the repo — the case the pipeline was tuned
against.

## Reproducing the reference pass

From the repo root:

```
/mmo:pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md
```

Output lands in [passes/pass1/](passes/) (created on run). See the top-level
[README.md](../../README.md) and [docs/running.md](../../docs/running.md) for
the full invocation flow and policy options.

## Recorded passes

Pass output directories are gitignored — each user generates their own
locally. If a maintainer has committed a reference pass here it will show up
under [passes/](passes/) with `telemetry.jsonl`, `manifest.json`, and the
generated source tree; otherwise the directory is empty until you run.

## Running a different brief

The pipeline is not coupled to this case. Copy
[../../docs/brief-template.md](../../docs/brief-template.md), fill it in
under `examples/<your-study-id>/brief.md`, and invoke `/mmo:pass` with
`--study=<your-study-id>`. See
[docs/running.md#bring-your-own-brief](../../docs/running.md#bring-your-own-brief).
