# CLAUDE.md

Linkr is a healthcare data visualization platform (React + FastAPI). v2 is a full rewrite from R/Shiny, with dual deployment: static WASM frontend-only, or full-stack with Python backend.

- **Code conventions (read before writing code)** → `docs/conventions.md`
- **UI patterns (read before writing any UI)** → `docs/ui-patterns.md` — which shared component to reuse (datatable, dialogs, toolbars, page headers) and the type scale
- Architecture, navigation, stores, OMOP patterns, database gotchas → `docs/architecture.md`
- **Running several agents at once** → `docs/worktrees.md` (one worktree each, own ports)
- Fuzzy search rules → `docs/fuzzy-search.md`
- Available shadcn/ui components (upstream catalogue) → `docs/shadcn-components.md`
- Long-term vision → `docs/vision-roadmap.md`
- **Ongoing work-in-progress plans** (versioning, IDE environments, dataset editing, fullstack backlog, permissions) → start at `docs/planning/README.md` (per-effort status index) before starting related work; the as-built lives in `docs/architecture.md`.

## Related repos

- **`../linkr-portal`** — template for deploying a pre-seeded Linkr instance (e.g. on GitLab Pages). It aggregates this app + workspace/project git repos as submodules, then `scripts/build.sh` bakes the workspace data into `apps/web/public/data/seed/` and builds a static site. The seed loader (`apps/web/src/lib/seed-loader.ts`) reads that data on startup. When an entity (project, mapping project, SQL collection, ETL pipeline) is git-linked, the workspace export emits only its metadata + a git pointer (+ a root `git-links.json`); the portal clones the linked repo and reconstitutes the full content at build time. Keep the export layout (`buildWorkspaceZip`/`buildProjectZip` in `lib/entity-io.ts`), the seed loader, and the portal's `build.sh`/`sync-git-links.sh` in sync. (`../linkr-portal-ricdc` is one concrete deployment, not the template.)

