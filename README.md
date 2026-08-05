# Linkr

[![Try Linkr](https://img.shields.io/badge/Try%20Linkr-GitLab%20Pages-2ea44f?style=for-the-badge)](https://linkr-v2-b1800b.frama.io/)
[![Documentation](https://img.shields.io/badge/Documentation-linkr.interhop.org-2ea44f?style=for-the-badge)](https://linkr.interhop.org/en/docs/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)

Healthcare data visualization and analysis platform using the OMOP Common Data Model.

![Linkr dashboard](docs/assets/dashboard-preview.png)

## Deployment modes

Linkr supports two deployment modes:

### Client-only (static site)

The app runs entirely in the browser — no server needed. Data processing is handled by DuckDB-WASM, code execution by Pyodide (Python) and webR (R), and persistence by IndexedDB. This mode can be deployed as a static site on GitLab Pages, GitHub Pages, or any static hosting.

```bash
# Install dependencies
npm install

# Start dev server
npm run dev:web

# Build for production
cd apps/web && npm run build
# Output is in apps/web/dist/ — deploy this folder as a static site
```

> **Already set up for server mode?** The mode is decided by a single variable,
> `VITE_API_URL`: set → server mode, unset/empty → client-only. Once
> `apps/web/.env.local` defines it, `npm run dev:web` always starts in server mode.
> To run client-only *without touching that file*, use:
>
> ```bash
> npm run dev:client   # = VITE_API_URL= vite — forces client-only for this run
> ```
>
> Handy for checking how a feature degrades without a backend (the catalog's install
> flow, versioning, users/roles — all of which show a "requires server" notice).

### Full-stack with FastAPI backend

> **🚧 Under development** — the FastAPI backend is being built out entity by entity. Auth, setup and the Workspace/Project entities work end-to-end; other entities still fall back to in-browser IndexedDB.

This mode adds a Python backend for server-side features: user authentication (multi-user, workspace-level permissions), a shared database (SQLite or PostgreSQL), and — coming — git versioning and server-side code execution. The frontend switches to "server mode" (API-backed storage + login) as soon as it knows the backend URL via `VITE_API_URL`.

> Each block below is meant to be run from the **repository root**. Commands
> avoid inline `#` comments so you can paste a whole block at once.

#### 1. Install dependencies

Frontend (all workspaces) and Python backend. For a PostgreSQL deploy, use `".[dev,postgres]"` instead of `".[dev]"` on the last line.

```bash
npm install
python -m venv apps/api/.venv
source apps/api/.venv/bin/activate
pip install -e "apps/api[dev]"
```

#### 2. Configure the backend (dev)

All backend settings are environment variables prefixed `LINKR_` (see `apps/api/.env.example`). For local development, a `.env` file is the easiest:

```bash
cp apps/api/.env.example apps/api/.env
```

Then edit `apps/api/.env`. Key settings:

- `LINKR_DATA_DIR` — dedicated folder for all data (default `~/.linkr`). The SQLite database and binary blobs (Parquet, attachments, IDE files) live here together.
- `LINKR_DATABASE_URL` — **leave unset** for SQLite inside `LINKR_DATA_DIR` (single-user, default). Set it for **PostgreSQL** (multi-user): `postgresql+asyncpg://user:pass@host:5432/linkr`.
- `LINKR_SECRET_KEY` — signs the auth tokens; **change it** for anything beyond local dev.

The database file is created automatically on first startup, and migrations run on every startup.

#### 3. Point the frontend at the backend

This sets `VITE_API_URL=http://localhost:8000`, which switches the app into server mode:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Leaving `VITE_API_URL` unset keeps the app in client-only mode. Setting it enables login + API-backed storage.

Once it is set, every `npm run dev:web` starts in server mode. To go back to client-only
for a single run without editing `.env.local`, use `npm run dev:client` (it forces
`VITE_API_URL=` empty).

#### 4. Run

The backend and frontend are two separate processes. Open **two terminals**, each at the repository root.

**Terminal 1 — backend.** Runs on port 8000. Wait until you see `Uvicorn running on http://127.0.0.1:8000` and the Alembic migration logs, with no traceback:

```bash
apps/api/.venv/bin/uvicorn app.main:app --reload --port 8000 --app-dir apps/api
```

**Terminal 2 — frontend.** Serves the app on http://localhost:3000:

```bash
npm run dev:web
```

> Alternatively, `npm run dev:all` runs both at once — but it needs `concurrently`, so run `npm install` at the repo root first.

#### 5. Create the first admin — two ways

The very first launch has no users. You create the initial admin account either **through the UI** or **from the command line**:

**Option A — Setup Wizard (in the browser).** Open http://localhost:3000. With an empty database the app shows a first-run wizard: it displays the database the server is using (read-only — configured via `LINKR_DATABASE_URL`), then lets you create the admin account. In dev builds the fields are pre-filled with `admin` / `admin`; production builds start empty. After that you land on the login page.

**Option B — Command line (headless / scripted).** Call the setup endpoint directly, then log in:

```bash
# Is setup still needed?
curl localhost:8000/api/v1/setup/status              # {"needs_setup": true}

# Create the first admin
curl -X POST localhost:8000/api/v1/setup/initialize \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

Either way, subsequent visits show the login page (pre-filled `admin` / `admin` in dev). Interactive API docs are at http://localhost:8000/docs.

#### Production deployment

On a server, keep three things separate: **code** (the checkout), **data** (a dedicated folder you back up), and **secrets** (never world-readable). Point everything at one data folder and inject config as environment variables — avoid shipping a `.env` file on disk.

```bash
# Dedicated, owned by the service account, holds the DB + all blobs.
sudo install -d -o linkr -g linkr /var/lib/linkr

# Generate a strong secret once:
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

**systemd** (recommended) — secrets in an `EnvironmentFile` with `chmod 600`:

```ini
# /etc/systemd/system/linkr-api.service
[Service]
User=linkr
WorkingDirectory=/opt/linkr/apps/api
EnvironmentFile=/etc/linkr/linkr.env          # chmod 600, owned by linkr
ExecStart=/opt/linkr/apps/api/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
# /etc/linkr/linkr.env   (chmod 600)
LINKR_DATA_DIR=/var/lib/linkr
LINKR_SECRET_KEY=<the generated secret>
LINKR_CORS_ORIGINS=https://linkr.example.org
# For multi-user, use PostgreSQL instead of the default SQLite-in-data-dir:
# LINKR_DATABASE_URL=postgresql+asyncpg://linkr:...@localhost:5432/linkr
```

#### Docker Compose (full-stack)

The `docker/` folder ships a full-stack stack: the front (built in **server mode** and served by nginx), the FastAPI backend (which runs DB migrations on start), and a named volume for the SQLite database + blobs. From the repo root:

```bash
# One-time: create the secrets file Compose reads automatically.
cp docker/.env.example docker/.env
chmod 600 docker/.env
# Put a real signing key in it (JWT + Fernet encryption of stored DB secrets):
python3 -c "import secrets; print('LINKR_SECRET_KEY=' + secrets.token_urlsafe(48))" > docker/.env

docker compose -f docker/docker-compose.yml up --build
```

Then open http://localhost:3000 — first launch shows the admin setup wizard (see step 5). The API is on http://localhost:8000. Data persists in the `linkr-data` volume across restarts; `docker compose down -v` wipes it.

**How it wires up.** The web image is built with `VITE_API_URL=/`, which turns on server mode while keeping API calls relative — nginx proxies `/api` and `/ws` to the `api` service, so the backend URL is never baked into the bundle. Migrations run automatically at container start (`alembic upgrade head`), so the schema is ready on first boot.

**Secrets — via `docker/.env`, never in the image.** Compose reads `docker/.env` (git- and docker-ignored, so it never lands in an image) and injects the values into the containers; `LINKR_SECRET_KEY` is **required** — Compose refuses to start without it. Keep the file `chmod 600`. Note the two `.env` files are unrelated: `docker/.env` feeds Compose interpolation, while `apps/api/.env` is only for running the backend directly in dev. Under the hood the backend reads `LINKR_`-prefixed settings from environment variables (which take precedence over `apps/api/.env`) via `pydantic-settings`. For orchestrated deployments (Swarm/K8s), prefer that platform's secret store — a mounted file or secret object — over an env var visible to `docker inspect`.

**PostgreSQL (multi-user).** Uncomment the `db` service in `docker-compose.yml` and set `LINKR_DATABASE_URL=postgresql+asyncpg://…`. Left unset, the API uses a SQLite file inside `LINKR_DATA_DIR` next to the blobs.

## Architecture

- **Frontend**: React + TypeScript + Vite + shadcn/ui
- **Backend**: FastAPI (Python), async SQLAlchemy + Alembic, JWT auth *(in development)*
- **Database**: PostgreSQL or SQLite (same models on both) for app data; DuckDB for analytics
- **In-browser runtimes**: DuckDB-WASM, Pyodide, webR
- **Monorepo**: Turborepo
