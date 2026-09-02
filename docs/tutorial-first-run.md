# Your first run

One greenfield run, start to finish. About twenty minutes, most of it waiting.

> **Before you start:** finish [../SETUP.md](../SETUP.md). This tutorial assumes
> `node plugin/codex/verify-setup.mjs` reports no blocking problems.
> **Also see:** [running.md](running.md) for the full surface · [methodology.md](methodology.md) for what the numbers mean

---

## 1. Make an empty folder

Greenfield writes a new application. Give it somewhere of its own — not the harness repo.

```bash
mkdir ~/ping-service && cd ~/ping-service
git init
```

## 2. Write a one-paragraph brief

You do not need the full section set for a first run. Save this as `brief.md`:

```markdown
# Project Brief — ping service

## One-line summary
A small HTTP service with a health endpoint.

## Scope
### 1. HTTP API
- `GET /ping` returns 200 with a JSON body containing a status and a timestamp
- Any unknown route returns 404 with a JSON error body

## Tech stack (fixed)
Node.js, Express, Jest for tests.

## Acceptance criteria
- `npm test` passes
- `GET /ping` returns 200; an unknown route returns 404
```

[brief-template.md](brief-template.md) has the full section set for real projects.

## 3. Check the invocation before spending anything

```bash
node '<path-to-harness>/plugin/codex/run.mjs' \
  --brief=brief.md \
  --project-root=. \
  --output-dir=.sdlc \
  --policy=gpt-plus-flash \
  --run-id=first \
  --dry-run
```

This prints the conductor prompt and the `codex exec` command it would run, then exits. Nothing
was spent. If that looks right, drop `--dry-run` and run it for real.

## 4. Answer the gates

The run stops four times and waits.

**Gate 1 — requirements.** It has written `.sdlc/requirements.md`. Read it. If it captured the
brief, reply:

```
approved
```

If it missed something, say so instead — `revise: the 404 body should include the requested path`
— and it will rewrite and ask again.

**Gate 2 — architecture.** Same shape, for `.sdlc/design.md`.

**Gate 3 — security review.** `.sdlc/security_review.md`. On a service this small this is short.

**Gate 4 — final acceptance.** Prints total cost, file count and test results. Reply `accept`.

Between the gates the run works without stopping: it plans task packets, generates code, writes
tests, runs them, and reviews what it produced.

## 5. Look at what it built

```bash
ls -R src
cat .sdlc/SUMMARY.md
```

One observed run of roughly this brief produced an Express app with the route handler, a server
entry point, a Jest test file, a `package.json` and a README — eight phases and nineteen
dispatches in about twenty-one minutes.

## 6. Run it

```bash
cd src
npm install
npm test
```

Then start it and check the endpoints:

```bash
npm start &
curl -i localhost:3000/ping     # 200, JSON with a status and timestamp
curl -i localhost:3000/nope     # 404, JSON error
```

## 7. Check what it cost

```bash
node '<path-to-harness>/tools/report.mjs' .sdlc --markdown
```

The observed run above cost **$0.5287**, vendor-metered, on `gpt-plus-flash`. That is one run of
one small brief, not a guarantee — cost scales with how much code the brief implies and how many
times a phase has to be revised.

The report shows dispatched work and the driver loop as separate totals. The driver figure is
modeled rather than measured and is deliberately kept out of the vendor total;
[methodology.md](methodology.md) explains why.

## What next

- Run it against a real brief — [brief-template.md](brief-template.md)
- Work on an existing repo instead — `$mmo-codex:brownfield`, described in [running.md](running.md#brownfield)
- Try the ChatGPT-seat policy if you would rather not spend API credit on the judgment tier —
  `$mmo-codex:policy`, and note that its judgment cost is reported as modeled
