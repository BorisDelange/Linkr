# Versioning — remaining work

> Merge of what remained from three mostly-completed efforts: `git-sync-plan.md`
> (bidirectional pull), `server-export-plan.md` (server-side export ZIP) and
> `workspace-source-concept-ids-ownership.md` (source-concept-id ownership).
> The as-built is documented in `docs/architecture.md` ("Versioning (as-built)" and
> "Fullstack Storage & Compute"). This document keeps only the remaining work.
> Every item below was re-verified against the code on 2026-07-22.

## Done (see docs/architecture.md)

- Behind/diverged detection (`git_sync_state` table, anchor written at push/pull, lazy
  adoption after import), banner + safety guard: **push refused while behind**.
- Pull for **mapping-project** (fine-grained 3-way merge: mappings line by line keyed by
  source+target, metadata per field, source-concepts/scores as whole blocks, LFS via
  `pull-file`) and pull for **project** (clone-based, diff per group, re-applied via
  `importProjectContent`).
- Export ZIP built **server-side for every scope** (`serverBuildsZip` returns true in
  server mode; the git routes fall back to their `assemble_fn` when no file is
  uploaded). TS↔Python parity pinned by golden tests (one frozen `expected/` tree per
  scope, compared per extracted file, never zip-container bytes). Like the
  mapping-project builder, server-built ZIPs don't take per-file LFS overrides
  (documented trade-off — the entity scopes are light JSON content).
- Settings versioning (scope `account`: orgs/users/roles, passwords never exported,
  re-imported user without a hash = disabled).
- Source-concept-id ownership: root `ranges.json` only, entries per project, monotone
  merge (`nextId = max`) on import/seed, root entries read as legacy fallback.
- **Instance/volatile field stripping — done for every scope** (verified 2026-07-22):
  `stripInstanceFields` (entity-io.ts) is applied by `buildProjectZip` (meta, pipelines,
  cohorts, databases, dashboards/tabs/widgets, dataset trees/assets), `buildWorkspaceZip`
  (meta + per-project reuse) and all six standalone entity builders (user-plugins use an
  explicit whitelist, stricter). Python twins each carry the matching `_INSTANCE_FIELDS`,
  reused by `workspace_export_assemble.py` for the child scopes.
- Empty commit selection can no longer fall through to the server's "commit everything"
  path (`_commitPushPaths` refuses an empty array; a missing `paths` field means
  `git add -A` server-side).

---

## Remaining

### 1. [TO TEST] End-to-end pull flow, especially the LFS path

Full 2-workspace flow (crossed pull/push), and above all the **LFS** path of
`pull-file` (source CSV / scores parquet) against a real endpoint (GitLab/GitHub with
LFS enabled) — validated in logic only so far. The plumbing exists (`_ensure_lfs`,
`GIT_LFS_SKIP_SMUDGE` fetches, pointer resolution in `pull_file_bytes`, git-lfs in
`Dockerfile.api`) but no test round-trips a real LFS object
(`tests/test_git_service.py` pushes plain CSVs to a local `file://` remote).
Manual validation first (~0.5 d); an automated integration test needs git-lfs in CI.

### 2. [TODO — small] Foreign files: server-side guard + optional listing

The UI is safe: every commit path passes explicit `paths`, empty selections are refused
client-side, and `defaultSelectedPaths` never checks unowned files by default. What
remains is defense in depth: the server still trusts `paths is None` → `git add -A` on
a tree wiped by `_unpack_zip_into`
([git_service.py](../../apps/api/app/services/git_service.py)) → it would record the
**deletion** of the remote's foreign files if a client ever omitted the field.
Optional hardening: refuse `paths=None` on the HTTP route (internal callers keep the
service default), and/or a read-only "Files outside the application" listing in the
sync UI (cosmetic — droppable).

### 3. [TO ARBITRATE] Pull for the 6 other scopes — as pull-overwrite, not merge

The six remaining scopes only have **Link + Push**: no detection banner, no pull.

| Scope | Link | Push | Status banner | Pull |
|---|---|---|---|---|
| project | ✓ | ✓ | ✓ | ✓ (clone) |
| mapping-project | ✓ | ✓ | ✓ | ✓ (fine-grained merge) |
| sql-script-collection / etl-pipeline / data-catalog / dq-rule-set / schema-preset / user-plugin | ✓ | ✓ | ✗ | ✗ |
| workspace | ✓ | ✓ | ✗ | ✗ (sync-all quick-action only) |

**Do NOT build a fine-grained merger for these scopes** (high cost, low value).
`applyClonedEntity` (entity-io.ts) already reconstitutes all six from a cloned repo
(delete-first, used by git-content-retry and the workspace sync-all quick-action) — an
effective pull-overwrite. What's missing is only: the behind/diverged banner per scope
(`syncStateSupported` gate in `GitSyncPanel.tsx`, `sync-state` endpoints) + a "Pull
(overwrite from remote)" action reusing `applyClonedEntity`. Effort ≈ 1–2 d, mostly UI +
sync-state wiring. Alternative: drop entirely for these secondary scopes.

### 4. [LATER] Server-side import (the big remaining offloading effort)

Import is today **100% client-side**: JSZip in the browser
(`parseProjectZip`/`parseWorkspaceZip`/`importProjectContent`) + per-entity HTTP calls —
the main remaining heavy client path in fullstack mode. Target: `POST /projects/import`
and `POST /workspaces/import` endpoints (ZIP → DB on the server). Twin project of the
server export, with the same duplication/consistency stakes (Python parsers for
`_tree.json` + contents; the TS parsers stay for front-only) — to tackle now that the
format contract (golden) is stable. Invariant to reproduce: a `sourceConceptId` is
global per `(vocab, code)` within a workspace — the client applies
`reconcileImportedEntries` (keeps the local id). Only worth it if client weight in
fullstack mode is an actual user pain; several days of work.

> Known parity reminder: JS `JSON.stringify` writes a round float as `0` where Python
> (a `Float` column) writes `0.0`. Not solved globally — the golden fixtures avoid round
> floats; if it surfaces in real data, normalize at the serializer or accept the diff.

---

## Won't do (decided 2026-07-22)

- **Client-side pull (front-only / WASM)** — everything git-related in front-only mode
  stays push-only; pull requires the backend. Decision: not doing it.
- **Exact client-side source-concept-id entry scoping** — the front-only client keeps
  exporting the **whole badge** (`buildProjectSourceConceptIds`): faithful scoping would
  require reproducing the server's deduplicated-dictionary read (CSV quoting, QUALIFY
  dedup, terminology fallback) = a third divergent implementation. **Known limitation**
  (see the note in
  [source-concept-ids-io.ts](../../apps/web/src/lib/concept-mapping/source-concept-ids-io.ts)):
  a mixed front-only/server team on the same remote sees churn on `entries.json`.
  Accepted while the mixed case stays marginal.
- **Fine-grained merge for the 6 entity scopes** — superseded by the pull-overwrite
  approach (item 3).
