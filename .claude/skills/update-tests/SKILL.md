---
name: update-tests
description: Audit and bring Linkr's tests up to date with the code — find what changed since the last audit, add the missing tests (unit, database-matrix corpus, end-to-end journeys, SPE scenarios), update the ones the change made stale, retire the dead ones, and re-check known bugs. Logs each audit in AUDIT-LOG.md so the next one starts where this one stopped. Use when asked to update, audit or complete the tests, after a feature lands without tests, or before a release.
argument-hint: "[<git range> | <area>]"
---

# Keep Linkr's tests up to date

What deserves a test, and how to write one, is in `docs/conventions.md` § Tests;
the tiers and their tooling are in `docs/testing.md`. This skill is the audit
loop around them.

## 1. Range

Read the newest entry of `AUDIT-LOG.md` (next to this file): its
`Last audited commit` is where this audit starts, up to `HEAD`. An argument
overrides it (a git range, or an area such as `cohorts` or `connectors`). No
entry yet: audit the last 30 commits on the current branch.

```bash
git log --oneline <from>..HEAD
git diff --stat <from>..HEAD -- . ':!**/*.json' ':!**/locales/**'
```

## 2. Inventory — what each change asks of the tests

Go through the changed files and fill one list per tier. A file can land in
several.

| Change | Test it needs | Where |
|---|---|---|
| Pure critical logic (SQL escaping/validation, query builders, fuzzy search, import/export, format helpers, schema transforms, stats) | unit test, with an adversarial case | co-located `*.test.ts` / `apps/api/tests/test_*.py` |
| A new or changed **query builder** whose SQL reaches a database | an entry in the matrix corpus, so every engine runs it | `tests/db-matrix/build-corpus.ts` |
| A new connector, engine or connection option | the engine in `tests/db-matrix/engines.py` (+ its load in `matrix.py`, its service in `docker/spe-sim/docker-compose.yml`) | db-matrix |
| A new screen, or a change to a journey a user relies on (boot, databases, concepts, cohorts, patient data, dashboards, import/export, IDE) | an end-to-end journey, or an update of the one it changed | `apps/web/e2e/client/` (WASM), `apps/web/e2e/server/` (full stack) |
| A changed label, placeholder or heading in `locales/en.json` | the journeys that select by it | grep the old text in `apps/web/e2e/` |
| Deployment, proxy, base path, WebSocket, mirror, resource behaviour | a scenario or a smoke-test check | `docker/spe-sim/scenarios/`, `smoke-test.sh` |
| A removed or renamed function, route or table | delete or rename its tests | grep the old name in every test tree |

Leave out what `docs/conventions.md` says not to test (volatile component
internals, store wiring, trivial getters). A UI change gets a journey only when
it changes what a user does, not how it looks.

## 3. Stale and dead tests

- **Collection errors and skips**: `pytest --collect-only -q` and `vitest list`
  fail on a test importing something gone. Every `skip`, `skipif`, `xfail`,
  `test.fixme` and `@known-bug` in the range: is its reason still true?
- **Known bugs**: run `E2E_KNOWN_BUGS=1 npm run test:e2e -- --grep @known-bug`.
  A journey that now passes several times in a row (`--repeat-each 5`) means the
  bug is fixed: drop the tag and its comment.
- **Matrix known differences**: a `sqlite`/engine failure in the last matrix
  report that a change claims to fix — re-run `npm run test:matrix` and check it
  is gone.
- **Churning tests**: a test edited in most commits of the range is testing
  something volatile — push the logic down into a pure function and test that,
  or delete the test.

## 4. Write them

Follow `docs/conventions.md` § Tests. Two rules the review log keeps
re-learning: test the input that breaks it, and **watch each new test fail**
(revert the fix, see it red, restore). For a journey: select by role, label or
visible text (`getByRole`, `getByPlaceholder`), never by CSS class; assert what
the user would check (a count, a name), not layout; add it to the right project
(`client` needs only the seed, `server` a running stack).

For the corpus: one `add(key, builder, sql)` per builder variant that changes
the SQL shape (a cohort level, a criterion type, a scope), not one per value.

## 5. Run what you touched

Use the `run-tests` skill on the tiers the new tests belong to. A new matrix
entry that fails on an engine is a finding, not a test to loosen: report it.

## 6. Log the audit

Prepend an entry to `AUDIT-LOG.md`:

```
## YYYY-MM-DD — <short title>

- Range: <from>..<head>  (<N> commits)
- Last audited commit: <head sha>
- Added: <tests, one line each, with file>
- Updated: <…>
- Removed: <…>
- Known bugs re-checked: <journey → still failing | fixed, tag dropped>
- Left for later: <what needs a test but was not written, and why>
```

Report the same in the reply, findings first (a bug a new test exposed).
