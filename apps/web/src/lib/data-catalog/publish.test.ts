import { describe, expect, it } from 'vitest'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { defaultCatalogVariables } from './config'
import { ageDisplayName, buildCrossingCsv, buildPublishedCatalog } from './publish'

const catalog = {
  variables: defaultCatalogVariables(),
  crossings: [['period'], ['sex'], ['period', 'sex']],
  anonymization: { threshold: 10, mode: 'replace' },
} as Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>

const cache = {
  concepts: [],
  crossings: [
    { id: 'period', variables: ['period'], rows: [{ values: ['2100'], patients: 3, stays: 3 }, { values: ['2101'], patients: 80, stays: 90 }, { values: ['2102'], patients: 70, stays: 75 }] },
    { id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 80, stays: 90 }, { values: ['female'], patients: 73, stays: 78 }] },
    { id: 'period-sex', variables: ['period', 'sex'], rows: [
      { values: ['2102', 'female'], patients: 7, stays: 777 },
      { values: ['2101', 'male'], patients: 50, stays: 55 },
      { values: ['2101', 'female'], patients: 30, stays: 35 },
      { values: ['2102', 'male'], patients: 63, stays: 64 },
      { values: ['2100', 'male'], patients: 3, stays: 3 },
    ] },
  ],
  modalities: { period: ['2100', '2101', '2102'], sex: ['male', 'female'] },
} as unknown as CatalogResultCache

describe('buildPublishedCatalog', () => {
  const pub = buildPublishedCatalog(catalog, cache)
  const crossing = pub.crossings.find((c) => c.id === 'period-sex')!

  it('never carries the numbers of a masked cell', () => {
    expect(JSON.stringify(pub)).not.toContain('777')
    expect(crossing.cells).toContainEqual([1, 1, null, null, 1])
  })

  it('drops the periods outside the first and last reaching the threshold', () => {
    expect(pub.variables.period!.mods).toEqual(['2101', '2102'])
    expect(crossing.cells).toHaveLength(4)
  })

  it('orders cells by modality and names them for display', () => {
    expect(crossing.cells.map((c) => c.slice(0, 2))).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]])
    expect(pub.variables.sex!.names).toEqual(['Male', 'Female'])
  })

  it('writes masked cells as empty counts with their status', () => {
    const csv = buildCrossingCsv(pub, crossing).trim().split('\n')
    expect(csv[0]).toBe('period,sex,patients,stays,status')
    expect(csv).toContain('2102,female,,,suppressed')
    // One protective cell per sex column: each holds a small cell, 2102·female
    // in its own and the trimmed 2100·male in the male one.
    expect(csv.filter((l) => l.endsWith('suppressed_secondary'))).toHaveLength(2)
  })
})

describe('single-variable crossings', () => {
  it('publishes a marginal only when it is chosen, and masks without it', () => {
    const pub = buildPublishedCatalog({ ...catalog, crossings: [['period'], ['period', 'sex']] }, cache)
    expect(pub.crossings.map((c) => c.id)).toEqual(['period', 'period-sex'])
    // No published total per sex any more: nothing to protect by subtraction along it.
    const withSex = buildPublishedCatalog(catalog, cache).crossings.find((c) => c.id === 'period-sex')!
    const withoutSex = pub.crossings.find((c) => c.id === 'period-sex')!
    expect(withoutSex.masked.secondary).toBeLessThanOrEqual(withSex.masked.secondary)
  })
})

describe('crossing measures', () => {
  const both = { ...catalog, counts: { visits: true, unitStays: true } }
  // A third small cell, so that masking the female one needs no secondary cell.
  const withUnits = {
    ...cache,
    crossings: [{ id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 80, stays: 90, unitStays: 120 }, { values: ['female'], patients: 4, stays: 5, unitStays: 6 }, { values: ['other'], patients: 2, stays: 2, unitStays: 2 }] }],
  } as unknown as CatalogResultCache

  it('carries each counted measure after patients, masked alike', () => {
    const [sex] = buildPublishedCatalog(both, withUnits).crossings
    expect(sex.measures).toEqual(['stays', 'unit_stays'])
    expect(sex.cells).toContainEqual([0, 80, 90, 120, 0])
    expect(sex.cells).toContainEqual([1, null, null, null, 1])
    expect(buildCrossingCsv(buildPublishedCatalog(both, withUnits), sex).split('\n')[0]).toBe('sex,patients,stays,unit_stays,status')
  })

  it('carries patients alone when the catalog counts nothing else', () => {
    const [sex] = buildPublishedCatalog({ ...catalog, counts: { visits: false, unitStays: false } }, withUnits).crossings
    expect(sex.measures).toEqual([])
    expect(sex.cells).toContainEqual([0, 80, 0])
  })
})

describe('ageDisplayName', () => {
  it('reads brackets as inclusive age ranges', () => {
    expect(ageDisplayName('[18;65[')).toBe('18–64')
    expect(ageDisplayName('[90;+∞[')).toBe('90+')
    expect(ageDisplayName('[0;+∞[')).toBe('All ages')
  })
})
