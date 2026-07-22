# Versioning — remaining work

> Merge of what remained from three mostly-completed efforts: `git-sync-plan.md`
> (bidirectional pull), `server-export-plan.md` (server-side export ZIP) and
> `workspace-source-concept-ids-ownership.md` (source-concept-id ownership).
> The as-built is documented in `docs/architecture.md` ("Versioning (as-built)" and
> "Fullstack Storage & Compute"). This document keeps only the remaining work.

## Done (see docs/architecture.md)

- Behind/diverged detection (`git_sync_state` table, anchor written at push/pull, lazy
  adoption after import), banner + safety guard: **push refused while behind**.
- Pull for **mapping-project** (fine-grained 3-way merge: mappings line by line keyed by
  source+target, metadata per field, source-concepts/scores as whole blocks, LFS via
  `pull-file`) and pull for **project** (clone-based, diff per group, re-applied via
  `importProjectContent`).
- Export ZIP built **server-side** for projects / workspaces / mapping-projects /
  settings (`serverBuildsZip`, git-sync-store.ts) + standalone builders for the 6
  workspace-child scopes (their commit-push no longer depends on the client-built ZIP).
  TS↔Python parity pinned by golden tests (one frozen `expected/` tree per scope,
  compared per extracted file, never zip-container bytes).
- Settings versioning (scope `account`: orgs/users/roles, passwords never exported,
  re-imported user without a hash = disabled).
- Source-concept-id ownership: root `ranges.json` only, entries per project, monotone
  merge (`nextId = max`) on import/seed, root entries read as legacy fallback.
- Instance/volatile field stripping for **mapping projects** (ids, timestamps, local
  UUIDs; stable sort; scores parquet gitignored; LFS opt-in).

---

## Remaining

### 1. [TO TEST] End-to-end pull flow, especially the LFS path

Full 2-workspace flow (crossed pull/push), and above all the **LFS** path of
`pull-file` (source CSV / scores parquet) against a real endpoint — validated in logic
only so far.

### 2. [TODO] Foreign files: the "commit everything" path + display

