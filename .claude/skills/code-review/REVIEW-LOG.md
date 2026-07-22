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

## Open items (distilled) — updated 2026-07-22

Carried context so future reviews stop re-litigating resolved/accepted items. Everything else from past reviews is fixed (verified in source 2026-07-22; the fixes landed in commits 371901a3, 0151efaa, 50829010, 40ad31fe, 11462798).

Worth doing (non-blocking):
- entity-io.ts (~2.5k lines), seed-loader.ts (~1.3k), WorkspacesPage.tsx (~1.2k) exceed the 800-line split threshold — entity-io splits naturally into export/import/clone.
- git-content-retry: no token input/hint on auth-gated retry failure (GitContentStatusBadge) — minor server-mode UX.
- PTY sessions have no idle sweep (bounded by WS lifetime; kernel sessions do sweep).

Deferred to the group-access rework (documented in docs/planning/users-authorizations-audit.md):
- `workspace_id is None → no access check` pattern (permissions.py and callers).
- `update_project` doesn't authorize the DESTINATION workspace on move.

Accepted / won't do:
- entries.json wide client scoping (mixed-mode churn) — documented limitation, see docs/planning/versioning-plan.md.
- JWT payload carries an informational `role` (authz always re-reads the DB).
- Author provenance re-links by ORCID/email without a claimed/verified distinction (no privilege attached).
- Minor UI nits: DashboardItemEditDialog persists empty-string descriptions; SchemaPresetsPage uses an inline AlertDialog for import errors; seed-loader duplicates the isShellHtml regex on purpose (decoupling).

---

## 2026-07-22 — Server-side project+workspace+entity export builders (byte-parity twins) + ms-UTC datetime format + alembic collapse + git-content-status badge/retry + dataset editing (box-plot/categorical filters/stats) + wiki server search + server-mode wasted-work skip

- Reviewed by: Claude Opus 4.8 — 4 parallel adversarial Explore sub-agents by feature group (1: server-side export builders + datetime byte-parity; 2: alembic collapse + git-content-status + git routes/service + dataset backend parsing; 3: dataset editing/dataviz frontend; 4: versioning/import/git-content-retry/wiki/server-mode frontend). **Reviewer independently re-verified every significant finding in source and REPRODUCED the two parity-critical ones empirically:** the float divergence (`json.dumps(100.0)`=`"100.0"` vs `JSON.stringify(100)`=`"100"` for DQ threshold/lastScore) and the datetime ms-UTC parity (`to_iso_ms_z` vs JS `toISOString()` — `.000Z` whole-second, µs truncation, naive→UTC, offset all match). Also independently confirmed: the alembic collapse completeness (all 6 deleted migrations' columns present in `000000000001`, single head, linear chain), the project-retry non-idempotency (`importProjectContent` un-`.catch`'d deterministic-id creates, no delete-first), the git-content-status authz gap (route authorizes path `workspace_id` but service writes client `body.workspace_id`, keyed on `(scope,entity_id)` only), the workspace-child cross-workspace clobber (WorkspacesPage.tsx:482+ delete-then-create with no other-workspace guard), and the hardcoded `'Count'` tooltip (while `datasets.stats_count` exists in both locales).
- Range: 0240b95b..56aafc7c (**32 commits, 196 files, ~7,982 insertions / ~741 deletions**). Highlights: **server-side project + workspace export builders** (`project_export.py`/`_assemble.py` +717, `workspace_export.py`/`_assemble.py` +1162 — Python ports of the TS entity-io builders, offload the browser in fullstack mode) plus **standalone builders for the 6 remaining entity scopes** (data-catalog, dq-rule-set, etl-pipeline, schema-preset, sql-collection, user-plugin), all pinned by twin golden fixtures (TS `*-export-golden.test.ts` + Python `test_*_export*`) against one frozen `expected/`; **ms-UTC datetime format** (`datetime_format.py` `to_iso_ms_z`, `schemas/base.py` `when_used='json'` field-serializer so DB writes still get real datetimes; golden regenerated; `org_snapshot` normalizes inline `createdAt`); **alembic collapse** (all 6 prior migrations → single `000000000001_initial_schema` + new `000000000002_git_content_status`); **git-content-status** (badge + retry for git-linked entities whose content wasn't reconstituted — `git_content_status` model/service/routes, `git-content-retry.ts`, `GitContentStatusBadge`); **git clone token fallback** (retry reuses the stored per-(user,host) token); **dataset editing UX** (`box-plot.tsx`, categorical `ColumnFilterInput`/`use-column-distinct`, `ColumnStatsPanel` +126, type badges, nice histogram ticks); **wiki server-side search** (`wiki_page_service.search_for_workspace`); **server-mode wasted-work skip** (`9447b726` — seed loader skips client row/raw-file work, consumers fall back to server); **import a clean/git project export** (uid stripped — `parseProjectZip` accepts projectId-only, `doImport` mints uid); **workspace git-linked child import fixes** (id collisions, dedup built-in plugin seeding, progress modal); **single VERSION source** (repo-root `VERSION` read by both front & back). Also lands `96eb2a7b` = the prior review's own fixes (spot-checked intact: French-boolean CASE, uid:undefined guard, settings-import admin refusal, matchScore `_js_numbers`).
- Last reviewed commit: 56aafc7cb9aefc0da2a5add9482f6bbc1f0194a9
- Verdict: **Fix-then-ship** — 1 🔴 (DQ float fields `threshold`/`lastScore`/`score` diverge `100.0`↔`100` between server and browser export → guaranteed spurious git diff on a mixed-mode remote; the `_js_numbers` fix landed only in `mapping_project_export`, not the two new builders) + 6 🟠 + a 🟡 batch. **Nothing fixed yet — awaiting user direction.**
- Tests: frontend **376 passed** (37 files) · backend touched-area suites **110 passed** (project/workspace/entity export ×4, mapping-project-export, dataset-parser/rows/files, file-reader, settings-versioning, activity-touch, mapping-projects — via `apps/api/.venv`) · Lint: **0 errors** (pre-existing React-Compiler warnings only) · datetime + float parity reproduced by hand. Alembic: single head, linear, symmetric down.
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). BUT 🔴#1 (float parity) affects BOTH modes on a shared remote — a WASM user and a server user versioning the same DQ rule set churn the diff → weighted highest despite being "server-side code". The project-retry 🟠 and both git-content-status authz 🟠 are server-mode-only. The workspace-child clobber 🟠, the 'Count' i18n 🟠, and the BoxPlot NaN 🟠 hit the shipping WASM build.

Findings (all re-verified in source; the two parity ones reproduced empirically):

