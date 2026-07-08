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
