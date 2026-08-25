/**
 * Parity against the app's own column-id fixture.
 *
 * `columnId` already has a TypeScript ↔ Python pair guarded by this fixture,
 * because a drift silently orphans every filter and widget config pointing at a
 * column. This package adds a third implementation, so it runs the SAME fixture:
 * the copy here cannot quietly diverge from the one the app and the server use.
 *
 * The duplication is temporary — step 4 of docs/planning/mcp-authoring-plan.md
 * makes the app import from this package and deletes its copy. Until then this
 * test is what makes the duplication safe.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildColumnIds, columnId, slugify } from './ids.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../apps/web/src/lib/column-id.fixture.json')

interface Fixture {
  cases: { names: string[]; ids: string[] }[]
}

describe('columnId parity with the app fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Fixture

  it('loads the shared fixture', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  for (const [i, testCase] of fixture.cases.entries()) {
    it(`case ${i}: ${JSON.stringify(testCase.names)}`, () => {
      expect(buildColumnIds(testCase.names)).toEqual(testCase.ids)
    })
  }
})

describe('columnId', () => {
  it('derives an id from the name', () => {
    expect(columnId('mean SpO2 (%)')).toBe('col_mean_spo2')
  })

  it('falls back to `col` for a name with no usable characters', () => {
    expect(columnId('!!!')).toBe('col_col')
  })
})

describe('slugify', () => {
  it('strips diacritics and lowercases', () => {
    expect(slugify('Démographie')).toBe('demographie')
  })

  it('collapses punctuation runs into a single dash', () => {
    expect(slugify('Age distribution — by sex')).toBe('age-distribution-by-sex')
  })

  it('falls back rather than returning an empty slug', () => {
    expect(slugify('---')).toBe('export')
  })
})
