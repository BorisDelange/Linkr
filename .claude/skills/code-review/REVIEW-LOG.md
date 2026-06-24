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
