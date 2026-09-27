import { describe, expect, it } from 'vitest'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { defaultCatalogVariables } from './config'
import { ageDisplayName, buildCrossingCsv, buildPublishedCatalog, computeCatalogMasks, publishedConcepts } from './publish'
import { PRIMARY, PUBLISHED, SECONDARY } from './suppression'

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

  it('leaves masked cells out, like empty ones: absent reads the same whichever it is', () => {
    expect(JSON.stringify(pub)).not.toContain('777')
    // One protective cell per sex column: each holds a small cell, 2102·female
    // in its own and the trimmed 2100·male in the male one.
    expect(crossing.masked).toEqual({ primary: 1, secondary: 2 })
    expect(crossing.cells).toEqual([[1, 0, 63, 64, 0]])
    expect(buildCrossingCsv(pub, crossing).trim().split('\n')).toEqual(['period,sex,patients,stays,status', '2102,male,63,64,published'])
  })

  it('keeps the masked cells with their numbers for the preview, without them for the agent', () => {
    const revealed = buildPublishedCatalog(catalog, cache, { reveal: true }).crossings.find((c) => c.id === 'period-sex')!
    expect(revealed.cells).toContainEqual([1, 1, 7, 777, 1])
    expect(revealed.cells.filter((c) => c[4] === 2)).toHaveLength(2)
    const kept = buildPublishedCatalog(catalog, cache, { keepMasked: true }).crossings.find((c) => c.id === 'period-sex')!
    expect(kept.cells).toContainEqual([1, 1, null, null, 1])
    expect(buildCrossingCsv(pub, kept)).toContain('2102,female,,,suppressed')
  })

  it('drops the periods outside the first and last reaching the threshold', () => {
    expect(pub.variables.period!.mods).toEqual(['2101', '2102'])
    expect(buildPublishedCatalog(catalog, cache, { reveal: true }).crossings.find((c) => c.id === 'period-sex')!.cells).toHaveLength(4)
  })

  it('orders cells by modality and names them for display', () => {
    const revealed = buildPublishedCatalog(catalog, cache, { reveal: true }).crossings.find((c) => c.id === 'period-sex')!
    expect(revealed.cells.map((c) => c.slice(0, 2))).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]])
    expect(pub.variables.sex!.names).toEqual(['Male', 'Female'])
  })
})

describe('the concept list as the concept margin', () => {
  const conceptCatalog = (crossings: DataCatalog['crossings'], mode: 'replace' | 'suppress' = 'replace') => ({
    variables: { ...defaultCatalogVariables(), concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } },
    crossings,
    anonymization: { threshold: 10, mode },
  }) as Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>
  const concept = (conceptId: number, patientCount: number) => ({ conceptId, conceptName: `C${conceptId}`, patientCount, recordCount: patientCount * 2 })

  // Concept 42: 60 men, 3 women; the list publishes its 63 patients.
  const reproduced = {
    concepts: [concept(42, 63), concept(7, 90)],
    crossings: [
      { id: 'concept', variables: ['concept'], rows: [{ values: ['42'], patients: 63, records: 126 }, { values: ['7'], patients: 90, records: 180 }] },
      { id: 'concept-sex', variables: ['concept', 'sex'], rows: [
        { values: ['42', 'male'], patients: 60, records: 120 },
        { values: ['42', 'female'], patients: 3, records: 6 },
        { values: ['7', 'male'], patients: 50, records: 100 },
        { values: ['7', 'female'], patients: 40, records: 80 },
      ] },
    ],
    modalities: { concept: ['7', '42'], sex: ['male', 'female'] },
  } as unknown as CatalogResultCache

  it('masks the other cell of a concept whose list total is published', () => {
    const cat = conceptCatalog([['concept', 'sex']])
    const { masks, concepts } = computeCatalogMasks(cat, reproduced, 10)
    // 42·male published would give 42·female away: 63 − 60 = 3.
    expect(masks.get('concept-sex')!.status[0]).not.toBe(PUBLISHED)
    expect([...concepts]).toEqual([PUBLISHED, PUBLISHED])
    const cells = buildPublishedCatalog(cat, reproduced).crossings[0].cells
    expect(cells.some((c) => c[2] === 60)).toBe(false)
  })

  it('masks in the list a concept the margin masks to protect another', () => {
    // One concept below the threshold: the smallest other one is masked with it.
    const cache = { concepts: [concept(1, 5), concept(2, 50), concept(3, 200)], crossings: [], modalities: {} } as unknown as CatalogResultCache
    const cat = conceptCatalog([])
    expect(publishedConcepts(cat, cache).map((c) => c.status)).toEqual([PRIMARY, SECONDARY, PUBLISHED])
    expect(publishedConcepts(conceptCatalog([], 'suppress'), cache).map((c) => c.conceptId)).toEqual([3])
    expect(publishedConcepts(conceptCatalog([], 'suppress'), cache, { reveal: true })).toHaveLength(3)
  })

  it('gives the 1-way concept crossing the statuses of the list', () => {
    const cache = {
      concepts: [concept(1, 5), concept(2, 50), concept(3, 200)],
      crossings: [{ id: 'concept', variables: ['concept'], rows: [{ values: ['3'], patients: 200, records: 400 }, { values: ['2'], patients: 50, records: 100 }, { values: ['1'], patients: 5, records: 10 }] }],
      modalities: { concept: ['3', '2', '1'] },
    } as unknown as CatalogResultCache
    const { masks } = computeCatalogMasks(conceptCatalog([['concept']]), cache, 10)
    expect([...masks.get('concept')!.status]).toEqual([PUBLISHED, SECONDARY, PRIMARY])
  })

  it('does not name the masked concepts in suppress mode', () => {
    const cache = {
      ...reproduced,
      concepts: [...reproduced.concepts, concept(99, 4), concept(98, 2)],
      crossings: [
        { ...reproduced.crossings[0], rows: [...reproduced.crossings[0].rows, { values: ['99'], patients: 4, records: 8 }, { values: ['98'], patients: 2, records: 4 }] },
        { ...reproduced.crossings[1], rows: [...reproduced.crossings[1].rows, { values: ['99', 'male'], patients: 4, records: 8 }] },
      ],
      modalities: { concept: ['7', '42', '99', '98'], sex: ['male', 'female'] },
      labels: { concept: { 7: 'C7', 42: 'C42', 99: 'Rare disease', 98: 'Rarer disease' } },
    } as unknown as CatalogResultCache
    const suppressed = buildPublishedCatalog(conceptCatalog([['concept', 'sex']], 'suppress'), cache)
    expect(suppressed.variables.concept!.mods).toEqual(['7', '42'])
    expect(JSON.stringify(suppressed)).not.toContain('Rare')
    const replaced = buildPublishedCatalog(conceptCatalog([['concept', 'sex']]), cache)
    expect(replaced.variables.concept!.names).toContain('Rare disease')
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
    expect(sex.cells).toEqual([[0, 80, 90, 120, 0]])
    expect(buildPublishedCatalog(both, withUnits, { keepMasked: true }).crossings[0].cells).toContainEqual([1, null, null, null, 1])
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
