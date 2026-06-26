---
name: update-default-data
description: Add or update Linkr's bundled "default data" — the seed under apps/web/public/data/seed/ that's pre-loaded into every fresh install (workspaces, projects, datasets, dashboards, databases, ETL pipelines, concept mappings, DQ rule sets, catalogs). Use when the user wants to change the demo/default content, add a seeded project or dataset, bump the bundled MIMIC data, or test the "Default data has been updated" re-seed flow. Covers the unified per-workspace manifest, the id/uid linkage rules, and how to make the user test add/update/remove end to end.
argument-hint: [what to add/update, e.g. "a dataset to icu-activity-dashboard"]
---

# Update Linkr's default (seed) data

The seed lives in `apps/web/public/data/seed/` and is **hand-edited** (no generator).
On a fresh install it's loaded into IndexedDB. On later visits, a change-detection
dialog ("Default data has been updated") offers the user to re-import changed entities
(and, for entities removed from the seed, to delete their local copy).

Read this whole file before editing — the id linkage rules are easy to get wrong and
fail silently (dialog never fires, or a re-seeded project comes back empty).

## One manifest per workspace (schemaVersion 2)

There is a **single registry per workspace**: `<folder>/manifest.json`. It lists every
first-class entity in one flat, homogeneous array. The seed loader, the change-detection
hash plugin and the targeted re-seed all iterate this same list, so they can't drift.

```jsonc
// <folder>/manifest.json
{
  "schemaVersion": 2,
  "organization": { ... },          // optional
  "entities": [
    { "type": "project",        "id": "<projectUid-or-folder>", "folder": "<folder>", "full": true? },
    { "type": "mappingProject", "id": "<mappingProjectId>",     "folder": "<folder>" },
    { "type": "dqRuleSet",      "id": "<id>",  "path": "data-quality/<x>.json" },
    { "type": "catalog",        "id": "<id>",  "path": "catalogs/<x>.json" },
    { "type": "database",       "id": "<id>",  "alias": "...", "schema": "...", "parquetBase": "...", "tables": [...], "linkToProject": "<projectUid>"? , "inMemory": true? },
    { "type": "conceptMapping", "id": "<mappingProjectId>", "file": "/data/<x>.json" },
    { "type": "etlScript",      "id": "<pipelineId>", "file": "/data/<x>.json", "customMappingsFile": "...", "mappingProjectId": "...", "vocabularyDataSourceId": "..." },
    { "type": "dataset",        "id": "<datasetFileId>", "file": "/data/<x>.json", "projectUid": "<projectUid>", "fileName": "x.csv" },
    { "type": "dashboard",      "id": "<dashboardId>", "file": "<folder>/dashboards/<x>.json", "projectUid": "<projectUid>" }
  ],
  "internals": { ... }              // optional — see below; the `default` seed omits it
}
```

The root `seed.json` is just the list of workspace folders:
```json
{ "schemaVersion": 2, "workspaces": ["default"] }
```

