# CLAUDE.md

Linkr is a healthcare data visualization platform (React + FastAPI). v2 is a full rewrite from R/Shiny, with dual deployment: static WASM frontend-only, or full-stack with Python backend.

- **Code conventions (read before writing code)** → `docs/conventions.md`
- **UI patterns (read before writing any UI)** → `docs/ui-patterns.md` — which shared component to reuse (datatable, dialogs, toolbars, page headers) and the type scale
- Architecture, navigation, stores, OMOP patterns, database gotchas → `docs/architecture.md`
- Fuzzy search rules → `docs/fuzzy-search.md`
- Available shadcn/ui components (upstream catalogue) → `docs/shadcn-components.md`
- Long-term vision → `docs/vision-roadmap.md`
- **Ongoing work-in-progress plans** (versioning, IDE environments, dataset editing, fullstack backlog, permissions) → start at `docs/planning/README.md` (per-effort status index) before starting related work; the as-built lives in `docs/architecture.md`.

## Related repos

- **`../linkr-portal`** — template for deploying a pre-seeded Linkr instance (e.g. on GitLab Pages). It aggregates this app + workspace/project git repos as submodules, then `scripts/build.sh` bakes the workspace data into `apps/web/public/data/seed/` and builds a static site. The seed loader (`apps/web/src/lib/seed-loader.ts`) reads that data on startup. When an entity (project, mapping project, SQL collection, ETL pipeline) is git-linked, the workspace export emits only its metadata + a git pointer (+ a root `git-links.json`); the portal clones the linked repo and reconstitutes the full content at build time. Keep the export layout (`buildWorkspaceZip`/`buildProjectZip` in `lib/entity-io.ts`), the seed loader, and the portal's `build.sh`/`sync-git-links.sh` in sync. (`../linkr-portal-ricdc` is one concrete deployment, not the template.)

- **`../linkr-website`** — public site + **user documentation** ([linkr.interhop.org](https://linkr.interhop.org)). Astro 5 + React 19 + MDX, FR/EN, deployed on GitLab Pages. User-facing docs live in `src/pages/docs/` (e.g. `getting-started/`, `concept-mapping/`); also hosts the blog, tools, and people pages. When a change here alters user-visible behaviour or a documented workflow, the matching doc page in `linkr-website` likely needs updating too — it is the source of truth for end-user documentation, not this repo.

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

**Reuse before building UI** — **read `docs/ui-patterns.md` before writing any screen**; it is the source of truth for tables, dialogs, page shells, fields and the type scale. Order: (1) a composed component from that doc (`ConceptDataTable`, `DialogShell`, `ListPageToolbar`, `SectionLabel`, `table-primitives`…), (2) a shadcn primitive from `apps/web/src/components/ui/` (catalogue: `docs/shadcn-components.md`), (3) only then build — and add it to that doc. Never hand-roll a `useReactTable` for sorting/resizing. When a shared component almost fits, **extend it** rather than forking it, dropping the feature, or hardcoding around it — the working rules are `docs/ui-patterns.md` §6. To add a shadcn component: copy from `../shadcn-ui/apps/v4/registry/bases/radix/ui/`, adapt imports, replace HSL colors with `var(--color-*)`.

**Type scale** — only `text-2xl font-bold` (page title), `text-sm` (body), `text-xs` (dense: table cells, labels, buttons), `text-[10px]` (micro-chrome: inline filters, counters). Dialog titles are `text-base` via the primitive. Write `<Label>`, `<Badge>`, `<DialogTitle>` with **no size class** — the primitives already carry the scale. `text-[11px]` is deprecated. Colors via theme tokens, not raw palette classes.

**Path alias** — always `@/` for imports from `src/` (e.g. `@/lib/utils`, `@/stores/app-store`). Note: `cn()` is at `@/lib/utils`.

**File naming** — TypeScript/React: kebab-case files + PascalCase exports. Python: snake_case. API routes: kebab-case URLs.

**No comments** — only add a comment when the WHY is non-obvious (hidden constraint, workaround, surprising invariant). Never describe what the code does.

**Tests follow the code** — when you change or add *pure, critical* logic (SQL escaping/validation, OMOP/query builders, fuzzy-search, import/export, format helpers), add or update its test in the same change. Run `npm run test` before pushing. Do not unit-test volatile UI components. Details → `docs/conventions.md` + `.claude/skills/write-tests/`.

**Two independent versions** — don't conflate them:
- **Export-format version** = repo-root `VERSION` file. Stamped into exports (`project.json` `appVersion`). Read by BOTH front (`vite.config.ts`/`vitest.config.ts` inject `__APP_VERSION__` → `lib/version.ts`) and back (`apps/api/app/export_version.py`). Bump it in ONE place (`VERSION`) when the export format changes or on a release. Front and server MUST stamp the same string or git shows false diffs — the project-export golden tests guard this.
- **Server/deployment version** = `apps/api/app/config.py` `app_version` (+ `pyproject.toml`). Only logs / `/health` / OpenAPI title. Bump on a server release. It is deliberately NOT the export version — never wire one to the other.