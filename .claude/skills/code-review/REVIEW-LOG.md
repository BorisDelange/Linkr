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

## 2026-06-24 — Dashboard rewrite (nested tabs, grid fit-to-height, filters, export/move trees, fullscreen)

- Reviewed by: Claude Opus 4.8 (2 parallel adversarial sub-reviews + manual verification pass)
- Range: 04ece659..15cb5037 (10 commits — Lou's MR squash + tab navigation, 48-col grid, fit-to-height, filter UX, export/move tree views, fullscreen, perf cache, review fixes)
- Last reviewed commit: 15cb503791200389620c05b643219055ecaa496a
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
