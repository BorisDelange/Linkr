import { describe, expect, it } from 'vitest'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { defaultCatalogVariables } from './config'
import { ageDisplayName, buildCrossingCsv, buildPublishedCatalog, computeCatalogMasks, computedMeasures, publishedConcepts, publishedTotals } from './publish'
import { PRIMARY, PUBLISHED, SECONDARY } from './suppression'
import { auditPublished } from './audit'

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
    // 2102 is masked in the period table to protect 2100, but the grand total
    // gives it back: 2102·male published would then give 2102·female away. So
    // its row is protected all the same, and that masks 2101 in turn.
    expect(crossing.masked).toEqual({ primary: 1, secondary: 3 })
    expect(crossing.cells).toEqual([])
    expect(buildCrossingCsv(pub, crossing).trim().split('\n')).toEqual(['period,sex,patients,stays,status'])
  })

  it('keeps the masked cells with their numbers for the preview, without them for the agent', () => {
    const revealed = buildPublishedCatalog(catalog, cache, { reveal: true }).crossings.find((c) => c.id === 'period-sex')!
    expect(revealed.cells).toContainEqual([1, 1, 7, 777, 1])
    expect(revealed.cells.filter((c) => c[4] === 2)).toHaveLength(3)
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

describe('the concept list at category level', () => {
  const categoryCatalog = (crossings: DataCatalog['crossings']) => ({
    variables: { ...defaultCatalogVariables(), concept: { enabled: true, level: 'category', categoryColumn: 'domain', scope: 'all', topN: 10 } },
    crossings,
    anonymization: { threshold: 10, mode: 'replace' },
  }) as Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>
  const concept = (conceptId: number, category: string, patientCount: number, recordCount: number) => ({ conceptId, conceptName: `C${conceptId}`, category, patientCount, recordCount })
  // Category C: 100 records, c1 90 + c2 10; D: 500, c3 470 + c4 30. c2 and c4
  // are below the threshold: two masked concepts, 40 records between them, so
  // the list alone tells nothing — but C's published 100 minus c1's 90 is c2.
  const cache = {
    concepts: [concept(1, 'C', 50, 90), concept(2, 'C', 3, 10), concept(3, 'D', 190, 470), concept(4, 'D', 4, 30)],
    crossings: [
      { id: 'concept', variables: ['concept'], rows: [{ values: ['C'], patients: 52, records: 100 }, { values: ['D'], patients: 194, records: 500 }] },
      { id: 'concept-sex', variables: ['concept', 'sex'], rows: [
        { values: ['C', 'male'], patients: 30, records: 60 }, { values: ['C', 'female'], patients: 22, records: 40 },
        { values: ['D', 'male'], patients: 100, records: 260 }, { values: ['D', 'female'], patients: 94, records: 240 },
      ] },
      { id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 130, records: 320 }, { values: ['female'], patients: 116, records: 280 }] },
    ],
    modalities: { concept: ['D', 'C'], sex: ['male', 'female'] },
  } as unknown as CatalogResultCache

  it('never publishes a category total with all but one of its concepts', () => {
    for (const crossings of [[['concept']], [['concept', 'sex']]] as DataCatalog['crossings'][]) {
      const cat = categoryCatalog(crossings)
      const listed = publishedConcepts(cat, cache)
      const C = computeCatalogMasks(cat, cache, 10).conceptModalities.get('C')
      expect(listed[1].status).toBe(PRIMARY)
      // 100 − 90 = 10: c1 or C's total must be masked, whether the 1-way crossing is published or not.
      expect(listed[0].status !== PUBLISHED || C !== PUBLISHED).toBe(true)
      expect(listed.map((c) => c.status)).toEqual([SECONDARY, PRIMARY, SECONDARY, PRIMARY])
    }
  })

  it('is caught by the audit when the list is masked alone', async () => {
    const cat = categoryCatalog([['concept']])
    const published = buildPublishedCatalog(cat, cache)
    const statuses = [PUBLISHED, PRIMARY, PUBLISHED, PRIMARY]
    const concepts = cache.concepts.map((c, i) => ({
      key: String(c.conceptId), name: c.conceptName, group: c.category,
      patients: statuses[i] === PUBLISHED ? c.patientCount : null,
      records: statuses[i] === PUBLISHED ? c.recordCount : null,
    }))
    const { findings } = await auditPublished({ published, concepts, totals: { patients: 246, records: 600 }, threshold: 10, noise: 0 })
    expect(findings.find((f) => f.measure === 'records')).toMatchObject({ crossing: 'concept-list', kind: 'exact', examples: expect.arrayContaining([{ cell: ['C', 'C2'], lo: 10, hi: 10 }]) })
    const fixed = publishedConcepts(cat, cache).map((c) => c.status)
    const safe = await auditPublished({
      published, totals: { patients: 246, records: 600 }, threshold: 10, noise: 0,
      concepts: concepts.map((c, i) => (fixed[i] === PUBLISHED ? c : { ...c, patients: null, records: null })),
    })
    expect(safe.findings).toEqual([])
  })
})