**🔴 CRITICAL:**
- 🔴 project_export.py:54 (`_json`) + workspace_export.py:56 (`_json`) — **whole-valued float fields serialize as `100.0`/`0.0` (Python) vs `100`/`0` (JS) → perpetual spurious git diff on a mixed-mode remote.** The `_js_numbers` whole-float→int normalizer that the 2026-07-21 review added to `mapping_project_export.py:47` to fix EXACTLY this for `matchScore` was NOT applied to the two new builders (grep: `_js_numbers` appears only in `mapping_project_export.py`). Blast radius = the 3 typed `Float` columns `DqCustomCheck.threshold` (default `0`), `DqRuleSet.last_score`, `DqRunResult.score` — and the frontend defaults thresholds to whole numbers (`DqChecksTab.tsx:192` `threshold:0`; `duckdb/data-quality.ts` `0`/`100`), so a realistic DQ rule set churns on every push. Reproduced live (`json.dumps(100.0)`→`"100.0"` vs `JSON.stringify(100)`→`"100"`). Uncaught: DQ golden fixtures use fractional thresholds (`0.02`/`0.05`) + `lastScore:null`. Fix: extract `_js_numbers` to a shared `app/core/json_export.py` and use it in all three `_json` builders; add a whole-number float (`threshold:0`/`100`, `lastScore:100`) to the DQ golden so the twin tests pin it.

**🟠 IMPORTANT:**
- 🟠 entity-io.ts:1793 (`applyClonedEntity`, `project` branch) — **git-content retry of a git-linked PROJECT is not idempotent → badge stuck "failed" forever (server mode).** The sql/etl/dq branches delete-first (their `decb5b0e`/`2b2d9887` idempotency fix), but the project branch calls `importProjectContent(parsed, targetId)` with no prior `deleteProjectData`. `importProjectContent` uses deterministic ids (`deterministicId(projectUid, oldId)`) and un-`.catch`'d `storage.*.create`, so a retry after a partially-successful first clone re-collides → throws → `retryGitContentClone` catches → re-marks `'failed'`. The project stays permanently half-imported. Fix: `await deleteProjectData(storage, targetId)` before `importProjectContent` (mirror the mapping-project `replaceExisting` treatment).
- 🟠 git.py:1425 (`set_workspace_content_status`) + git_content_status_service.py:15-30 — **content-status PUT trusts the client `body.workspace_id`, not the path-authorized workspace.** Route gates `workspace-settings:write` against the PATH `workspace_id`, but calls `set_status(..., body.workspace_id, ...)` and the row is keyed on `(scope, entity_id)` only → a user with write on workspace A can write/overwrite a badge tagged to workspace B. Bounded (advisory instance state, never exported, no data disclosure). Fix: pass the path `workspace_id`; drop `workspace_id` from `GitContentStatusUpdate`.
- 🟠 git.py:1442 (`clear_workspace_content_status`) + git_content_status_service.py:33-40 — **content-status DELETE clears globally by `(scope, entity_id)`, ignoring the authorized workspace.** Same bounded impact as above; a user with write on A can clear B's badge. Fix: add `GitContentStatus.workspace_id == workspace_id` to the `clear` WHERE + pass the path workspace.
- 🟠 WorkspacesPage.tsx:482-506 (+etl 514, dq 546, mapping 587, catalog 664) — **cross-workspace clobber of a workspace-level child on plain import.** On a non-duplicate import each child keeps its ZIP id then `delete(id)`+`create({id, workspaceId: targetWsId})` with NO cross-workspace guard (unlike the project fix in `ProjectsPage.doImport`) → a child with that id in ANOTHER workspace is silently MOVED into the target. Same clobber class as the prior-review project bug, one level up. Realistic for git-forked children sharing an id. Fix: before delete, if the existing row's `workspaceId !== targetWsId` mint a fresh id (keep lineageId), mirroring the project guard.
- 🟠 ColumnStatsPanel.tsx:422,456 — **hardcoded English `'Count'` in the histogram + date-timeline chart tooltips (i18n regression, shipping build).** Newly added lines; `datasets.stats_count` (`"Count"`/`"Nombre"`) already exists in both locales. A French user sees "Count". Fix: `t('datasets.stats_count')` in both `formatter`s.
- 🟠 box-plot.tsx:26-27,40 — **no NaN/Infinity guard; degenerate input renders invalid SVG (shipping build).** `range = max - min || 1` guards only exact-zero single-value; a `NaN` quartile (server stat absent → `Number(undefined)`, or `ConceptDetailView` free-form parse) makes every `pct()` → `"NaN%"` (blank/garbage), and `max < min` renders negative width. Fed by two callers with untrusted numeric input. Fix: `if (![min,p25,median,p75,max].every(Number.isFinite)) return null` + clamp pct to [0,100].

**🟡 MINOR (batch):**
- 🟡 test_project_export_assemble.py `_normalize_utc` — the regex strips `.\d+Z?`, so this end-to-end test structurally cannot catch a datetime-format regression; only the pure builder test + TS golden pin `…Z`. Add a focused `to_iso_ms_z` unit test (zero-ms→`.000Z`, µs truncation, naive→UTC, offset→UTC).
- 🟡 datetime_format.py:21 (`normalize_iso_ms_z`) vs TS `orgSnapshot` — Python `datetime.fromisoformat` accepts ISO-8601 only and returns non-ISO input verbatim; TS `new Date(...)` is permissive → a non-ISO-but-JS-parseable org `createdAt` diverges. Low (org createdAt is always ISO). Document the assumption.
- 🟡 project_export_assemble.py:206 — attachment dict puts `att.created_at` straight into `_json`, working only because `ReadmeAttachment.created_at` is a `String(40)` column; a future migration to `DateTime` would `TypeError` in plain `json.dumps` and skip `.000Z`. Pin the invariant or route through `to_iso_ms_z`.
- 🟡 git-file-classify.ts:32-58 (`defaultSelectedPaths`) — `isUnownedConfigModification` guards only `modified`; a DELETED `.gitignore`/`.gitattributes` (category `config`, not `other`) is checked by default → proposes to delete a hand-created remote config. In practice Linkr always writes `.gitignore` so it won't appear deleted. Extend the config guard to `deleted` too.
- 🟡 use-column-distinct.ts:28,66 — local-mode distinct effect deps `[fileId, key]` exclude `rows`; a cell edit / row add that leaves the column set unchanged doesn't refresh the categorical filter options (stale until file/column-set changes). Add a `_dirtyVersion` signal to deps for the local branch.
- 🟡 git-content-retry.ts:29 — retry passes no token, relies entirely on the backend stored-token fallback (`625c26eb`); a user with no stored token gets an opaque failure with no way to enter one (the workspace-import dialog has a token input). Surface a hint on auth-gated failure.
- 🟡 ColumnStatsPanel.tsx:394-405 — histogram data/ticks computed in an IIFE in render, not `useMemo` (≤15 bins, low cost). Wrap in `useMemo([stats.histogram])`.
- 🟡 Coverage gaps: `applyColumnFilter` date+boolean branches untested; `toServerFilters` (UI→server filter translation, pure) untested; box-plot quartile/histogram helpers (`percentile`/`buildHistogram` in ColumnStatsPanel) not extracted/tested. File sizes: entity-io.ts 2549 / seed-loader.ts 1299 / WorkspacesPage.tsx 1167 (>800; extraction suggested — entity-io splits naturally into export/import/clone).

