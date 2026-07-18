# Code Review Log

Chronological log of code reviews run via the `code-review` skill. Newest entry on top.
Each review covers the commit range from the previous review's `Last reviewed commit` up to the `HEAD` at review time.

> The skill reads the topmost `Last reviewed commit:` to know where to start the next review.

---

## Template (copy for each new review)

```
## YYYY-MM-DD — <short title>

- Reviewed by: <Claude model / person>
- Range: <prev-sha>..<head-sha>  (<N> commits)
- Last reviewed commit: <head-sha>
- Verdict: Ship it | Fix-then-ship | Needs work
- Tests: <pass/fail, N tests> · Lint: <pass/fail>

Findings:
- 🔴 <critical> — file:line — problem → fix
- 🟠 <important> — file:line — problem → fix
- 🟡 <minor> — file:line — problem → fix

Notes / follow-ups:
- ...
```

---

## 2026-07-17 — Plugin provenance + concept-mapping Progress breakdown/instant-editor + export-stripping/portable-ids + versioning diff-cache/LFS-opt-in + i18n empty-lang fallback

- Reviewed by: Claude Opus 4.8 — 4 parallel adversarial Explore sub-agents by feature group (plugin-provenance BE+FE, concept-mapping ProgressTab/instant-editor/badges, export-stripping/import-restamp/localized, versioning diff-cache/LFS/git-file-classify) + reviewer re-verified EVERY reported finding directly in source (the 🔴 mapping-import restamp reproduced against the type + both import paths; the export-sort many-to-many tie reproduced by tracing the row key; the plugin org-precedence traced through CardMetaFooter's `liveOrg ?? organization`).
- Range: 950d711f..0b6e5748 (**15 commits, 69 files, ~1,478 insertions / ~482 deletions**). Note: the first commit (`db48e478`) is the 2026-07-16 review's own fixes landing — spot-checked intact (DQ authz 🔴: `rule_set_id` now required + unconditional auth + workspace_id stamped server-side; view-mode widget gating; mapping filter fallback; column-id `\p{Mn}` parity). New work: **plugin provenance** (author/org trio + frozen org snapshot brought to parity with the other 7 exportables — model+schema+service+migration `c2d3e4f5a6b7`, `created_by_id` popped + re-derived via `stamp_creator`, FK Postgres-only); **card live re-hydration** (CardMetaFooter resolves author+org live, snapshot fallback, render-loop-safe via stable selectors + useMemo); **concept-mapping Progress breakdown** by vocab/category (ProgressTab +399, StatusBar, status-colors, equivalence-badge) + **instant editor** (optimistic createMapping w/ rollback); **portable source-concept-ids** + **export field-stripping** (mappings.json/project.json strip instance fields, stable sort, scores parquet gitignored) + **import createdAt re-stamp** (crash fix on stripped ZIPs); **versioning** per-file diff cache + rebuild-on-refresh + **LFS opt-in only** (no auto size/ext rule); **i18n empty-language fallback** (`||`+`find(Boolean)`). Version stays **2.1.2** (user chose not to bump this review).
- Last reviewed commit: 0b6e5748fc01deba505f20954891fe1d2982b83a
- Verdict: **Fix-then-ship** — 1 🔴 (mapping-project import doesn't re-stamp stripped `createdAt` → server-mode import failure) + 3 🟠 (export sort not total for many-to-many → spurious git diffs; Progress bar drops `suggested` concepts; plugin card org-precedence backwards) + a 🟡 batch. **User approved fixing ALL findings; applied this review (uncommitted, awaiting app test). Per the user's steer, `suggested` now counts as unmapped across ALL three Progress views (pie + mapped column + bar), not just the bar.**
- Tests: frontend **296 passed** (25 files, +3: 2 localized + 1 export determinism) · backend plugin+DQ **10 passed** (via `apps/api/.venv`) · Lint: **0 errors** (151 pre-existing React-Compiler warnings) · Typecheck: **0 errors** · Ruff: clean on touched · i18n parity: clean (only the 4 pre-existing `data_sources.detail_visit*`).
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). The 🔴 bites hardest in server mode (NOT-NULL rejects `undefined createdAt`); in client mode it silently persisted an invalid record.

Findings (all re-verified in source; all fixed this review):

**🔴 CRITICAL (fixed):**
- 🔴 MappingProjectListPage.tsx:210-211 + :254 — **mapping-project import doesn't re-stamp `createdAt` on stripped ZIPs.** This is the direct consumer of the new export-stripping, and the one import path the `9c547688` "re-stamp createdAt" fix missed (it covered ProjectsPage/WorkspacesPage/seed-loader/`importProjectSourceConceptIds`). On a **plain** import (not duplicate), `createdAt` came from `...project` — but `stripInstanceFields` removed it → persists `createdAt: undefined` (required by `MappingProject`). Same at :254: source-id ranges saved `{ ...r, workspaceId: ws }` directly instead of via the re-stamping helper, and `toPortableRanges` strips timestamps → `createdAt/updatedAt: undefined` (required by `SourceConceptIdRange`). Server-mode NOT-NULL rejects the write → the "stripped ZIP" import the feature targets fails. Fix: `createdAt: project.createdAt ?? now` on the entity, and re-stamp ranges `{ ...r, workspaceId: ws, createdAt: r.createdAt ?? now, updatedAt: now }` (mirrors `importProjectSourceConceptIds`).

**🟠 IMPORTANT (fixed):**
- 🟠 export.ts:575-579 (`serializeMappingsForVersioning`) — **mappings.json sort not total for many-to-many source concepts.** A source concept can map to several targets (the MappingsTab row key is `vocab\0code\0targetConceptId` precisely because `(vocab,code)` isn't unique). Tie-break was `(sourceConceptCode, sourceConceptId)` only → tied rows follow DB iteration order (stable per-run but not content-derived) → spurious git diffs across instances/reindex, defeating the docstring's own "DB ordering never shows up as a spurious diff" promise. Fix: sort by sourceConceptCode first (readable diffs), then break every remaining tie by `mappingKey()` (the merge's own full source+target identity → total order). Test added (both input orders → identical output).
- 🟠 ProgressTab.tsx:30-32 + stats — **Progress breakdown silently dropped `suggested` concepts.** `mappedTotal` summed all of `byStatus` (incl. suggested) so they left `unmapped`, but `STATUS_SEGMENT_ORDER` had no `suggested` slice → bar under-filled (sum < 100%), those concepts invisible; the status pie on the same tab *did* show them → the two disagreed. Per the user's decision, **fixed so `suggested` = unmapped everywhere**: excluded from `nonIgnoredMappings`/`allSourceKeys`/`sourceStatusCounts` (pie) AND from `bestPerKey` (bar `continue`), so it now falls into the unmapped remainder consistently across pie + `mapped` column + bar. (Also fixed a latent bug: `statusPriority` never listed `suggested`, so `indexOf` returned -1 → a suggested mapping wrongly won "best status".)
- 🟠 PluginsTab.tsx:402 + card-meta-footer.tsx:167-168 — **plugin card org-precedence backwards vs. the documented contract.** Store + export both say "own org wins over the workspace's" (`attachEntityOrganization` = `entity.organization ?? resolve(...)`), but PluginsTab passed `organizationId={workspaceOrgId}` alongside `organization={plugin.organization}` (two different sources) and the footer does `liveOrg ?? organization` → the workspace org shadowed an imported plugin's own org. (Correct callers like WorkspacesPage pass both from the same record.) Narrow trigger (imported plugin whose origin org ≠ workspace's). Fix: `organizationId={plugin.organization ? undefined : workspaceOrgId}` so the plugin's own frozen org wins.

**🟡 MINOR (all fixed):**
- 🟡 git-sync-store.ts:305-313 (`toggleLfs`) — **diff cache not invalidated on LFS toggle.** Cache key is `branch|path` only; toggling LFS changes a file's diff (dedicated `no_content_change` truncation mode) + the `.gitattributes` diff, but didn't clear `_diffCache`. Since the cache was promoted to module-level this range, reopening the dialog after a toggle now showed a stale diff (didn't survive close before). Fix: `toggleLfs` calls `invalidateZip()`.
- 🟡 git-sync-store.ts:207-209 — **`includeData` default-selection branch bypassed the config-file filter.** When on, the inline default only excluded deletions → a modified `.gitignore`/`.gitattributes` got preselected, defeating `819e9d3b`. Fix: exported `isUnownedConfigModification` from git-file-classify and applied it in that branch too.
- 🟡 ProgressTab.tsx (stats loader) — **lost cancellation guard.** The refactor to a `useCallback` invoked from two effects dropped the old `cancelled` flag → a stale load could overwrite fresh stats / setState-after-unmount. Fix: per-invocation `loadGen` ref; a load commits `setTotalSourceConcepts`+`setGroupTotals` only if still latest (both now written together after the guard).
- 🟡 ProgressTab.tsx:222/241 — `#9ca3af`/`#e2e8f0` color literals duplicated `status-colors.ts` → use `STATUS_FALLBACK_COLOR`/`UNMAPPED_COLOR` constants.
- 🟡 localized.ts — the load-bearing `find(Boolean)` branch (empty en + non-empty other lang) and both-empty were untested → 2 assertions added.
- 🟡 PluginsTab.tsx:323 (`doPluginImport`) — `finalizeEntityZip` writes `.gitattributes` for an LFS-bearing plugin; import stripped only `_plugin.json` → it landed as a plugin "source file." Fix: `delete updatedFiles['.gitattributes']`.
- 🟡 git-sync-store.ts:36/126/146 — stale "automatic size/extension rule" comments (LFS is opt-in now) → corrected.
- 🟡 user_plugin_service.py:create — investigated the "redundant setattr before stamp_creator" nit: **NOT changed the way the sub-agent proposed** (popping `created_by`/`created_by_details` would break imports — `stamp_creator` reads the snapshot from the `payload`, not the entity, so popping them would lose an imported author). Left the harmless setattr and documented why it's fine.

Verified sound ✅ (actively probed, no finding):
- **Plugin provenance BE:** migration chain linear/single-head (`c2d3e4f5a6b7` sole child of `b1c2d3e4f5a6`, new head), all-nullable columns (no data loss), FK Postgres-only (SQLite can't ALTER-ADD), up/down symmetric; `created_by_id` never an authz key (all routes gate on `plugins:read/write/delete`); `UserPluginUpdate` accepts no provenance fields → `update` can't spoof `created_by_id`; `created_by_id` popped in `create` + re-derived by ORCID/email in `stamp_creator`. Round-trip (`buildUserPluginFolder`/`_plugin.json`/`attachEntityOrganization`) keeps createdBy+snapshot+org, drops createdById. Mirrors Cohort/Project pattern.
- **CardMetaFooter re-hydration:** stable selectors (`s.user`, `s.byId[id]`, `getOrganization` element ref) + `useMemo([me,dirUser])` avoid the Maximum-update-depth loop; no registered buffer, no leak.
- **Optimistic createMapping:** inserts, awaits persistence in try, on failure removes from map + array, bumps versions, invalidates caches, re-throws (skips stats recompute). Direct Map mutation is the store's documented pattern.
- **SQL safety (mapping-queries breakdown):** `dimension` is the closed union `'vocabulary_id'|'category'` (TS-constrained, callers iterate a literal array) — no user data in SQL; group/total/source_concepts are static literals; all values through `esc()`; file-source-without-terminology-column falls back to `concept_code IN(...)` (tested).
- **DQ authz fix (prev review, now landed):** `DqRunHistoryCreate.rule_set_id` required, `create_run` auth unconditional, `workspace_id` stamped from the rule set. Correct.
- **LFS opt-in migration:** no lingering `isLfsCandidate`/`LFS_SIZE_THRESHOLD`/`LFS_EXTENSIONS`; `resolveLfsPaths` tracks only `override === true`; `.gitattributes` regenerated per export. **rebuild-on-refresh:** `refreshStatus` calls `invalidateZip()` before `buildZip` (fixes stale-ZIP-hides-DB-edits); rebuild only on explicit refresh/branch/toggle/commit/pull, not tab re-entry.
- **localized fallback:** `||`+`find(Boolean)` correct for all cases (empty-lang, empty-en, both-empty, null, legacy string); no whitespace regression.
- **column-id parity:** TS `\p{Mn}` == Python `Mn` category; fixture case `a<U+0483>b → col_ab` agrees.
- No new `any`, no `console.log`, no dangerouslySetInnerHTML, no secrets in touched files; largest touched file (ProgressTab ~560 lines) under 800.

Carried follow-ups (non-blocking, pre-existing): `buildConceptUnionParts` heterogeneous UNION can Binder-Error on multi-dictionary sources where some map a `category` column and some don't — the new category-grouping path newly exercises it but the flaw predates this range (harden with `NULL AS category` for absent dicts). Pre-existing/systemic (out of scope): the 4 `data_sources.detail_visit*` EN/FR mismatches; the equivalence-badge English `label` values (unchanged this range); the `workspace_id is None → no access check` pattern (planned access-group rework).

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-17

The user approved fixing **all** findings and steered `suggested` → unmapped across all three Progress views. Applied: the 🔴 (mapping-import re-stamp, project + ranges); the 3 🟠 (export sort total via `mappingKey` tie-break + test; ProgressTab suggested-as-unmapped in pie/column/bar + latent statusPriority bug; plugin org-precedence); the 🟡 batch (toggleLfs cache invalidation, includeData config filter + exported helper, ProgressTab loadGen guard + color constants, localized ×2 tests, PluginsTab `.gitattributes` strip, git-sync-store stale comments). The backend "redundant setattr" nit was deliberately NOT changed (the proposed fix would break imports). Version stays **2.1.2** (user chose not to bump this review).

Verification: frontend **296 tests** pass + **0 lint errors** + **0 typecheck errors**; backend plugin+DQ **10 pass** + ruff clean on touched; i18n parity clean. All uncommitted, awaiting the user's app test.

---

## 2026-07-16 — Dashboards keep-alive/localized-names + DQ enable-disable/run-history + concept-mapping dedup+filters + deterministic column ids + import UX

- Reviewed by: Claude Opus 4.8 — 4 parallel adversarial Explore sub-agents by feature group (dashboards keep-alive/tabs/filters, data-quality FE+BE, concept-mapping dedup/filters/align, import-seed-storage-entityio-columnid) + reviewer re-verified EVERY reported finding directly in source and **reproduced the two data-integrity ones empirically** (column-id parity divergence computed in both TS+Python; DQ authz gap confirmed against the schema).
- Range: d0077b07..950d711f (**46 commits, 141 files, ~4,700 insertions / ~1,688 deletions**). Note: the first commit in range (`b9c4f13a`) is the 2026-07-13 review's own fixes landing — verified clean. Highlights: dashboards **keep-alive** (visited leaf grids stay mounted across tab levels, parked with `visibility` not `display:none`, memoized WidgetGrid + narrowed store subscription so tab switches don't re-render kept-alive grids), **localized tab/widget name+description** (LocalizedString migration + backfill, Edit modal, hover tooltips), edit-mode filter-column change; **data-quality** enable/disable checks + inline rename + delete modal + bulk edit + **scan-run history** (client-only + fullstack, reopenable modal) + shared concept datatable/SQL highlight in Results; **concept-mapping** dedup source concepts on (vocab, code) via a `source_concepts_raw`→`source_concepts` QUALIFY view (client + server in lockstep), multi-select searchable filters (mapped-by/concept-class/standard), multilingual filter labels, Valid column, align-onto-resolved-concept; **deterministic name-derived column ids** (`col_<slug>`, client `column-id.ts` + server `column_id.py` twins with a shared fixture) replacing volatile `col-<stamp>-<idx>`; import-error dialog (scrollable/closable), unified server-mode notice (+ drop in-browser git clone), git-link for catalog/dq/schema-preset, seed re-seed tolerance + HTML-fallback rejection. Version 2.1.1 → **2.1.2** by this review.
- Last reviewed commit: 950d711f88fbd4c27022841218cbeb096ecec59f
- Verdict: **Fix-then-ship** — 1 🔴 (DQ run-history authz gap, server-mode) + 3 🟠 (widget destructive actions in view mode; concept-mapping filter Binder-Error on file sources w/o terminology column; column-id client↔server parity divergence). **User approved fixing all findings; applied this review (uncommitted, awaiting app test).**
- Tests: frontend **279 passed** (24 files) · backend **419 passed / 2 skipped** (Postgres-only, run via `apps/api/.venv` — ambient python lacks greenlet/aiosqlite) · Lint: **0 errors** (147 pre-existing React-Compiler warnings) · Frontend typecheck: **0 errors** · i18n: all new keys in both en/fr (only the 4 pre-existing `data_sources.detail_visit*` mismatches remain).
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). The DQ authz 🔴 is server-mode-only → weighted accordingly, but it's a real authz bypass so it was fixed.

Findings (all re-verified in source):

**🔴 CRITICAL (server-mode; fixed):**
- 🔴 dq_rule_sets.py:197 (`create_run`) + schemas/dq_rule_set.py:107 — **run-history write skips authz when `ruleSetId` is null.** `DqRunHistoryCreate.rule_set_id` was `str | None` (unlike the required `str` on `DqCustomCheckCreate.rule_set_id`), and the permission check was `if body.rule_set_id`. Any authenticated user (incl. zero workspace access) could POST a run with no `ruleSetId` → arbitrary `dq_run_history` row with a client-controlled `workspace_id` + `report` blob. The frontend always sends a rule_set_id, so it's API-abuse not a functional bug. Fix: `rule_set_id` made required (422 on omission), the permission check is now unconditional, and `workspace_id` is **stamped from the rule set** server-side (client value ignored). Regression test `test_create_run_requires_rule_set_and_membership` (422 on null, 403 for non-member, spoofed workspaceId overwritten).

**🟠 IMPORTANT (fixed):**
- 🟠 WidgetCard.tsx:124 (menu) + WidgetGrid.tsx:428-433 — **the "unify widget menu" commit exposed destructive actions in view mode.** Collapsing `viewMenuItems`/`menuItems` made the hover kebab show Delete/Edit/Configure/Duplicate/Move regardless of `editMode` (edit-mode itself is `canWrite`-gated). Server rejects a viewer's write and client-only is single-user, so no hard breach — but a writer could delete/move outside edit mode and the UI shouldn't offer it to a viewer. Fix: structural/destructive items gated behind `editMode`; Export + accept-plugin stay in view mode; the trigger only renders when `editMode || hasViewActions` (no empty menu button).
- 🟠 mapping-queries.ts:264 (`tupleInClause`) — **mapping-status/suggestion filter Binder-Errors on a file source mapped WITHOUT a terminology column.** The refactor switched the predicate from `concept_id IN (…)` (always present) to `(vocabulary_id, concept_code) IN (…)`, but such a source's `source_concepts` view has no `vocabulary_id` column (engine.ts:903) — all keys carry empty vocab (`\0code`). Fix: when every key has empty vocab, emit `concept_code IN (…)` instead (mirrors `source_concepts_dedup_partition`'s own fallback). Test added.
- 🟠 column-id.ts:20 vs column_id.py:25 — **client↔server column-id parity divergence for combining marks.** TS stripped only U+0300–U+036F; Python strips all Unicode `Mn` (a superset: Cyrillic/Hebrew/Arabic combining marks). Reproduced: header `"a<U+0483>b"` → TS `col_a_b`, Python `col_ab`. Since the util exists SPECIFICALLY for row-key parity (Parquet cache vs IndexedDB), a mixed-script header silently drifts row keys on export/reimport or fullstack↔client. Fix: TS now `.replace(/\p{Mn}/gu, '')` + a mixed-script parity fixture case (both twins → `col_ab`).

**🟡 MINOR (all fixed except two carried):**
- 🟡 DqChecksTab.tsx:281/290 (`'Query returned no rows'`, `stats` string) + DqHistoryDialog.tsx:100 (`{failed} failed`) — hardcoded English → new i18n keys `data_quality.test_result_no_rows`/`test_result_stats`/`history_failed` (en+fr), wired.
- 🟡 ConceptDetailSheet.tsx:568 — **relations/synonyms tab goes blank on concept-switch.** The concept-change effect read `relations.length` from the same-commit closure (stale, previous non-empty) so the `=== 0` guard skipped the reload, and the reset effect's `setRelations([])` didn't re-fire the effect (deps unchanged). Fix: refetch unconditionally via loader refs when tab/concept changes (reset already cleared the data). Moved below the loader `useCallback`s (TS use-before-declaration).
- 🟡 export.ts:23-28 docstring + engine.ts:931 comment — **actively described dedup/return-value the function doesn't do** (it stores the CSV verbatim; dedup happens downstream in the view, returns `void`). Corrected both.
- 🟡 CreateMappingProjectDialog.tsx:334 (`countDuplicatesWasm`) — **registered DuckDB file buffer never dropped** → a full CSV copy leaks per mapping edit for the DB lifetime. Fix: `db.dropFile(tmpName)` in a `finally` (mirrors scores-engine).
- 🟡 DqResultsView.tsx:94 — lone `console.error` swallowing a scan failure with no user feedback. Fix: `scanError` state + a destructive banner (new key `data_quality.scan_failed`); console call removed.
- 🟡 DqRuleSetDetailPage.tsx:95 — run id `run_${Date.now()}` (same-ms PK collision) → `crypto.randomUUID()`; the fire-and-forget `updateRuleSet`/`addRunHistory` now `void … .catch(console.warn)`.
- 🟡 dashboard-filters.ts:117 — `buildTabFilterChips` dead (zero callers after the tab-chip indicator was removed) → deleted (no orphaned imports).
- 🟡 WidgetGrid.tsx:235 — stale `display:none` comment (parking now uses `invisible`) → corrected.
- 🟡 seed-loader.ts:212 — over-broad HTML-rejection regex on the shared `fetchText` (`a\b` alternative + weak boundary would drop legit CSV/markdown/code starting with `<a>`/`<meta>` etc.) → tightened to match `fetchMarkdown`'s guard (app-shell openers on word boundaries, no `a`).
- 🟡 validity-badge.tsx:24 — hardcoded English tooltips (`Valid`/`Upgraded`/`Deleted`/`Invalid (…)`) in a `lib/` component → `useTranslation` + new keys `concept_mapping.validity_valid/_upgraded/_deleted/_invalid` (en+fr).
- 🟡 MappingEditorTab.tsx:164/518 — `mappingStatusMapRef` write-only dead ref (post-refactor) → removed (the `mappingStatusMap` useMemo it mirrored is still used).
- 🟡 vite-plugin-seed-hashes.ts:231 — added a note that the etlPipeline hash intentionally covers only `_pipeline.json` (tree/scripts change-detected via `etlScript` entries).
- 🟡 **NOT changed (carried):** DashboardItemEditDialog empty-description persists as `{en:'',fr:''}` not `undefined` (behaviorally harmless; the `onSave` contract is non-optional `LocalizedString`, so the fix would ripple into the type + store — deferred). SchemaPresetsPage still uses an inline AlertDialog instead of the new `ImportErrorDialog` (schema-preset errors are short i18n strings, no raw payload — uniformity nit, deferred).

Verified sound ✅ (actively probed, no finding):
- **Keep-alive/memoization core:** narrow store subscription (dropped `activeTabId`) doesn't drop needed re-renders — filter mutators produce new `activeFilters` refs and tab CRUD new `tabs` arrays; `widgetsByTab` slices stable across tab switch; `handleRequestExport` useCallback-stable → `memo(WidgetGridImpl)` genuinely bails on tab switch; `visitedTabIds` reset on dashboard change; parking uses `invisible` (layout box kept) — no chart redraw/animation replay, no state leak.
- **DQ backend access control:** every run-history route funnels through `_load_rule_set`/`_load_run` → `check_workspace_permission` at the right tier (read/write); all ORM-bound, no raw SQL. `create_run` upsert idempotent-by-id (client re-send running→success). `distinct_values` new endpoint: `search` bound as `?`, `col_id` via `_quote_ident` + validated against real columns (404 else), `limit` clamped.
- **Dedup determinism:** client (engine.ts) and server (db_connect.py) use identical `QUALIFY row_number() OVER (PARTITION BY <same cols> ORDER BY concept_id) = 1`; partition falls back to `concept_code` when no terminology column, on both sides.
- **SQL safety:** all dynamic *values* through `esc()`/bound params; `dedup_partition` is fixed literals (no user input); frontend `discoverColumns`/`discoverTables` interpolate only the regex-sanitized `schema` + catalog-derived `tableName` into string literals (pre-existing pattern; the new `table_catalog` clause reuses the same sanitized value).
- **column-id parity (post-fix):** shared fixture asserted by both `column-id.test.ts` and `test_column_id.py`; the new Mn/mixed-script case agrees (both → `col_ab`); Latin accents unchanged.
- **Cross-workspace import clobber (last review's 🟠):** fix confirmed still correct — `_projectsRaw` is global, a plain import mints a fresh uid only on a cross-workspace uid collision (same-workspace still overwrites for git round-trips), `lineageId` preserved.
- No new `any`, no `console.log`, no dangerouslySetInnerHTML, no secrets in touched files.

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-16

The user approved fixing **all** findings. All applied (see per-finding notes above): DQ authz 🔴 + regression test; the 3 🟠 (widget view-mode gating, concept-mapping filter fallback + test, column-id `\p{Mn}` parity + fixture); and the 🟡 batch (DQ i18n keys ×4, ConceptDetailSheet relations/synonyms refetch, export/engine docstrings, WASM buffer dropFile, DQ scan-error banner, run-id UUID + persist .catch, dead `buildTabFilterChips` + `mappingStatusMapRef` removed, WidgetGrid comment, seed-loader regex tighten, validity-badge i18n, seed-hasher note). Two 🟡 left as carried follow-ups (DashboardItemEditDialog empty-description type-ripple; SchemaPresetsPage ImportErrorDialog uniformity). Version 2.1.1 → **2.1.2**.

Verification: frontend **279 tests** pass + **0 lint errors** + **0 typecheck errors**; backend **419 passed / 2 skipped** + ruff clean on touched files; i18n parity clean (only the 4 pre-existing `detail_visit*`). All uncommitted, awaiting the user's app test.

---

## 2026-07-13 — Concept-mapping pull/merge + server-owned renders (viewer-RCE fix) + provenance/lineage + alembic collapse + UI unification

- Reviewed by: Claude Opus 4.8 — 4 parallel adversarial Explore sub-agents (render builders, git backend + pull-sync, provenance/entity-io/**alembic-collapse completeness**, frontend UI + pull UI) + reviewer re-verified every reported finding directly in source (git command-injection reproduced by reading `_run`; the two data-loss/i18n front-end findings re-read in the components).
- Range: dd96b39a..d0077b07 (**69 commits, 219 files, ~12,310 insertions / ~4,607 deletions**). Highlights: concept-mapping **pull** (pure 3-way `merge.ts` keyed on source+target not id, `pull.ts` glue, pull-preview/pull-file/sync-state endpoints, PullResolveDialog/PullMappingsTable, apply-to-DB + anchor advance); **server-owned renders** closing last review's 🔴 (viewer-RCE via `purpose="render"`) — 9 `services/execution/render/*.py` builders run static per-kind Python injecting only a validated spec, `render` refused on `/execute`, new `POST /execute/render` gated at project-read; git versioning (cheap oid sync-state, LFS overrides in status/diff, git isolated from ambient creds, versioning UI for ETL/catalogs/DQ/schema/plugins); author/org **provenance** (editable, org snapshot on standalone entities, ORCID/email re-link on import) + **lineageId** cross-instance identity; **alembic collapse** (all ~30 migrations → one `669558a7416a_initial_schema`); shared list-page toolbar (`list-sort.ts`) + unified card UI across 13 list pages. Version 2.1.0 → 2.1.1 by this review.
- Last reviewed commit: d0077b074e41e02c5e1b7171260cb63a702d8f8c
- Verdict: **Fix-then-ship** — 1 🔴 (git `synced_oid` command-injection, server-mode/write-tier) + 3 🟠 (git `branch` injection; project cross-workspace import clobber = data loss; missing i18n key rendering a raw key). **Nothing fixed yet — awaiting user direction.**
- Tests: frontend **250 passed** (23 files) · backend **393 passed / 2 skipped** (Postgres-only) · Lint: **0 errors** (148 pre-existing React-Compiler warnings) · Frontend typecheck: no new errors on touched files.
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). The git command-injection findings are server-mode-only → severity weighted accordingly, but they are real RCE-class subprocess injection so they must be closed before any server deployment.

Findings (all re-verified in source):

**🔴 CRITICAL (server-mode; new surface this range):**
- 🔴 git_service.py:479 + :602 (`sync_state`/`pull_preview`) — **command injection via `synced_oid` into `git fetch`.** `synced_oid` is client-supplied (`GitSetSyncStateRequest.synced_oid: str`, schemas/git.py:82 — **no format validation**), persisted verbatim, and this range added two paths feeding it to `_run(repo, "fetch", "-q", url, synced_oid)`. `_run` passes `*args` to `subprocess.run(["git","-C",repo,*args])` with **no `--` separator** (confirmed at git_service.py:238), so an anchor like `--upload-pack=touch /tmp/x` is honored by `git fetch` → arbitrary command execution on the API host. Write-tier gated (`concept-mapping:write` = workspace editor), but an editor should not get host RCE. Pre-range `synced_oid` only reached `merge-base --is-ancestor` (harmless), so the exposure is genuinely new. Fix: validate `synced_oid` against `^[0-9a-f]{7,40}$` in the schema (and reject non-oid in `set_oid`).

**🟠 IMPORTANT:**
- 🟠 git_service.py:264/274/462/865 (+checkout `-B` at :267/:277) — **command injection via `branch`** (pre-existing pattern, EXTENDED by the new `sync_state`/pull reachers). `branch` is a client Form/query string through `_default_branch` (git.py:71-75, no validation) passed as a positional refspec (no `--`) to `ls-remote`/`fetch`/`push`/`checkout`; `--upload-pack=<cmd>` / `--receive-pack=<cmd>` = RCE. Reachable at the **read** tier (`concept-mapping:read` / `project-settings:read`) — lower bar than the 🔴. Fix: validate `branch` once in `_default_branch` (reject `startswith("-")`, allowlist `^(?!-)[\w./-]+$`).
- 🟠 ProjectsPage.tsx:221 (+conflict check :264-267) — **cross-workspace project-import clobber = silent data loss (shipping build).** The conflict check is scoped to the current workspace (`p.workspaceId === currentWs`, intentional: "same project in another workspace = independent copy"), but plain import keeps `uid = project.uid` verbatim and unconditionally runs `deleteProjectData(storage, uid)` + `storage.projects.delete(uid)`. If that uid already exists in a **different** workspace, the "independent copy" **deletes the other workspace's project** instead. The mapping-project path already guards this (MappingProjectListPage.tsx:202-203 regenerates the local id on a global uid collision). This runs in the WASM shipping build → highest real-world impact of the batch. Fix: global `getById(uid)` collision check; regenerate uid (keep lineageId) when the uid lives in another workspace.
- 🟠 PullMappingsTable.tsx:151 — **missing i18n key `concept_mapping.col_target_concept_code`** (absent from BOTH en.json and fr.json — verified). The "Target concept code" column header renders the raw key string. `col_source_concept_code` and the other target-side keys all exist. Fix: add the key to both locales mirroring `col_source_concept_code`.

**🟡 MINOR / latent:**
- 🟡 PullResolveDialog.tsx:34/70/148 — **stale pull draft.** `_draftCache` (module-level Map) keyed only on `projectId|branch`; the effect returns early when a cache entry exists (:70) and only clears on **successful** apply (:148). Close-and-reopen (or a remote that advanced meanwhile) reuses the stale BASE/REMOTE snapshot + stale `remoteHead`; applying then advances the sync anchor to a stale head. Fix: invalidate the draft when `syncState`/`remoteHead` changes (or key the cache on `remoteHead`).
- 🟡 regression.py:38 — `confidenceLevel = float(spec.get(...,95))` not finite/range-checked (unlike kaplan_meier.py:37-39). A crafted spec `confidenceLevel:"inf"/0` → `NaN`/degenerate CI → `NaN` in JSON output → invalid JSON on the wire → the component shows an error. Fix: mirror kaplan_meier's finite check + clamp to [1e-6, 100].
- 🟡 key_indicator.py (validate_spec) — `chartBins`/`decimals` coerced via `int()` but not clamped; a crafted spec `chartBins:0` → div-by-zero (500), `decimals:-1` → `format()` ValueError (500). Render endpoint is viewer-reachable, so a crafted spec 500s rather than returning a clean empty chart. Fix: clamp `chart_bins=max(1,...)`, `decimals=max(0,...)`. (statistical_tests.py:39 `alpha` has the same unguarded-`float()` shape — lower likelihood.)
- 🟡 author_provenance.py:64 — import re-links author by ORCID/email from an attacker-controlled ZIP → an entity can display "authored by <victim>". **No privilege** is granted (authz never keys on provenance — verified), so acceptable; optional mitigation: only re-link on verified ORCID, or mark imported authors as "claimed".
- 🟡 card-meta-footer.tsx:86 — org `type:'other'` renders `t('workspaces.org_type_other')` and ignores `customType`, unlike WorkspaceHomePage.tsx:142. Display inconsistency, no crash.
- 🟡 list-sort.ts:55 — name comparator `acc.name(a).localeCompare(...)` has no null guard; type-guarded today (all callers pass `localized(...)` → string) so not live. Fix: coerce `?? ''` + add a null-name test.

Verified sound ✅ (actively probed, no finding):
- **Viewer-RCE 🔴 fix (last review) is CLOSED:** `purpose="render"` is explicitly refused on `/execute` (execution.py:94-98); `/execute/render` runs server-owned per-kind Python and embeds the client spec as DATA via `json.dumps(json.dumps(spec))` + `_json.loads(...)` (verified in all 9 builders — column names are dict-keys/DataFrame lookups, never spliced into source). No injection path in any render builder. Gated at `project-summary:read` (correct: the code is server-owned, a viewer may see widgets).
- **alembic collapse is COMPLETE:** all 41 model tables + every `mapped_column` (author fields, `organization` JSON, `lineage_id`/`parent_lineage_id`, `git_remote_config`/`git_remote_secret`, `git_sync_state`, `execution_sessions`, `entity_visits`, dashboards, `concept_stats_cache`, `stats_cache`) cross-checked against `669558a7416a_initial_schema.py`; `down_revision=None`, single head, no dangling refs to deleted migrations. A fresh `alembic upgrade head` yields a runnable schema.
- **git security core (regression check):** token still injected per-call via `_with_credentials`, never written to `.git/config` (the new LFS smudge in `pull_file_bytes` restores the clean URL in a `finally`), scrubbed from errors (`_scrub`), never returned by any new schema; `_reject_internal_host` (SSRF) present before every new network op (sync_state/pull/verify/clone/push/branches); `_safe_join` guards `pull_file_bytes` path twice + an allowlist to the 2 managed filenames; non-interactive env + timeout intact.
- **git authorization:** every new mapping-project git route funnels through `_load_mapping_project(..., permission)` → `check_workspace_permission`; tiers correct (reads → `concept-mapping:read`, `set-sync-state`/`commit-push` → `concept-mapping:write`); sync-state trusts the DB anchor (client oid only mis-reports behind/diverged, doesn't bypass the push guard); `mapping_status.py` + stats services build queries entirely from ORM expressions + bound params (no raw SQL).
- **3-way merge core (merge.ts):** keyed on source+target (id is regenerated on import — correct); optional-aware equality treats null/undefined/'' as empty; delete only classified when local==base (safe auto-delete); both-changed→conflict incl. delete-vs-edit; clean no-ops omitted. Pull-resolution defaults reflect the plan (clean add/update/delete kept, conflicts→remote, nothing silently dropped). Covered by merge.test.ts (new).
- **provenance round-trip (entity-io):** `INSTANCE_FIELDS` strips createdById/organization/owner/workspace/git/timestamps on export but keeps the `createdBy`/`createdByDetails` snapshot + lineageId/parentLineageId; `dropForeignAuthorId` clears foreign createdById on import; org travels by UUID inline or as a workspace sidecar. lineageId never an access key; collision→regenerate-id path correct for mapping projects. Tested.
- **git-sync-store `statusGen` race guard** (from the 2026-07-12 fix): intact and correct (bump-on-entry, three discard guards, reset() invalidation). PullResolveDialog preview-fetch uses a `cancelled` flag (no setState-after-unmount). No new SQL raw-interpolation, no dangerouslySetInnerHTML, no secrets, no console.log, no new `any` in touched files; largest touched file 553 lines (under 800).

Carried follow-ups (non-blocking): render spec finite/range clamps (regression confidenceLevel, key_indicator chartBins/decimals, statistical_tests alpha); PullResolveDialog stale-draft invalidation; provenance import "claimed vs verified" author display; card-meta-footer customType; list-sort null-name coerce+test. Pre-existing/systemic (out of scope): the `workspace_id is None → no access check` pattern (belongs to the planned access-group rework); the 4 `data_sources.detail_visit*` EN/FR mismatches.

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-13

The user approved fixing **all** findings. Applied:

**Git command-injection (🔴 synced_oid + 🟠 branch), server-mode:**
- **`synced_oid` validated at the API boundary** (schemas/git.py) — `GitSetSyncStateRequest.synced_oid` gets a `field_validator` enforcing `^[0-9a-f]{7,64}$`, so an `--upload-pack=<cmd>` anchor 400s before it can reach `git fetch`.
- **`branch` + `synced_oid` hard-guarded in the service** (git_service.py) — new `_safe_ref` (git-refname allow-list `^[A-Za-z0-9_][\w./-]*$`, rejects leading `-`/spaces/metachars) and `_safe_oid` (`^[0-9a-f]{7,64}$`) called at the top of every public function that feeds one to git argv: `status`, `sync_state`, `pull_file_bytes`, `pull_preview`, `diff`, `commit_push`, `clone_to_zip`. `_run` still has no `--` separator, but a poisoned value can no longer reach it. Defense-in-depth: the service validates even DB-sourced anchors, not just fresh client input. Tests: `test_set_sync_state_schema_validates_oid`, `test_safe_ref_rejects_option_injection`, `test_safe_oid_rejects_option_injection`, `test_sync_state_rejects_malicious_branch_and_oid`.

**Project cross-workspace import clobber (🟠, shipping build):**
- **ProjectsPage.tsx `doImport`** — a plain (non-duplicate) import now mints a fresh `uid` (keeping `lineageId`) when the ZIP's uid already belongs to a project in **another** workspace, so the delete-then-create no longer wipes that other workspace's project. A same-workspace overwrite still reuses the uid (correct). Mirrors the global-collision guard in MappingProjectListPage.

**Missing i18n key (🟠):**
- **`concept_mapping.col_target_concept_code`** added to both en.json ("Target concept code") and fr.json ("Code concept cible") — PullMappingsTable.tsx:151 no longer renders the raw key.

**Render spec numeric guards (🟡, crafted-spec 500 / invalid-JSON):**
- **regression.py** confidenceLevel + **statistical_tests.py** alpha — reject non-finite, clamp to range (mirrors kaplan_meier); **key_indicator.py** chartBins clamped ≥1 (div-by-zero) and decimals ≥0 (format() error). Tests added in test_render.py.

**Stale pull draft (🟡):**
- **PullResolveDialog.tsx** — takes a `remoteHead` prop (from the panel's `syncState`); a cached draft whose `prepared.remoteHead` differs is discarded before it seeds state, and `remoteHead` is an effect dep so a mid-open remote advance refetches. Closes applying an out-of-date merge / advancing the anchor to a stale head. `GitSyncPanel` passes `syncState?.remoteHead`.

**UI/robustness nits (🟡):**
- **card-meta-footer.tsx** — org `type:'other'` now renders `customType` (mirrors WorkspaceHomePage) instead of the generic `org_type_other`.
- **list-sort.ts** — name comparator coerces `?? ''` so a null/undefined name can't throw and break the whole sort; null-name test added.

The 🟡 provenance import "claimed vs verified" author display was **not** changed — it's a UX-policy choice (no privilege is granted; authz never keys on provenance), left as a carried follow-up for the user to decide the wording.

Verification: frontend **251 tests** pass + 0 typecheck errors on touched files (the 2 `entity-io.test.ts` errors are pre-existing backlog, untouched by this diff); backend **405 passed / 2 skipped** + ruff clean on all touched files. Version 2.1.0 → **2.1.1**. All uncommitted, awaiting the user's app test.

---

## 2026-07-12 — Git versioning backend + permission-catalogue rework + plugins/schema-preset/dialog UX

- Reviewed by: Claude Opus 4.8 — 4 parallel adversarial Explore sub-agents (permissions+migrations, backend services, frontend git/LFS, plugins/schema/dialogs) + reviewer read the git backend directly; **every reported finding re-verified in source (and reproduced where testable) before reporting**.
- Range: 5137bc09..dd96b39a (**89 commits, 275 files, ~11,105 insertions / ~3,795 deletions**). Pinned to the HEAD at review start per the user's request (ignore any later commits). Highlights: server-side git versioning (git_service/git route/git_secret + LFS, per-file LFS control, verify-remote + server-side clone-to-zip replacing the browser CORS proxy) with frontend GitSyncPanel/GitRepositoryTab/GitDiffDialog/git-sync-store; a full permission-catalogue rework (per-resource RWD catalogue, 3-tier split, atomic-permission UI gating everywhere, render/execute perms separated from ide:execute, members management owner-only) with ~7 Alembic migrations; new backend services (scores_service, blob_cleanup ref-counted, stats_cache, entity_visits, global_table fuzzy/multi-select); plugins rework (PluginSettingsDialog + per-workspace seeding + row-id/manifest-id split); schema-preset store/rename/actions; dialog Enter-key fix + single-line descriptions + settings-tab trim; export strips instance fields + deterministic id remap for stable git round-trips.
- Last reviewed commit: dd96b39aac8bb8c1b5e095183e77df235365cab8
- Verdict: **Fix-then-ship** — 1 🔴 (server-mode authz policy) reported for the user's decision, not fixed unilaterally (per the deferred-authz-pass precedent); 3 🟠 front-end/robustness fixes recommended. **Nothing fixed yet — awaiting user direction.**
- Tests: frontend **201 passed** (20 files) · backend **324 passed / 2 skipped** (Postgres-only) · Lint: **0 errors** (145 pre-existing React-Compiler warnings) · Ruff: clean · i18n: all new keys present in both en/fr (only the 4 pre-existing `data_sources.detail_visit*` mismatches remain).
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). The git versioning + permission + service findings are all server-mode-only → severity weighted accordingly, but the git backend is the largest new attack surface yet, so it was read line-by-line.

Findings (all re-verified in source):

**🔴 CRITICAL (server-mode; reported for the user's authz decision — NOT fixed unilaterally):**
- 🔴 execution.py:90-92 + :168 (`execute_code`) — **viewer can run arbitrary server-side code via `purpose="render"`.** The `render` branch gates only on `project-summary:read` (viewer tier) on the theory that a built-in component's aggregation is "generated code, no user interpreter". But `/execute` runs the client-supplied `body.code` verbatim (`out = await k.execute(code, …)`) with NO server-side check that the code is component-generated. A viewer POSTs `{purpose:"render", language:"python", code:"<anything>"}` → arbitrary Python/R in that project's working dir. CORRECTION to the sub-agent's framing: the resource-execute purposes (dashboards/datasets/patient-data) do NOT reach viewer — `_LADDER["read"]={"read"}`, so `_catalogue_perms("read")` yields no `:execute`; ONLY `purpose="render"` is the viewer-accessible hole. Same trust-the-frontend-shaped-request family as the accepted "editor SQL reads local files" residual. Fix options: require a real `:execute` for all `/execute` calls; or for `render`, server-generates the aggregation from a structured spec and refuses a free-form `code` field.

**🟠 IMPORTANT (recommended fixes):**
- 🟠 git_service.diff:373 (`new_file = repo / path`) + git.py:84-99 (`project_diff`/`workspace_diff`/`mapping_project_diff`) — **arbitrary server-file read via the diff endpoint.** `path` is a client Form field, unvalidated; `repo / "../../../../etc/passwd"` resolves outside the repo and its `.read_text()` result is returned as `newContent`. Reproduced with pathlib. Reachable by anyone with `project-settings:read`/`workspace-settings:read` (viewer). The ZIP-unpack path IS traversal-guarded (git_service.py:287); the diff `path` is not. Fix: reject `path` containing `..`/absolute, or resolve and assert it stays inside `repo` (mirror `_safe_join`). Note: the `git show HEAD:{path}` old side is safe (git rejects `..` in a rev). Server-mode only.
- 🟠 git.py:317-342 (`/verify-remote`, `/clone`) — **SSRF: any authenticated user makes the server issue git network requests to an arbitrary URL** (`http://169.254.169.254/…`, internal services). By design for the import flow (server-side clone replaces the browser CORS proxy), but unbounded. Fix: block link-local/loopback/private hosts (or an allow-list of git hosts) for the clone/verify targets. Server-mode only.
- 🟠 git-sync-store.ts:94 (`refreshStatus`) — **out-of-order status responses (race).** No request sequencing/abort; triggered from 4 places (mount, branch change, refresh button, includeData toggle). A slower earlier response calls `set({status,selected})` last and wins → the panel shows a status computed for the wrong `includeData`/`branch`, and the selection re-seed keys off the stale status. Same bug-class as the last review's GlobalSummaryView fix; `GitDiffDialog` already uses the correct `cancelled` guard. Fix: monotonic request-id (or AbortController) in the store; drop superseded results.
- 🟠 SchemaPresetsPage.tsx:1323/1516-1531 (`confirmCreatePreset` + Create button/Enter) — **the schema-preset Create dialog silently overwrites an existing preset on a duplicate identifier.** It renders an `EntityIdField` with `existingIds` (shows the warning) but neither the button, the Enter handler, nor `confirmCreatePreset` blocks on `isEntityIdValid(newPresetId,…)` — they gate only on name-duplicate. A distinct name + duplicate id → `savePreset` upserts by `presetId` (store:37-46) → the existing preset's mapping is overwritten. This is exactly the bug-class `dd96b39a` set out to fix for the SQL/ETL dialogs but missed here. Fix: gate all three on the id validity (empty already falls back to a random `custom-…`).

**🟡 MINOR (latent / low-risk):**
- 🟡 permissions.py migrations 4d744166dce4:30 & e9e7ec8fd6eb:21 & 0e1743d6bfc2 & 620b1821e106 — **data migrations import LIVE `_catalogue_perms`/`PERMISSIONS` instead of hardcoding the literal perms they meant to grant/revoke at authoring time.** Final state is correct today (viewer has no `:execute` because `_LADDER["read"]={"read"}`), but the render-execute grant + its "viewer loses render-execute" clawback are both no-ops against current code — their real effect depends on which code revision runs them. Fix: freeze the intended permission lists as literals inside each migration so effect is deterministic. Migration chain itself is linear/consistent (no orphan/branch revisions), and no migration grants a write perm to viewer (verified).
- 🟡 global_table_service.py:277 (`cache_path`) — client `signature` interpolated into the cache filename unvalidated; constrained by the `{ws}__{mode}__…` prefix + `.parquet` suffix + `.exists()` gate, but should validate `^[0-9a-f]{16}$` (it's a sha256 prefix) like blob_store does. Hardening.
- 🟡 deterministic-id.ts:35 — **separator ambiguity: `deterministicId('proj:1','dash') === deterministicId('proj','1:dash')`** (reproduced). Latent only because namespace=project-uid and key=entity-id are UUID-ish (no `:`). Fix: length-prefix or ` ` delimiter. Also: the "no collisions" test uses 9 keys (can't detect a weak hash) — add a large-batch + separator test per the pure-critical-logic convention. FNV-1a×4 itself verified collision-free over 1M mixed pairs.
- 🟡 entity_visit_service.py:19-37 — check-then-insert upsert races on the unique constraint → second concurrent record → IntegrityError/500 (per-user recent-items only). Fix: DB upsert / catch IntegrityError. (`entity_id` is unchecked against ownership but reads are strictly `user_id`-scoped, so no cross-user leak.)
- 🟡 PluginsTab.tsx:211 — stale-editor cleanup guarded by `pluginList.length > 0`, so switching into a genuinely-empty workspace leaves the previous workspace's plugin open. Rare now that every workspace is seeded with built-in plugins. Fix: use a "list loaded for this workspace" flag, not length.
- 🟡 plugin-editor-store.ts:494 — `unregisterPlugin(rowId)` but the registry keys on `manifest.id`; for seeded built-ins (row id = UUID ≠ manifest id) the registry entry lingers on delete. Also createPlugin/duplicate use `user-plugin-${Date.now()}` as PK (same-ms collision). Low-risk.
- 🟡 git-lfs.ts `quotePattern` only handles spaces, not `#`/glob metacharacters in a .gitattributes pattern; export paths are slugified so low risk. GitRepositoryTab keeps the token in component state after a successful connect (in-memory lingering).

Verified sound ✅ (actively probed, no finding):
- **git backend security core:** token is injected into the remote URL only per-call (`_with_credentials`, never written to `.git/config`), scrubbed from all error text (`_scrub`), stored Fernet-encrypted in a dedicated `git_remote_secret` column and never returned by the API (test_git_routes). git runs non-interactive (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`) with a 120s timeout; all git args use `--` before paths (no option injection); ZIP unpack is traversal-guarded; `_clean_url` strips nav cruft (both front + back). Frontend `api/git.ts` sends the token only in POST bodies — never a URL/query/log/localStorage. `stripInstanceFields` guarantees `gitRemoteConfig`/token never gets committed into the repo's own export.
- **permission logic:** no default-to-allow, no KeyError→500 (all `ROLE_ORDER.get(...,99/-1)` fail closed), admin hard-bypass + super-admin/owner distinction correct, override-replaces-inheritance correct, members read=viewer/write=owner. Migration chain linear; no write-perm-to-viewer.
- **SQL safety:** scores_service uses bound `?` params + a static REQUIRED_COLUMNS; global_table_service `_where`/`_fuzzy_search`/`distinct_filter_values` escape all values (`_esc` quote-doubling) and use only allow-listed/constant column idents + int-cast limit/offset; the new fuzzy + multi-select `IN(...)` build only from escaped values.
- **blob_cleanup ref-counting:** re-checks every (model, sha-column) pair after the cascade delete before deleting a blob — a sha still referenced anywhere is preserved (content-addressed dedup respected); per-project delete doesn't touch workspace-scoped blobs.
- **access control on changed routes** (dashboards/data_sources/data_catalogs/attachments/mapping_projects) migrated cleanly to `check_*_permission` at the right tier; `preview_file_columns` now requires `concept-mapping:write` on a supplied workspaceId (was ungated); `query_file_source` raised viewer→write.
- **Dialog Enter-fix (dd96b39a):** the `handleSubmit` guards match the `disabled` conditions exactly (SQL/ETL); catalog description wired into both create & edit; Textarea→Input conversions don't touch submit logic. Clean.
- **pure logic:** git-lfs (strict `>` threshold, case-insensitive ext, override honoring), git-file-classify (datasets/ prefix + ext, metadata-vs-data), entity-io strip/remap round-trip (id/parentId/uid NOT stripped) — all tested; deterministic-id is collision-free at scale (1M pairs) modulo the separator caveat.

Carried follow-ups (non-blocking): migration-literalize-perms; global_table signature validation; deterministic-id delimiter + tests; entity_visit upsert race; PluginsTab empty-workspace cleanup + registry unregister-by-manifest-id. Pre-existing (out of scope): the 4 `data_sources.detail_visit*` EN/FR key mismatches; `workspace_id is None → no access check` systemic pattern (belongs to the planned access-group rework).

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-12

The user approved fixing the 🟠 diff-traversal, 🟠 SSRF, and 🟠 schema-preset id-guard, plus the 🟠 refreshStatus race. Applied:
- **git diff path traversal** (git_service.py) — new `_safe_join(tree, rel)` refuses any path resolving outside the repo; used in `diff` (before the `git show` and the `repo / path` read), in `_stage_paths` (commit-push `paths`), and refactored `_unpack_zip_into` to reuse it. Regression tests: `test_safe_join_rejects_traversal_keeps_legit_paths`, `test_diff_rejects_traversing_path`.
- **SSRF on verify-remote/clone/sync** (git_service.py) — new `_reject_internal_host(url)` resolves the http(s) host and refuses loopback/link-local/private/reserved/multicast/unspecified addresses (blocks 169.254.169.254 metadata, localhost, RFC1918). Wired into `verify_remote`, `clone_to_zip`, `_sync_remote_branch`, `commit_push` (push), and `branches`. ssh/git remotes and unresolvable hosts are left for the OS/git (not blocked). Regression test `test_reject_internal_host_blocks_ssrf_targets`.
- **schema-preset create id-guard** (SchemaPresetsPage.tsx) — a single `canCreatePreset` (name present + not name-dup + `presetIdOk`) now gates the Create button, the Enter handler, and `confirmCreatePreset`. `presetIdOk` = non-blank template, OR empty id (→ random fallback), OR `isEntityIdValid` against BUILTIN + current-workspace preset ids. Closes the silent-overwrite-by-duplicate-id hole (the same bug-class dd96b39a fixed for SQL/ETL dialogs).
- **refreshStatus race** (git-sync-store.ts) — module-level `statusGen` counter; each `refreshStatus` bumps it on entry and discards its status/selected/error/loading writes if superseded; `reset()` bumps it to invalidate an in-flight refresh from a closing panel. Mirrors the GlobalSummaryView generation-guard from the 2026-07-10 review.

The 🔴 (viewer runs arbitrary code via purpose=render) was NOT fixed here — the user chose the structured-spec approach (render sends a spec, server generates the code, free-form `code` refused for render), which is a larger cross-cutting change (endpoint + the 9 analysis components) scoped as its own task.

### 🟡 latent fixes applied (second pass, at the user's request) — 2026-07-12

The user then approved all four latent items:
- **deterministic-id separator** (deterministic-id.ts) — join now escapes `:`→`::` inside each part before joining on `:`, so `('a:b','c')` and `('a','b:c')` no longer collide. Verified the escape leaves the common case (UUID inputs, no `:`) byte-identical → already-persisted import ids stay stable (they ARE persisted via importProjectContent→storage.create, so a delimiter that changed the common-case output would have broken every prior import's round-trip). Tests added: `:`-boundary disambiguation + 1M-pair collision-free batch.
- **global_table signature validation** (global_table_service.py) — `cache_path` now rejects any `signature` not matching `^[0-9a-f]{16}$` (it's a sha256[:16]) before it becomes a filename (mirrors blob_store._SHA_RE), closing the path-traversal-into-cache-read hardening gap; `cached_path_or_raise` maps the ValueError to CacheMissing (clean rebuild path, no 500). Tests added.
- **entity_visit upsert race** (entity_visit_service.py) — the check-then-insert now catches IntegrityError, rolls back, and falls through to the update path (extracted `_get` helper), so two concurrent first-visits no longer 500 the loser. Test simulates the stale-read race via a monkeypatched `_get`.
- **PluginsTab empty-workspace cleanup + registry unregister** (plugin-editor-store.ts, PluginsTab.tsx) — new `pluginListWorkspaceId` marker lets the stale-editor cleanup fire even when the target workspace has zero plugins (was gated on `pluginList.length > 0`); `deletePlugin` now resolves the manifest id from the list before `unregisterPlugin` so a seeded built-in's registry entry (keyed by manifest.id ≠ row id) is actually removed.

Verification: frontend tests green + 0 lint/typecheck errors on touched files; backend suite green + ruff clean on touched files. All uncommitted, awaiting the user's app test.

Verification: frontend 202 tests + 0 lint errors + 0 new typecheck errors on touched files; backend git/mapping suites green (30) + ruff clean on git_service.py/test_git_service.py (the 2 F401s ruff reports are in test_dataset_files/test_readme_persist from commit 7df9b5ef, outside this range).

---

## 2026-07-10 — Full-stack second wave: dashboards/members/attachments/global-table + UI role-gating + server-mode data paths

- Reviewed by: Claude Opus 4.8 — by coherent file groups at final state (4 parallel adversarial Explore sub-agents; every reported finding re-verified in source by the reviewer before reporting/fixing).
- Range: 22f01a8c..5137bc09 (**100 commits, 269 files, ~12,255 insertions / ~2,533 deletions**). Highlights: dashboards persistence (routes/service/model), members + 3-dimension RBAC (members router/service, project_member model, my-role endpoints), README/wiki attachments (blob store), concept-stats + concept-list Parquet caches, cross-project global-table service (server-side merge + Parquet paging), warm DuckDB connection pool, execution sessions + per-user kernel/PTY caps, UI role-gating infra (context-role-store, GatedButton, no-access-notice), server-mode data paths (Concepts from Parquet cache, no WASM load in server mode), Docker full-stack deploy, History feature removed. Version 2.0.22→2.1.0.
- Last reviewed commit: 5137bc09edeff95676f0142dd4d5461bf1cffe17
- Verdict: **Fix-then-ship** → 2 front-end UX bugs fixed during review; backend findings are server-mode-only policy items, reported for the user's authz decision (not fixed unilaterally, per the deferred-authz-pass precedent).
- Tests: frontend **168 passed** (16 files) · backend **275 passed / 2 skipped** (Postgres-only skips) · Lint: **0 errors** (151 warnings, all pre-existing React Compiler category) · Typecheck: 0 errors introduced in edited files.
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). Server-mode findings are real but do not affect the current production build → severity weighted accordingly.

Findings (all re-verified in source):

**Front-end (FIXED during review — safe, high-value, aligns with UI-quality priority):**
- 🟠 FIXED — context-role-store.ts:36-43 / 50-53 — **stale-role window on context switch.** On A→B navigation the store kept A's role until the async `/my-role` refetch resolved; during that window a *viewer* of B saw B's settings/Save/Danger controls as enabled (UI-only; server still rejects). Fix: reset role to `null` when the incoming workspaceId/projectUid differs, before awaiting (`atLeast(null)` already denies). Note: `clearProjectRole` remains defined-but-unused — left as a follow-up (wire to closeProject or drop).
- 🟠 FIXED — GlobalSummaryView.tsx:582-620 — **cross-project Table goes permanently blank if a filter/sort changes mid-load.** The filter/sort effect cleared rows then called loadTableRows(0), but the busy-mutex early-return dropped the new page-0 load and the effect wouldn't re-fire → blank table until the next interaction (server mode, large workspace = multi-second window). Fix: added a `tableLoadGen` counter — page-0 loads always supersede an in-flight load (only scroll defers to the mutex), and a superseded request discards its result/state writes. Doubles as the missing out-of-order-response guard.

**Backend (REPORTED, server-mode-only, authz-policy — NOT fixed unilaterally):**
- 🟠 mapping_projects.py:161-190 (`POST /{id}/query`) — a **viewer** can run arbitrary SQL over the project's file-source DuckDB. The connection is a plain `duckdb.connect()` with **no** `enable_external_access=false` / filesystem lockdown (db_connect.query_file_source:296), so the SQL can `read_csv('/etc/passwd')`, `INSTALL`/`LOAD` extensions, etc. → local-file read + privilege issue (viewer should not execute SQL). Fix options: require `editor` (matches code-execution being a distinct powerful capability) and/or lock the file-source connections (`SET enable_external_access=false`, disable arbitrary INSTALL/LOAD). Mirrors the WASM model but server DuckDB has real FS access the browser sandbox lacks.
- 🟠 mapping_projects.py:199-218 (`POST /preview-columns`) — **no workspace/project access check** (depends only on `get_current_user`). Any authed user with a 64-hex sha (blobs are globally content-addressed/dedup'd) can read another workspace's blob column names + row count → cross-tenant schema/row-count leak + drives DuckDB parsing of arbitrary stored blobs. sha format is validated (no traversal) but sha↔resource ownership is not. Fix: require `editor` on a supplied workspaceId, or verify the sha belongs to a resource the caller can access.
- 🟠 db_connect.py:79-84 (`_dsn_value`) — the prior review's DSN-injection fix escapes only the literal **space**, not tab/newline/other libpq whitespace. libpq (and DuckDB's postgres/mysql ATTACH parser, which reuses it) treats any whitespace as a key=value separator → a workspace editor with a `username`/`database` containing a tab could smuggle `host=`/`sslmode=`/`options=` (SSRF / connect redirect). CONFIRMED that only space is escaped; PLAUSIBLE that tab is a separator in DuckDB's impl (not empirically verified). Fix: escape all whitespace (`re.sub(r"\s", ...)`) or reject control/whitespace chars; add a tab/newline regression test (current test_db_connect_dsn covers only space).
- 🟡 mapping_projects.py:141-154 (`set_raw_file`) — an editor can point a project at ANY existing blob sha (no sha↔project ownership check); requires cross-tenant sha knowledge (not enumerable), low impact. Same ownership-gap family as preview-columns.

**Backend robustness (REPORTED, MINOR, server-mode-only):**
- 🟡 db_connect.materialize_parquet:500-510 — temp file named `.tmp-<pid>`; two concurrent concept-cache refreshes of the same source (threadpool, same PID) collide on the tmp path → one COPY fails or the unlink races the other's write (dest rename stays atomic, so no corruption at rest). Fix: per-call-unique temp name (uuid4/mkstemp).
- 🟡 kernel.py per-user cap counts dict keys incl. dead (`not alive`) kernels → a user who crashes N kernels within the idle window is locked out at the cap. Fix: drop `not kernel.alive` entries in the sweep/count.
- 🟡 pty_kernel.py — no idle eviction for PTY shells (kernels get swept, PTYs don't); bounded only by per-user cap + WS lifetime; `session_id = str(id(websocket))` risks id() reuse. Fix: idle sweep for PTYs + uuid4 session id (or document the bound).
- 🟡 concept-mapping robustness: SourceIdTab.assignIds:277-281 breaks silently when a badge range is exhausted (>1M pairs → under-assign with no warning); source-concept-ids-io.ts:45-53 (`parseSourceConceptIdEntries`) doesn't validate compact-row arity (short row → `undefined` fields coerced into the id); `importProjectSourceConceptIds` is exported but dead (the two real import paths reimplement it inline — divergence risk). All non-blocking.

Verified sound ✅ (actively probed, no finding):
- Access control **holds** on the new routers: members (owner-for-writes/viewer-reads + last-owner guard), dashboards (all routes funnel through _require_project_access/_load_*), attachments (README/wiki blobs re-load + enforce scope role before returning bytes; sha 64-hex validated → no traversal), global-table endpoint (check_workspace_role viewer + sort allow-list). The organizations/execution "unguarded router" bug class does NOT recur here.
- SQL safety: global_table_service._where escaping is single-quote doubling (correct for DuckDB literals; sort is allow-listed via _SORT_COLS); global-summary-queries.ts all data via esc() with localized() on names; dataset_rows binds filter/sort values as `?` params + validates column ids before quoting; file_reader routes path/sheet/delimiter through _sql_str. database.py app-DB query is admin-gated (app-database:read) with single-statement check + always-rollback.
- connection_pool: per-key locks, keyed by source.id (access gated before pool use → no cross-project credential leak), all READ_ONLY, invalidated on update/delete. concept_cache_fs: source_id validated by `^[A-Za-z0-9_-]{1,64}$` before FS. kernels keyed by (project,user,lang,env) — can't read another user's kernel; sql_query RPC keeps creds host-side.
- Front gating logic directionally correct: atLeast(null/unknown/'none') denies (no default-to-allowed); admin bypass gated on role==='admin' with permissions absent → deny; revalidate-on-mount under-grants until /auth/me hydrates (safe).
- Export/import round-trip: source-concept-ids survive export→import + cross-workspace re-keying (tested); 10k cap genuinely removed (queryDataSourceAll pages until short page); columnar Arrow ingest has no row/column misalignment.
- i18n parity: all new keys (members.*, common.no_access_*/insufficient_permissions, global_*, source_id_*, import_phase_source_id_registry) present in both en.json and fr.json.

Carried follow-ups (non-blocking): clearProjectRole wire-or-drop; materialize_parquet temp-name race; dead-kernel cap accounting; PTY idle eviction; assignIds range-exhaustion warning; parseSourceConceptIdEntries arity validation + malformed/empty tests; wire or drop importProjectSourceConceptIds; entity-io source-concept-ids wiring untested end-to-end.

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-11

The user approved fixing all three backend authz items too. Applied:
- **query viewer→editor** (mapping_projects.py:171) — `/query` now requires `editor` (was viewer). Also hardened the DuckDB connection that runs the client SQL: new `_lock_down_user_sql` (db_connect.py) disables autoinstall/autoload of known + community extensions and locks the config before running user SQL. IMPORTANT residual, documented in code: DuckDB 1.5.4 CANNOT confine the local filesystem once running (`allowed_directories` can't be set at/after connect, `enable_external_access` can't be toggled and a blanket off breaks the legitimate blob read — verified empirically), so an editor's SQL can still read arbitrary local files. Accepted because /query is now editor-only and editors already hold code-execution (Python/R/SQL IDE) in this app. If tighter isolation is ever required, run these reads in the sandboxed execution kernel instead of an in-process DuckDB.
- **preview-columns access check** (mapping_projects.py:200) — now takes `workspaceId` and requires `editor` on it (was: any authed user with a sha). Frontend threaded through: `previewFileColumnsOnServer(workspaceId, ...)` (mapping-projects.ts) + CreateMappingProjectDialog passes `activeWorkspaceId` (guards null).
- **DSN whitespace** (db_connect.py `_dsn_value`) — now escapes ALL whitespace (`re.sub(r"\s", ...)`), not just space, closing tab/newline DSN-keyword injection. Regression tests added (test_db_connect_dsn.py: tab/newline/CR/FF/VT + a tab-separated injection case).
- Regression test `test_query_and_preview_columns_require_editor` (test_mapping_projects.py): viewer → 403 on both endpoints, editor → 200.

Front-end fixes (from the review pass): context-role-store.ts (stale-role window), GlobalSummaryView.tsx (blank-table generation guard).

Verification: frontend 168 tests + lint 0 errors + 0 new typecheck errors; backend test_db_connect_dsn + test_mapping_projects green (20). Full backend suite re-run pending confirmation.

---

## 2026-07-08 — Full-stack backend review (by coherent file groups) — COMPLETE

Reviewed the 170-commit FastAPI backend landing (`eac0095f..22f01a8c`, 346 files, ~27.5k insertions) **by coherent file groups at their final state**, not commit-by-commit (far less redundant on files touched across many commits; judges the code as it is today). Cursor advanced to HEAD at completion (see FINAL SUMMARY below). All fixes went into one grouped commit.

Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). Server-mode findings are real but do not affect the current production build → severity weighted accordingly.

### Group A — Backend socle (`core/`, `config.py`, `main.py`, `alembic/env.py`, auth_providers) — DONE

- Reviewed by: Claude Opus 4.8 (direct single-pass, final-state read + runtime verification of the fix)
- Verdict: **Fix-then-ship** → 🔴 fixed during review
- Findings:
  - 🔴 FIXED — config.py:25 / .env.example — `secret_key` default `"dev-secret-change-in-production"` could boot in production with **no guard**; it signs all JWTs AND derives the Fernet key encrypting external-DB passwords → forgeable admin tokens + decryptable secrets. Fix (main.py lifespan): refuse boot when `secret_key == default and not debug` (verified: rejects in prod, allows in debug). Mirrors the auth-provider RuntimeError pattern.
  - 🟠 NOT FIXED (documented) — main.py:90-99 — CORS `allow_credentials=True` + free-string `cors_origins`; a misconfigured `*`-ish list in prod would expose credentials. Default is safe. → document explicit origins in .env.example; optionally warn at boot.
  - 🟡 security.py:19-29 — `role` embedded in JWT payload but authz never trusts it (re-reads from DB every request — good). Stale after a demotion; informational only. → drop from payload or comment.
- Verified sound ✅: JWT access/refresh `type` enforced (deps + ws_auth); Fernet key rotation returns None cleanly ([[secrets-at-rest]]); ws_auth replicates HTTP checks with private close code 4401; the CORS-phantom-500 middleware fix is correct; SQLite FK pragma present. Permissions model (global super-admin bypass, `is_system` non-deletable, code-owned catalogue) is the coherence yardstick for the route groups B–I.

### Group B — Auth / RBAC / identity (setup, auth, users, roles, workspaces, projects, organizations, schema-presets + services) — DONE

- Reviewed by: Claude Opus 4.8 (direct single-pass, final-state read + service cross-check)
- Verdict: **Fix-then-ship** (2 authz holes)
- Findings:
  - 🔴 FIXED — organizations.py — create/update/**delete** only depended on `get_current_user` (no admin check; service had none either). `organizations` is a GLOBAL resource → any base `user` could delete any organization. Fixed: create/update/delete → `Depends(get_current_admin)`. Added regression test `test_write_requires_admin` (non-admin gets 403 on POST/PATCH/DELETE, 200 on GET) — it fails against the pre-fix code.
  - 🟠 FIXED — projects.py:30-36 — `create_project` reimplemented the role check with `ROLE_ORDER[member.role]` (direct dict access) → a custom/unknown workspace role raised KeyError → 500. Fixed: reuse `check_workspace_role(db, body.workspace_id, user, "editor")` (DRY + `.get(...,-1)` safe); dropped now-unused WorkspaceMember/ROLE_ORDER/HTTPException imports (ruff clean).
  - 🟡 NOT YET FIXED — projects.py:45-51 — `update_project` lets an editor change `workspace_id` without checking editor rights on the DESTINATION workspace (require_project_role validates only the current one). Left for a follow-up (needs a destination check in update_project or the service).
- Verified sound ✅: first-admin setup gated by `count==0` re-checked in-txn; last-active-admin guard on delete/demote/deactivate (user_service); role perms validated against catalogue, is_system non-deletable, refuse-delete-if-in-use; workspace/project/schema-preset membership scoping correct (admin-sees-all vs WorkspaceMember join); workspace create adds owner membership in same txn (flush before insert); schema-preset save/delete gated by `check_workspace_role("editor")` when workspace-scoped, global presets visible to all.

### Group C — Blob store + Datasets (blob_store, uploads, dataset_parser/fs/type_inference, datasets routes) — DONE

- Reviewed by: Claude Opus 4.8 (direct single-pass, final-state read + traversal/SQL-injection verification in-process)
- Verdict: **Fix-then-ship** (2 real security bugs fixed + tests)
- Findings:
  - 🔴 FIXED — blob_store.path_for(sha) built `_files_dir()/sha` with **no validation**, and `sha` is client-supplied (DatasetImportRequest.sha etc. are free `str`, no pattern). `sha="../../../../etc/passwd"` → arbitrary-file read/parse/return (auth'd editor, server mode). The `exists(sha)` guard didn't help (a traversal target can exist). Fixed: `_SHA_RE = ^[0-9a-f]{64}$` enforced in `path_for` (raises ValueError) — covers read_bytes/delete/path_for across datasets, data_sources, mapping_projects, dataset_files at once; `exists()` returns False for a malformed sha so route guards give a clean 400. New tests/test_blob_store.py (traversal/short/upper/non-hex all rejected).
  - 🟠 FIXED — dataset_parser.py:49 — `sheet` from client parse_options interpolated into the DuckDB `read_xlsx('...', sheet='<sheet>')` string **unescaped** → SQL injection in the DuckDB context (delim was escaped, sheet wasn't). Fixed: single `_sql_str()` helper (doubles embedded quotes) now used for path, sheet AND delim (path too, defense-in-depth). Parser tests + dataset import tests green.
  - 🟡 NOT FIXED — uploads.py — chunked upload enforces **no size limit** (`file_size` stored in _meta, never checked); an auth'd user can fill the disk. Needs a quota/max-size policy (config), left as follow-up.
- Verified sound ✅: `project_fs._safe_join` rejects `..`/absolute traversal for datasets/ & scripts/ rel paths; upload `_session_dir` rejects non-alnum upload_id; blob store is content-addressed (sha = sha256(content)) so a stored sha is always well-formed; dataset access gated by `_require_project_access` (workspace membership, editor for writes); xlsx magic-byte check gives a clean error on renamed CSVs. NOTE: `db_connect.py` + `dataset_rows.py` deferred to Group D (external-DB SQL surface).

### Group D — Data sources + external connections (db_connect, dataset_rows, data_source_service, ide_connections) — DONE

- Reviewed by: Claude Opus 4.8 (direct single-pass, final-state read + DuckDB in-process injection verification)
- Verdict: **Fix-then-ship** (1 real injection fixed + tests)
- Findings:
  - 🔴 FIXED — db_connect._dsn — external-DB `connection_config` (host/username/database) is a free client dict, interpolated **unquoted** into the libpq/MySQL DSN `ATTACH '<dsn>' ...`. A `username` like `x password=STOLEN host=evil.internal` injected extra DSN keywords → connection redirection / SSRF to an internal host / credential smuggling (auth'd workspace editor, server mode). Fixed: `_dsn_value()` double-quotes each value (backslash-escaping `"`/`\`) so it stays one opaque libpq token; `_attach` additionally doubles single quotes in the whole DSN before putting it in the SQL literal (a legit `'` in a password no longer breaks the `ATTACH '...'` parse). Verified in-process: injected username stays one quoted token (no dup top-level keys); a `'`-containing password yields IOException, not ParserException. New tests/test_db_connect_dsn.py.
- Verified sound ✅ (no change needed):
  - dataset_rows.py is **exemplary**: filter/sort values bound as `?` params, column ids validated against `col_types` before `_quote_ident` (unknown ids ignored, never interpolated), LIMIT/OFFSET `int()`-cast. Stats queries interpolate only validated idents + numeric literals.
  - db_connect: `_scope` regex-validates schema/db before interpolation; sources ATTACH READ_ONLY (writes land in DuckDB `memory` catalog only); `introspect_external` doubles quotes for the nested information_schema literal on a validated scope; file/parquet paths are server-derived (sha now validated in Group C). Arbitrary `sql` in query_external/query_file is by-design (SQL IDE over a read-only attach) — the read-only ATTACH is the guardrail.
  - ide_connections reuses data_source's secret pattern verbatim (`_extract_secret`/`strip_secrets`/`crypto.encrypt`; secret never in the returned config) with per-project workspace-membership guards — consistent, matches [[secrets-at-rest]].
  - data_source_service: password stripped from persisted config + Fernet-encrypted; update leaves the stored secret untouched when absent; blob dedup ref-counting on delete.

### Group E — Execution kernels + terminal (kernel, runtime, pty_kernel, execution route) — DONE

- Reviewed by: Claude Opus 4.8 (direct single-pass, final-state read + full execution test suite re-run)
- Verdict: **Fix-then-ship** (1 authz 🔴 fixed + regression test; arbitrary code execution itself is by-design)
- Findings:
  - 🔴 FIXED — execution.py — POST /execute, GET /execute/kernels, POST /execute/restart AND the /execute/terminal WebSocket only checked `get_current_user` — **no project/workspace membership check** (sibling routes dataset_files/ide_files all have `_require_project_access`). Any authenticated user could run arbitrary R/Python/Bash in ANY project's working dir (reaching its scripts/ + datasets/) and, via `connectionId`, query ANY data source (resolver didn't check source access either). Worse than the Group-B orgs hole: cross-project code execution + data exfiltration. Fixed: added `_require_project_access` (editor for execute/restart/terminal, viewer for kernels) + `_require_connection_access` (viewer on the source's workspace) mirroring the sibling pattern; WS checks explicitly after authenticate_ws (dep system doesn't apply to raw WS). Updated kernel tests to create a real workspace-less project (execution now requires the project row to exist — a made-up uid 404s, which is correct: no row → no workspace → no access control possible). New regression test `test_execute_forbidden_without_project_membership` (non-member → 403 on execute/kernels/restart). Full suite: 194 passed / 2 skipped.
  - Also removed a pre-existing dead import in tests/test_execution.py (ruff F401) since the file was in scope.
- Verified sound ✅ (by-design, no change): arbitrary code execution is the feature (RStudio/Jupyter model, documented in runtime.py/pty_kernel.py headers) — isolation is process-level (fresh cwd or per-project dir, hard `execution_timeout_seconds` wall-clock, kill-on-timeout) + application permissions (now enforced). `enable_code_execution` gate honoured on every path. PTY design is careful: `pty.openpty()` + subprocess_exec (only bash fork/exec'd, never the multithreaded uvicorn worker — avoids the classic forkpty asyncio deadlock, well-commented). Kernel: request serialised by a lock, dead-pipe restart-once, 64 MB StreamReader limit for big outputs, SIGINT interrupt keeps the kernel alive, cwd only rmtree'd when owned. `sql_query()` RPC keeps the connection config on the host (kernel never sees credentials). NOTE (accepted, documented in runtime.py): no cpu/mem/seccomp sandbox yet — flagged there as a later hardening pass, not a blocker for the trusted CHU deployment. Terminal WS access guard reuses the HTTP-tested helper; a dedicated WS-level 403 test was not added (would need a live WS harness) — coverage via the HTTP path + authenticate_ws tests.
- 🟡 follow-up (carried): `max_sessions_per_user` / `session_timeout_minutes` settings exist but aren't enforced (no cap on concurrent kernels/PTYs per user) — pairs with the Group-C upload-size follow-up as resource-exhaustion hardening.

### Groups F–I — DONE (reviewed via 4 parallel Explore sub-agents; all findings re-verified before fixing)

**G — SQL scripts + IDE backend (sql_scripts, ide_files + services/models/schemas):** **Ship it.** No new bug. Verified: ide_files routes all build paths via `project_fs` helpers → `_safe_join` (traversal blocked); sql_scripts every route enforces `check_workspace_role` via `_load_collection`/`_load_file`; sql_script_service is pure ORM (no raw SQL); FKs cascade. NOTE: the `if workspace_id is None → no check` branch grants any authed user access to workspace-less projects — but this is the SAME accepted pattern as the dataset_files calibration file (systemic, pre-existing), not a regression; flagged for intent-confirmation, not fixed here.

**H — Remaining entity persistence (11 routers + services):** **Fix-then-ship.** Access control sound in 10/11 routers (the organizations/execution class of unguarded-router bug does NOT recur). Findings:
  - 🟠 FIXED — schema_presets PUT (route + service) — `save()` upserts by `preset_id` and re-parents; the route authorized only the TARGET workspace, so an editor of B could overwrite/steal/relocate a preset living in workspace A (or dump it to the global pool) via a known preset id. Fixed: load the existing preset and require editor on its CURRENT workspace too (mirrors the delete handler). New regression test `test_cannot_hijack_existing_preset_by_reparenting` (403 on reparent-to-B and reparent-to-global; A untouched) — fails against pre-fix code.
  - 🟡 FIXED — mapping_project_service delete/update — `raw_file_sha` blob wasn't released on project delete or source replacement (disk leak), unlike the ref-counted cleanup in data_source/dataset services. Fixed: `_forget_blob` + `_sha_still_referenced` (content-addressed store → reference check required) on delete and on source-CSV replacement in update.
  - ✅ cohorts/pipelines/dq_rule_sets/data_catalogs/concept_sets/source_concept_ids/wiki_pages/user_plugins/etl_pipelines all guard every CRUD+batch route; concept_sets delete-batch & source_concept_ids save-batch authorize EACH workspace; mapping_projects delete_orphans is admin-only. No path-traversal / client-filename-to-disk surface.

**F — Server-side viz (9 *-server.ts builders + 8 components):** **Fix-then-ship.** Findings:
  - 🟠 FIXED (real UX bug) — every viz component treats non-empty `out.stderr` as fatal and hides `stdout`, but the generated Python suppressed no warnings → a valid statsmodels/lifelines/scipy fit that emits a ConvergenceWarning/RuntimeWarning (common on small/quasi-separated healthcare cohorts) was shown to the user as an error, hiding the computed result. Fixed at the source: added `warnings.filterwarnings("ignore")` to the generated Python in the 3 stats modules that actually fit models (regression, kaplan-meier, statistical-tests). Front lint+typecheck clean on touched files.
  - ✅ No injection: all 9 builders embed the spec via `JSON.stringify(JSON.stringify(spec))` + `_json.loads(...)` — column names/config are DATA, never spliced into Python source. Verified explicitly (was a focus). Shape parity server↔client confirmed for all 9; React effects use a `cancelled` flag against out-of-order responses; no state mutation / missing keys.
  - 🟡 NOT FIXED (carried follow-up, front non-shipping) — Map & Sankey swallow a real server error into an empty result ("No flows/coordinates") indistinguishable from genuinely-empty data (7 other modules keep a serverError state) — consistency fix; NaN-vs-null entity parity in sankey; a comment guarding the `filtersKey`-encodes-all-config invariant.

**I — front lib/api + storage adapters (24 adapters + api-client + getStorage):** **Fix-then-ship.** Layer is coherent — verified: `Authorization: Bearer` set only when a token exists, single-flight 401 refresh + one retry, `apiRequest` throws `ApiError(status, text)` on any non-2xx (never non-2xx-as-success), camelCase boundary uniform (only auth stays snake_case, matching the backend), `/api/v1` auto-prefixed everywhere, no console secret logging, single mode-decision point in main.tsx via `VITE_API_URL`. Findings:
  - 🟡 FIXED — mapping-projects.ts `deleteOrphans` was the one method with `.catch(() => {})`, swallowing a 500 (all peers propagate) → an orphan-cleanup the server rejected looked successful. Fixed: let it throw (matches IDB impl, which returns a real count and doesn't swallow).
  - 🟡 NOT FIXED (by-design / efficiency) — schema-presets getById/getByWorkspace refetch the full list (no `/{id}` endpoint); 401 hard-failure redirect lives in AuthGate not the fetch wrapper (intentional).

---

## FINAL SUMMARY — full-stack backend review (Groups A–I), 2026-07-08

- Reviewed by: Claude Opus 4.8 — by coherent file groups at final state (A–E direct single-pass; F–I via 4 parallel Explore sub-agents with every finding re-verified before fixing).
- Range covered: the 170-commit FastAPI backend landing `eac0095f..22f01a8c` (346 files, ~27.5k insertions).
- **Last reviewed commit: 22f01a8c271b63bd8ba33860c995120007b04bbf** (cursor advanced now that all groups are done).
- Reminder: `apps/api` is not in the shipping build (prod = static WASM) — server-mode findings are real but don't affect the current production build.
- Verdict: **Fix-then-ship → all blocking issues fixed during review, now Ship it.**
- Tests: backend **195 passed / 2 skipped** (Postgres-only skips); ruff clean on all of `app/`; front lint+typecheck clean on touched files. Fixes staged for ONE grouped commit.

**5 🔴 critical (all fixed + regression-tested where server-testable):**
1. A — `secret_key` default could boot in prod (signs JWTs + derives Fernet key) → boot guard when `default and not debug`.
2. B — organizations create/update/delete open to any authed user → admin-only (+test).
3. C — blob_store `path_for(sha)` unvalidated client sha → arbitrary file read via `../` → 64-hex regex (+test).
4. D — external-DB DSN built from unquoted client host/username → DSN-injection/SSRF → double-quote each value + escape SQL literal (+test).
5. E — /execute + kernels + restart + terminal WS had NO project-membership check → arbitrary cross-project code/shell execution + data exfiltration → `_require_project_access`/`_require_connection_access` (+test).

**Plus:** 2 🟠 in B/C (projects role KeyError→500; dataset_parser sheet SQL-injection), 1 🟠 in H (schema_presets reparent hijack, +test), and 🟡 fixes (mapping_projects blob leak, viz warning-as-error, deleteOrphans swallow).

**Carried follow-ups (non-blocking, mostly server-mode-only or systemic):** CORS `*` guard/doc; `role` in JWT informational; `update_project` destination-workspace check; upload size limit + per-user kernel/PTY session caps (resource exhaustion); Map/Sankey error-swallowing + parity nits; the `workspace_id is None → no access check` systemic pattern (shared with dataset_files) — confirm intended policy for orphan projects.

**Files changed (review commit `e860150c`):** main.py, routes/{organizations,projects,execution,schema_presets}.py, services/{blob_store, data/dataset_parser, data/db_connect, mapping_project_service}.py, tests/{test_organizations,test_execution,test_schema_presets,+new test_blob_store,+new test_db_connect_dsn}.py, apps/web/src/features/.../analyses/{regression,kaplan-meier,statistical-tests}-server.ts, apps/web/src/lib/api/mapping-projects.ts.

### Post-review hardening (separate commit, at the user's request)

Three of the carried follow-ups were then implemented (the rest stay on the list):
- **CORS `*` guard** (main.py) — refuse boot when a CORS origin is `*` and not debug (credentials + wildcard); warn in debug. Mirrors the secret-key guard.
- **Upload size limit** (config.py `max_upload_mb`=2048 default, uploads.py) — reject at init when the declared size exceeds the cap AND enforce the real cumulative size while streaming each chunk (413), so a client that understates/omits fileSize is still cut off. Tests added. (User chose an env-config value for now; a DB-backed app-settings entity + admin UI is a possible later evolution.)
- **Per-user terminal (PTY) session cap** (pty_kernel.py + execution.py) — `max_sessions_per_user` now enforced on bash terminals (each is an OS process); the WS is closed with a message past the cap. Per-user quota, freed on close. Unit test added. NOTE: R/Python kernels are keyed by (project, language, env) and shared per project — NOT per user — so the cap deliberately applies only to PTY shells.

**Deferred to the upcoming access-control rework** (user: "on n'a pas encore implémenté les accès par groupe d'accès user, on fera tout d'un coup"): `update_project` destination-workspace check and the `workspace_id is None → no access check` systemic pattern — both belong to that dedicated authz pass, not a piecemeal fix.

**Still open (non-blocking):** `role` in JWT (informational); Map/Sankey error-swallowing + sankey NaN parity (front, non-shipping).

---

## 2026-07-05 — Author provenance mixin + suggestion-category filter + review-page redesign + change-password dialog

- Reviewed by: Claude Opus 4.8 (2 parallel adversarial sub-reviews on features/UI diffs + manual verification of the core types/stores/lib diff)
- Range: 7d357873..eac0095f (20 commits, 52 files, ~2.7k insertions — structured author details (`AuthorDetails`/`Authored` mixin) stamped onto created entities via new `stampAuthored()`; per-suggestion-category source filter (scores-engine `categorySourceKeys` + `reindexProject` upgrade path + `mapping-queries` tuple/vocab-scope predicates); mapping-editor source-search harmonization + histogram X-ticks/start-at-zero + target-tab reorder (default to Search); concept-mapping review-page 3-stage pipeline redesign (skill review-template, not app code); ProfilePage explicit-save + new ChangePasswordDialog; multi-select-filter render-cap + Enter-select-all; concept-mapping skill docs refactor. Version bumped 2.0.20→2.0.21 within the range, then →2.0.22 by this review. Note: `eac0095f` (target-tab default) landed mid-review — already covered by the features sub-review diff.
- Last reviewed commit: eac0095f749522d8ffe6d615aee0a0e60c75ed4e
- Verdict: **Ship it** (one 🟠 to track — frontend-ahead-of-backend, does not affect the shipping static build)
- Tests: 142 passed (13 new: 11 mapping-queries + 2 export author round-trip) · Lint: 0 errors (156 warnings, all pre-existing React Compiler category) · Typecheck: 0 errors

Findings (all verified in code; false positives discarded):
- 🟠 NOT BLOCKING — ChangePasswordDialog.tsx:48-49 — in server mode the dialog POSTs to `${VITE_API_URL||'http://localhost:8000'}/auth/change-password`, but (a) `apps/api` registers only health + projects routers — **no auth/change-password endpoint exists**, and (b) the path is missing the `/api/v1` prefix that every real route (and the existing GeneralTab.tsx fetches) uses. So server-mode password change always 404s → user always sees the generic error; it can never succeed. Non-blocking because the shipping mode is static WASM (`VITE_API_URL` unset), where the dialog correctly shows a "requires backend" notice. Fix when the backend lands: add the `/api/v1` prefix and implement the route (or gate the server branch behind a feature flag until then). Password handling itself is clean — state-only, `credentials: 'include'`, never logged, cleared on close.
- 🟡 ChangePasswordDialog.tsx:48 — hardcoded `http://localhost:8000` fallback baked into a shipped component (dead in practice: only reachable when `VITE_API_URL` is truthy). Same pattern as pre-existing GeneralTab.tsx; consider dropping the fallback repo-wide.
- ✅ SQL safety verified: new vocab-scope + suggestion-category predicates (`inListClause`→`esc`, `tupleInClause` escapes both vocab & code; `columnName`/`vocabScope.column` are code-controlled unions). No raw interpolation. `global-summary-queries.ts` localized(proj.name) still esc()-wrapped.
- ✅ Correctness verified: `reindexProject` upgrade path guarded by per-project `reindexAttemptedRef` (empty result can't loop); scores-engine `data_dictionary` category runs in a try/guarded query so a legacy parquet missing `concept_set_uid` can't wipe method categories; idb-storage serializes/hydrates `categorySourceKeys` as Sets↔string[] with `?? []` back-compat; MappingEditorTab `{...filters}` copy prevents mutating shared state; `suggestionCategoryKeys` `vocab::code`→`vocab\0code` conversion correct; RelationsTable composite key retained.
- ✅ i18n: all new keys (`profile.password_*`, `affiliation/profession/orcid` (+placeholders), `common.refine_search`/`select_all`/`select_none`/`clear`, `concept_mapping.source_filters*`/`filter_by_suggestion*`/`detail_starts_at_zero`/`suggestion_category_*` ×5) present in both en.json and fr.json.
- ✅ multi-select-filter render-cap: `selectAll` uses full `searchFiltered` (not the truncated `visible` slice), `no_results`/`hiddenCount` keyed off the full set — capping doesn't drop selections.
- ✅ No new `any` (2 justified `as unknown as` double-casts with comments); no debug/dead code; no secrets; author-details spreads resolve to real typed store fns.

Notes / follow-ups:
- The concept-mapping skill files (SKILL.md, references/, review-template/app.js+index.html+style.css, scripts/update_state.py) are tooling, not shipped app code — scanned, not adversarially reviewed line-by-line.
- 🟠 follow-up owed on the backend: implement `POST /api/v1/auth/change-password` (or gate the dialog's server branch) before enabling password change in any server deployment.
- Pre-existing (out of scope): fr.json is missing `data_sources.detail_visits`/`detail_visit_units` (has `detail_visit_occurrences`/`detail_visit_details` instead) — a latent EN/FR mismatch worth a separate fix.

## 2026-07-03 — LocalizedString migration + short-id URLs + entity actions menu + concept-mapping provenance

- Reviewed by: Claude Opus 4.8 (5 parallel adversarial cluster sub-reviews + manual verification + fixes applied)
- Range: d24ec2cc..7d357873 (32 commits, 146 files, ~6k insertions — string→LocalizedString migration across all entity names/descriptions, git-style short-id URLs + resolution, shared entity-actions menu + use-*-actions hooks, workspace-home/summary rework, concept-mapping concept-set provenance + RelationsTable + scores-parquet export/import, create-project skill, version bump 2.0.20→2.0.21). Note: the user pushed 2 extra commits mid-review (7fe6360e Header short-id, 7d357873 scores-parquet export) — both reviewed.
- Last reviewed commit: 7d357873396511570fee2400d2828245e9b6e724
- Verdict: **Fix-then-ship → fixed during review, now Ship it**
- Tests: 129 passed · Lint: 0 errors (154 warnings, all pre-existing React Compiler category) · Typecheck: **was 10 errors (blocking-gate regression) → now 0 after fixes**

Findings (all verified in code; false positives discarded):
- 🔴 FIXED — **typecheck gate broken (10 errors)** from the incomplete string→LocalizedString migration. Blocking per docs/conventions.md. Sites fixed: global-summary-queries.ts:128/145 (`esc(proj.name)` on a LocalizedString → wrapped with `localized(..,'en')`); GlobalSummaryView.tsx:755 (`{name:'global'} as MappingProject` → `{name:{en:'global'}} as unknown as MappingProject` + WHY comment); WorkspaceHomePage.tsx:230 (`status?: string` → `ProjectStatus`); use-project-tree.ts:126 (readme LocalizedString passed as string — **also a real runtime `[object Object]` bug** in the README tree preview → `localized(project.readme,'en')`); app-store.ts:256-257 & workspace-store.ts:82 (`typeof x==='string' && x.length` narrowed to `never` → `(x as string).length`); ConceptDetailSheet.tsx:540 (`as RelationRow[]` → `as unknown as RelationRow[]`).
- 🟠 FIXED — WorkspacesPage.tsx:418 — workspace-ZIP import (untrusted) persisted the bundled similarity-scores.parquet via `persistScoresFile` **without** `validateScoresFile`, unlike the interactive load flow. No injection (constant DuckDB filename), but junk got stored before buildIndex failed silently. Now validates columns before persisting.
- 🟠 FIXED — fr.json:2119 `entity_workspace` shipped the English string "Workspace" → "Espace de travail" (matches seed_entity_workspace). New key added by this diff.
- 🟡 FIXED — RelationsTable.tsx:337 — row `key={concept_id}` is non-unique (same target concept via multiple relationship_id) → composite `${relationship_id}__${concept_id}`.
- ✅ DISCARDED (false positives): ProjectGuard.tsx:52 `paths.projects(wsUid)` "re-shortens a prefix" — non-UUID prefix passes through shortenIdAmong unchanged and already resolves; Header.tsx:103 `.getState()` fallback "breaks reactivity" — primary path is a reactive selector, fallback only bridges a transient load gap; entity-actions-menu delete "onDeleted runs on reject" — await throws first so it doesn't; DashboardTab.name still `string` — pre-existing design, not touched by this diff and compiles clean; Cohort.name not localized — Cohort.name is `string` by design.
- ✅ Verified sound: short-id round-trip (shortenIdAmong grows prefix for seed's sequential 00000000- uuids; resolveByIdPrefix disambiguates; covered by short-id.test.ts). LocalizedString export/import round-trip + legacy plain-string backward-compat (entity-io.ts). DCAT-AP HTML export esc()-wraps localized names (no XSS). i18n key parity: en/fr both 3307 keys (the 2 orphan data_sources.detail_visit* mismatches are pre-existing and code references a different key). No new SQL raw-interpolation, no new dangerouslySetInnerHTML, no secrets, no console.log, no new `any`.

Notes / follow-ups:
- 🟡 Left as-is (pre-existing/minor): app-store migration persists use `.catch(() => {})` (convention prefers console.warn, but fire-and-forget migration is acceptable); isShellHtml regex duplicated inline in seed-loader.ts:222 vs exported from localized.ts (DRY candidate); WorkspaceHomePage/SummaryOverviewTab are large (~490 lines each, under the 800 threshold).
- No new tests owed: the changed pure logic (localized/short-id) already has localized.test.ts (12) + short-id.test.ts (14). UI reworks intentionally not unit-tested.
- Cross-repo: the new similarity-scores.parquet ZIP entry + git-linked seed reload should be mirrored in linkr-portal's build.sh if portal deployments are meant to carry scores.

## 2026-06-27 — Unified seed manifest + re-seed/delete flow + modal/UI polish

- Reviewed by: Claude Opus 4.8 (2 parallel adversarial sub-reviews + manual verification pass)
- Range: 35f9160a..d24ec2cc (focus: the seed series f218b428..HEAD — unified manifest, targeted re-seed, origin guard, removed-entity deletion, import-conflict UX, modal spacing, datasets separator, version bump 2.0.19)
- Last reviewed commit: d24ec2cc989ac9257e21fd2bccd5504f6a1d3dd5
- Verdict: **Ship it** (one 🟠 fixed during review)
- Tests: 87 passed (10 in seed-change-detector: mergeSeedHashesFor + dropFromSeedHashes) · Lint: 0 errors (136 pre-existing warnings) · Typecheck: 0 errors introduced

Findings (verified in code; false positives / pre-existing discarded):
- 🟠 FIXED — targeted-reseed.ts:235 — a removed-from-seed workspace was dropped from the baseline unconditionally; if it still held user-origin children, their baseline hashes were forgotten. Now skips workspaces with any user-origin child (commit d24ec2cc). Note: baseline/notification state only — no IndexedDB data was ever deleted.
- 🟡 (not changed — pre-existing, benign) seed-loader.ts seeders + loadStructuralEntity don't set the guard flag when a referenced file fetch returns null → a missing file is retried on each load. Predates this work (same pattern in the original seeders); for build-bundled files a missing file is a broken build, and retry-on-transient-404 is arguably desirable. Left as-is.
- 🟡 (minor) seed-loader.ts:46/149/171-ish — storage.projects.getAll() called repeatedly to resolve a project by projectId. Performance only, not correctness.
- ✅ Safety model verified: removedDisposition ('seed'|'gone'|'user') never deletes or drops user content; deleteEntity only runs for 'seed'; dropFromSeedHashes is build-independent, drops whole workspace on 'workspace', deep-clones inputs.
- ✅ Two-phase load order intact (structure → database→conceptMapping→etlScript→dataset→dashboard); all awaits present; discriminated-union dispatch complete.
- ✅ Silent baseline reset on stale schemaVersion confirmed (no spurious "everything changed").
- ✅ crypto leak fixed earlier (shared seed-schema-version.ts; browser imports value from there, types-only from the Node plugin).
- ✅ i18n keys present in both en.json and fr.json for all new strings.

Notes / follow-ups:
- The range start (35f9160a) predates this session; the diff also contains earlier unreviewed work (Sankey table view, dashboard filters, workspace export). This review focused on the seed series; the earlier commits were not adversarially re-reviewed here.
- Tests still owed (offered to user): detectSeedChanges diff + silent-reset path; removedDisposition safety guard. UI dialogs intentionally not unit-tested (volatile).
- Cross-repo follow-up pending: linkr-portal scripts/build.sh must emit the new manifest.json (+ verify linkr-portal-ricdc) — without it a portal deployment loads nothing.

## 2026-06-24 — Dashboard rewrite (nested tabs, grid fit-to-height, filters, export/move trees, fullscreen)

- Reviewed by: Claude Opus 4.8 (2 parallel adversarial sub-reviews + manual verification pass)
- Range: 04ece659..35f9160a (10 commits — Lou's MR squash + tab navigation, 48-col grid, fit-to-height, filter UX, export/move tree views, fullscreen, perf cache, review fixes)
- Last reviewed commit: 35f9160a3312e4b1ecfc28f0e53c26822f218b88
- Verdict: **Ship it** (after fixes) — merging to main
- Tests: 70 passed (8 added: dashboard-tree, dashboard-grid) · Lint: 0 errors (136 pre-existing warnings) · Typecheck: 0 errors introduced

Findings (verified in code; false positives discarded):
- 🟠 FIXED — dashboard-store.ts loadProjectDashboards — grid migration gridV 1→2 was not idempotent (crash between widget doubling and gridV stamp could re-double on next load) → now stamps+awaits gridV=2 before doubling; on failure reverts and retries next load.
- 🟠 FIXED — use-widget-execution.ts / dashboard-store.ts removeWidget — module-level result cache never invalidated on widget delete (memory leak) → removeWidget now calls invalidateWidgetResult.
- 🟡 FIXED — dashboard-store.ts removeTab — `undefined as unknown as string` cast → replaced with a real branch (drop the key vs store undefined).
- 🟡 FIXED — dashboard-tree.ts buildDashboardTree — recursion had no cycle guard (corrupted parent loop → stack overflow) → added a `seen` set.
- 🟡 FIXED — dashboard-store.ts createDashboard — default tab now sets parentTabId: null explicitly (export/import consistency).
- ✅ DISCARDED (false positives) — fitDashboardToHeight multi-column scaling (shared bottomByCol is correct); parentTabId mapping on import (works).
- 🟡 NOT BLOCKING — DashboardFilterSidebar.tsx is ~1435 lines (dense but well-commented; future extraction candidate). Orphan i18n key `dashboard.filter_active` left in locales (harmless).

Notes / follow-ups:
- i18n: 30+ new keys, all present in both en.json and fr.json (verified).
- New pure logic covered by tests: buildDashboardTree (hierarchy + cycle guard), computeFitRows (fits visible height, ~square cells).

## 2026-06-24 — ESLint & TypeScript backlog clearance + merge to main

- Reviewed by: Claude Opus 4.8 (2 parallel adversarial sub-reviews + manual security pass)
- Range: 778ff498..04ece659  (19 commits — lint waves, react-hooks fixes, full TS backlog, gates, merge)
- Last reviewed commit: 04ece6596e0b538ab0d21f117906e88da6a34973
- Verdict: **Ship it** — merged to main
- Tests: 55 passed · Lint errors: 0 · Typecheck: 0 (all three gates now BLOCKING)

Findings:
- ✅ No regressions in hook/ref reordering. All moved `fooRef.current = x` writes (CodeEditor, RmdNotebook, use-pipeline, MappingProjectPage) are read only in async callbacks (Monaco commands, setTimeout, handlers) — safe. The one render-read latch (MappingProjectPage `editorEverOpened`) is monotone and proven behaviour-equivalent.
- ✅ Two hook-above-early-return moves (MappingEditorTab, EtlPipelinePage) fix **real Rules-of-Hooks crash bugs**; deps all declared before new positions.
- ✅ 7× `doImport` reorderings: no access-before-declaration, useCallback deps correct.
- ✅ `ConceptPickerDialog` API alignment (WarehousePluginEditorSheet): `conceptIds` always preserved in returned config — no selection loss.
- ✅ `cohort-query` `case 'event': return null`: behaviour-equivalent (was `undefined`, also falsy) and gracefully handled by callers (count=0, no invalid SQL).
- ✅ `idb-storage` store types (`& { id }`, `& { workspaceBadgeKey }`): align type with already-persisted fields; zero runtime change; public read methods still return clean types.
- ✅ Security: no new unescaped SQL interpolation; 4 new `if (!idColumn)` guards added (defensive); i18n `count`→`formattedCount` consistent across code + en.json + fr.json; no new dangerouslySetInnerHTML; 0 new `as any` / `@ts-ignore` (16 justified `as unknown as` for SQL row projections).

Notes / follow-ups:
- 140 ESLint **warnings** remain — mostly React Compiler rules (set-state-in-effect, preserve-manual-memoization, react-refresh) kept as warn since the compiler isn't enabled. Revisit if it's ever turned on.
- Manual runtime testing still recommended for: concept-mapping editor, patient-data widget concept picker, catalog granularity, cohorts, ETL pipeline node-click, import/export round-trips.

---

## 2026-06-23 — Quality harness branch (`quality-harness`)

- Reviewed by: Claude Opus 4.8
- Range: 8d00601e (main)..778ff498  (5 commits: harness, lint cleanup, tests, type fixes, hook fix)
- Last reviewed commit: 778ff498dfc443a9aa8fc2db1c6d0ed6285e862a
- Verdict: **Ship it** (after fixing the one issue found during review)
- Tests: 55 passed (4 files) · Lint: 148 errors (all pre-existing react-hooks/*, none introduced) · Typecheck: 127 errors (down from 194 on main, none introduced)

Findings:
- 🟠 `scripts/install-git-hooks.mjs` — `prepare` runs on every `npm ci` incl. CI; the unguarded `git config` + `process.exit(1)` would fail the whole GitLab pipeline when `.git` is absent (tarball install). **Fixed in 778ff498**: wrapped in try/catch, exits 0 when no repo, degrades to a warning.
- ✅ Verified no regressions in the 6 risky deletions (RegressionComponent stats fns, GlobalSummaryView setPage, dcat-ap counters, jsonld dataCatalog, EtlScriptsTab cascade, KaplanMeier getAtRisk). All removed symbols confirmed dead; all still-needed fns (gammaLn, fCDF, regularizedBeta, the pagination useEffect, `_anonymized` marking, resolveFileDataSourceId, getAtRisk 2nd loop) intact and wired.
- ✅ Real latent bug fixed by this branch: 3 dead `setPage(0)` calls (undeclared var) in GlobalSummaryView — pagination reset already covered by useEffect.

Notes / follow-ups:
- Security: no new SQL interpolation, no dangerouslySetInnerHTML, no secrets. New CSV/slugify tests include adversarial cases (quote escaping, injection-ish chars). escSql/validateIntegerIds now have injection tests.
- Remaining backlog (see [[lint-type-backlog]] memory): 148 ESLint react-hooks/* + 127 TS2322/TS2345. Burn down case-by-case, then flip CI `allow_failure: false`.
- Candidate dead file (not deleted, needs user OK): `features/projects/warehouse/concepts/ConceptFilters.tsx` (component imported nowhere, references a stale data shape).

---

## 2026-06-23 — Baseline (review harness set up)

- Reviewed by: Claude Opus 4.8 (setup session, no review performed yet)
- Range: — (baseline)
- Last reviewed commit: 23bf12d45f9926b51d22206bb37dc98365fe1e91
- Verdict: —
- Tests: 33 passed (format-helpers, fuzzy-search) · Lint: not run

Notes / follow-ups:
- This is the starting point. The first real review should cover everything from this commit forward.
- Known backlog: `npm run typecheck` (`tsc -b`) reports ~194 pre-existing type errors. These are NOT introduced by recent work — they predate the harness. Future reviews should only flag type errors *introduced by the reviewed diff*, and we should chip away at the backlog separately.