describe('the published order of ranked modalities', () => {
  const cat = {
    variables: { ...defaultCatalogVariables(), concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } },
    crossings: [['concept']],
    anonymization: { threshold: 10, mode: 'replace' },
  } as unknown as Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>
  // Concepts 1 and 5 are masked; only their exact counts differ between the two.
  const results = (one: number, five: number) => {
    const counts: [number, number][] = [[3, 200], [2, 50], [1, one], [5, five]]
    const exactOrder = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => String(id))
    return {
      concepts: counts.map(([conceptId, n]) => ({ conceptId, conceptName: `C${conceptId}`, patientCount: n, recordCount: n * 2 })),
      crossings: [{ id: 'concept', variables: ['concept'], rows: counts.map(([id, n]) => ({ values: [String(id)], patients: n, records: n * 2 })) }],
      modalities: { concept: exactOrder },
    } as unknown as CatalogResultCache
  }

  it('places a masked modality by its published count, not its exact one', () => {
    const a = buildPublishedCatalog(cat, results(5, 7))
    const b = buildPublishedCatalog(cat, results(8, 7))
    expect(a.variables.concept!.mods).toEqual(['3', '2', '1', '5'])
    expect(b.variables.concept!.mods).toEqual(a.variables.concept!.mods)
    expect(b.crossings).toEqual(a.crossings)
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
  // A third cell, masked to protect the female one: 24 patients between them, nothing to tell.
  const withUnits = {
    ...cache,
    crossings: [{ id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 80, stays: 90, unitStays: 120 }, { values: ['female'], patients: 4, stays: 5, unitStays: 6 }, { values: ['other'], patients: 20, stays: 20, unitStays: 20 }] }],
  } as unknown as CatalogResultCache

  it('carries each counted measure after patients, masked alike', () => {
    const [sex] = buildPublishedCatalog(both, withUnits).crossings
    expect(sex.measures).toEqual(['stays', 'unit_stays'])
    expect(sex.cells).toEqual([[0, 80, 90, 120, 0]])
    expect(buildPublishedCatalog(both, withUnits, { keepMasked: true }).crossings[0].cells).toContainEqual([1, null, null, null, 1])
    expect(buildCrossingCsv(buildPublishedCatalog(both, withUnits), sex).split('\n')[0]).toBe('sex,patients,stays,unit_stays,status')
  })

  it('counts stays over events too, before records, unless computed without them', () => {
    const rows = [{ values: ['c1'], patients: 80, stays: 95, records: 400 }]
    const over = (r: object[]) => ({ ...cache, crossings: [{ id: 'concept', variables: ['concept'], rows: r }] }) as unknown as CatalogResultCache
    expect(computedMeasures(catalog, over(rows).crossings![0])).toEqual(['stays', 'records'])
    expect(computedMeasures(catalog, over([{ values: ['c1'], patients: 80, records: 400 }]).crossings![0])).toEqual(['records'])
  })

  it('carries patients alone when the catalog counts nothing else', () => {
    const [sex] = buildPublishedCatalog({ ...catalog, counts: { visits: false, unitStays: false } }, withUnits).crossings
    expect(sex.measures).toEqual([])
    expect(sex.cells).toContainEqual([0, 80, 0])
  })
})

describe('perturbed publication', () => {
  const noisy = { ...catalog, crossings: [['sex']], anonymization: { threshold: 10, mode: 'replace', noise: 3 } } as Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>
  const keyed = {
    ...cache,
    grandTotal: { totalPatients: 153, totalVisits: 168, totalRecords: 0, totalKey: 77 },
    totalPatients: 153, totalVisits: 168,
    crossings: [{ id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 80, stays: 90, key: 123_456 }, { values: ['female'], patients: 73, stays: 78, key: 987_654_321 }] }],
  } as unknown as CatalogResultCache

  it('moves each count by at most the noise, the same way every time', () => {
    const [sex] = buildPublishedCatalog(noisy, keyed).crossings
    const exact = [[80, 90], [73, 78]]
    sex.cells.forEach((cell, i) => {
      expect(Math.abs((cell[1] as number) - exact[i][0])).toBeLessThanOrEqual(3)
      expect(Math.abs((cell[2] as number) - exact[i][1])).toBeLessThanOrEqual(3)
    })
    expect(buildPublishedCatalog(noisy, keyed).crossings[0].cells).toEqual(sex.cells)
    expect(buildPublishedCatalog({ ...noisy, anonymization: { ...noisy.anonymization, noise: 0 } }, keyed).crossings[0].cells).toEqual([[0, 80, 90, 0], [1, 73, 78, 0]])
  })

  it('perturbs the totals, and keeps a published cell at or above the threshold', () => {
    const totals = publishedTotals(noisy, keyed)
    expect(Math.abs(totals.patients - 153)).toBeLessThanOrEqual(3)
    const low = { ...keyed, crossings: [{ id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 10, stays: 10, key: 5 }, { values: ['female'], patients: 143, stays: 158, key: 6 }] }] } as unknown as CatalogResultCache
    for (const cell of buildPublishedCatalog(noisy, low).crossings[0].cells) if (cell[3] === 0) expect(cell[1]).toBeGreaterThanOrEqual(10)
  })

  it('gives a concept the same noise in the list and in its 1-way crossing', () => {
    const conceptCatalog = {
      variables: { ...defaultCatalogVariables(), concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } },
      crossings: [['concept']],
      anonymization: { threshold: 10, mode: 'replace', noise: 3 },
    } as unknown as Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>
    const withConcepts = {
      concepts: [{ conceptId: 7, conceptName: 'C7', patientCount: 90, recordCount: 180, patientKey: 4242 }],
      crossings: [{ id: 'concept', variables: ['concept'], rows: [{ values: ['7'], patients: 90, records: 180, key: 4242 }] }],
      modalities: { concept: ['7'] },
    } as unknown as CatalogResultCache
    const [listed] = publishedConcepts(conceptCatalog, withConcepts)
    const [cell] = buildPublishedCatalog(conceptCatalog, withConcepts).crossings[0].cells
    expect([listed.patientCount, listed.recordCount]).toEqual([cell[1], cell[2]])
  })
})

describe('ageDisplayName', () => {
  it('reads brackets as inclusive age ranges', () => {
    expect(ageDisplayName('[18;65[')).toBe('18–64')
    expect(ageDisplayName('[90;+∞[')).toBe('90+')
    expect(ageDisplayName('[0;+∞[')).toBe('All ages')
  })
})