Verified sound ✅ (actively probed, no finding):
- **Datetime ms-UTC parity** genuinely correct: `to_iso_ms_z` = JS `toISOString()` for zero-ms (`.000Z`), µs truncation (`.123999`→`.123Z`), naive→UTC, offset→UTC (all reproduced side-by-side). `when_used='json'` guard prevents the DB-write crash (`9c819a90`). `org_snapshot` drops `updatedAt` + normalizes `createdAt`; the workspace-fallback org re-hydrates via `OrganizationResponse.model_dump(mode='json')`. `_slugify`/key-order/`ensure_ascii=False`/separators/no-trailing-newline/code-point sort all match TS. `appVersion` single-sourced from repo-root VERSION, golden-pinned.
- **Alembic collapse complete:** all 6 deleted migrations folded into `000000000001` (localized tab/widget `name`/`description` JSON; user_plugin `organization`/`created_by*`; user `affiliation`/`profession` LocalizedText; `git_credentials` + `uq_git_credential_user_host`, old `git_remote_secret` fully removed; `app_settings`; `version` server_default `0.1.0`). `down_revision=None`, single head, `000000000002` chains + symmetric down.
- **Git injection guards** (`_safe_ref`/`_safe_oid`/`_reject_internal_host`/`_safe_join`) applied on every new argv-feeding path (clone/verify/branches/sync_state/pull_file_bytes, `--` on checkout); synced_oid/branch re-validated even when DB-sourced; schema `_OID_RE`. **Token fallback** resolves only the acting user's own Fernet-encrypted (user,host) token — no leak, no cross-user use, no bypass; never returned (only `has_token`).
- **Wiki server search** filters `workspace_id ==` (bound), matches in Python (no SQL interp), gated `wiki:read` — no injection, no cross-workspace leak.
- **Dataset SQL safety:** frontend categorical filter/stats/distinct pass structured JSON or `encodeURIComponent` params — no frontend SQL. Backend `_infer_types_sql` interpolates only constants + `_quote_ident`-escaped identifiers, categorical filter uses `?` placeholders; **French-boolean fix intact** (`_bool_case` avoids `try_cast AS BOOLEAN`).
- **Server-mode wasted-work skip** does NOT reintroduce the empty-filter bug: seed loader skips row work but `DashboardFilterSidebar`/`GenericConfigPanel`/`DatasetFileTree`/`PluginWidgetRenderer` all fall back to server-side fetches.
- **Dedup built-in plugin seeding** dedups by manifest id via `entityId`, fresh-UUID row ids, skips already-seeded — no drop/duplicate. **git-linked pointer import** always threads `targetWsId` (no `workspaceId:''` orphan). **project-pull** `deleteOverwrittenEntities` deletes analyses/data/raw/files + widgets→tabs→dashboards before insert-only import.
- **Prior review's two 🔴 confirmed fixed:** uid:undefined (`doImport` mints uid on stripped/absent uid) and cross-workspace project clobber (`doImport` mints uid on another-workspace collision). `parseProjectZip` now accepts uid-stripped exports.
- No new `any`, no `console.log`, no unsanitized `dangerouslySetInnerHTML`, no secrets in touched files. All 3 async dataset fetches (distinct/stats/rows) correctly race-guarded (cancelled flag / keyed / monotonic reqId).

Carried follow-ups (non-blocking): the box-plot/histogram quartile helpers want extraction + tests; entity-io.ts split (export/import/clone). Pre-existing/systemic (out of scope): the 4 `data_sources.detail_visit*` EN/FR mismatches (resolved 2026-07-22: dead keys removed); the `workspace_id is None → no access check` pattern.

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-22

The user approved fixing **all** findings. Applied (verified in source; the 🔴 float parity reproduced before AND after across all three builders):

**🔴 (fixed):**
- **DQ float parity** — extracted `_js_numbers`/`_json` into a shared `app/core/json_export.py` (`js_numbers`/`export_json`) and routed all three builders (`project_export`, `workspace_export`, `mapping_project_export`) through it, so a whole-valued float (DQ `threshold`/`lastScore`/`score` of 0/100, a `matchScore` of 1.0) serializes as `0`/`100`/`1` like `JSON.stringify` instead of `0.0`/`100.0`/`1.0`. Removed the now-duplicate `_js_numbers` + `import json` from each builder. Pinned by the DQ golden: set `lastScore: 100` + one check `threshold: 100` in the shared `dq-rule-set` fixture (input + expected/rule-set.json + expected/checks.json) so the TS twin AND the Python `build_dq_rule_set_tree`/`test_entity_export_assemble` both assert the int form. Verified: all three `_json`s emit `100`/`0`/`0.05` (not `100.0`/`0.0`).