The normal UI flow passes an explicit `paths` → `_stage_paths` → foreign files (outside
the app's managed tree: a hand-written `notes.md`, a `.gitlab-ci.yml`…) survive. But the
`paths is None` path still runs `git add -A` on a tree wiped by `_unpack_zip_into`
([git_service.py:916](../../apps/api/app/services/git_service.py)) → it records the
**deletion** of the remote's foreign files. Targeted fix: stage the managed paths
explicitly (add an `isManaged(scope, path)` predicate to the classification in
`git-file-classify.ts` / `git-file-meta.ts`) instead of `add -A`.
Also: list foreign files in the sync UI ("Files outside the application", read-only); on
pull they are ignored by the entity merge (never written to the DB) but stay versioned in
the working tree.

### 3. Pull for the 6 other scopes (case by case, later)

The six remaining scopes only have **Link + Push**: no detection banner, no pull.
Factual wiring state:

| Scope | Link | Push | Status banner | Pull |
|---|---|---|---|---|
| project | ✓ | ✓ | ✓ | ✓ (clone) |
| mapping-project | ✓ | ✓ | ✓ | ✓ (fine-grained merge) |
| sql-script-collection | ✓ | ✓ | ✗ | ✗ |
| etl-pipeline | ✓ | ✓ | ✗ | ✗ |
| data-catalog | ✓ | ✓ | ✗ | ✗ |
| dq-rule-set | ✓ | ✓ | ✗ | ✗ |
| schema-preset | ✓ | ✓ | ✗ | ✗ |
| workspace | ✓ | ✓ | ✗ | ✗ (sync-all quick-action only) |

The banner + Pull are gated centrally by `syncStateSupported` (`GitSyncPanel.tsx`); the
`sync-state`/`pull-*` endpoints exist only for projects (sync-state alone),
mapping-projects (full set) and settings/account. The reusable brick is the **infra**
(`git_sync_state` table, anchor, `pull-preview`/`pull-file` endpoints, push guard, review
datatable pattern). What is NOT reusable as-is: the **merger** (a stable matching key —
reminder: `id`s are regenerated on import — + the compared fields) and the **resolution
UI sections**. Questions to settle per scope: merge unit? stable key? content families
and per-family strategy (line by line / block / field)? resolution UI?

Sketch (to validate, not frozen):

| Scope | Likely unit | Families / points to think through |
|---|---|---|
| sql-script-collections | a script | SQL files (name + content) → per-script text diff + metadata |
| etl-pipelines | a step / a file | inline scripts + pipeline config |
| data-catalogs | an entry | config/DCAT-AP JSON; `catalog_results` = cache (never merge) |
| dq-rule-sets | a rule | inline SQL + custom checks |
| schema-presets | a preset | schema JSON |
| user-plugins | a code file | inline code |
| workspaces | aggregate | pulling a workspace = orchestrating its entities' pulls? Think through separately |

### 4. [TODO] Client-side pull (front-only / WASM)

The current pull (mapping-project + project) goes through the backend (server clone
`gitCloneToZip`, `pull-preview`/`pull-file` endpoints). The **client-side** pull — for
the front-only mode with no backend — remains to be done for all types, including those
that already have the server pull.

### 5. [TODO] Stripping: extend to projects, workspaces and the other scopes

Run every versionable scope through the same sieve as mapping projects (rule: a
versioned export contains only portable content; strip any field regenerated on import
or purely instance-bound). `stripInstanceFields` already covers the generic entity
fields (`ownerId`, `createdAt`, `updatedAt`, `workspaceId`, `gitRemoteConfig`,
`organization`…) but each scope has its own specific fields and its own files to sort:

- **projects**: dashboards (widget/tab ids?), datasets (data-source ids, timestamps),
  IDE scripts, badges. The richest — probably several files to normalize + sort.
- **workspaces**: aggregate; inherits each entity's stripping, check the
  workspace-specific files (registries; ranges already handled).
- **sql-collections / etl-pipelines / dq-rule-sets / schema-presets / user-plugins /
  data-catalogs**: local ids, timestamps, serialization order of collections (sort by a
  stable key).

Method: open a real export, spot the fields that move between two exports with no
business change + non-deterministic ordering, strip/sort on export **and**
regenerate/tolerate on import. Update the scope's golden test in the same change
(careful: any format change here touches both the TS **and** Python builders).

### 6. [TODO] `serverBuildsZip`: extend to the 6 remaining scopes

`serverBuildsZip` ([git-sync-store.ts:42](../../apps/web/src/stores/git-sync-store.ts))
only covers projects / workspaces / mapping-projects / settings. The standalone server
builders already exist for sql-script-collections, etl-pipelines, data-catalogs,
dq-rule-sets, schema-presets and user-plugins (`workspace_export_assemble.py`) and the
git routes take the upload as optional — what remains is switching the **client**
(status, diff, commit, Export) so the browser stops building those ZIPs in server mode.
Front-only unchanged.

### 7. [LATER] Server-side import (the big remaining offloading effort)

Import is today **100% client-side**: JSZip in the browser
(`parseProjectZip`/`parseWorkspaceZip`/`importProjectContent`) + per-entity HTTP calls —
the main remaining heavy client path in fullstack mode. Target: `POST /projects/import`
and `POST /workspaces/import` endpoints (ZIP → DB on the server). Twin project of the
server export, with the same duplication/consistency stakes (Python parsers for
`_tree.json` + contents; the TS parsers stay for front-only) — to tackle now that the
format contract (golden) is stable. Invariant to reproduce: a `sourceConceptId` is
global per `(vocab, code)` within a workspace — the client applies
`reconcileImportedEntries` (keeps the local id).

> Known parity reminder: JS `JSON.stringify` writes a round float as `0` where Python
> (a `Float` column) writes `0.0`. Not solved globally — the golden fixtures avoid round
> floats; if it surfaces in real data, normalize at the serializer or accept the diff.

### 8. Exact client-side entry scoping — deferred + known limitation

The server scopes a project's `entries.json` to its `(vocab, code)` universe
(`source_concept_id_scope.py`); the front-only client still exports the **whole badge**
(`buildProjectSourceConceptIds`) because faithful scoping would require mounting/querying
the deduplicated source dictionary (~177k DuckDB rows) during export — and reproducing
the server behaviour here (CSV quoting, QUALIFY dedup, terminology-column fallback) would
risk a **third** divergent implementation. Validated decision: keep the wide client
scoping (correct, just slightly wide).

**Known limitation** (see the note in
[source-concept-ids-io.ts](../../apps/web/src/lib/concept-mapping/source-concept-ids-io.ts)):
a mixed front-only/server team on the same remote will see churn on `entries.json`
(the client writes wide, the server writes scoped). To resolve if the client scoping is
ever aligned — or accept it as long as the mixed case stays marginal.

To verify in passing on the `../linkr-portal` side: no script change expected
(`sync-git-links.sh`/`build.sh` already inject the linked project's full folder), but
note in the portal repo whether the disappearance of the root `entries.json` deserves a
docs touch.
