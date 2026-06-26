---
name: update-default-data
description: Add or update Linkr's bundled "default data" — the seed under apps/web/public/data/seed/ that's pre-loaded into every fresh install (workspaces, projects, datasets, dashboards, databases, ETL pipelines, concept mappings, DQ rule sets, catalogs). Use when the user wants to change the demo/default content, add a seeded project or dataset, bump the bundled MIMIC data, or test the "Default data has been updated" re-seed flow. Covers WHERE each entity lives, the two seeding paths, the id/uid linkage rules, and how to make the user test it end to end.
argument-hint: [what to add/update, e.g. "a dataset to icu-activity-dashboard"]
---

# Update Linkr's default (seed) data

The seed lives in `apps/web/public/data/seed/` and is **hand-edited** (no generator).
On a fresh install it's loaded into IndexedDB. On later visits, a change-detection
dialog ("Default data has been updated") offers the user to re-import changed entities.

Read this whole file before editing — the id linkage rules and the hash/restart
coupling are easy to get wrong and fail silently (dialog never fires, or a re-seeded
project comes back empty).

## The two seeding paths (decides WHERE you register an entity)

Every seed entity is loaded by ONE of two paths. Know which before editing.

- **Path A — declared in `seed.json`**, loaded by `seedDatabases()`, each guarded by a
  per-entity localStorage flag (idempotent):
  `databases`, `conceptMappings`, `etlScripts`, `datasets`, `dashboards`.
- **Path B — declared in `<folder>/_index.json`**, loaded by `loadSeedWorkspace()`
  (no per-entity flag; re-created if missing):
  `projects`, `mappingProjects`, `etlPipelines`, `dqRuleSets`, `catalogs`.

`_index.json` exists because the browser can't list a directory over fetch — it's the
manifest of what's in the workspace folder.

## Layout

```
apps/web/public/data/seed/
  seed.json                      # Path A manifest: workspaces[] with databases/datasets/dashboards/conceptMappings/etlScripts
  seed-hashes.json               # GENERATED (gitignored) — change detection baseline
  <folder>/                      # one per workspace, e.g. "default"
    workspace.json               # { id, name:{en,fr}, description, organizationId, ... }
    _index.json                  # Path B manifest: projects/mappingProjects/etlPipelines/dqRuleSets/catalogs
    projects/<projectId>/        # project.json (+ README.md); full project also has scripts/ dashboards/ datasets/ pipeline/ cohorts/
    mapping-projects/<id>/       # _project.json (+ mappings.json, source-concepts.csv)
    etl/<id>/                    # _pipeline.json, _tree.json, script files
    dashboards/<name>.json       # { dashboard, tabs, widgets } (referenced from seed.json dashboards[])
    data-quality/<name>.json     # { ruleSet, checks }
    catalogs/<name>.json         # DataCatalog object
  <dataset>.json                 # { columns, rows } for a Path-A dataset (referenced by seed.json datasets[].file)
  <parquetBase>/<table>.parquet  # database tables
```

Reference example to copy from: the `default` workspace (MIMIC-IV demo) —
`id: 00000000-0000-0000-0000-000000000010`.

## Linkage rules (get these wrong → entity silently not loaded)

- dataset/dashboard → project: `projectUid` = the project's `uid`.
- database → project (optional): `databases[].linkToProject` = project `uid`.
- conceptMappings → mapping project: `conceptMappings[].projectId` = mapping project `id`.
- etlScripts → pipeline: `etlScripts[].pipelineId` = pipeline `id`.
- every entity's `workspaceId` = the workspace `id`; workspace `organizationId` = the org `id`.

## How to add/update each type

