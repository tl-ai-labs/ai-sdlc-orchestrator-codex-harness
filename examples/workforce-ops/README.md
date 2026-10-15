# Workforce Ops — reference case

The brief in [brief.md](brief.md) describes a mid-sized-enterprise leave and
workforce-management service (five modules: employees, time entries, leave
requests, reports, auth/RBAC/audit) built on NestJS + Prisma + SQLite. It is
the reference brief shipped with the repo — the case the pipeline was tuned
against.

## Reproducing the reference pass

In a codex session, `$mmo-codex:greenfield` offers this brief as one of its
shipped examples. Start it in an empty folder; see
[docs/tutorial-first-run.md](../../docs/tutorial-first-run.md).

Headless, from a clone at `~/mmo-codex`, in a folder of its own:

```bash
mkdir -p ~/mmo-runs/workforce && cd ~/mmo-runs/workforce
cp ~/mmo-codex/examples/workforce-ops/brief.md brief.md
node ~/mmo-codex/plugin/codex/run.mjs \
  --brief=brief.md \
  --project-root="$PWD" \
  --mode=greenfield \
  --policy=gpt-plus-flash \
  --gates=auto-approve \
  --run-id=pass1 \
  --max-turns=24
```

Add `--dry-run` first to see the pinned invocation without spending anything.
Five modules take an hour or more, and more `codex exec` invocations than the
default `--max-turns` of 12. The run's record lands in `.sdlc/runs/pass1/`,
with its cost report in `report.md` there. To render it again:

```bash
node ~/mmo-codex/plugin/scripts/report.mjs .sdlc/runs/pass1 --markdown
```

[docs/headless-runs.md](../../docs/headless-runs.md) explains how to check the
cost figures from such a run, and [docs/running.md](../../docs/running.md) has
every flag and the policy options.

## Recorded passes

Run folders are not committed — each user generates their own locally.

## Running a different brief

The pipeline is not coupled to this case. Copy
[../../docs/brief-template.md](../../docs/brief-template.md), fill it in, and
point `--brief` at it from a folder of its own. See
[docs/running.md](../../docs/running.md#bring-your-own-brief).
