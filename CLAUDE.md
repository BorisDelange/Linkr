# CLAUDE.md

Linkr is a healthcare data visualization platform (React + FastAPI). v2 is a full rewrite from R/Shiny, with dual deployment: static WASM frontend-only, or full-stack with Python backend.

- Architecture, navigation, stores, OMOP patterns, database gotchas → `docs/architecture.md`
- Fuzzy search rules → `docs/fuzzy-search.md`
- Available shadcn/ui components → `docs/shadcn-components.md`
- Long-term vision → `docs/vision-roadmap.md`

## Commands

```bash
# Frontend (apps/web)
npm run dev        # port 3000
npm run build

# Backend (apps/api)
uvicorn app.main:app --reload --port 8000
alembic upgrade head

# Monorepo root
npm run dev:web / dev:api / dev:all / build

# Docker
docker compose -f docker/docker-compose.yml up
```

## Rules (apply to every task)

**i18n** — all user-facing text via `t('key')`. Add keys to both `locales/en.json` and `locales/fr.json`.

**shadcn/ui first** — before building any UI, check `docs/shadcn-components.md`. Installed components are in `apps/web/src/components/ui/`. To add a new one: copy from `../shadcn-ui/apps/v4/registry/bases/radix/ui/`, adapt imports, replace HSL colors with `var(--color-*)`.

**Path alias** — always `@/` for imports from `src/` (e.g. `@/lib/utils`, `@/stores/app-store`). Note: `cn()` is at `@/lib/utils`.

**File naming** — TypeScript/React: kebab-case files + PascalCase exports. Python: snake_case. API routes: kebab-case URLs.

**No comments** — only add a comment when the WHY is non-obvious (hidden constraint, workaround, surprising invariant). Never describe what the code does.