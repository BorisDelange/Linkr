---
name: run-tests
description: Run Linkr's tests at the right depth for a change — unit suites (web, API, packages), the end-to-end browser journeys (Playwright), the database matrix (every app query on DuckDB, SQLite, PostgreSQL, MySQL…, optionally upsampled and on capped machines) and the SPE scenarios (proxy, offline, machine variants). Picks the tiers from what the diff touches, runs them, and reports results with timings and findings. Use when asked to run or check the tests, before a merge or release, after touching SQL builders / connectors / boot / deployment, or when another skill (code-review) asks for a test run.
argument-hint: "[quick | e2e | matrix | spe | full | <git range>]"
---

# Run Linkr's tests

The tiers, cheapest first. `docs/testing.md` is the reference for what each one
covers and how it is built; this skill is the procedure.

| Tier | Command | Time | Needs |
|---|---|---|---|
| **quick** | the pre-push hook's steps (below) | 2–4 min | API venv |
| **e2e** | `npm run test:e2e` | 2–5 min (+1 min build) | Chromium (`npx playwright install chromium`) |
| **matrix** | `npm run test:matrix` (file engines) · `-- --spe` (+ PostgreSQL, MySQL) | 1 min · 5–10 min | Docker for `--spe` |
| **spe** | `npm run test:spe -- default` · all scenarios · `--e2e` | 3 min per scenario | Docker |

Never start the user's dev server (`npm run dev`/`dev:all`): the e2e tier serves
its own build on port 4317 (4317 + the offset of a worktree's `WEB_PORT` over
3000; `E2E_PORT` overrides it), the SPE tiers run in containers.

## 1. Pick the tiers

With an explicit argument, run that tier (`full` = all four, matrix and spe at
default settings). Otherwise read the diff — the range given, else the branch
against `main` plus uncommitted changes (`git diff main...HEAD --name-only; git status --short`)
— and take every row that matches:

| The diff touches | Run |
|---|---|
| anything | **quick**, restricted to the areas touched (as the hook does) |
| `apps/web/src/**` outside `lib/` pure helpers, a page, a store, boot/seed (`seed-loader`, `lib/duckdb/engine.ts`, `mount-guard`) | **e2e** |
| SQL builders (`lib/duckdb/*-queries.ts`, `cohort-query.ts`, `catalog-queries.ts`, `lib/schema-classes/**`, `concept-count-plan.ts`) or connectors (`apps/api/app/services/data/db_connect.py`, `db_schemas.py`, `pushdown.py`, `remote_sql.py`) | **matrix** — with `--spe` when the external engines matter (connectors, pushdown, anything Postgres/MySQL-specific) |
| performance-sensitive SQL (counts, catalog, patient pages, pagination) | **matrix** with `--spe --machine tiny --scale 50` to see it on a small machine and a bigger base |
| `docker/**`, `nginx.conf`, the gateway, base path / prefix handling, WebSockets, environments/mirror (`LINKR_PIP_INDEX_URL`, `LINKR_R_REPOS`) | **spe** (all scenarios); `--e2e` when the UI path changed too |
| a release | **full**, the SPE scenarios with `--e2e` |

Say which tiers you picked and why in one line each before running them.

## 2. Run

**quick** — the same steps as `scripts/git-hooks/pre-push`, run directly so
they do not depend on a push (skip the areas the diff does not touch):

```bash
(cd apps/web && npm run --silent test && npm run --silent lint && npm run --silent typecheck)
(cd apps/api && .venv/bin/python -m pytest -q -p no:cacheprovider -n 4 --timeout=120 -m "not slow")
(cd packages/linkr-format && npx vitest run) ; (cd packages/linkr-mcp && npx vitest run)
(cd packages/linkr-py && PYTHONPATH=src ../../apps/api/.venv/bin/python -m pytest -q tests)
(cd packages/linkr-r && Rscript -e 'testthat::test_local(".", reporter = "summary", stop_on_failure = TRUE)')  # skip if R/testthat missing
```

A bare `uv sync` strips the dev extras (pytest, xdist): if pytest is missing,
`uv pip install --python .venv/bin/python -e ".[dev]"` in `apps/api`.

**e2e** — `npm run test:e2e`. Add `E2E_SKIP_BUILD=1` when `apps/web/dist` is a
fresh client build. A failure leaves a trace: `npx playwright show-trace <path>`
from `apps/web`, or read `test-results/*/error-context.md` (the page's
accessibility tree at the failure). Journeys tagged `@known-bug` are left out;
`E2E_KNOWN_BUGS=1` runs them.

**matrix** — `npm run test:matrix [-- --spe] [--machine M] [--scale N] [--engines …]`.
It prints a table per engine and writes `.cache/db-matrix/<machine>-x<scale>/report.md`.
`different` means an engine answered a query differently from DuckDB on the
Parquet — always a bug, either in the builder's SQL or in the connector.
`error` means the engine refused the app's SQL. The `Slowest` column and the
total per engine are the performance signal: compare a capped machine
(`tiny`, `laptop`) with `unlimited` before calling something slow.

**spe** — `npm run test:spe [-- --machine M] [--e2e] [scenario…]`. Each scenario
is a first install. Writes `.cache/spe/report-<machine>.md`.

**Races** — when the diff touches mounting (`lib/duckdb/engine.ts`,
`data-source-store`), the seed, background jobs, cancellation or WebSockets, run
that area's tests five times (`--repeat-each 5` for Playwright, a five-iteration
loop over the pytest files), and the client journeys with `--repeat-each 5` for a
release. A failure seen once is reported, never rerun until it passes
(`docs/testing.md` § Flaky tests).

Run tiers in the background when they take minutes, and keep working on the
next one meanwhile; Docker tiers one at a time (they share the SPE's containers).

## 3. Report

Lead with the verdict. Then one table: tier, result (counts), duration. Then
every failure as a bullet: what failed, the first line of its error, and whether
it is caused by the change under test or was already there (check by running
the same test on `main` when unsure — `git stash` is not yours to use in a shared
checkout; use a worktree). Name known bugs as known. Do not fix failures unless
asked: this skill measures.

When called from `code-review`, return the table and the failures for its
report instead of a separate message.
