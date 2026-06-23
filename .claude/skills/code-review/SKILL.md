---
name: code-review
description: Run a structured quality + security review of recent Linkr changes (security, state-of-the-art code, global coherence, no useless comments, conventions). Logs each review with its date and the commit range covered in REVIEW-LOG.md. Use when the user asks to review the code, audit recent work, or check quality before a release.
argument-hint: [since-commit-or-range (optional)]
---

# Linkr Code Review

You are performing a disciplined review of recent changes to Linkr. The user is **not** a developer and cannot review every line themselves — your review is the main quality gate. Be thorough, concrete, and honest. Do not rubber-stamp.

## Step 0 — Determine the review range

1. Read `.claude/skills/code-review/REVIEW-LOG.md`. The most recent entry records the **last reviewed commit** (`Last reviewed commit:`).
2. Decide the range:
   - If the user passed an argument, use it (e.g. `abc123..HEAD` or a single commit).
   - Else, review from the last reviewed commit to `HEAD`: `git log --oneline <last>..HEAD`.
   - If the log is empty (first review ever), review the last 20 commits and say so.
3. Get the actual diff to review: `git diff <last>..HEAD` (and `git status` for uncommitted work — review that too).
4. Tell the user the range and the list of commits you are about to review before diving in.

## Step 1 — Review across five dimensions

Go file by file through the diff. For **each** finding, record: file:line, severity (🔴 critical / 🟠 important / 🟡 minor), the problem, and a concrete fix. Group findings by dimension.

### 1. Security
- **SQL safety**: every dynamic string into DuckDB SQL must use `escSql()`; identifiers via `isSafeIdentifier()`; numeric ID lists via `validateIntegerIds()`. Flag any raw interpolation. (See `docs/conventions.md` → SQL safety.)
- **HTML injection**: any `dangerouslySetInnerHTML` must go through `sanitizeHtml()`. Flag raw HTML.
- **Secrets**: no API keys, tokens, passwords, or connection strings in code. Config via env / `config.local.json`.
- **Untrusted input**: user-authored SQL, plugin code (R/Python), imported ZIPs, cloned git repos — confirm they're handled as untrusted.
- **Dependencies**: flag any newly added dependency that looks unnecessary, unmaintained, or surprising (hallucinated package risk — verify it's a real, intended package).

### 2. State-of-the-art code
- Correctness: off-by-one, null/undefined handling, async race conditions, missing `await`, unhandled promise rejections, stale closures in hooks (missing/incorrect deps arrays).
- Error handling matches the convention table in `docs/conventions.md` (silent-at-load, console.warn at persist, degrade-don't-throw). Flag swallowed errors that should surface to the user.
- No new `any`. No `console.log`. Proper TypeScript types.
- React: keys on lists, no work in render that belongs in `useMemo`/effects, no state mutated directly.

### 3. Global coherence
- Does the change follow existing patterns (Zustand store shape, hook return shape, component structure, import order)? Compare against neighbours.
- Reuse: is logic duplicated that already exists in `@/lib/*`? Could it be extracted?
- i18n: every user-facing string via `t()`, keys present in **both** `en.json` and `fr.json`.
- File size: flag files pushed past ~800 lines; suggest extraction.

### 4. Comments & readability
- Flag comments that describe **what** the code does (should be deleted). Keep only WHY-comments (non-obvious constraints/workarounds).
- Flag dead code, commented-out code, leftover debug.

### 5. Tests
- For any new/changed **pure critical logic** (SQL builders, escaping, OMOP queries, fuzzy-search, import/export, format helpers), is there a matching test? If not, flag it and offer to write it (`.claude/skills/write-tests/`).
- Run `cd apps/web && npm run test` and report pass/fail.

## Step 2 — Verify, don't assume

- Before reporting a security or correctness finding as 🔴, re-read the surrounding code to confirm it's real (not already guarded elsewhere). False alarms erode trust.
- Run `cd apps/web && npm run lint` and `npm run test`; include results.
- Optionally run `npm run typecheck` — note: there is a known backlog of pre-existing type errors, so only flag type errors **introduced by this diff**, not the whole list.

## Step 3 — Write the verdict and log it

1. Present a summary to the user: counts by severity, the top 3 things to fix, and an overall verdict (Ship it / Fix-then-ship / Needs work).
2. Append a new entry to `.claude/skills/code-review/REVIEW-LOG.md` using the template in that file. Set `Last reviewed commit:` to the current `HEAD` SHA (`git rev-parse HEAD`).
3. Do **not** invent the date — get it from the environment context (the `currentDate` reminder) or `git log -1 --format=%cd`.

## Tone

Be direct. Surface real problems plainly without softening. If something is genuinely good, say so briefly. The user relies on this review catching what they cannot.
