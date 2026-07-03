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