- **[`linkr-catalog`](https://framagit.org/interhop/linkr/linkr-catalog)** — the community catalog index repo. Holds `entries/` (one JSON per published entity) and a `build.mjs` that generates `catalog.json` + `catalog-index.json`, which the app fetches through the GitLab API v4 raw route (the only route sending `access-control-allow-origin: *`, so browsing works in static/WASM mode). App side lives in `apps/web/src/lib/catalog/`; entries must be **publicly clonable** (installs pass no credentials). This is also the registry for the default data — see `docs/planning/default-data-repos-plan.md`.

- **[`linkr-public-content`](https://framagit.org/interhop/linkr/linkr-public-content)** — GitLab group holding the **public default content**, one repo per entity, grouped by type (`database-schemas/`, `etl-pipelines/`, …). Each repo is a plain Linkr entity export tree (e.g. a schema preset is `entity.json` + `mapping.json` + `schema.ddl` + `README.md` + `LICENSE.md`), so the normal import path reads it with no special-casing. These are the repos the catalog indexes and the build bakes into the seed. Working copies: `../@Linkr public content/`.

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
npm run data:fetch # bake the default data into public/data/seed/ (needs network)

# Docker
docker compose -f docker/docker-compose.yml up

# Parallel worktrees (see below)
npm run worktree:new -- <name>   # own branch, own ports, ready to run
npm run worktree:status          # who runs where
```

## Working in parallel — use a worktree

Several agents often work on this repo at once, and a shared checkout makes them
collide: each one's `git status` shows the others' half-finished edits, staging
has to be done path by path, and only one of them can run the app (ports 3000/8000
are taken by the first). **Before starting a task that another agent could be
running in parallel, create your own worktree** rather than editing the shared
checkout:

```bash
npm run worktree:new -- my-task     # → ../linkr-my-task, branch feature/my-task
cd ../linkr-my-task && npm run dev:all
```

It gets its own branch, its own free port pair, its own `LINKR_DATA_DIR`, and a
copy of everything git ignores (`node_modules`, venv, seed).

### Then report back — do not paraphrase this

The user works in **one VS Code window**, opened on the main worktree. From
there they can neither see your files nor reach your app until you tell them
how. **Never start a dev server yourself** — the user runs it, in their own
terminal, so they control restarts. Repeat the script's closing block to them
**verbatim**, as a copyable command block, covering all three:

1. **The command to run the app** — `cd "<worktree path>" && npm run dev:all`,
   to be pasted in a **new VS Code terminal** (one terminal per worktree; front
   and back run together in it).
2. **How to reach it** — the frontend URL (`http://localhost:<WEB_PORT>`), and
   that `Ctrl+C` in that terminal stops it.
3. **How to see your files** — *File › Add Folder to Workspace…* on the worktree
   path, which adds it to their window with its own Source Control section,
   separate from the main worktree's.

A summary sentence is not enough: the paths and ports must be there literally,
ready to paste. Then merge the branch back when the work is done and tell them
the `worktree:remove` command.

Two consequences worth knowing: a branch can only be checked out in one worktree
at a time (so each agent needs its own branch), and a new worktree checks the
branch out **as committed** — uncommitted work elsewhere does not come along.

Details, removal, and what is shared vs copied → `docs/worktrees.md`.

**Default data is not in this repo.** It is one published workspace
(`linkr-public-content/workspaces/demo-workspace`) whose children are git links.
Server mode installs it through the catalog (setup wizard, step 3); a client-only
build has no git client, so CI runs `npm run data:fetch` before `vite build` to clone
it and bake it into `apps/web/public/data/seed/` — that whole folder is a build
artefact and is gitignored. `npm run dev` does **not** fetch (no network required):
run `data:fetch` once if you want the demo content locally. Details →
`docs/planning/default-data-repos-plan.md`.

## Rules (apply to every task)

**i18n** — all user-facing text via `t('key')`. Add keys to both `locales/en.json` and `locales/fr.json`.

**Reuse before building UI** — **read `docs/ui-patterns.md` before writing any screen**; it is the source of truth for tables, dialogs, page shells, fields and the type scale. Order: (1) a composed component from that doc (`ConceptDataTable`, `DialogShell`, `ListPageToolbar`, `SectionLabel`, `table-primitives`…), (2) a shadcn primitive from `apps/web/src/components/ui/` (catalogue: `docs/shadcn-components.md`), (3) only then build — and add it to that doc. Never hand-roll a `useReactTable` for sorting/resizing. When a shared component almost fits, **extend it** rather than forking it, dropping the feature, or hardcoding around it — the working rules are `docs/ui-patterns.md` §6. To add a shadcn component: copy from `../shadcn-ui/apps/v4/registry/bases/radix/ui/`, adapt imports, replace HSL colors with `var(--color-*)`.

**Type scale** — only `text-2xl font-bold` (page title), `text-sm` (body), `text-xs` (dense: table cells, labels, buttons), `text-[10px]` (micro-chrome: inline filters, counters). Dialog titles are `text-base` via the primitive. Write `<Label>`, `<Badge>`, `<DialogTitle>` with **no size class** — the primitives already carry the scale. `text-[11px]` is deprecated. Colors via theme tokens, not raw palette classes.

**Path alias** — always `@/` for imports from `src/` (e.g. `@/lib/utils`, `@/stores/app-store`). Note: `cn()` is at `@/lib/utils`.

**File naming** — TypeScript/React: kebab-case files + PascalCase exports. Python: snake_case. API routes: kebab-case URLs.

**Comments** — default to none: name things well and let the code speak. Never restate the line below. Write one only when the code can't carry it: a non-obvious why, an invariant an edit would break, a domain/spec fact, opaque code (regex, generated SQL), a contract on exported API, or a section banner in a long file. Deferred work gets `// TODO(scope):`, never prose. Details → `docs/conventions.md` § Comments.

**Tests follow the code** — when you change or add *pure, critical* logic (SQL escaping/validation, OMOP/query builders, fuzzy-search, import/export, format helpers), add or update its test in the same change. Run `npm run test` before pushing. Do not unit-test volatile UI components. Details → `docs/conventions.md` + `.claude/skills/write-tests/`.

**Export format has a second home** — the shape of an exported entity (`entity.json`, `dashboards/*.json`, `_tree.json`, payload files) is described BOTH in `apps/web/src/lib/entity-io.ts` and in `packages/linkr-format/` (schemas + validator + authoring serializer, consumed by the `@linkr/mcp` server). **Change one, update the other in the same change** — otherwise the validator silently stops checking the new field, or flags a legitimate tree. Details → `docs/architecture.md` § Format package & MCP authoring.

**Two independent versions** — don't conflate them:
- **Export-format version** = repo-root `VERSION` file. Stamped into exports (`entity.json` `appVersion`). Read by BOTH front (`vite.config.ts`/`vitest.config.ts` inject `__APP_VERSION__` → `lib/version.ts`) and back (`apps/api/app/export_version.py`). Bump it in ONE place (`VERSION`) when the export format changes or on a release. Front and server MUST stamp the same string or git shows false diffs — the project-export golden tests guard this.
- **Server/deployment version** = `apps/api/app/config.py` `app_version` (+ `pyproject.toml`). Only logs / `/health` / OpenAPI title. Bump on a server release. It is deliberately NOT the export version — never wire one to the other.