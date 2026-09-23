# Linkr

[![Try Linkr](https://img.shields.io/badge/Try%20Linkr-GitLab%20Pages-2ea44f?style=for-the-badge)](https://linkr-v2-b1800b.frama.io/)
[![Documentation](https://img.shields.io/badge/Documentation-linkr.interhop.org-2ea44f?style=for-the-badge)](https://linkr.interhop.org/en/docs/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)

**A health data platform for the people who ask the clinical questions.**

Linkr takes a hospital's data — an OMOP warehouse, a CSV, a REDCap export — and gives
clinicians and researchers the whole chain in one place: explore it, map it to standard
terminologies, build a cohort, analyse it, and publish a dashboard. Without writing code,
and without leaving the data where it should not go: **every deployment is yours**, on
your servers or in your browser, and nothing is sent anywhere.

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/dash-board-en.png" alt="A Linkr dashboard: KPI tiles, a survival curve and a distribution chart, filtered by cohort" width="100%">
</p>

---

## What you can do with it

### Explore a data warehouse

Connect an OMOP database (PostgreSQL, DuckDB, Parquet, SQLite…) and browse it without SQL:
per-table statistics, concept counts by domain and by vocabulary. Patient boards then bring
one patient's whole stay onto a single screen — demographics, timeline, labs, treatments —
with tabs for the details that matter to your question.

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/concepts-en.png" alt="The concepts page: counts per domain and vocabulary, with inline filters" width="100%">
</p>

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/board-overview-en.png" alt="A patient board: demographics, stay timeline, lab results and treatments on one screen" width="100%">
</p>

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/board-haemodynamics-en.png" alt="The same patient, on a tab dedicated to haemodynamic curves over the stay" width="100%">
</p>

### Map your local codes to standard terminologies

Hospital data speaks the hospital's language. Concept mapping aligns your local codes with
SNOMED CT, LOINC, UCUM or RxNorm — the step that makes data comparable between departments
and between hospitals. Linkr ranks candidates for each source code, keeps the decision, its
author and its date, and exports the result as a reusable mapping project.

### Build cohorts

Inclusion and exclusion criteria, combined visually, resolved into a patient set you can
reuse across analyses and dashboards.

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/cohort-builder-en.png" alt="The cohort builder: criteria combined into inclusion and exclusion groups" width="100%">
</p>

### Analyse — with or without code

Ready-made analyses (a Table 1, distributions, survival curves) run on a dataset without a
line of code. When you do want code, the built-in IDE runs **Python and R** — server-side in
a managed environment, or entirely in the browser via Pyodide and webR.

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/analysis-table1-en.png" alt="A generated Table 1 comparing baseline characteristics between groups" width="100%">
</p>

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/ide-en.png" alt="The built-in IDE running an R script against a dataset" width="100%">
</p>

### Build dashboards

Assemble widgets on a grid, wire filters once for every tab, and share the result. Widgets
come from a plugin library you can extend.

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/dash-kpi-en.png" alt="Configuring a KPI widget on a dashboard" width="100%">
</p>

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/dash-plugins-en.png" alt="The widget plugin library" width="100%">
</p>

### Collect data — eCRF and manual collection

Not every study starts with a warehouse. Design a form, collect case by case, import an
existing REDCap or Excel file, and the result becomes a dataset like any other.

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/ecrf-survey-en.png" alt="An eCRF form being filled in" width="100%">
</p>

<p align="center">
  <img src="https://linkr.interhop.org/images/demo/ecrf-import-en.png" alt="Importing an existing REDCap export" width="100%">
</p>

**See it in action:** the [guided demo](https://linkr.interhop.org/en/demo/) walks through each
of these with commentary, and the [live instance](https://linkr-v2-b1800b.frama.io/) runs in
your browser with demo data — nothing to install.

---

## Install

### Docker (recommended)

Two published images, nothing to build:

```bash
curl -O https://framagit.org/interhop/linkr/linkr/-/raw/main/docker/docker-compose.hub.yml
export LINKR_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
docker compose -f docker-compose.hub.yml up
```

Open http://localhost:3000 — the setup wizard takes it from there.

`LINKR_SECRET_KEY` signs login tokens and encrypts the passwords of registered databases:
generate it once and keep it. By default the data lives in a Docker named volume; to keep it
in a folder you can see and back up, change one line in the Compose file (its header says
which). Images: [`interhop/linkr`](https://hub.docker.com/r/interhop/linkr/tags).

Full instructions, including PostgreSQL for multi-user setups:
**[Installation guide](https://linkr.interhop.org/en/docs/getting-started/install-local)**.

### In the browser, no install

Linkr also runs with **no server at all** — DuckDB-WASM for data, Pyodide and webR for code,
IndexedDB for persistence. Deployable as a static site on GitLab Pages, GitHub Pages or any
static host. You lose accounts, shared storage and git versioning; everything else works.

```bash
npm install
npm run dev:web                    # http://localhost:3000
cd apps/web && npm run build       # static site in apps/web/dist/
```

### From source, for development

```bash
npm install
python3 -m venv apps/api/.venv
source apps/api/.venv/bin/activate
pip install -e "apps/api[dev]"

cp apps/api/.env.example apps/api/.env
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Paste that value over `dev-secret-change-in-production` in `apps/api/.env` — the backend
refuses to start on the example key. Then point the frontend at the backend and run both:

```bash
cp apps/web/.env.example apps/web/.env.local
npm run dev:all
```

The mode is decided by one variable, `VITE_API_URL`: set → server mode, unset → client-only.
`npm run dev:client` forces client-only for a single run without touching the file.

The three settings that matter in `apps/api/.env`: **`LINKR_DATA_DIR`** (where everything is
stored — *this* is what you back up), **`LINKR_DATABASE_URL`** (unset = SQLite in the data
dir; set it for PostgreSQL), **`LINKR_SECRET_KEY`**. Add `LINKR_CORS_ORIGINS` if the frontend
is not on `localhost:3000`, or the browser blocks the API calls.

<details>
<summary><b>Production deployment (systemd)</b></summary>

Keep three things separate: **code** (the checkout), **data** (a dedicated folder you back
up), **secrets** (never world-readable).

```bash
sudo install -d -o linkr -g linkr /var/lib/linkr
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

```ini
# /etc/systemd/system/linkr-api.service
[Service]
User=linkr
WorkingDirectory=/opt/linkr/apps/api
EnvironmentFile=/etc/linkr/linkr.env
ExecStart=/opt/linkr/apps/api/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

In `/etc/linkr/linkr.env` (`chmod 600`), at minimum `LINKR_DATA_DIR`, `LINKR_SECRET_KEY` and
`LINKR_CORS_ORIGINS` (the frontend's public address). The backend reads `LINKR_`-prefixed
environment variables, which take precedence over `apps/api/.env`. For orchestrated
deployments (Swarm, Kubernetes), prefer the platform's secret store to an env var visible in
`docker inspect`.

For multi-user, use PostgreSQL rather than the default SQLite:
`LINKR_DATABASE_URL=postgresql+asyncpg://linkr:…@localhost:5432/linkr`.

</details>

<details>
<summary><b>Creating the first admin from the command line</b></summary>

The first launch has no users. Instead of the wizard, you can call the API:

```bash
curl localhost:8000/api/v1/setup/status

curl -X POST localhost:8000/api/v1/setup/initialize \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"a-strong-password"}'
```

`status` answers `{"needs_setup": true}` until the instance is initialised. Interactive API
docs are at http://localhost:8000/docs.

</details>

---

## Architecture

- **Frontend**: React + TypeScript + Vite + shadcn/ui
- **Backend**: FastAPI (Python), async SQLAlchemy + Alembic, JWT auth
- **Database**: PostgreSQL or SQLite (same models on both) for app data; DuckDB for analytics
- **In-browser runtimes**: DuckDB-WASM, Pyodide, webR
- **Monorepo**: Turborepo

## Authoring content outside the app

Projects, dashboards, datasets and scripts can be written as an entity tree without opening
Linkr, and validated against the real format — useful for seeding a portal, building a demo,
or keeping the public content repos importable.

```bash
# Validate any entity tree (project, SQL collection, ETL pipeline, schema preset)
npx tsx packages/linkr-format/src/node/cli.ts path/to/entity
```

Agents get the same thing as an MCP server, which writes the tree and validates every change:

```bash
claude mcp add linkr-files -- npx tsx "$PWD/packages/linkr-mcp/src/files/server.ts"
```

## Driving a running instance from an agent

The `linkr` MCP server acts on a running Linkr server as one user — projects, databases,
cohorts, datasets, dashboards — through the REST API, so every permission is re-checked. Its
writes show up live in the open tab and in the header's notification centre, where each one
can be undone. Configure `packages/linkr-mcp/.env` (template `.env.example`), then:

```bash
claude mcp add linkr -- npx tsx --tsconfig "$PWD/packages/linkr-mcp/tsconfig.json" "$PWD/packages/linkr-mcp/src/live/server.ts"
```

`packages/linkr-mcp/README.md` lists the tools; `packages/linkr-format/README.md` documents
what is checked.

## Contributing

Issues and contributions are welcome on either
[FramaGit](https://framagit.org/interhop/linkr/linkr) (where development happens) or the
[GitHub mirror](https://github.com/BorisDelange/Linkr) — use whichever you already have an
account on. Bug reports, confusing screens and use cases we do not cover are as useful as
code; **[CONTRIBUTING.md](CONTRIBUTING.md)** says how.

The user documentation lives in a separate repository and is published at
[linkr.interhop.org](https://linkr.interhop.org/en/docs/).
