# Default data as external repos — plan

**Status**: 🔜 design settled, all decisions taken (§11) — ready to build · **Effort**: L
**Date**: 2026-08-21 · **Depends on**: [catalog-plan.md](catalog-plan.md) (the
`linkr-catalog` repo must exist first)

Move the bundled default data out of this repo and into one public git repo per entity
(database, project, schema preset, mapping project, ETL pipeline, catalog, DQ rule
set…) — the same repos the catalog indexes. The app then acquires them:

- **client-only (WASM)** — at *build time*, CI clones the repos and bakes them into the
  seed folder. Runtime behaviour is unchanged: same `public/data/seed/`, same loader,
  same "Reset all data" → same content.
- **server mode** — at *first run*, optionally clone the same repos into the instance
  (the backend can already clone; the frontend cannot).
- **on demand, both modes** — a third tab in the import dialog: "from default data",
  listing the catalogue of available entities.

The short answer to the three questions asked: **yes, the build-time clone is the right
shape**; **yes, first-run opt-in is the right shape for server mode** (but the current
setup wizard is the place, not the SQLite picker, which is cosmetic today); and **yes,
what we do with MIMIC-IV demo OMOP is legal** — it is Open Access under ODbL 1.0, and it
can move to a public git repo in Parquet provided the ODbL notices travel with it.

And the fourth: **the registry and the install path already exist — they are the
community catalog** (§2, §5, §7). This plan is mostly "extend the catalog with a
`database` type and a pinned ref, then let CI install from it at build time".

---

## 1. Where we stand today

