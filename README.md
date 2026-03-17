# Linkr v2

[![Try Linkr](https://img.shields.io/badge/Try%20Linkr-GitLab%20Pages-2ea44f?style=for-the-badge)](https://linkr-v2-b1800b.frama.io/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)

Healthcare data visualization and analysis platform using the OMOP Common Data Model.

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

### Full-stack with FastAPI backend

> **🚧 Under development** — the FastAPI backend is not yet ready for production use.

This mode adds a Python backend for server-side features: user authentication, PostgreSQL persistence, git versioning, and server-side code execution.

```bash
# Install dependencies
npm install
cd apps/api && pip install -e ".[dev]"

# Start both frontend and backend
npm run dev:all

# Or start them separately
npm run dev:web                                      # Frontend (port 3000)
cd apps/api && uvicorn app.main:app --reload         # Backend (port 8000)
```

## Architecture

- **Frontend**: React + TypeScript + Vite + shadcn/ui
- **Backend**: FastAPI (Python) *(in development)*
- **Database**: PostgreSQL / SQLite / DuckDB
- **In-browser runtimes**: DuckDB-WASM, Pyodide, webR
- **Monorepo**: Turborepo
