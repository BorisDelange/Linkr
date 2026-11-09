/**
 * A data-quality run's report, assembled by the server (apps/api
 * services/server_runs/dq.py, checked by tests/test_server_run_dq.py) as the
 * browser assembles its own: the same rows give the same results, summary and
 * score. This writes the rows and the browser's report.
 *
 * To regenerate after an intentional change:
 *   GOLDEN_UPDATE=1 npx vitest run src/lib/duckdb/data-quality.twin.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { checkReport, checkResult, entryResult, runOutcome, type DqCheck, type DqRunEntry } from './data-quality'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/dq-runs/report.json')

const check = (id: string, over: Partial<DqCheck> = {}): DqCheck => ({
  id, name: `Check ${id}`, description: '', category: 'completeness', subcategory: null, severity: 'error',
  origin: 'ddl', tableName: 'person', threshold: 0, sql: `SELECT /* ${id} */ 1`, exploreSql: null, ...over,
})

type Case = { check: DqCheck; ms: number } & ({ rows: Record<string, unknown>[] } | { error: string })

const CASES: Case[] = [
  { check: check('pass-zero'), rows: [{ violated_rows: 0, total_rows: 10 }], ms: 12.4 },
  { check: check('fail-zero', { severity: 'warning' }), rows: [{ violated_rows: 1, total_rows: 10 }], ms: 12.5 },
  { check: check('pass-threshold', { threshold: 5, category: 'plausibility' }), rows: [{ violated_rows: 1, total_rows: 50 }], ms: 3 },
  { check: check('fail-threshold', { threshold: 5, category: 'conformance', severity: 'notice' }), rows: [{ violated_rows: 3, total_rows: 50 }], ms: 0.49 },
  { check: check('third', { threshold: 50 }), rows: [{ violated_rows: 1, total_rows: 3 }], ms: 1999.5 },
  { check: check('no-rows-counted'), rows: [{ violated_rows: 0, total_rows: 0 }], ms: 1 },
  { check: check('no-row', { origin: 'manual', tableName: null }), rows: [], ms: 2 },
  { check: check('null-count', { category: 'plausibility' }), rows: [{ violated_rows: null, total_rows: 5 }], ms: 4 },
  { check: check('broken', { origin: 'manual' }), error: 'Catalog Error: Table with name missing does not exist!', ms: 7 },
]

const results = CASES.map((c) => checkResult(c.check, 'rows' in c ? c.rows : [], c.ms, 'error' in c ? c.error : null))
const report = { ...checkReport('ds-1', CASES.map((c) => c.check), results), computedAt: '2026-11-09T12:00:00.000Z' }

describe('a data-quality run report, server twin', () => {
  it('rebuilds each result from what a server run keeps of it', () => {
    CASES.forEach((c, i) => {
      const entry: DqRunEntry = 'error' in c
        ? { ms: Math.round(c.ms), error: c.error }
        : c.rows.length
          ? { ms: Math.round(c.ms), violated: Number(c.rows[0].violated_rows ?? 0), total: Number(c.rows[0].total_rows ?? 0) }
          : { ms: Math.round(c.ms), empty: true }
      expect(entryResult(c.check, entry)).toEqual(results[i])
    })
  })

  it('matches the fixture the server is held to', () => {
    const twin = {
      dataSourceId: report.dataSourceId,
      computedAt: report.computedAt,
      cases: CASES,
      expected: { report, outcome: runOutcome(report) },
    }
    const text = `${JSON.stringify(twin, null, 2)}\n`
    if (process.env.GOLDEN_UPDATE) writeFileSync(FIXTURE, text)
    expect(readFileSync(FIXTURE, 'utf-8')).toBe(text)
  })
})