**🟠 (all fixed):**
- **project git-content retry idempotency** (entity-io.ts) — the `project` branch of `applyClonedEntity` now `await deleteProjectData(storage, targetId)` before `importProjectContent`, mirroring the delete-first sql/etl/dq branches, so a retry after a partial clone no longer collides on deterministic ids and re-marks 'failed'. (`deleteProjectData` covers ide/connections/attachments/datasets+data+raw+analyses/dashboards+tabs+widgets — everything the import creates.)
- **git-content-status authz** (git.py + git_content_status_service.py + schemas/git.py) — the PUT now uses the PATH `workspace_id` (dropped `workspace_id` from `GitContentStatusUpdate` + the client body); `set_status` refuses to overwrite/reparent a row tagged to a different workspace (entity ids are globally unique → a row belongs to one workspace), and `clear` is scoped to the authorized workspace. New `test_git_content_status_service.py` (workspace-scoped list, can't-overwrite-another-workspace, updates-own-row, clear-only-own). NOTE surfaced by the test: the table has `UniqueConstraint(scope, entity_id)` (no workspace), confirming the globally-unique-entity_id assumption — the fix respects it (guard, not workspace-partitioned upsert).
- **workspace-child cross-workspace clobber** (WorkspacesPage.tsx) — new `resolveChildId(getById, originalId)` helper: a plain import keeps the ZIP id (git round-trip overwrite) EXCEPT when that id already belongs to a child in ANOTHER workspace, where it mints a fresh id (mirrors ProjectsPage.doImport). Applied to all 7 child branches (sql/etl/dq/conceptSets/mapping/catalog/serviceMappings); the delete-then-create now guards on `id === originalId`, and child files/checks/mappings remint when the parent id was re-minted (`remint = id !== originalId`, covers both duplicate and collision).
- **hardcoded 'Count'** (ColumnStatsPanel.tsx) — both chart tooltips now `t('datasets.stats_count')` (key already in both locales).
- **BoxPlot NaN guard** (box-plot.tsx) — bails (`return null`) when any of min/p25/median/p75/max is non-finite; `pct`/IQR-width clamped to [0,100] (guards a `max < min` negative width).

**🟡 batch (all fixed except the retry-token hint, carried):**
- datetime unit test — new `test_datetime_format.py` pins `to_iso_ms_z`/`normalize_iso_ms_z` (zero-ms→`.000Z`, µs truncation, naive→UTC, offset→UTC, plain-date/Zulu/garbage) independently of the goldens (whose assemble test normalizes `.SSSZ` away).
- attachment createdAt invariant (project_export_assemble.py) — routed through `to_iso_ms_z`/`normalize_iso_ms_z` so a future String→DateTime migration can't emit a raw datetime or a divergent format.
- org_snapshot ISO assumption (org_snapshot.py) — documented that `normalize_iso_ms_z` only rewrites ISO strings (non-ISO would diverge from TS `new Date`).
- deleted-config guard (git-file-classify.ts) — a DELETED `.gitignore`/`.gitattributes` is no longer checked by default (new `isConfigFile` guard in `defaultSelectedPaths`); test added.
- local distinct staleness (use-column-distinct.ts + DatasetTable.tsx) — new optional `dataVersion` param (wired to `_dirtyVersion`) in the effect deps so a cell edit refreshes categorical filter options in front-only mode.
- test coverage — `applyColumnFilter` date+boolean cases added; `toServerFilters` exported + tested (categorical→values, empty-skip, number/date/string by type, null drop). column-filter.test.ts 5→15 tests.

**NOT changed (carried):** the git-content-retry opaque-failure token hint (git-content-retry.ts:29 — minor UX, belongs in the badge component, out of proportion to fix now); box-plot/histogram quartile helper extraction+tests; entity-io.ts split.

Verification: frontend **384 tests** pass (+8) + **0 lint errors** (153 pre-existing React-Compiler warnings) + typecheck clean on all touched files; backend touched-area suites **110 pass** + ruff clean on all touched files. All uncommitted, awaiting the user's app test.

---

## 2026-07-21 — Server-side mapping-project export (byte-parity Python twin) + git per-user/host tokens + settings-versioning (orgs/users/roles) + project git-pull + versioning quick-actions + SQL-scripts/IDE homogenize + dataset server-preview

- Reviewed by: Claude Opus 4.8 — 4 adversarial Explore sub-agents by feature group (BE git+settings-versioning; BE server-export+dataset-parser+source-concept-id-scope; FE versioning+project-pull+quick-actions; FE settings/users/SQL/Header — the last one relaunched split in two, 4a UI + 4b pure IO, after the first attempt died without a result). **Reviewer independently re-verified EVERY reported finding in source, and REPRODUCED the two most severe empirically:** the French-boolean data loss (`try_cast('oui' AS BOOLEAN)` → NULL in a live DuckDB, while inference classifies it boolean), and the matchScore float-parity (`json.dumps(1.0)`=`"1.0"` vs `JSON.stringify(1.0)`=`"1"`). Also independently confirmed: the projectId-only import `uid: undefined` chain (traced through ProjectsPage doImport), the datasetAnalyses overwrite ConstraintError (`db.add` + deterministic `mapId`), the 3 missing `file_cat_*` i18n keys (rendered raw at GitDiffDialog:86/GitSyncPanel:338), the imported-`admin`-role escalation, the clone-retry `workspaceId:''` orphan, the alembic chain (linear, single head `a7b8c9d0e1f2`, 4 new migrations up/down-symmetric), and the byte-parity golden fixture (twin TS+Python producers against one frozen `expected/`).
- Range: 0b6e5748..0240b95b (**80 commits, 206 files, ~12,588 insertions / ~1,904 deletions**). Highlights: **server-side mapping-project export** (`mapping_project_export.py`/`_assemble.py` — byte-faithful Python port of the TS git-variant builder, pinned by a shared golden fixture + twin tests; offloads the browser); **source-concept-id ownership rework** (entries per project scoped to its (vocab,code) universe, ranges at root, merged/reconciled on import/seed — `source_concept_id_scope.py`); **git credential re-architecture** (per (user, host) token, Fernet-encrypted, never returned — replaces per-entity secret); **settings-versioning** (push/import organizations+users+roles, NO passwords — `settings_import_service.py`/`_export_assemble.py`, `app_settings` singleton, all admin-gated); **project git-pull** (additive overlay — `project-pull.ts`, `ProjectPullDialog`); **versioning quick-actions** (Sync all / per-group, include-data toggle, A/M/D badges, per-action spinner, click-file→diff — `git-quick-actions.ts`, `GitSyncPanel` +396); **users** (rich datatable, block self-disable/delete, block enabling a password-less local account); **SQL-scripts** homogenized with the IDE (file tree, Markdown-on-run, run-selection shortcut); **dataset server-side preview** (preview == import via `dataset_parser.py`); **activity_touch** (bubble child-write to parent updatedAt); Header entity-badge ordering + type-name-to-confirm delete; Docker rocker/r-ver pinned 4.5.1.
- Last reviewed commit: 0240b95b4905b7d71be60431623db3012d150bfb
- Verdict: **Fix-then-ship** — 2 🔴 (French-boolean columns imported all-NULL, preview≠import, server-mode; clean-export re-import via Projects page → `uid: undefined`, shipping build) + 6 🟠 + a 🟡 batch. **User approved fixing ALL findings; applied this review (uncommitted, awaiting app test) — except entries.json parity, which was investigated and deliberately DEFERRED (a faithful TS port needs the DuckDB-deduped dictionary; a hand-rolled scope would be a third divergent behaviour — see the applied-fixes note).**
- Tests: frontend **354 passed** (28 files) · backend touched-area suites **82 passed** (git-credential, settings-versioning, git-settings-routes, mapping-project-export ×2, source-concept-id-scope, activity-touch, dataset-parser, git-routes, versioning-dir-cleanup, users — via `apps/api/.venv`) · Lint: **0 errors** (152 pre-existing React-Compiler warnings) · Typecheck: **0 errors** · i18n parity: clean (only the 4 pre-existing `data_sources.detail_visit*` — resolved 2026-07-22: dead keys removed). Alembic: linear, single head, 4 new migrations up/down-symmetric.
- Reminder: `apps/api` is **not in the shipping build** (prod = static WASM). 🔴#1 (French-boolean), the settings-import 🟠, the matchScore/entries parity 🟠, the content-disposition 🟠, and the transcode-tmp 🟡 are server-mode-only. **🔴#2 (uid:undefined) and the datasetAnalyses-overwrite 🟠 hit the shipping WASM build** → weighted highest.

Findings (all re-verified in source; the two 🔴 reproduced empirically):

**🔴 CRITICAL:**
- 🔴 dataset_rows.py:62 (`_typed_projection`) + type_inference.py:17-18 — **French boolean columns imported as all-NULL (preview ≠ import, silent data loss), server mode.** Inference classifies `oui/non/vrai/faux/o` as `boolean` (BOOL_TRUE/BOOL_FALSE incl. FR tokens, and the row-by-row `parse_boolean` preview renders them correctly), but the Parquet write casts with `try_cast(x AS BOOLEAN)` — DuckDB returns **NULL** for exactly those FR tokens (reproduced live: `oui/non/vrai/faux/o → NULL`; `yes/no/true/1 → ok`). So the dialog shows True/False and the imported column is empty — the precise invariant this "preview == import" feature exists to guarantee. Uncaught: tests use `yes/no`; no test round-trips `oui/non` through `write_parquet`. (The client `dataset-utils.ts` shares the same FR token set — worth checking its typed-write path, though that isn't in this diff.) Fix: emit an explicit `CASE WHEN lower(trim(x)) IN (<true-tokens>) THEN true WHEN … THEN false ELSE NULL END` in `_typed_projection` (mirror `parse_boolean`), or restrict boolean inference to DuckDB-castable tokens.
- 🔴 ProjectsPage.tsx:193-194 (`doImport`) — **clean/git project export re-imported via the Projects page → `uid: undefined` (store corruption), shipping build.** `buildProjectZip` now strips `uid` from project.json (entity-io.ts:474); `parseProjectZip` accepts projectId-only. On a **plain** import, `globalExisting = find(p => p.uid === undefined)` and `uid = … ? randomUUID() : project.uid` → `uid = undefined` → `deleteProjectData(undefined)`, `projects.delete(undefined)`, `projects.create({uid: undefined})`, `importProjectContent(parsed, undefined)`. Server mode likely 500s the insert; IDB keys a record `undefined` and collides on the next such import. The duplicate path (fresh UUID) and the git-pull path (caller supplies projectUid) are safe; only the file-import path is broken. Mapping projects are unaffected (keyed on `id`, not stripped). Uncaught: the projectId-only test asserts parse-only, never runs doImport. Fix: `uid = … ? randomUUID() : (project.uid ?? randomUUID())` (keep the cross-workspace-collision guard).

**🟠 IMPORTANT:**
- 🟠 settings_import_service.py:158-186 — **settings import can create/promote an `admin` user, no visibility in the pull-preview.** `if role not in role_names and role != "admin"` always accepts `role:"admin"`. On a NEW user it lands disabled+passwordless (latent admin, must be enabled later); on an EXISTING active user it sets `existing.role="admin"` with password/is_active untouched → **immediate silent promotion**, bypassing the `user_service.update` guards (that path isn't traversed). Admin-gated to trigger, and the pull-preview shows only counts. Fix: drop imported `admin` → `user` with a warning, or surface admin-granting rows explicitly in the preview + warnings.
- 🟠 project-pull.ts:334-342 (`deleteOverwrittenEntities`) — **pull-overwrite of a dataset leaves `datasetAnalyses` undeleted → ConstraintError, half-deleted dataset, shipping build.** The datasets branch deletes datasetData/datasetRawFiles/datasetFiles but not datasetAnalyses; re-import creates analyses at a deterministic id (`mapId` = `deterministicId(projectUid, oldId)`) via `db.add` (idb-storage.ts:1336), which throws on the duplicate. With no transaction, the file/data are already gone → local data loss. The full-import cleanup deletes analyses first (entity-io.ts:117); this selective path omits it. Fix: add `await storage.datasetAnalyses.deleteByDataset(f.id).catch(()=>{})` before the datasetFiles.delete.
- 🟠 git-file-meta.ts:140-142 → GitDiffDialog.tsx:86 + GitSyncPanel.tsx:338 — **3 missing i18n keys render raw.** Categories `organizations`/`users`/`roles` (settings scope) have no `versioning.file_cat_*` key in en.json OR fr.json (every other file_cat key is present in both) → the Settings › Versioning file-list + diff headers show the literal `versioning.file_cat_organizations`. Fix: add `file_cat_organizations`/`_users`/`_roles` to both locales.
- 🟠 mapping_project_export.py `_json` (schema `match_score: float`) — **matchScore whole-float breaks mappings.json byte-parity.** `json.dumps(1.0)`→`"1.0"` vs `JSON.stringify(1.0)`→`"1"` (reproduced). A mapping with `matchScore` 1.0/0.0 (realistic for exact/zero matches) → server vs client emit different bytes → perpetual spurious git diff on a mixed-mode remote. Golden fixture only has `matchScore:null` → uncaught. Fix: normalize whole-valued floats to int before `_json` (and audit any other float field).
- 🟠 source_concept_id_scope.py vs source-concept-ids-io.ts:275 — **entries.json NOT byte-parity front-only vs server (by design, churns a shared remote).** Server scopes entries to the project's (vocab,code); the TS builder still exports the WHOLE badge (`buildProjectSourceConceptIds`, unscoped — plan §6 says TS scoping wasn't coded). A WASM user and a server user pushing the same project to one remote → entries.json differs every push. The scoping logic (drop another project's same-badge entry) is also not exercised by any golden/parity test. Decision needed: port scoping to TS, or accept+document mixed-mode churn (+ add a cross-project scope test).
- 🟠 UploadDatasetDialog.tsx:110-116/149 — **server-mode preview re-uploads the ENTIRE file on every option change + no async race guard.** The re-parse effect calls `previewDatasetOnServer` → `uploadFileInChunks(full file)` per delimiter/skipRows/encoding/header/sheet tweak (ImportSettingsDialog does the cheap `previewDatasetByPath` — reuses the sha). `parseServer` is async, fired per change, `setParsed`/`setError` unconditional → out-of-order results can show stale columns, and a resolve after close does setState-after-unmount. Also mapping-project export download 500s on a non-latin1 project name (see 🟡 content-disposition — grouped 🟠 with this by the BE agent). Fix: upload once, cache the sha, re-preview by sha/path; add a per-call sequence token / `open` guard.

**🟡 MINOR (batch):**
- 🟡 mapping_projects.py:569-571 — **export download 500s on a non-latin1 project name.** `content-disposition: filename="{slug}.zip"` with raw `_localized(name,'en')`; Starlette latin-1-encodes headers → CJK/em-dash/emoji `UnicodeEncodeError` (a `"` also breaks the quoting). FR names are latin-1-safe so it won't show in French testing. Fix: RFC 5987 `filename*=UTF-8''<pct-encoded>` + ASCII fallback.
- 🟡 file_reader.py:61 (`_transcode_to_utf8`) — **temp file leaked on every non-UTF-8 (cp1252) CSV read.** `NamedTemporaryFile(delete=False)`, never unlinked; every preview/import/global-table build on a Windows-1252 CSV accumulates one. Fix: unlink in a `finally` after the DuckDB read (DuckDB reopens by path, so `delete=True` won't work).
- 🟡 WorkspacesPage.tsx:184 (`handleCloneEntity`) — **manual clone-retry orphans a git-linked mapping project into `workspaceId:''`.** Calls `cloneEntityContent(e)` with no opts → `applyClonedEntity(…, undefined)` → `import.ts` writes `workspaceId: ''` (entity-io.ts:1715 `workspaceId ?? ''`). Only on the error-recovery path (auto-clone failed on a missing token, user clicks Clone). Fix: thread the target ws id into `handleCloneEntity` like the auto-clone loop (WorkspacesPage.tsx:722).
- 🟡 dataset_parser.py `_infer_types_sql` (`trim`) vs type_inference.py:58 (`.strip()`) — DuckDB `trim()` strips only spaces; Python `.strip()` strips all whitespace → a `"\ttrue"` boolean or tab-padded date infers differently in preview vs import (numbers neutralized by DOUBLE cast). Narrow. Fix: `trim(c, ' \t\n\r')`.
- 🟡 entity-io.ts:559-576 — dashboard tabs/widgets/dashboards emitted in storage (PK) order, not sorted by content key → array order still churns across instances (ids are now stable, order isn't). Not a regression, but undermines the byte-stability goal. Fix: sort by content key before serialize.
- 🟡 d3e4f5a6b7c8 (localize affiliation/profession) — `downgrade` alters Text→String(255); a >255-char localized JSON would truncate/fail on downgrade (rare; downgrade only). 
- 🟡 SqlScriptsEditorPage.tsx:239/277/282 — hardcoded English output-tab labels (`Preview — …`, `… (selection)`, `…:line`); matches a pre-existing untranslated `Result — …` at :211. Add `sql_scripts.tab_*` keys.
- 🟡 activity_touch.py:596-600 — the two-hop widget→dashboard fallback SELECT (tab not session-resident) is untested (the test pre-loads the tab). Add a widget-edit-without-preloaded-tab test.
- 🟡 UploadDatasetDialog.tsx:406 — `fileName: name` (user-editable display name) now feeds `dsChildPath` instead of the original `file.name`; verify the server path builder sanitizes it. File sizes: Header.tsx 837 / SqlScriptsEditorPage.tsx 1022 (>800; extraction suggested, non-blocking). AuthorDetails affiliation/profession LocalizedString key order can churn provenance snapshots (low impact — written once).
- 🟡 git_service.py:147-153 (`remove_repo`) — `rmtree(data_path/kind/entity_id)` with no `_safe_join` guard (callers pass trusted DB ids today; harden anyway). git_credential set_git_remote_config + set_token_for_url are two independent commits (self-healing).

Verified sound ✅ (actively probed, no finding):
- **Mapping-project export byte-parity** is genuinely double-pinned: the pure builder (`test_mapping_project_export`) and the full DB→dict→builder path (`test_mapping_project_export_assemble`) both assert byte-for-byte against the SAME `expected/` fixture the TS golden test (`export-golden.test.ts`) also asserts against — two independent producers, one frozen fixture. JSON serialization (`indent=2`, `separators=(",",": ")`, `ensure_ascii=False`, no trailing newline, insertion-order keys), `dataSourceId` reset-in-place, `fileSourceData` re-append, `organization` append, `.gitignore` bytes — all match. `compareCodePoints` (`a<b?-1:…`) == Python native str/tuple sort for BMP; `mappingKey` tie-break gives a total order. `_portable_ranges`/`_compact_entries` sort + `_range_dict` reconciliation (monotone nextId, window-scoped totalConcepts, no double-count) verified + tested.
- **Git security core:** every new git-feeding path applies `_safe_ref`/`_safe_oid` (reject leading `-` → no `--upload-pack` RCE) + `_reject_internal_host` (SSRF, incl. 169.254.169.254) + `_safe_join` (traversal); tokens Fernet-encrypted, never in `.git/config`, never returned by any schema (`has_token` only), scrubbed from errors; per (user,host) with `UniqueConstraint` + cross-user isolation test. All `/settings/account/*` admin-gated; host-token endpoints user-scoped.
- **Settings import excludes passwords/privilege** (new users disabled+passwordless, existing password/is_active untouched, roles forced `is_system=False`, permissions filtered to `ALL_PERMISSIONS`) — except the imported-`admin`-role gap (🟠 above).
- **source-concept-id reconcile/merge** (`resolveImportedRange`, `reconcileRangeWithEntries`, `reconcileImportedEntries`, `mergeSourceConceptIdRegistry`): local-id preservation, diverged-badge drop, monotone nextId, no blind overwrite, order-independent — thoroughly tested (not happy-path only).
- **importMappingProjectContent** order + best-effort steps + `createdAt ?? now`; **stripInstanceFields** dropping linkedDataSourceIds/empty-createdAt with every consumer `?? []`-safe; **ATHENA vocab-ref skip**; **activity_touch** bumps only the direct parent, no cross-authz write.
- **UsersTab** client affordances mirror the server guards (self-guard, block-enable-passwordless, last-admin guards) with disabled+title, no misleading affordance; **Markdown-on-run** sanitized via rehypeSanitize (no dangerouslySetInnerHTML); **type-name-to-confirm delete** fails closed; run-selection shortcut + file-tree drag/drop guards correct.
- **refreshStatus race** guarded by `statusGen`; stale ZIP/diff cache invalidated on pull/includeData/branch/LFS; per-action spinner cleared in `finally`; `buildQuickActions` grouping/A-M-D tested. Alembic chain linear/single-head/symmetric. No new `any`, no console.log, no unsanitized dangerouslySetInnerHTML, no secrets in touched files.

Carried follow-ups (non-blocking): `loadSyncState` gen guard (git-sync-store); `isDataFilePath` divergence from `isDataFile` (.pq); `dashboardNaturalKey` empty-name fallback mismatch; `project-pull.ts` has zero tests (highest-risk overlay/overwrite logic untested — a test would have caught the datasetAnalyses 🟠). Pre-existing/systemic (out of scope): the 4 `data_sources.detail_visit*` EN/FR mismatches (resolved 2026-07-22: dead keys removed); `workspace_id is None → no access check` pattern.

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-22

The user approved fixing **all** findings. Applied (verified in source; the two 🔴 reproduced empirically before AND after the fix):

**🔴 (both fixed):**
- **French-boolean data loss** (dataset_rows.py) — `_typed_projection` now emits an explicit `CASE WHEN lower(trim(x)) IN (<true-tokens>) … ELSE NULL` for boolean columns (token sets imported from type_inference), mirroring `parse_boolean` instead of DuckDB's narrower `try_cast AS BOOLEAN`. Reproduced pre-fix (`oui/non/vrai/faux/o → NULL`) and confirmed post-fix (`→ True/False`, `yes/no → True/False`, unknown → None). Test `test_french_boolean_tokens_survive_the_write`.
- **uid:undefined import** (ProjectsPage.tsx) — a plain import with a stripped/absent `project.uid` now mints a fresh uid (`!project.uid → crypto.randomUUID()`) before the collision check + delete-then-create, so it can't operate on `undefined`. Duplicate/git-pull paths unchanged.

**🟠 (5 fixed, 1 deferred):**
- **settings-import admin escalation** (settings_import_service.py) — an imported `role:"admin"` is now REFUSED → `user` with a warning (no latent-admin creation, no silent promotion of a live account); a locally-existing admin is never demoted by import either. Removed the now-dead per-row `_active_admin_count` demotion race. Tests: refuse-on-new, cannot-promote-existing, cannot-demote-existing.
- **pull-overwrite datasetAnalyses** (project-pull.ts) — the datasets branch now `deleteByDataset`s analyses before deleting the file (mirrors the full-import cleanup), so the deterministic-id `db.add` re-import no longer throws ConstraintError and half-deletes the dataset.
- **3 missing i18n keys** — `file_cat_organizations`/`_users`/`_roles` added to en+fr.
- **matchScore byte-parity** (mapping_project_export.py) — new `_js_numbers` normalizes whole-valued floats to int before `_json` (bool guarded out), so `1.0→"1"` like `JSON.stringify`. Test `test_whole_float_matchscore_serializes_like_js`.
- **UploadDatasetDialog re-upload + race** — new `previewDatasetBySha` (no re-upload); the dialog uploads the raw file ONCE (sha cached per File ref) and re-previews by sha on option tweaks; a `previewSeqRef` token discards out-of-order/after-close responses.
- **entries.json TS scoping — DEFERRED (not fixed).** Ported a pure `scopeEntriesToProject`/`sourceConceptPairKey` (tested) but did NOT wire it into the builder: the golden fixture proved the server scopes by the DuckDB-**deduped source dictionary** (its entries `20112-9`/`a,b` come from the CSV, not the mappings `ZZ`/`AA`), so a mappings-only scope drops entries the server keeps — a third divergent behaviour that broke the byte-parity golden test. Reproducing the dictionary read (CSV quoting + QUALIFY dedup + terminology fallback) in the export path risks new drift, so front-only keeps whole-badge export; documented as a known limitation in buildProjectSourceConceptIds. `git-file-meta.ts` scope keys were fixed anyway (the i18n 🟠). 

**🟡 batch (all fixed):**
- content-disposition RFC 5987 (`_attachment_disposition`: ASCII fallback + `filename*=UTF-8''`) so a non-latin1 project name can't 500 the export download.
- transcode temp leak — `_transcode_to_utf8` registers its UTF-8 temp against the connection; new `cleanup_transcoded(con)` called in every `build_read_expr` caller's `finally` (db_connect ×2, dataset_parser ×2). Test `test_transcoded_temp_is_cleaned_up`.
- clone-retry orphan (WorkspacesPage.tsx) — a `gitLinkedWsId` state carries the target ws into the manual retry so it no longer restores into `workspaceId:''`.
- trim vs strip (dataset_parser.py) — `_infer_types_sql` now trims the explicit ASCII-whitespace set (`trim(c, ' '||chr(9)||chr(10)||chr(13)||chr(11)||chr(12))`) so a tab/newline-padded boolean/date infers the same in preview and import.
- dashboard export order (entity-io.ts) — dashboards sorted by dashKey, tabs by key, widgets by (tabKey, key) via compareCodePoints so array order is byte-stable across instances.
- SQL-scripts labels (SqlScriptsEditorPage.tsx) — `Result — `/`Preview — `/`(selection)` → i18n keys `sql_scripts.tab_result`/`tab_preview`/`label_selection` (en+fr), effect deps updated.
- remove_repo (git_service.py) — now `_safe_join`-guards the entity_id before the rmtree (defense in depth). activity_touch — new test `test_editing_a_widget_bumps_dashboard_via_db_fallback` exercises the previously-uncovered two-hop DB SELECT.

**NOT changed:** the parity-edge entries.json scoping (deferred, above). The prior-review carried follow-ups (loadSyncState gen guard, isDataFilePath .pq, dashboardNaturalKey empty-name, project-pull tests) left for a dedicated pass.

Verification: frontend **369 tests** pass (+15: scope ×3 + suite growth) + **0 lint errors** (153 pre-existing React-Compiler warnings) + typecheck clean on all touched files (the 1 tsc error is in `workspace-export-golden.test.ts`, an **untracked parallel-session WIP file outside this review range** — flagged to the user, not ours to fix); backend touched-area suites **103 pass** (+21) + ruff clean on all touched files; i18n parity clean (only the 4 pre-existing `detail_visit*` — resolved 2026-07-22: dead keys removed). All uncommitted, awaiting the user's app test.

---

## 2026-07-17 — Plugin provenance + concept-mapping Progress breakdown/instant-editor + export-stripping/portable-ids + versioning diff-cache/LFS-opt-in + i18n empty-lang fallback

- Reviewed by: Claude Opus 4.8 — 4 parallel adversarial Explore sub-agents by feature group (plugin-provenance BE+FE, concept-mapping ProgressTab/instant-editor/badges, export-stripping/import-restamp/localized, versioning diff-cache/LFS/git-file-classify) + reviewer re-verified EVERY reported finding directly in source (the 🔴 mapping-import restamp reproduced against the type + both import paths; the export-sort many-to-many tie reproduced by tracing the row key; the plugin org-precedence traced through CardMetaFooter's `liveOrg ?? organization`).
- Range: 950d711f..0b6e5748 (**15 commits, 69 files, ~1,478 insertions / ~482 deletions**). Note: the first commit (`db48e478`) is the 2026-07-16 review's own fixes landing — spot-checked intact (DQ authz 🔴: `rule_set_id` now required + unconditional auth + workspace_id stamped server-side; view-mode widget gating; mapping filter fallback; column-id `\p{Mn}` parity). New work: **plugin provenance** (author/org trio + frozen org snapshot brought to parity with the other 7 exportables — model+schema+service+migration `c2d3e4f5a6b7`, `created_by_id` popped + re-derived via `stamp_creator`, FK Postgres-only); **card live re-hydration** (CardMetaFooter resolves author+org live, snapshot fallback, render-loop-safe via stable selectors + useMemo); **concept-mapping Progress breakdown** by vocab/category (ProgressTab +399, StatusBar, status-colors, equivalence-badge) + **instant editor** (optimistic createMapping w/ rollback); **portable source-concept-ids** + **export field-stripping** (mappings.json/project.json strip instance fields, stable sort, scores parquet gitignored) + **import createdAt re-stamp** (crash fix on stripped ZIPs); **versioning** per-file diff cache + rebuild-on-refresh + **LFS opt-in only** (no auto size/ext rule); **i18n empty-language fallback** (`||`+`find(Boolean)`). Version stays **2.1.2** (user chose not to bump this review).
- Last reviewed commit: 0b6e5748fc01deba505f20954891fe1d2982b83a
- Verdict: **Fix-then-ship** — 1 🔴 (mapping-project import doesn't re-stamp stripped `createdAt` → server-mode import failure) + 3 🟠 (export sort not total for many-to-many → spurious git diffs; Progress bar drops `suggested` concepts; plugin card org-precedence backwards) + a 🟡 batch. **User approved fixing ALL findings; applied this review (uncommitted, awaiting app test). Per the user's steer, `suggested` now counts as unmapped across ALL three Progress views (pie + mapped column + bar), not just the bar.**
- Tests: frontend **296 passed** (25 files, +3: 2 localized + 1 export determinism) · backend plugin+DQ **10 passed** (via `apps/api/.venv`) · Lint: **0 errors** (151 pre-existing React-Compiler warnings) · Typecheck: **0 errors** · Ruff: clean on touched · i18n parity: clean (only the 4 pre-existing `data_sources.detail_visit*` — resolved 2026-07-22: dead keys removed).
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

Carried follow-ups (non-blocking, pre-existing): `buildConceptUnionParts` heterogeneous UNION can Binder-Error on multi-dictionary sources where some map a `category` column and some don't — the new category-grouping path newly exercises it but the flaw predates this range (harden with `NULL AS category` for absent dicts). Pre-existing/systemic (out of scope): the 4 `data_sources.detail_visit*` EN/FR mismatches (resolved 2026-07-22: dead keys removed); the equivalence-badge English `label` values (unchanged this range); the `workspace_id is None → no access check` pattern (planned access-group rework).

### Fixes applied this review (uncommitted, awaiting user test) — 2026-07-17

The user approved fixing **all** findings and steered `suggested` → unmapped across all three Progress views. Applied: the 🔴 (mapping-import re-stamp, project + ranges); the 3 🟠 (export sort total via `mappingKey` tie-break + test; ProgressTab suggested-as-unmapped in pie/column/bar + latent statusPriority bug; plugin org-precedence); the 🟡 batch (toggleLfs cache invalidation, includeData config filter + exported helper, ProgressTab loadGen guard + color constants, localized ×2 tests, PluginsTab `.gitattributes` strip, git-sync-store stale comments). The backend "redundant setattr" nit was deliberately NOT changed (the proposed fix would break imports). Version stays **2.1.2** (user chose not to bump this review).

Verification: frontend **296 tests** pass + **0 lint errors** + **0 typecheck errors**; backend plugin+DQ **10 pass** + ruff clean on touched; i18n parity clean. All uncommitted, awaiting the user's app test.

---

## 2026-07-16 — Dashboards keep-alive/localized-names + DQ enable-disable/run-history + concept-mapping dedup+filters + deterministic column ids + import UX

- Range: d0077b07..950d711f (46 commits) · Last reviewed commit: 950d711f88fbd4c27022841218cbeb096ecec59f · Verdict: Fix-then-ship (all findings fixed)
- Covered: dashboards keep-alive + localized tab/widget names, DQ enable/disable + scan-run history (incl. a server-mode run-history authz 🔴), concept-mapping dedup/multi-select filters, deterministic name-derived column ids (TS/Python twins), import-error UX.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-07-13 — Concept-mapping pull/merge + server-owned renders (viewer-RCE fix) + provenance/lineage + alembic collapse + UI unification

- Range: dd96b39a..d0077b07 (69 commits) · Last reviewed commit: d0077b074e41e02c5e1b7171260cb63a702d8f8c · Verdict: Fix-then-ship (all findings fixed)
- Covered: concept-mapping pull (3-way merge), server-owned render builders closing the viewer-RCE, author/org provenance + lineageId, alembic collapse to one initial schema, unified list-page UI; fixed git `synced_oid`/`branch` command injection + cross-workspace project-import clobber.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-07-12 — Git versioning backend + permission-catalogue rework + plugins/schema-preset/dialog UX

- Range: 5137bc09..dd96b39a (89 commits) · Last reviewed commit: dd96b39aac8bb8c1b5e095183e77df235365cab8 · Verdict: Fix-then-ship
- Covered: server-side git versioning + LFS, permission-catalogue rework (3-tier RWD), plugins/schema-preset/dialog UX; fixed diff path traversal, clone/verify SSRF, refreshStatus race, schema-preset id-guard; the viewer `purpose="render"` 🔴 was closed by the 2026-07-13 server-owned renders.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-07-10 — Full-stack second wave: dashboards/members/attachments/global-table + UI role-gating + server-mode data paths

- Range: 22f01a8c..5137bc09 (100 commits) · Last reviewed commit: 5137bc09edeff95676f0142dd4d5461bf1cffe17 · Verdict: Fix-then-ship (all approved items fixed)
- Covered: dashboards/members/attachments persistence, 3-dimension RBAC, global-table service, UI role-gating, server-mode data paths; fixed stale-role window + blank-table race (front) and query viewer→editor + preview-columns access check + DSN whitespace escaping (back).
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-07-08 — Full-stack backend review (Groups A–I) — COMPLETE

- Range: eac0095f..22f01a8c (170 commits) · Last reviewed commit: 22f01a8c271b63bd8ba33860c995120007b04bbf · Verdict: Fix-then-ship → Ship it (all blockers fixed in commit e860150c + post-review hardening)
- Covered: the whole FastAPI backend landing by coherent file groups; 5 🔴 fixed (secret-key boot guard, organizations admin-only, blob sha traversal, DSN injection, /execute+terminal authz) + upload size cap, CORS guard, PTY session cap.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-07-05 — Author provenance mixin + suggestion-category filter + review-page redesign + change-password dialog

- Range: 7d357873..eac0095f (20 commits) · Last reviewed commit: eac0095f749522d8ffe6d615aee0a0e60c75ed4e · Verdict: Ship it
- Covered: `AuthorDetails`/`Authored` mixin + `stampAuthored()`, per-suggestion-category source filter, review-page redesign, ChangePasswordDialog (server endpoint owed at the time — since landed with the auth backend).
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-07-03 — LocalizedString migration + short-id URLs + entity actions menu + concept-mapping provenance

- Range: d24ec2cc..7d357873 (32 commits) · Last reviewed commit: 7d357873396511570fee2400d2828245e9b6e724 · Verdict: Fix-then-ship → Ship it
- Covered: string→LocalizedString migration (fixed the 10-error typecheck regression it introduced), git-style short-id URLs, shared entity-actions menu, concept-set provenance + scores-parquet export/import.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-06-27 — Unified seed manifest + re-seed/delete flow + modal/UI polish

- Range: 35f9160a..d24ec2cc · Last reviewed commit: d24ec2cc989ac9257e21fd2bccd5504f6a1d3dd5 · Verdict: Ship it
- Covered: unified seed manifest, targeted re-seed + removed-entity deletion (user-content-safe), import-conflict UX; fixed a baseline drop of user-origin children on workspace removal.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-06-24 — Dashboard rewrite (nested tabs, grid fit-to-height, filters, export/move trees, fullscreen)

- Range: 04ece659..35f9160a (10 commits) · Last reviewed commit: 35f9160a3312e4b1ecfc28f0e53c26822f218b88 · Verdict: Ship it (after fixes) — merged to main
- Covered: nested dashboard tabs, 48-col grid + fit-to-height, filter UX, export/move trees, fullscreen; fixed grid-migration idempotency, widget-result cache invalidation, tree cycle guard.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-06-24 — ESLint & TypeScript backlog clearance + merge to main

- Range: 778ff498..04ece659 (19 commits) · Last reviewed commit: 04ece6596e0b538ab0d21f117906e88da6a34973 · Verdict: Ship it — merged to main
- Covered: full lint + typecheck backlog driven to 0 errors (all three gates now blocking); verified the hook/ref reorderings and dead-code deletions introduced no regressions.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-06-23 — Quality harness branch (`quality-harness`)

- Range: 8d00601e..778ff498 (5 commits) · Last reviewed commit: 778ff498dfc443a9aa8fc2db1c6d0ed6285e862a · Verdict: Ship it (after the one fix)
- Covered: Vitest harness + CI quality stage + pre-push hook, lint cleanup, risky dead-code deletions (verified safe); fixed the `prepare` git-hook script failing CI when `.git` is absent.
- Findings resolved or captured in "Open items" above; details elided 2026-07-22.

---

## 2026-06-23 — Baseline (review harness set up)

- Range: — (baseline) · Last reviewed commit: 23bf12d45f9926b51d22206bb37dc98365fe1e91 · Verdict: —
- Starting point of the review chain; no review performed.