**Two load phases (don't fight them).** Entities load in a fixed order because of real
dependencies:
- **Phase 1 (structure):** `project`, `mappingProject`, `dqRuleSet`, `catalog` — plus the
  workspace `internals`. Loaded by `seedWorkspaces()`.
- **Phase 2 (data):** `database` → `conceptMapping` → `etlScript` → `dataset` → `dashboard`,
  in that order. Loaded by `seedDatabases()`. (A db's `linkToProject` needs the project row;
  the ETL vocab script is generated from already-seeded mappings + the mounted vocab DB.)

Every entity gets one uniform guard flag `linkr-seed-<type>-<id>` and one content hash.

## `internals` (rarely needed for the `default` seed)

Bootstrap content that is NOT a re-seedable entity — `schemas`, `databases` (metadata-only
JSON), `wikiPages`, `sqlCollections`/`sqlScriptFiles`, `etlPipelines`/`etlFiles`,
`conceptSets`, `serviceMappings`, `pluginFolders`/`pluginFiles`. Same shape as the old
`_index.json` minus the first-class types. The `default` (MIMIC-IV demo) seed uses **none**
of these, so its manifest has no `internals`. The portal's `build.sh` populates it from a
real workspace export.

## Layout

```
apps/web/public/data/seed/
  seed.json                      # { schemaVersion, workspaces: [folders] }
  seed-hashes.json               # GENERATED (gitignored) — change-detection baseline
  <folder>/                      # one per workspace, e.g. "default"
    workspace.json               # { id, name:{en,fr}, description, organizationId, ... }
    manifest.json                # the unified registry (entities[] + optional internals)
    projects/<projectId>/        # project.json (+ README.md); full project also has scripts/ dashboards/ datasets/ …
    mapping-projects/<id>/       # _project.json (+ mappings.json, source-concepts.csv)
    etl/<id>/                    # _pipeline.json, _tree.json, script files  (an internals entry)
    dashboards/<name>.json       # { dashboard, tabs, widgets } (referenced by a dashboard entity's `file`)
    data-quality/<name>.json     # { ruleSet, checks }
    catalogs/<name>.json         # DataCatalog object
  <dataset>.json                 # { columns, rows } for a dataset entity (referenced by its `file`)
  <parquetBase>/<table>.parquet  # database tables
```

Reference example to copy from: the `default` workspace (MIMIC-IV demo) —
workspace id `00000000-0000-0000-0000-000000000010`.

## Linkage rules (get these wrong → entity silently not loaded)

- dataset/dashboard → project: the entity's `projectUid` = the project's `uid`.
  (This is also how a project re-seed finds its children to re-import — see Gotchas.)
- database → project (optional): `linkToProject` = project `uid`.
- conceptMapping → mapping project: the entity's `id` = the mapping project's `id`.
- etlScript → pipeline: the entity's `id` = the pipeline `id`.
- every entity's `workspaceId` is set by the loader = the workspace `id`;
  workspace `organizationId` = the org `id`.
- **`id` is the identity for the flag and the hash.** Pick a stable id (a uid, a folder name,
  or a slug) — changing an entity's `id` reads as "old removed + new added", not "modified".

## How to add/update each type

| Type | manifest entry | Files to create/edit |
|---|---|---|
| Project (full) | `{type:'project', id, folder, full?}` | `projects/<folder>/project.json` (+ `scripts/_tree.json`, `dashboards/`, `datasets/`, …) |
| Dataset | `{type:'dataset', id, file, projectUid, fileName}` | `<dataset>.json` = `{columns, rows}` |
| Dashboard | `{type:'dashboard', id, file, projectUid}` | `<folder>/dashboards/<name>.json` = `{dashboard,tabs,widgets}` |
| Database | `{type:'database', id, alias, schema, parquetBase, tables, …}` | `<parquetBase>/<table>.parquet` |
| ETL pipeline | `{type:'etlScript', id, file, …}` + an `internals.etlPipelines` entry | `etl/<id>/_pipeline.json` + `_tree.json` + scripts; `<etl-scripts>.json` |
| Concept mapping | `{type:'conceptMapping', id, file}` + `{type:'mappingProject', id, folder}` | `mapping-projects/<id>/_project.json` (+ `mappings.json`); `<mappings>.json` |
| DQ rule set | `{type:'dqRuleSet', id, path}` | `data-quality/<name>.json` = `{ruleSet,checks}` |
| Catalog | `{type:'catalog', id, path}` | `catalogs/<name>.json` |
| Workspace | add the folder to `seed.json` + create `<folder>/manifest.json` + `workspace.json` | — |

To **update** an existing entity, just edit its file(s) (or its manifest entry). The change
is detected by a content hash, so any real content change is enough.

To **remove** an entity, delete its entry from `manifest.json` (and optionally its files).
On the next visit the dialog shows it as *Removed*; the user can delete its local copy
(only entities created by the seed — `origin: 'seed'` — are deletable; user content is never
touched).

## Change detection (no restart needed)

`apps/web/vite-plugin-seed-hashes.ts` regenerates `seed-hashes.json` at build start **and on
HMR** — editing any file under `public/data/seed/` (or a referenced `public/data/*.json`)
regenerates it live, so you no longer need to restart the dev server. `seed-hashes.json` is
gitignored — never commit it.

What gets hashed per entity (so you know an edit is detectable):
- project = sha256(project.json + README.md); workspace = sha256(workspace.json + manifest.json);
  mappingProject = sha256(_project.json); database = sha256(its manifest entry);
  dataset/dashboard/conceptMapping/etlScript/dqRuleSet/catalog = sha256(referenced file).

The baseline is versioned (`schemaVersion`). If a stored baseline is from an older schema, the
app silently resets it (stores the current hashes, no notification) — so a format change never
fires a spurious "everything changed" dialog.

## Test it end to end (have the user do this)

The app runs at `http://localhost:3000` (`npm run dev`). No dev-server restart needed (HMR
regenerates the hashes).

**A returning user with a baseline** (don't clear IndexedDB):
1. Make the seed edit(s).
2. Reload the page.
3. The **"Default data has been updated"** dialog lists the changed entities, grouped by
   workspace (readable name), each tagged New / Updated / Removed.
   - New / Updated → checkbox ticked by default.
   - Removed → checkbox (red, unticked) **if** the local copy is seed-origin; otherwise read-only.
4. Tick what you want and click **Update selected** → it re-imports the ticked New/Updated and
   deletes the ticked Removed, then refreshes the affected views (no full reload).

**Clean-slate reset for a fresh-install test** — in the browser console, then reload:
```js
localStorage.clear()
indexedDB.databases().then(dbs => dbs.forEach(d => indexedDB.deleteDatabase(d.name)))
```
Relevant keys: `linkr-seeded`, `linkr-seed-hashes`, `linkr-app-build-hash`, and per-entity
`linkr-seed-<type>-<id>`.

## Gotchas

- **Re-seeded project comes back empty?** A project's datasets/dashboards are separate
  manifest entities (own ids, own flags). The targeted re-seed derives them from the manifest
  via their `projectUid` (`fetchProjectChildEntities`) and clears their flags too. If you add a
  new dataset/dashboard to a seeded project, keep its `projectUid` correct or it won't attach.
- **Dialog fires for the whole workspace on a tiny edit?** Editing `workspace.json` or
  `manifest.json` changes the `workspace` hash → a `workspace` "modified" row. That only
  refreshes metadata on re-seed; components diff individually.
- **Changed an entity's `id`?** That's a remove + add, not a modify. Keep ids stable.
- **Don't commit** `seed-hashes.json` (gitignored) — and don't commit throwaway demo edits
  unless they're real updates.

## Keep producers in sync (cross-repo)

The seed format is shared. When you change it, also update:
- `apps/web/src/lib/seed-loader.ts` (consumer) and `vite-plugin-seed-hashes.ts` (hashes),
- `../linkr-portal/scripts/build.sh` (the portal generates `manifest.json` for deployed
  workspaces; verify `../linkr-portal-ricdc` too).

## Conventions

Follow `docs/conventions.md`. Commit messages in English: `Seed: <imperative>`.
After editing, the app must still pass `npm run typecheck` / `lint` / `test` if you
touched any `.ts` (pure seed JSON edits don't need tests).
