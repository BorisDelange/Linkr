# Testing

How Linkr is tested, tier by tier: what each tier proves, how to run it, and
where its code lives. What deserves a unit test and how to write one is in
[`conventions.md` § Tests](conventions.md#tests). Two skills drive the tiers:
`run-tests` (pick and run the right ones for a change) and `update-tests`
(audit and complete the tests after the code moved).

| Tier | Proves | Run | When |
|---|---|---|---|
| Unit — web | pure logic of the front: SQL builders, escaping, import/export, format | `npm run test` | every push (hook) |
| Unit — API | routes, services, connectors, jobs, migrations | `npm run test:api` | every push touching `apps/api` (hook) |
| Unit — packages | `@linkr/format`, `@linkr/mcp`, `linkr-py`, `linkr-r` | see the hook | every push touching them (hook) |
| End-to-end | a user's journeys in a real browser | `npm run test:e2e` | on demand, code review, release |
| Database matrix | every app query gives the same answer on every engine, and how fast | `npm run test:matrix` | on demand, SQL or connector changes, release |
| SPE scenarios | the app inside a hospital-like SPE, under each proxy / network / machine variant | `npm run test:spe` | deployment changes, release |

## Pre-push

`scripts/git-hooks/pre-push` (installed by `npm install` through
`scripts/install-git-hooks.mjs`) runs the unit tiers, each only when the push
touches what it guards: web tests, lint and typecheck for `apps/web`,
`packages/linkr-format`, `packages/linkr-mcp`, `packages/default-plugins` (the app
bundles their manifests), `VERSION` (the export goldens pin it) and the root
`package.json` / `package-lock.json` / `turbo.json`; the API suite for `apps/api`
and `VERSION`; each package's suite for itself, what it imports or reads
(`packages/default-plugins` for the MCP), `VERSION` and the root `package.json` /
`package-lock.json`. `LINKR_PREPUSH_ALL=1 git push` runs everything.
The API suite runs in parallel (`pytest-xdist`, 4 workers, 120 s per test at most) and leaves out tests
marked `@pytest.mark.slow` (the marker is registered in `apps/api/pyproject.toml`;
none carries it yet). The slow tiers are never in the hook.

The API's test database is a SQLite file per test with a real connection pool,
in WAL mode, as in production (`tests/conftest.py`, `engine`): one shared
in-memory connection let a request's closing rollback undo a background job's
writes, and lost its tables when a job's cancellation invalidated it.

## End-to-end (Playwright)

`apps/web/playwright.config.ts`, journeys in `apps/web/e2e/`:

- **`client`** — the client-only (WASM) build with the demo seed, served by
  `vite preview` on port 4317 (built by the config unless `E2E_SKIP_BUILD=1`;
  `E2E_BASE_URL` points it at a build already served). A worktree gets 4317 plus
  the offset of its `WEB_PORT` over 3000 (3004 → 4321), so two worktrees' runs
  never meet; `E2E_PORT` overrides it. A server already on that port is reused
  only with `E2E_SKIP_BUILD=1`; otherwise the port must be free, so a run never
  tests someone else's or an older build. The `browser-check` skill previews on
  4500, out of that range. Needs the seed
  (`npm run data:fetch`). Covers the boot and a cold deep link, the workspace
  databases, a concept search, a cohort, a patient board, a dashboard, a
  dataset, the IDE running the demo SQL script and moving it and its result
  between the two panels, the demo ETL pipeline (its
  scripts, one run against its source), the demo mapping project (filter, open a
  mapping) and a project exported as a ZIP then re-imported. Python and R in the
  IDE are left out (Pyodide / webR downloads), and so are data quality (the demo
  ships no rule set) and git versioning (server only).
- **`server`** — a running full stack named by `E2E_SERVER_URL`; the SPE
  scenarios pass it. Its `server-setup` dependency (`first-run.spec.ts`) creates
  the first account, so give it a fresh, disposable instance; the other journeys
  sign in as that account. They create a workspace, upload a SQLite database and
  query it through the server, then link it to a new project.

`e2e/fixtures.ts` fails every journey on an uncaught page exception and gives
`bootDemo(page)` and, for the server, `signIn(page)`. The code editor binds its
shortcuts by the user agent, which the `Desktop Chrome` device sets to Windows:
press `Control+…`, never `ControlOrMeta+…`, and insert text with
`keyboard.insertText` rather than typing it past the completion popup. Journeys select by role, label and visible text, never by CSS
class, and assert what a user would check. A journey that reproduces an open bug
is tagged `@known-bug` in its title and left out of normal runs; run those with
`E2E_KNOWN_BUGS=1`. A failure keeps its trace and the page's accessibility tree
under `apps/web/test-results/` (`npx playwright show-trace …`).

Some journeys pin figures of the demo content — the mapping project's
"1,786 of 5,636 source concepts mapped" (`concept-mapping.spec.ts`), the IDE
script's result row (`ide.spec.ts`). That content comes from
`linkr-public-content` through `npm run data:fetch`, unpinned: when it changes,
these figures fail and are updated with it, not treated as a regression.

`server/workspace.spec.ts` builds its SQLite file with `node:sqlite`, which needs
Node 22.13 or later (`engines` in the root `package.json`; CI and the images run
`node:22-alpine`).

The `browser-check` skill stays for exploring a change by hand; once a check is
worth keeping, it becomes a journey here.

## Database matrix

`tests/db-matrix/` ([README](../tests/db-matrix/README.md)). The corpus is the
SQL the app itself sends: `build-corpus.ts` runs the real query builders
(patient data, overview, cohorts, concept counts, catalog) on the test
database's mapping, with the class relations injected as `queryDataSource`
injects them. `test_matrix.py` runs each query through the API's own
`db_connect` on every engine — Parquet folder (the reference), DuckDB file,
SQLite file, PostgreSQL, MySQL, and an existing Doris when
`MATRIX_DORIS_HOST` names one — and compares the rows with the reference.
Oracle and SQL Server are listed as unsupported until Linkr has a connector.

The data is the public MIMIC-IV demo in OMOP (100 patients), cloned into
`.cache/test-data/` on first use; `--scale N` makes N copies of every patient
under new ids (vocabulary once) for a bigger base — PostgreSQL and the file
engines then, not MySQL, whose dialect the ×1 base already checks and which takes
longer to load than the whole run (`--engines` still names it). With `--spe`, the matrix runs
inside the SPE simulation, in the API image, capped by a machine profile, against
the datamart containers.

```bash
npm run test:matrix                                   # file engines, this machine
npm run test:matrix -- --spe                          # + PostgreSQL & MySQL, machine "laptop"
npm run test:matrix -- --spe --machine tiny --scale 50
```

Report: `.cache/db-matrix/<machine>-x<scale>/report.md` — per engine, how many
queries answer the same, differently or not at all, the total time and the
slowest query.

## SPE scenarios

`scripts/test-spe.mjs` over `docker/spe-sim/` ([README](../docker/spe-sim/README.md)):
each scenario of `docker/spe-sim/scenarios/` (default, no WebSockets, short
idle timeout, 1 MB body limit, prefix not stripped, no mirror) starts a fresh
install under a machine profile of `docker/spe-sim/machines/` (tiny, laptop,
small-server, unlimited), runs the smoke test and, with `--e2e`, the `server`
journeys.

```bash
npm run test:spe -- default                 # one scenario
npm run test:spe -- --machine tiny --e2e    # all of them, capped, with the journeys
```

Report: `.cache/spe/report-<machine>.md`.

## Flaky tests

A test that fails one run in five is a race, in the test or in the app — the
Concepts deep link and a dozen API job tests were both. Neither tier retries
(`retries: 0`, no rerun plugin), so a flake shows as a failure instead of
hiding. Repeating every run would cost too much; repeat where races live:

- after touching mounting, the seed, jobs, cancellation or WebSockets, run the
  tests of that area five times: `npx playwright test <spec> --repeat-each 5`,
  or the pytest files in a five-iteration loop;
- before a release, the client journeys with `--repeat-each 5`;
- a failure seen once and not reproduced is still investigated, not rerun until
  it passes.

## Machine profiles

A fast development Mac hides slow queries. The profiles cap the SPE's API
container (`SPE_CPUS`, `SPE_MEMORY`) and the datamarts (`DATAMART_CPUS`,
`DATAMART_MEMORY`); DuckDB reads the memory cap and sizes itself on it. Compare a
capped run with `unlimited` before calling a query slow, and keep in mind that
Docker Desktop's own VM limits are the ceiling of every profile.