| Type | Path | Create/edit | Register in |
|---|---|---|---|
| Project (full) | B | `projects/<id>/project.json` (+ `scripts/_tree.json`, `dashboards/`, `datasets/`, …) | `_index.json` → `projects[]` |
| Dataset | A | `<dataset>.json` = `{columns, rows}` | `seed.json` → `datasets[]` `{file,id,projectUid,fileName}` |
| Dashboard | A | `<folder>/dashboards/<name>.json` = `{dashboard,tabs,widgets}` | `seed.json` → `dashboards[]` `{file,projectUid}` |
| Database | A | `<parquetBase>/<table>.parquet` | `seed.json` → `databases[]` `{id,alias,name,schema,parquetBase,tables,…}` |
| ETL pipeline | A+B | `etl/<id>/_pipeline.json` + `_tree.json` + scripts; `<etl-scripts>.json` | `seed.json` → `etlScripts[]` AND `_index.json` → `etlPipelines[]` |
| Concept mapping | A+B | `mapping-projects/<id>/_project.json` (+ `mappings.json`); `<mappings>.json` | `seed.json` → `conceptMappings[]` AND `_index.json` → `mappingProjects[]` |
| DQ rule set | B | `data-quality/<name>.json` = `{ruleSet,checks}` | `_index.json` → `dqRuleSets[]` |
| Catalog | B | `catalogs/<name>.json` | `_index.json` → `catalogs[]` |
| Workspace | both | `<folder>/workspace.json` + `_index.json` | `seed.json` → `workspaces[]` |

To **update** an existing entity, just edit its file(s). The change is detected by a
content hash, so any real content change is enough.

## Change detection & the restart requirement (critical)

`apps/web/vite-plugin-seed-hashes.ts` regenerates `seed-hashes.json` ONLY at
`buildStart` — i.e. on dev-server start / production build. **There is no HMR
regeneration.** So after editing any seed file you MUST restart the dev server,
or the change-detection dialog won't see the change.

What gets hashed per type (so you know an edit is detectable):
- project = sha256(project.json + README.md); workspace = sha256(workspace.json + _index.json);
  mappingProject = sha256(_project.json); database = sha256(its seed.json entry);
  dataset/dashboard/conceptMapping/etlScript/dqRuleSet/catalog = sha256(referenced file).

`seed-hashes.json` is gitignored — never commit it.

## Test it end to end (have the user do this)

The app runs at `http://localhost:3000` (`npm run dev`).

1. Make the seed edit(s).
2. **Restart the dev server** (regenerates `seed-hashes.json`).
3. Reload the page **without clearing IndexedDB** (a returning user with a baseline).
4. The **"Default data has been updated"** dialog should list the changed entities,
   grouped by workspace (shown by readable name), each with: New / Updated / Removed.
   - added/modified → checkbox, ticked by default.
   - removed → read-only (we never delete local data; user deletes manually if wanted).
5. Tick the entities and click **"Update selected"** → it deletes those entities locally,
   re-imports them from the seed, and reloads. Confirm the content is the new version.

If the dialog does NOT appear, the baseline is already in sync — usually the dev server
wasn't restarted, OR this browser has no baseline yet (first visit stores it silently).

### Clean-slate reset for a fresh test
In the browser console, then reload:
```js
localStorage.clear(); // wipes the seed baseline + per-entity flags
// then use the app's "Reset all data" (Settings) to also clear IndexedDB, or:
indexedDB.databases().then(dbs => dbs.forEach(d => indexedDB.deleteDatabase(d.name)))
```
Relevant keys: `linkr-seeded`, `linkr-seed-hashes`, `linkr-app-build-hash`, and
per-entity `linkr-seed-{db|dataset|dashboard|mappings|etl}-<id>`.

## Gotchas

- **Re-seeded project comes back empty?** A project's datasets/dashboards are Path A
  (separate `seed.json` entries with their own flags). The targeted re-seed clears those
  flags when re-importing a project (see `lib/targeted-reseed.ts`); if you add a new
  Path-A child to a seeded project, keep its `projectUid` correct or it won't attach.
- **Dialog fires for the whole workspace on a tiny edit?** Editing `workspace.json` or
  `_index.json` changes the `workspace` hash → a `workspace` "modified" row. That only
  refreshes metadata on re-seed; components diff individually.
- **Don't commit** `seed-hashes.json` (gitignored) — and when testing, don't commit
  throwaway edits to the demo content unless they're real updates.

## Conventions

Follow `docs/conventions.md`. Commit messages in English: `Seed: <imperative>`.
After editing, the app must still pass `npm run typecheck` / `lint` / `test` if you
touched any `.ts` (pure seed JSON edits don't need tests).
