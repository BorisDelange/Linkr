---
name: write-tests
description: Write and maintain Vitest unit tests for Linkr's pure, critical logic (SQL escaping/validation, OMOP/query builders, fuzzy-search, import/export, format helpers). Defines what to test, what NOT to test, and how to keep tests in sync as the code changes. Use when adding tests, or when you changed tested logic and need to update its test.
argument-hint: [file-or-area to test (optional)]
---

# Write & Maintain Tests for Linkr

The point of these tests is **reliability the user can trust without reading every line**. So we test the things that fail silently and stay stable — not the things that churn.

## The one rule that keeps tests maintainable

> **Test stable contracts, not volatile UI.**

The user changes a lot of UI frequently. If we unit-test components, the tests rot and become noise. Instead we test the *pure logic underneath* — its contract ("this input → that output") rarely changes even when the screen around it does. That's why these tests stay cheap to maintain.

## What to test ✅

Pure functions with a clear input → output contract, especially security- or correctness-critical ones:

- **SQL safety** — `escSql`, `isSafeIdentifier`, `validateIntegerIds` (`lib/format-helpers.ts`). Always include an injection-payload case.
- **Query builders** — `buildFuzzySearchSql` (`lib/fuzzy-search.ts`), OMOP query builders in `lib/duckdb/` (e.g. `concept-queries.ts`, batch-count builders). Assert on the *structure* of the generated SQL (tiers present, term escaped, alias applied), not on a full string match.
- **Text logic** — `fuzzyTextMatch`, `format-helpers` (dates, labels, `daysBetween`).
- **Import/export** — `lib/entity-io.ts` round-trips (build a project ZIP → parse it → assert fields survive). Catches data-loss regressions.
- **Schema/DDL transforms**, **stats helpers**, **DCAT-AP serialization** — any pure transform where a silent wrong answer would corrupt data or mislead a clinician.

## What NOT to test ❌

- React components / JSX rendering (volatile — churns every iteration).
- Zustand stores' wiring, hooks, anything needing the DOM or a live DuckDB/Pyodide/WebR runtime.
- Trivial getters/constants.
- Anything that would need heavy mocking to test — that's a signal the logic should be extracted into a pure function first, *then* tested.

If behaviour really needs a browser/runtime, cover it with the `verify` skill (manual/E2E run), not a unit test.

## How to write a test

1. Co-locate: `foo.ts` → `foo.test.ts` in the **same folder**. Vitest picks up `src/**/*.test.ts`.
2. Import explicitly: `import { describe, it, expect } from 'vitest'` (don't rely on globals in new files; keeps `tsc` happy).
3. One `describe` per function, one `it` per behaviour. Name behaviours, not implementations: `it('doubles single quotes')`, not `it('works')`.
4. For every security-critical function, include at least one **adversarial** case (injection string, NaN, empty, null/undefined).
5. Keep tests pure: no network, no filesystem, no real DB. If you need fixture data, inline a small literal.
6. Run `cd apps/web && npm run test`. All green before you're done.

See `src/lib/format-helpers.test.ts` and `src/lib/fuzzy-search.test.ts` as the reference style.

## Keeping tests in sync (the maintenance loop)

This is the part that matters for a fast-moving codebase:

- **When you CHANGE a tested function**: update its test in the *same* change. Treat a failing test as a question — "did I mean to change this contract?" If yes, update the assertion. If no, you found a regression: fix the code.
- **When you ADD critical pure logic**: add its test before you consider the task done. The test *is* the spec.
- **When you DELETE a function**: delete its test.
- **When a test becomes flaky or needs constant churn**: it's probably testing something volatile. Delete it or push the logic down into a purer function and test that instead. A test that's edited every week is worse than no test.

The `code-review` skill checks for missing tests on new critical logic and will route back here.

## Coverage philosophy

Don't chase a coverage percentage. Aim for: **every function that could silently corrupt data, leak via SQL, or produce a clinically wrong number has at least one adversarial test.** That's the bar. Breadth over the critical surface beats depth on trivial code.
