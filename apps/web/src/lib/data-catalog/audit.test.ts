import { describe, expect, it } from 'vitest'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { auditCatalog, auditPublished, type AuditInput } from './audit'
import { defaultCatalogVariables } from './config'
import type { PublishedCatalog } from './publish'

const variable = (id: 'concept' | 'period' | 'sex', mods: string[]) => ({ id, label: id, kind: 'nominal' as const, mods, names: mods, partition: {} as never })

/**
 * The Atrovent case of the MIMIC-IV audit, as an outsider reads it: the
 * concept's 1,300 records are published, and its periods but the last,
 * masked — 1,164 + 133 of them. The last one holds the remaining 3 records,
 * so between 1 and 3 patients.
 */
function atrovent(noise: number): AuditInput {
  const published: PublishedCatalog = {
    threshold: 10,
    variables: { concept: variable('concept', ['c']), period: variable('period', ['2190', '2200', '2210']) },
    crossings: [
      { id: 'concept', vars: ['concept'], measures: ['records'], masked: { primary: 0, secondary: 0 }, cells: [[0, 900, 1300, 0]] },
      { id: 'concept-period', vars: ['concept', 'period'], measures: ['records'], masked: { primary: 0, secondary: 0 }, cells: [[0, 0, 800, 1164, 0], [0, 1, 79, 133, 0]] },
    ],
  }
  return { published, concepts: [], totals: { patients: 1000, records: 5000 }, threshold: 10, noise }
}

describe('auditPublished', () => {
  it('finds a masked cell whose records give its patients away', async () => {
    const { findings } = await auditPublished(atrovent(0))
    expect(findings.find((f) => f.measure === 'patients')).toMatchObject({
      crossing: 'concept-period', kind: 'small', count: 1, examples: [{ cell: ['c', '2210'], lo: 1, hi: 3 }],
    })
    expect(findings.find((f) => f.measure === 'records')).toMatchObject({ kind: 'exact', examples: [{ lo: 3, hi: 3 }] })
  })

  it('finds nothing once every count is known only within the noise', async () => {
    // 1,300 ± 3, 1,164 ± 3 and 133 ± 3: the last period holds between 0 and 12 records.
    expect((await auditPublished(atrovent(3))).findings).toEqual([])
  })

  it('follows a total recovered from another table', async () => {
    // Period 2 is masked, but the grand total gives its 90 stays back; then
    // its women are 90 − 80 = 10 stays, so at most 9 patients… here 8.
    const published: PublishedCatalog = {
      threshold: 10,
      variables: { period: variable('period', ['1', '2']), sex: variable('sex', ['male', 'female']) },
      crossings: [
        { id: 'period', vars: ['period'], measures: ['stays'], masked: { primary: 0, secondary: 0 }, cells: [[0, 100, 110, 0]] },
        { id: 'period-sex', vars: ['period', 'sex'], measures: ['stays'], masked: { primary: 0, secondary: 0 }, cells: [[0, 0, 60, 66, 0], [0, 1, 40, 44, 0], [1, 0, 70, 82, 0]] },
      ],
    }
    const { findings } = await auditPublished({ published, concepts: [], totals: { patients: 170, stays: 200, records: 0 }, threshold: 10, noise: 0 })
    expect(findings.find((f) => f.crossing === 'period-sex' && f.measure === 'patients')).toMatchObject({ examples: [{ cell: ['2', 'female'], lo: 1, hi: 8 }] })
  })
})

describe('auditCatalog', () => {
  it('finds nothing in what the masking now publishes for the Atrovent case', async () => {
    // Two small cells masked — 2100, trimmed off the page, and 2210 — which
    // the old rule took as protected by being two: 1,300 − 1,297 gave them away.
    const catalog = {
      variables: { ...defaultCatalogVariables(), concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } },
      crossings: [['period'], ['concept', 'period']],
      anonymization: { threshold: 10, mode: 'replace' },
    } as unknown as Pick<DataCatalog, 'variables' | 'crossings' | 'anonymization' | 'counts'>
    const row = (p: string, patients: number, records: number) => ({ values: ['c', p], patients, records })
    const cache = {
      catalogId: 'x', computedAt: 'now', durationMs: 0, totalConcepts: 1, totalPatients: 1000, totalVisits: 2000,
      grandTotal: { totalPatients: 1000, totalVisits: 2000, totalRecords: 1300 },
      concepts: [{ conceptId: 'c', conceptName: 'Atrovent', patientCount: 900, recordCount: 1300 }],
      crossings: [
        { id: 'period', variables: ['period'], rows: [{ values: ['2100'], patients: 3, stays: 3 }, { values: ['2190'], patients: 800, stays: 1000 }, { values: ['2200'], patients: 150, stays: 900 }, { values: ['2210'], patients: 50, stays: 97 }] },
        { id: 'concept-period', variables: ['concept', 'period'], rows: [row('2100', 1, 1), row('2190', 800, 1164), row('2200', 79, 133), row('2210', 1, 2)] },
      ],
      modalities: { period: ['2100', '2190', '2200', '2210'], concept: ['c'] },
    } as unknown as CatalogResultCache
    const audit = await auditCatalog(catalog, cache)
    expect(audit.findings.filter((f) => f.measure === 'patients')).toEqual([])
    expect(audit).toMatchObject({ threshold: 10, noise: 0, resultsComputedAt: 'now' })
  })
})