| Piece | Reality |
|---|---|
| Seed content | `apps/web/public/data/seed/default/` — 100 KB of JSON, committed |
| Seed heavy data | `apps/web/public/data/` — **33 MB**, mostly `mimic-iv-demo/` (18 MB) + `mimic-iv-demo-omop/` (12 MB), committed Parquet |
| Repo pack | 45 MB `size-pack` — the bundled data is most of it |
| Seed loader | [seed-loader.ts](../../apps/web/src/lib/seed-loader.ts) — reads `seed.json` → per-workspace `manifest.json`; runs **in the browser in both modes**, writing through `getStorage()` (IDB client-only, HTTP API in server mode) |
| Seed trigger | [app-store.ts:263](../../apps/web/src/stores/app-store.ts#L263) `seedWorkspaces()` if no project/workspace and no `linkr-seeded` flag; [App.tsx:88](../../apps/web/src/app/App.tsx#L88) `seedDatabases()` |
| Heavy blobs in server mode | Skipped by design ([seed-loader.ts:904](../../apps/web/src/lib/seed-loader.ts#L904)) — the code assumes Parquet is pre-provisioned server-side, **but no provisioning script exists** |
| Backend seed | **None.** Only `seed_default_roles()` ([permissions.py:180](../../apps/api/app/core/permissions.py#L180)) |
| Reset all data | Front-only, client-only-mode-only ([version-check.ts:60](../../apps/web/src/lib/version-check.ts#L60)) — flags a pending reset, deletes every IndexedDB + `localStorage.clear()` at next boot, so the seed replays in full |
| Update detection | `seed-hashes.json` (generated at build by `vite-plugin-seed-hashes.ts`) diffed against a `localStorage` baseline → "Default data has been updated" |
| Git clone | Server-side only: `POST /api/v1/git/clone` ([git.py:1117](../../apps/api/app/api/v1/routes/git.py#L1117)) → `clone_to_zip()` returns a ZIP through the normal import path. In-browser clone was abandoned (CORS) |
| CI | [.gitlab-ci.yml](../../.gitlab-ci.yml) — `npm ci` + `vite build`. **Clones nothing today**; the portal is the repo that does submodule injection ([linkr-portal `scripts/build.sh`](../../../linkr-portal/scripts/build.sh)) |

**Prior art we already own.** `linkr-portal` is this exact mechanism, one level up: it
aggregates workspace/project repos as submodules, overlays git-linked entities into
`apps/web/public/data/seed/`, regenerates `seed.json` + per-workspace `manifest.json`,
then builds. The plan below is that script, moved into this repo and driven by a
declarative list instead of a submodule tree.

---

## 2. Target architecture

```
linkr-default-data/                     (a GitLab group, one repo per entity)
├── db-mimic-iv-demo/                   Parquet + LICENSE (ODbL) + NOTICE
├── db-mimic-iv-demo-omop/              Parquet + LICENSE + NOTICE
├── schema-omop-5.4/                    schema preset
├── project-icu-mortality-prediction/   project export layout
├── project-icu-activity-dashboard/
├── mapping-mimic-iv-to-omop/
├── etl-mimic-iv-to-omop/
├── dq-mimic-iv-demo/
└── catalog-mimic-iv-demo/
```

Each repo is a **standard Linkr export tree** — exactly what `buildProjectZip` /
`buildWorkspaceZip` emit ([entity-io.ts](../../apps/web/src/lib/entity-io.ts)) — so the
existing import path consumes it with no new parser. That is the load-bearing constraint:
*a default-data repo is just an entity export under git*. It is already true for
git-linked entities, so the format is proven.

### The registry — it already exists, it is the catalog

**Decided 2026-08-21**: do not invent a second registry. The community catalog
([catalog-plan.md](catalog-plan.md)) is this mechanism, already built and unit-tested:

| Need here | Catalog already has it |
|---|---|
| List of published entities with name/description/license/version | `CatalogEntry` ([types.ts](../../apps/web/src/lib/catalog/types.ts)) |
| Fetched from a git repo, CORS-safe in WASM mode | [remote.ts](../../apps/web/src/lib/catalog/remote.ts) — GitLab API v4 raw route |
| Hash-diff to detect "3 new, 1 updated" | `diffCatalog()` + `catalog-index.json` |
| Pluggable source URL per deployment | [settings.ts](../../apps/web/src/lib/catalog/settings.ts) — `linkr-catalog-source` |
| Clone → install into a workspace | `prepareCatalogInstall` / `commitCatalogInstall` ([install.ts](../../apps/web/src/lib/catalog/install.ts)) |
| Id-collision + lineage safety, "(copy)" on duplicate, git sync anchoring | same module, already careful about all three |
| "Is it installed, and is it stale?" | [installed.ts](../../apps/web/src/lib/catalog/installed.ts) |

So the "default data registry" is **a curated subset of catalog entries**, marked as
such. Two fields on `CatalogEntry` carry it:

```ts
/** Ships in the client-only (WASM) build: cloned at CI build time into the seed. */
bundled?: boolean
/** Offered by default at server first-run setup. */
defaultInstall?: boolean
```

**What `bundled: true` means** (the question asked): it is the flag that answers *"does
this entity get baked into the static build, or is it only installable on demand?"* In
client-only/WASM mode there is no backend, so nothing can be cloned at runtime — an
entity is usable **only if it is already inside the deployed `public/data/`**. `bundled:
true` is CI's shopping list: `fetch-default-data.mjs` clones exactly those entries into
the seed folder before `vite build`. Everything else stays listed in the catalog but is
installable in server mode only (which is already how the catalog behaves today —
`prepareCatalogInstall` returns `server-mode-required`).

It is separate from `defaultInstall` because the two answer different questions: *is it
in the WASM bundle* (a build-size decision) vs *is it pre-ticked at server setup* (a
first-run UX decision). The demo workspace is both; the 18 MB MIMIC source is probably
neither by default.

### Gaps to close in the catalog

Three, all small, and each is a genuine improvement to the catalog itself:

1. **No `database` type.** `CatalogEntryType = GitLinkedEntity['type']`
   ([entity-io.ts:3079](../../apps/web/src/lib/entity-io.ts#L3079)) covers project,
   mapping-project, sql-collection, etl-pipeline, data-catalog, dq-rule-set,
   schema-preset — but **not a Parquet database**, which is the heavy part of the default
   data. This is the one non-trivial piece of work; **design settled below**.
2. **No `workspace` type** either. ~~Probably fine — seed a workspace by seeding its
   entities~~ — **now needed**: the demo content ships as one curated workspace whose
   children come in through their git links. See decision 6 (reversed 2026-08-27).
3. **No pinned ref.** `git: { url, branch, subdir? }` tracks a *branch*. A reproducible
   build needs a **tag or commit**: add `git.ref`, prefer it over `branch` when present.
   Deployments get reproducibility; the catalog gets a real versioning story.

Everything else — LFS (`git lfs pull` happens server-side in `clone_to_zip`, and in CI),
size hints, license display — is additive metadata.

### The `database` type — design (arbitrated 2026-08-25)

**Decision: open ZIP / git / catalog to importing a database WITH its data; keep the
export data-free.** The asymmetry is the whole point and must survive future tidying.

**Why it is safe.** The export guard exists so the app can never be the path by which
patient data leaves a hospital ([types/index.ts:376](../../apps/web/src/types/index.ts#L376),
`buildDataSourceFolder` writes `_database.json` and not one row). Importing an open
dataset runs the other way: nothing leaves. And because the export still writes no data,
a user cannot accidentally produce a database repo holding real patient rows — the
Parquet has to be put there by hand, outside the app. **That property is what keeps this
safe; do not "harmonise" the export to match the import.**

**Repo layout** — the same shape the other entities use, so the normal import path reads
it with no special-casing:

```
_database.json      metadata + schemaMapping (preset id or inline), NO connection config
data/*.parquet      one file per table, LFS-tracked
.gitattributes      *.parquet filter=lfs diff=lfs merge=lfs -text
README.md / LICENSE.md
```

`_database.json` is what `buildDataSourceFolder` already writes. The `data/` folder is
new and is only ever *read* by the app. Table name = file basename, which is what
`SeedDatabase.tables` already assumes.

**LFS is already handled.** `clone_to_zip` detects `.gitattributes`, runs
`git lfs install --local` then `git lfs pull`, precisely so a tracked file does not land
in the ZIP as a 3-line pointer
([git_service.py:1476](../../apps/api/app/services/git_service.py#L1476)). Catalog
install is server-mode-only ([install.ts:196](../../apps/web/src/lib/catalog/install.ts#L196)),
so that path always applies — there is no WASM clone to make LFS-aware. What remains is
to *use* the bytes once they arrive.

**Work items:**

| # | Item | Where |
|---|---|---|
| 1 | Add `database` to `CatalogEntryType` / `ENTRY_TYPES` / `META_FILE` (`_database.json`) / `idOf` (`id`) / `findExisting` / `createShell` | `lib/catalog/` |
| 2 | `applyClonedEntity` branch: read `data/*.parquet` from the ZIP → `storage.files.create` → `connectionConfig.fileIds`/`fileNames` → mount in DuckDB | `entity-io.ts` |
| 3 | Same read path for the ZIP importer, so ZIP and git agree (they must stay the same tree) | `entity-io.ts` |
| 4 | Show the download size on the catalog card and confirm before install — 18 MB is worth announcing | catalog UI |
| 5 | `size` / `lfs` hints in the catalog entry schema | `linkr-catalog` |

Item 2 is the only real logic, and it already exists in another form: `seedDatabase`
([seed-loader.ts:905-950](../../apps/web/src/lib/seed-loader.ts#L905)) does fetch →
`storage.files.create` → `connectionConfig` → mount. Reuse it rather than writing a
second copy; the difference is only where the bytes come from (a cloned ZIP instead of
`public/data/`).

**Sizes, measured:** `mimic-iv-demo` 18 MB / 32 tables, `mimic-iv-demo-omop` 12 MB. Well
under `MAX_CLONE_BYTES` (200 MB), so no streaming work is needed.

**Authoring side.** The MCP may write a database WITH data (it runs outside the sensitive
context — that is the entire reason it can do what the app refuses). The skill must say:
**synthetic or public open data only, never from a connected database.**

### The three acquisition paths

| Mode | When | How |
|---|---|---|
| client-only | CI build | `scripts/fetch-default-data.mjs` clones every `bundled: true` entry at its pinned ref into `apps/web/public/data/seed/…`, regenerates `seed.json` + manifests, then `vite build` |
| server | first run | Setup wizard step: "start empty" or "install default data" → backend clones the selected entries server-side |
| both | any time | Import dialog → third tab → pick from the registry. Client-only: only entries present in the build. Server: clone on demand |

---

## 3. Client-only: build-time clone

**Yes, this works, and it preserves Reset-all-data semantics for free** — because reset
deletes local storage and replays the seed from `public/data/`, which is part of the
deployed build. Nothing about the reset flow needs to change.

New script `scripts/fetch-default-data.mjs`, run before `vite build`:

1. Read the registry, filter `bundled: true`.
2. For each entry: `git clone --depth 1 --branch <ref> <repo>` into a temp dir
   (`git lfs pull` when `lfs: true`), strip `.git/`.
3. Copy the tree into `apps/web/public/data/seed/<workspace>/<type>/<id>/`, or for
   databases into `apps/web/public/data/<id>/`.
4. Regenerate `seed.json` and each workspace `manifest.json` — reuse the portal's
   generation logic rather than writing a second one (see §8).
5. `vite-plugin-seed-hashes.ts` then hashes the result as it does today, so the
   "Default data has been updated" flow keeps working with zero changes.

CI (`.gitlab-ci.yml`, build stage) becomes:

```yaml
build:
  script:
    - apk add --no-cache git git-lfs && git lfs install
    - npm ci
    - node scripts/fetch-default-data.mjs        # ← new
    - cd apps/web && npx vite build --base /
  cache:
    paths: [node_modules/, apps/web/node_modules/, .cache/default-data/]
```

**Cache the clones** keyed by `<repo>@<ref>` under `.cache/default-data/`. Pinned refs
make this a perfect cache hit — a build that changes no data pays nothing.

**Offline / local dev.** `npm run dev` must not require network. Three rules:
- the fetch script is **not** part of `npm run dev`;
- `apps/web/public/data/` stays gitignored except for a tiny committed fallback (an
  empty workspace) so a fresh clone runs;
- `npm run data:fetch` is the explicit local command, and it no-ops when the cache is
  warm and refs are unchanged.

**Risk to name now**: the build gains a hard dependency on the availability of N public
repos. Mitigations: pinned refs + CI cache (a transient outage is a cache hit), and a
`--offline` flag that fails loudly rather than silently producing an app with no default
data. A build that fetched nothing must fail, not ship empty.

### What this buys

- repo pack drops from ~45 MB toward ~12 MB;
- default data gets its own history, issues, and release tags, decoupled from app releases;
- the catalog indexes the *same* repos users clone — one artefact, not two;
- updating the demo dataset becomes a tag bump in the registry, not a 30 MB commit here.

### What it costs

- one more moving part in CI, and a network dependency at build;
- contributors who edit default data now work in two repos (mitigated by
  `update-default-data`, which should learn the new flow — see §9).

---

## 3bis. Migration inventory — what moves out of this repo

Everything Linkr ships as default content today, and where it goes. Group:
[`linkr-public-content`](https://framagit.org/interhop/linkr/linkr-public-content), one
subgroup per type, one repo per entity.

### A. Schema presets — **hard-coded in TypeScript** (the only truly hard-coded family)

`apps/web/src/lib/schema-presets.ts` (570 lines) + `apps/web/src/lib/schema-ddl/*.ts`
(~90 KB of DDL as TS string literals), surfaced via `BUILTIN_PRESET_IDS` / `SCHEMA_PRESETS`.

| Preset | Repo | Tables | License | Status |
|---|---|---|---|---|
| `omop-5.4` | `database-schemas/omop-cdm-5.4` | 39 | Apache-2.0 | ✅ pushed 2026-08-21 (license + attribution added to the existing content) |
| `omop-5.3` | `database-schemas/omop-cdm-5.3` | 37 | Apache-2.0 | ✅ pushed — DDL **regenerated from OHDSI** (see below) |
| `mimic-iv` | `database-schemas/mimic-iv` | 32 | MIT | ✅ pushed |
| `mimic-iii` | `database-schemas/mimic-iii` | 26 | MIT | ✅ pushed |

Still **private** pending an import test in both modes; make them public once that passes.

Repo layout (what `applyClonedEntity('schema-preset')` reads):
`preset.json` (the `CustomSchemaPreset`: `presetId`, `mapping`, `version`, `license`
metadata) + `schema.ddl` + `README.md` / `README.fr.md` + `LICENSE.md`.

**Verified 2026-08-21**: all four DDLs create every table under DuckDB (the `ALTER TABLE …
FOREIGN KEY` statements are inert there — pre-existing, they document the model), and all
four round-trip through the real `applyClonedEntity('schema-preset')` with DDL, license
and README correctly restored.

Two things to know before importing them into a running app:

- `presetId` is set from the **caller's `targetId`**, not from `preset.json` — installing
  the `omop-cdm-5.4` folder yields `presetId: 'omop-cdm-5.4'`, not `omop-5.4`;
- the built-in presets are still seeded by the app
  ([workspace-store.ts:126](../../apps/web/src/stores/workspace-store.ts#L126),
  [seed-loader.ts:492](../../apps/web/src/lib/seed-loader.ts#L492)), so an import lands
  **alongside** them as a duplicate until `BUILTIN_PRESET_IDS` is retired. Expected at
  this stage; retiring it is what step B below is for.

> **Bug found while extracting** 🐛 — `omop53` is built as `{ ...omop54, presetId: 'omop-5.3', … }`
> ([schema-presets.ts:225](../../apps/web/src/lib/schema-presets.ts#L225)), so it inherits
> `ddl: OMOP_54_DDL`: **choosing OMOP 5.3 in the app today creates 5.4 tables.** Confirmed
> byte-identical (50 772 b both). There is no `omop-5.3-ddl.ts` at all. The repo now carries
> a real 5.3 DDL regenerated from OHDSI's official `OMOPCDM_duckdb_5.3_ddl.sql` +
> `_constraints.sql` (37 tables — incl. 5.3-only `attribute_definition`, which 5.4 dropped —
> and 157 FKs), reformatted to our house style. Fix the app when it switches to the repos,
> or sooner.

### B. Seed content — files under `apps/web/public/data/`

From `seed/default/manifest.json`, 14 entities:

| Type | Entity | Target subgroup |
|---|---|---|
| project ×2 | `icu-mortality-prediction`, `icu-activity-dashboard` | `projects/` |
| mappingProject | `mimic-iv-to-omop` | `mapping-projects/` |
| etlPipeline | `mimic-iv-to-omop` | `etl-pipelines/` |
| dqRuleSet | `mimic-iv-demo` | `dq-rule-sets/` |
| catalog | `mimic-iv-demo` | `data-catalogs/` |
| database ×4 | MIMIC-IV Demo (OMOP) 12 MB · MIMIC-IV Demo 18 MB · OMOP Vocabulary · OMOP ETL Pipeline Example (in-memory) | `databases/` — **needs the new `database` catalog type + LFS** |
| conceptMapping | `mimic-iv-concept-mappings.json` (356 KB) + `mimic-iv-custom-mappings.json` (572 KB) | travels with the mapping project |
| etlScript | `mimic-iv-etl-scripts.json` (96 KB) | travels with the ETL pipeline |
| dataset | `icu-activity-dataset.json` (1.8 MB) | travels with its project |
| dashboard | `activity-dashboard` | travels with its project |
| workspace | `default` (+ `Demo Hospital` organization) | 🔜 needs the new `workspace` catalog type — decision 6 |
| — | `demo-scripts/` (88 KB), `demo-scripts-activity/` (36 KB) | travel with their projects |
| — | `omop-vocabulary/` (504 KB) | `databases/` or with the vocabulary DB |

### C. Stays in this repo

Built-in **plugins** (`lib/plugins/default-plugins.ts`) — code, not content, and part of
the app's own surface. Revisit only if the
[harmonize-plugin-model](../../CLAUDE.md) work makes file-based warehouse plugins real.

### The repos to create

Group: `linkr-public-content/<subgroup>/<repo>`. Subgroups `database-schemas`,
`etl-pipelines`, `projects`, `mapping-projects` **exist**; `data-catalogs`, `dq-rule-sets`
and `databases` must be **created** (checked 2026-08-21).

| # | Subgroup / repo | Source today | Status |
|---|---|---|---|
| 1–4 | `database-schemas/{omop-cdm-5.4, omop-cdm-5.3, mimic-iv, mimic-iii}` | `lib/schema-presets.ts` + `lib/schema-ddl/` | ✅ pushed |
| 5 | `projects/icu-mortality-prediction` | `seed/default/projects/…` + `demo-scripts/` (5 scripts) | ✅ pushed |
| 6 | `projects/icu-activity-dashboard` | same + dashboard + `demo-scripts-activity/` + the ICU dataset (1 810 rows × 55 cols, 646 KB CSV) | ✅ pushed |
| 7 | `mapping-projects/mimic-iv-demo` | `seed/default/mapping-projects/` + `mimic-iv-concept-mappings.json` (1 786 rows) | ✅ pushed |
| 8 | `etl-pipelines/mimic-iv-demo-to-omop` | `seed/default/etl/` + `mimic-iv-etl-scripts.json` (18 scripts) | ✅ pushed |
| 9 | `dq-rule-sets/mimic-iv-demo` | `seed/default/data-quality/` | ⏸ deferred — DQ rework pending |
| 10 | `data-catalogs/mimic-iv-demo` | `seed/default/catalogs/` | ⏸ deferred — catalog rework pending |
| 11 | `databases/mimic-iv-demo-omop` | 31 parquet, 12 MB | 🔜 blocked on the `database` catalog type + LFS |
| 12 | `databases/mimic-iv-demo` | 32 parquet, 18 MB | 🔜 same |
| 13 | `databases/omop-vocabulary` | 10 parquet, 504 KB | 🔜 same |

Repos 7 and 8 are named `mimic-iv-demo…`, not `mimic-iv…`: private equivalents exist for
**full** MIMIC-IV with slightly different item coverage, and the two must not collide.

Naming convention: entity names are **proper nouns** — `ICU Mortality Prediction`,
`MIMIC-IV Demo` (capitalised in `name` fields and titles); lower-case only when the word
turns descriptive mid-sentence ("built from MIMIC-IV demo data").

**Still hard-coded, found 2026-08-21**: the projects' IDE scripts live in
[file-store.ts](../../apps/web/src/stores/file-store.ts) (~400 lines of inline stubs,
`createDefaultFiles` / `createActivityDashboardFiles`, hydrated at seed time from
`public/data/demo-scripts{,-activity}/`, with a `DEMO_FILES_VERSION` + rename-map
migration). That is a **third** source of default data beyond the manifest and the
schema presets, and it goes away with the same change as decision 10.

Not a repo: the **`OMOP ETL Pipeline Example`** database (`inMemory: true`, no Parquet) —
it is an empty target the ETL populates. It stays a manifest/setup declaration. Likewise
the `Demo Hospital` **organization**, which travels as a provenance snapshot inside the
workspace export, never as its own entity (decision 6). The `default` **workspace** DOES
become a repo, now that it has a catalog type — it is the entry that pulls the rest in.

Repos 11–13 are blocked on the new **`database` catalog type** (§2 gap 1) — nothing reads
them until that exists. Repos 1–10 work with today's code.

> 🐛 **Export bug: a widget's `datasetFileId` is written as a local UUID.**
> Found 2026-08-21 by diffing a hand-built repo against a real round-trip export.
> `datasets/_tree.json` declares the dataset under its portable id
> (`icu_activity.csv`), but `dashboards/*.json` writes `datasetFileId` as the
> instance's UUID (`dc114ff5-…`). On import both go through `mapId`, which hashes
> them against the target `projectUid` — two different inputs, two different ids —
> so `resolveDatasetId` finds nothing and **every widget is orphaned**: the dashboard
> imports with all its widgets and no data to plot. The repo keeps the portable form
> by hand; the exporter should emit it too (resolve the UUID back to the dataset's
> tree id when writing, the way tabs/widgets already resolve to content keys).

### Three things to settle before filling 5–10

1. **Datasets are gitignored by default.** `buildProjectZip` writes a `.gitignore` covering
   `**/*.csv|parquet|pq|xlsx|xls` "so health data is never committed by accident"
   ([entity-io.ts:1184](../../apps/web/src/lib/entity-io.ts#L1184)); a data file ships only
   if its export path is in `project.config.versionedDataFiles`. Both seed projects have
   `config: {}`, so **`icu-activity-dataset` would not travel** — it must be marked for
   versioning before export. This is the single most likely way to publish a project repo
   that imports into an empty dashboard.
2. **Databases do not travel with a project.** `linkedDataSourceIds` is an instance field,
   stripped on export ([entity-io.ts:806](../../apps/web/src/lib/entity-io.ts#L806)), so an
   imported project arrives **unlinked** and the user re-links by hand. Deliberate. But the
   seed today wires `linkToProject`, `vocabularyDataSourceId` and `mappingProjectId` by
   fixed uid (`0000…0001`, `0000…0005`) — **the manifest, not the repos, must keep carrying
   those links**, or the demo lands as disconnected pieces.
3. **Fixed uids are load-bearing.** Keep `uid`/`presetId` exactly as they are in each repo;
   changing one silently breaks the cross-links above.

### Suggested migration order

Schemas ✅ → dq-rule-set + catalog (one JSON each, quickest win) → mapping project + ETL
(medium, exercise `_tree.json`) → projects (exercise datasets/dashboards/scripts, and the
versioning-mark trap) → **databases last** (new catalog type, LFS, API-image fix).

---

## 4. Server mode: first run

Two things are true today and both need addressing:

1. There is **no backend seeding at all** — the browser does it, per-browser, gated on
   `localStorage`. In a multi-user server instance that is already wrong: a second user
   with an empty `localStorage` can re-trigger a seed that writes through the API.
2. The Settings → General "Application database" picker
   ([GeneralTab.tsx:228](../../apps/web/src/features/settings/GeneralTab.tsx#L228))
   writes only to `localStorage` — it does not reconfigure anything. **It is not the
   right place to put the default-data choice.** The database is server config
   (`LINKR_DATABASE_URL`, [config.py:119](../../apps/api/app/config.py#L119)).

The right place is the **setup wizard** ([SetupWizard.tsx](../../apps/web/src/features/setup/SetupWizard.tsx)),
which already runs exactly once, gated server-side on "zero users"
([setup.py:20](../../apps/api/app/api/v1/routes/setup.py#L20)). Add a second step after
the admin account:

```
Step 1  Create the administrator account          (exists)
Step 2  Default data
        ○ Start empty
        ● Install default data
          ☑ Demo workspace (ICU)              120 KB
          ☑ MIMIC-IV demo OMOP database        12 MB
          ☐ MIMIC-IV demo (source)             18 MB
          ☐ OMOP vocabulary                   504 KB
```

Backend work:

- `GET /api/v1/setup/default-data` → the `defaultInstall` entries, resolved server-side
  from the configured catalog (so a deployment can point at an internal mirror via env,
  without a rebuild);
- `POST /api/v1/setup/initialize` gains `defaultData: string[]`;
- installation runs as a **background job** with progress (cloning 30 MB is not a request
  — reuse the existing job infrastructure from the IDE work), writing entities through
  the normal server-side import path;
- persist an `instance_settings` row (`default_data_installed`, the registry refs
  installed). This is the shared baseline that `localStorage` cannot provide.

Frontend work:

- the browser-side seed must be **disabled in server mode**. Today it is not
  ([app-store.ts:263](../../apps/web/src/stores/app-store.ts#L263) has no `isServerMode`
  guard) and that is the source of the per-browser reseed. Gate it, and let the server
  own the baseline.
- likewise move the seed-update baseline (`seed-hashes`) server-side for server mode, or
  suppress the "Default data has been updated" dialog there — a per-browser dialog
  proposing to rewrite shared instance data is wrong.

**Decision needed** 🤔: is the default data installed **once, at setup**, or is it
**upgradable** later (registry ref bumps → an admin-only "update default data" screen)?
Recommendation: install-once at setup, plus the on-demand import tab for everything
else. Upgrading shared, possibly-edited instance data is the versioning problem all over
again and should not be smuggled into this plan.

---

## 5. The import dialog's third tab

**Server-mode half shipped 2026-08-23** (commit `005c249e`). "From the catalog" is a third
tab of [ImportSourceDialog](../../apps/web/src/components/ui/import-source-dialog.tsx),
implemented as [import-catalog-tab.tsx](../../apps/web/src/components/ui/import-catalog-tab.tsx)
on the existing catalog modules — `useCatalog`, `findInstalled`, `useCatalogInstall`,
`CatalogInstallOutcome` — so there is still one install implementation. Which type it lists
comes from the page's `GitScope` via
[catalog/scope.ts](../../apps/web/src/lib/catalog/scope.ts); scopes the catalog does not
publish (workspaces, settings, user-plugins) keep the two-tab dialog. Wired on Projects,
Schemas and the four `ListPageTemplate` pages.

**Still open**: the client-only half (below) — the tab currently shows the server-mode
notice in WASM builds, since it depends on the build-time fetch (§3) that does not exist
yet. The `bundled || defaultInstall` filter is likewise not implemented: the tab lists every
catalog entry of its type, which is the correct behaviour in server mode and will need the
filter only once bundled entries exist.

Original design, for the remaining half:

- entries come from `getCatalogSource()` + the cached `CatalogEntry[]`, filtered to
  `bundled || defaultInstall` and to the `type` matching the calling context (a project
  import dialog shows only projects);
- the card shows name, description, size, license, version, repo link —
  [entry-meta.ts](../../apps/web/src/lib/catalog/entry-meta.ts) already renders that
  vocabulary, and [installed.ts](../../apps/web/src/lib/catalog/installed.ts) already
  answers "installed / update available";
- **server mode**: "Install" → `prepareCatalogInstall` → conflict prompt →
  `commitCatalogInstall`. That is [CatalogInstallDialog](../../apps/web/src/features/catalog/CatalogInstallDialog.tsx)'s
  exact flow, including the lineage/id-collision safety and the git-sync anchoring, so the
  entity lands git-linked to its upstream and gets pull-updates for free;
- **client-only**: only `bundled` entries are installable, read from `public/data/` with
  no git link. Everything else is listed disabled with the `ServerModeNotice` treatment
  the Git tab already gets — `prepareCatalogInstall` returns `server-mode-required`, so
  the honest message is already the code's own behaviour.

The factoring that follows: extract the card + install flow out of `CatalogInstallDialog`
into a shared component the catalog page and this tab both render, rather than a second
copy of the same dialog. Follow `docs/ui-patterns.md` §6 (extend, don't fork); all
strings through `t()` into both locale files.

---

## 6. MIMIC-IV demo — legality

### Is what we do today legal?

**Yes.** Checked against the source today:

- [physionet.org/content/mimic-iv-demo-omop/0.9/](https://physionet.org/content/mimic-iv-demo-omop/0.9/)
  is **Open Access** — "anyone can access the files, as long as they conform to the terms
  of the specified license". No credentialed access, no DUA, no PhysioNet training
  requirement. (This is the crucial distinction from full MIMIC-IV, which *is*
  credentialed under PhysioNet Credentialed Health Data Use Agreement and could **not**
  be redistributed.)
- License: **ODbL 1.0**. It permits sharing, modification and redistribution, including
  commercially, under attribution + share-alike + keep-notices-intact.
- Our [LICENCE-data](../../LICENCE-data) already does the required work: names the
  source and download date, states ODbL 1.0 with its URI, discloses the modifications
  (person/visit id renumbering), carries the citations, and enumerates the terminology
  licenses (CMS, RxNorm, UCUM, LOINC, SNOMED GPS, OHDSI/Apache-2.0). That is a
  conformant ODbL notice.

One point worth being precise about: renumbering ids and converting CSV→Parquet makes
our copy a **Derivative Database** under ODbL §1.0, not merely a Produced Work. So the
share-alike obligation applies to the data — the derivative must be offered under ODbL
1.0 (or a compatible license). It does **not** infect Linkr's own code license: the app
is a separate work, and ODbL's copyleft reaches the database, not software that reads it.

### Moving it to a public git repo in Parquet

Also fine, and arguably cleaner than today, because the notices become impossible to
separate from the data. Requirements, all mechanical:

1. **One repo per database**: `db-mimic-iv-demo-omop`, `db-mimic-iv-demo`.
2. At the repo root, non-negotiable:
   - `LICENSE` — the **full ODbL 1.0 text** (a URI is permitted, but shipping the text is
     safer and costs 30 KB);
   - `NOTICE.md` — today's `LICENCE-data` content: origin URL, download date, ODbL
     statement, **the list of modifications** (renumbered ids, CSV→Parquet conversion),
     citations, terminology licenses with their required attribution strings (UCUM's
     Regenstrief copyright line, NLM's RxNorm disclaimer, the LOINC citation, the SNOMED
     GPS CC BY 4.0 attribution);
   - `README.md` — what it is, provenance, how Linkr consumes it;
   - `PROVENANCE.md` or a `provenance.json` — source URL, version (0.9), DOI
     (`10.13026/p1f5-7x35`), sha256 of the upstream ZIP, the conversion script/commit.
     ODbL only requires "all of the alterations made"; a reproducible conversion script
     is the strongest form of that.
3. **Keep `LICENCE-data` in this repo too**, trimmed to point at the data repos. Users
   land here first; the notice must be findable from here.
4. Repos must be **public and free to fetch** — ODbL requires the derivative (or the
   alterations) be available at no charge over the internet. Public GitLab satisfies it.
5. **Do not** relicense, and do not slap the app's license on the data repos. The data
   repos are ODbL; Linkr's code is not.

### Format and storage

- **Parquet, not CSV.** It is what the app consumes, it is 3–5× smaller, and format
  conversion is an explicitly-disclosed alteration. Nothing in ODbL prefers a format.
- **Git LFS for the Parquet files** (decided 2026-08-21). 30 MB of binaries in plain git
  history is workable but bad — every re-export rewrites whole objects. LFS keeps clones
  cheap and matches what the versioning work already supports. Practical consequences to
  honour:
  - `.gitattributes` in each data repo: `*.parquet filter=lfs diff=lfs merge=lfs -text`;
  - CI needs `git-lfs` installed and `git lfs install` before the fetch — the current
    `node:22-alpine` image has neither (`apk add git git-lfs`);
  - the **server-side clone must pull LFS too**: `clone_to_zip()`
    ([git_service.py:1443](../../apps/api/app/services/git_service.py#L1443)) runs
    `git clone --depth 1`, which fetches LFS pointers only unless git-lfs is present in
    the API image. Without it, a database installs as a folder of ~130-byte text files
    and fails at read time with no obvious cause. **Add git-lfs to the API Docker image
    and cover it with a test** — this is the most likely silent failure in the whole plan;
  - watch the GitLab group LFS quota; if it becomes a problem, a tarball attached to a
    release tag is a drop-in alternative with the same pinning guarantee.
- Regenerate Parquet with a committed script (`scripts/convert.py`) so the derivative is
  reproducible from the upstream ZIP. Store its sha256.

**Do not** put the credentialed full MIMIC-IV anywhere near this. Only
`mimic-iv-demo-omop` (and the equally-open `mimic-iv-demo` — verify it is the
*demo* release, ODbL, before moving it: it should be
[physionet.org/content/mimic-iv-demo/](https://physionet.org/content/mimic-iv-demo/),
also Open Access ODbL, but confirm the exact version and re-state it in `NOTICE.md`).

🤔 **Verify before executing**: the source-format `mimic-iv-demo/` (18 MB) — confirm its
PhysioNet page, version, and license line, and record them the same way.

---

## 7. Registry hosting — settled by reusing the catalog

The question "TS module or served JSON?" is moot now the registry *is* the catalog: it is
already served JSON (`catalog.json` + `catalog-index.json` in the `linkr-catalog` repo),
already fetched CORS-safely in WASM mode, already cached and hash-diffed, and already
retargetable per deployment via [settings.ts](../../apps/web/src/lib/catalog/settings.ts)
(Settings → Catalog tab). A hospital behind a proxy points at an internal mirror with no
rebuild — the capability we wanted, already shipped.

Two additions:

- server mode should be able to fix the catalog URL by env (`LINKR_CATALOG_URL`) so an
  admin sets it once for the instance rather than per browser;
- CI reads the same `catalog.json` (from a checkout or the API route) to drive
  `fetch-default-data.mjs`. One source of truth for browser, server, and build.

**Consequence, and it is the real prerequisite**: the `linkr-catalog` repo does not exist
yet ([catalog-plan.md](catalog-plan.md) lists it as 🔜, the app side being done). It is
now on this plan's critical path — nothing here works until it exists.

---

## 8. Convergence with linkr-portal

The portal's `build.sh` already does 80 % of `fetch-default-data.mjs`: overlay entity
trees into the seed dir, generate `seed.json` and per-workspace `manifest.json` with the
`_tree.json`-path-keyed index the loader needs (≥ export format 2.3.0).

**Do not write that logic twice.** Two of them will drift, and the drift will be a silent
"seeded with no content" bug — exactly the one the portal script's comments record having
already been fixed once. Move the generation into this repo as a Node module
(`scripts/lib/seed-manifest.mjs`), used by `fetch-default-data.mjs`, and have the portal's
`build.sh` call it from the submodule. That also finally puts it under test.

---

## 9. Impact checklist

| Area | Change |
|---|---|
| `.gitlab-ci.yml` | git + git-lfs in the image, fetch step, clone cache |
| **API Docker image** | **install git-lfs** — else server-side clones install LFS pointers, not data (§6) |
| `scripts/fetch-default-data.mjs` | new — clone, overlay, generate |
| `scripts/lib/seed-manifest.mjs` | new — extracted from portal `build.sh`, unit-tested |
| `linkr-catalog` repo | must exist first — now on the critical path (§7) |
| `lib/catalog/types.ts` | add `bundled`, `defaultInstall`, `git.ref`, `sizeBytes`; add the `database` type |
| `lib/catalog/install.ts` | `META_FILE` + `createShell` + `applyClonedEntity` branches for `database` |
| `CatalogInstallDialog` | extract the card + install flow into a shared component (catalog page + import tab) |
| `.gitignore` | `apps/web/public/data/` (except the minimal fallback) |
| Git history | the 33 MB of data stays in history unless rewritten — see below |
| `seed-loader.ts` | unchanged for client-only; server-mode seed path removed (§4) |
| `app-store.ts:263` | gate `seedWorkspaces()` on `!isServerMode()` |
| Setup wizard + `setup.py` | default-data step, `GET /setup/default-data`, background install job |
| `instance_settings` | new — shared baseline replacing per-browser `localStorage` |
| `ImportSourceDialog` | ✅ third tab + i18n (en + fr) — server mode; client-only half waits on §3 |
| `LICENCE-data` | trimmed to a pointer; full notices move into each data repo |
| `update-default-data` skill | rewrite: the workflow becomes "edit the data repo, tag, bump the registry ref" |
| `linkr-portal` | `build.sh` calls the shared manifest generator |
| Tests | `seed-manifest.mjs` (pure, critical) + registry validation get unit tests per `docs/conventions.md` |

**History rewrite** 🤔: deleting the data files leaves 33 MB in git history — clones keep
paying for it. A `git filter-repo` purge would reclaim it but rewrites every hash and
breaks every existing clone, the portal submodule pin included. Recommendation: **don't**
rewrite. Take the one-time 45 MB and let future history be lean; revisit only if the pack
becomes a real problem.

---

## 10. Suggested order

| # | Step | Effort | Notes |
|---|---|---|---|
| 0 | **Create the `linkr-catalog` repo** (entries/ + schema + build.mjs + CI) | S | already 🔜 in catalog-plan; now blocks everything here |
| 1 | Verify `mimic-iv-demo` (source format) license page, record version + DOI | S | blocks step 2 |
| 2 | Create the data repos: ODbL text, `NOTICE.md`, `PROVENANCE.md`, conversion script, Parquet via LFS, `.gitattributes`; tag `v1` | M | legal work is here, do it once, properly |
| 3 | git-lfs in the API image + a test that a cloned Parquet is real data, not a pointer | S | cheap, and it prevents the plan's nastiest silent failure |
| 4 | Catalog schema additions: `database` type, `git.ref`, `bundled`, `defaultInstall`, `sizeBytes` | M | the `database` install branch is the real work |
| 5 | Extract `seed-manifest.mjs` from the portal script + unit tests | M | de-risks everything downstream |
| 6 | `fetch-default-data.mjs` + CI wiring + cache; verify the client-only build behaves exactly as today | M | the real proof: build, reset all data, same app |
| 7 | Point the portal's `build.sh` at the shared generator | S | |
| 8 | Import dialog third tab, on the shared catalog card/install component | M | ✅ server mode (2026-08-23); client-only half rides on step 6 |
| 9 | Server mode: gate the browser seed, `instance_settings`, setup wizard step, install job | L | biggest chunk; also fixes the per-browser reseed bug |
| 10 | Rewrite the `update-default-data` skill | S | otherwise the next contributor edits the wrong repo |

Steps 0–7 are self-contained and ship value alone (smaller repo, decoupled data releases,
a working catalog). Step 9 is where the shared-instance correctness fix lives and can be
planned separately.

---

## 11. Decisions

All settled as of 2026-08-21. Decision 10 carries the largest code change and an
ordering constraint — read it before starting.

1. **One repo per entity** — matches the catalog and the existing git-link model.
2. **Git LFS** for the Parquet — with the API-image consequence in §6/step 3.
3. **Reuse the catalog** as the registry and the install path (§2, §5, §7); extract the
   shared card/install component rather than forking `CatalogInstallDialog`.
4. **Repo naming**: plain names under a typed subgroup
   (`linkr-public-content/database-schemas/omop-cdm-5.4`). The group path already carries
   the "LinkR" prefix the trademark analysis wanted, so no per-repo prefix is needed —
   the disclaimer in each README does the rest.
5. **Licensing** (researched 2026-08-21, primary sources): OMOP CDM DDL is **Apache-2.0**
   (upstream ships no `LICENSE` file — removed 2023-09 for CRAN packaging, not a license
   change — so we provide the text ourselves); MIMIC schema is **MIT**, and only the
   *data* on PhysioNet is credentialed. Derive from OHDSI's **DDL** (Apache-2.0), never
   from its narrative docs (CC BY-SA 4.0, copyleft).

6. **A `workspace` catalog type — reversed 2026-08-27.**

   ~~No `workspace` catalog type (decided 2026-08-21). A workspace is the container a
   user installs *into*, not a thing to browse and download — nobody wants to install
   "someone else's workspace".~~

   The demo/default content is one curated workspace ("Demo workspace") holding every
   default entity. Publishing it as a single catalog entry that pulls its children
   through their git links is simpler than listing a dozen entries the user must install
   one by one and then wire together — and it is the same import the ZIP and git paths
   already run. The premise of the original decision was wrong: a *curated* workspace is
   exactly a thing worth browsing and downloading.

   What the reversal keeps from it:
   - The **seed still exists and is still a build concern**. Catalog install is
     server-mode-only (`prepareCatalogInstall` → `server-mode-required`), so a WASM build
     cannot clone at runtime; `fetch-default-data.mjs` + `public/data/seed/` remain the
     client-only path. The catalog entry is an *addition*, not a replacement.
   - The **manifest keeps carrying the cross-entity links** (`linkToProject`,
     `vocabularyDataSourceId`, `mappingProjectId` — see §3bis): the repos do not.

   Shape of the type (settled 2026-08-27):
   - **No target-workspace selector** for this type — a workspace has no parent. Install
     creates one at instance level.
   - **No overwrite.** Reinstalling offers "keep both" only: overwriting a workspace would
     delete every project, database and mapping inside it, which is a different order of
     destruction from replacing one entity.
   - **No nesting.** `collectGitLinkedEntities` never emits `workspace`, so a workspace
     cannot git-link another one and the clone loop cannot recurse.

   Still excluded, and the 2026-08-21 reasoning stands: **users, organizations and
   roles** are instance data, not shareable content — a user or a role means nothing
   outside its instance, and publishing them would raise personal-data questions. Note a
   workspace export *does* carry an organization snapshot, but as immutable provenance
   (`organization.json`), not as a catalog-installable entity.

7. **Server default-data: install-once** (decided 2026-08-21). The setup wizard clones at
   the pinned refs and records what it installed; that is the end of it. Upgrading later
   goes **through the catalog** — that is precisely its job, and it already carries
   installed-state, version badges and an update flow
   ([installed.ts](../../apps/web/src/lib/catalog/installed.ts)). No separate
   "update default data" screen.

8. **Build profiles: `demo` by default, `lean` for portals** (decided 2026-08-21).
   `demo` bundles everything (today's 33 MB — visitors get real data with zero setup);
   `lean` bundles **nothing**, not even MIMIC, because a portal starts from an empty
   instance and brings its own content. One env var (`LINKR_BUILD_PROFILE`) read by
   `fetch-default-data.mjs`. Note this makes `lean` a genuinely empty app, so the
   fetch-failure rule from §3 matters: a `demo` build that fetched nothing must fail
   rather than silently look like a `lean` one.

9. **History rewrite: probably yes, later** (2026-08-21). Deleting the files does not
   shrink the repo — the blobs stay in history (45 MB `size-pack`); only `git filter-repo`
   reclaims them, and it rewrites every commit hash, so every clone must be re-made and
   each portal submodule pin re-pointed. Only two portals exist today, both the same
   owner's, so the blast radius is small. **Do not act on this yet**: assess the real risk
   first (open branches, the portal pins, any published tag) and treat it as a separate,
   deliberate operation once the data has actually left the repo.

### 10. Retire the auto-seeded schema presets — **decided 2026-08-21**

Schema presets stop being an exception: they arrive like every other entity, through a
ZIP import, a git import, or the catalog. **No preset is created automatically any more.**

The two places that auto-create them go away:

| Where | What it does today |
|---|---|
| [workspace-store.ts:126](../../apps/web/src/stores/workspace-store.ts#L126) | seeds the 4 presets into **every new workspace** |
| [seed-loader.ts:492](../../apps/web/src/lib/seed-loader.ts#L492) | seeds the 4 presets into **every seeded workspace** |

The other `SCHEMA_PRESETS` usages are a different thing and are **not** covered by this
decision — resolve them one by one when doing the work:

- `SchemaPresetsPage` — `isBuiltin` (locks editing) and the *create from template*
  dropdown. Once presets are ordinary entities nothing is "built-in": drop `isBuiltin`,
  and the template dropdown should offer the workspace's **installed** presets instead of
  a hard-coded list. That is what keeps the create-from-a-model flow alive without a
  bundled copy.
- `seed-loader.ts:868/935`, `AddDatabaseDialog.tsx:452`, `Header.tsx:292` — these resolve
  a preset **id to a mapping** (a seeded database declares `"schema": "omop-5.4"`). They
  must resolve against the workspace's stored presets, not a compiled-in map. Worth
  checking early: it decides whether a seeded database can even be attached before its
  schema repo is installed.
- `idb-storage.ts:399` — a migration fallback. Leave it or inline the mapping it needs.

**Ordering constraint**: this lands *with* the build-time fetch (§3), never before. Until
the seed carries the presets, removing the auto-seed leaves a fresh install with no schema
at all. The rule from §3 applies — a build that fetched nothing must fail, not ship empty.

**Migration for existing users**: match on `templateId` (already in each `preset.json`) so
an installed repo **updates** the preset a user already has rather than adding a second
one. Without it, everyone's first update produces the duplicate this decision removes.

> **5.3 DDL bug — status after removing the built-in presets (2026-08-23).** The bug is
> no longer reachable from the UI: the Schemas page no longer offers built-in presets, and
> the only remaining preset dropdown (`AddDatabaseDialog`) lists `customPresets` alone. A
> user can no longer pick `omop-5.3` and get 5.4 tables, because they can no longer pick it.
>
> What survives is dead-ish code, not a live defect: `lib/schema-presets.ts` still exports
> `SCHEMA_PRESETS` / `BUILTIN_PRESET_IDS` / `getSchemaPreset`, with `omop53` still spreading
> `omop54` (hence still carrying `OMOP_54_DDL`). Two callers remain — `getSchemaPreset()` in
> `AddDatabaseDialog` (resolves a *stored* `schemaPresetId`, so it still hydrates the wrong
> DDL for a database saved as `omop-5.3` **before** this change) and `SCHEMA_PRESETS[…]` in
> `Header.tsx` (breadcrumb label only, harmless).
>
> So: **delete the module rather than fix the DDL.** Fixing `omop53`'s DDL now would only
> make a more correct copy of something the catalog already publishes properly. The cleanup
> is (a) drop `schema-presets.ts` + the three `schema-ddl/*.ts` blobs, (b) give `Header.tsx`
> its label from the stored preset, (c) decide what `AddDatabaseDialog` does with a legacy
> stored `omop-5.3` id — simplest is to treat an unresolvable preset as "none" and let the
> user re-pick an installed one. Left out of the built-in removal on purpose: it touches the
> databases path, which is the next chunk anyway.

### 11. Databases: import data, never export it — **decided 2026-08-25**

ZIP, git and catalog **import** may carry a database's Parquet data; the **export** keeps
writing metadata only. Design in § *The `database` type* above.

This asymmetry is deliberate and load-bearing, so state the reasoning wherever someone
might "fix" it:

- The export guard protects data **leaving** a hospital. An import runs the other way.
- Because the export writes no rows, a user cannot accidentally build a database repo
  containing real patient data — the Parquet must be placed there by hand, outside the
  app. Making the export symmetric would destroy exactly that guarantee.
- The MCP may author a database with data: it runs outside the sensitive context, which
  is the entire reason it can do what the app refuses. The skill must restrict this to
  **synthetic or public open data**, never a connected database.

Confirmed while designing: LFS already resolves server-side in `clone_to_zip`, and
catalog install is server-mode-only, so there is no browser clone to teach about LFS.
