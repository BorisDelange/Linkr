# Linkr v2

Healthcare data visualization and analysis platform using the OMOP Common Data Model.

## Development

```bash
# Install dependencies
npm install

# Start frontend
npm run dev:web

# Start backend
cd apps/api && uvicorn app.main:app --reload

# Start both
npm run dev:all
```

## Architecture

- **Frontend**: React + TypeScript + Vite + shadcn/ui
- **Backend**: FastAPI (Python)
- **Database**: PostgreSQL / SQLite / DuckDB
- **Monorepo**: Turborepo

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.
