import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { describe, expect, it } from 'vitest'
import type { CatalogCrossingResult, CatalogResultCache, DataCatalog } from '@/types'
import { defaultCatalogVariables } from '@/lib/data-catalog/config'
import {
  baseUnits, compileCatalogPlan, emptyRunState, modalityPlanOf, orderModalities, planCrossings, planSlices, runUnit, SLICE_EVENT_ROWS, stateFromCache,
  type CatalogQuery,
} from './catalog-compute'
import { runCatalogComputation } from './catalog-run'
import { getCatalogRunSnapshot, pauseCatalogRun, startCatalogRun, watchCatalogRun } from './catalog-runner'

const mapping = mappingV1ToV2({
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'start', typeColumn: 'type' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: { M: { table: 'measurement', conceptIdColumn: 'cid', patientIdColumn: 'person_id', dateColumn: 'd' } },
  genderValues: { male: 'M', female: 'F' },
} as unknown as SchemaMappingV1)

function catalog(patch: Partial<DataCatalog> = {}): DataCatalog {
  return {
    id: 'c', dataSourceId: 'd', variables: defaultCatalogVariables(), crossings: [],
    anonymization: { threshold: 10, mode: 'replace' }, ...patch,
  } as DataCatalog
}

const conceptVariable = { enabled: true, level: 'concept' as const, scope: 'all' as const, topN: 10 }
const noQuery: CatalogQuery = async () => []

describe('planSlices', () => {
  it('counts a small warehouse in one go', async () => {
    expect(await planSlices(mapping, async () => [{ event_rows: 1000 }])).toEqual([{}])
  })

  it('cuts a large one into patient ranges with open ends', async () => {
    const query: CatalogQuery = async (sql) => (sql.includes('ROW_NUMBER()') ? [{ b: 100n }, { b: 200 }] : [{ event_rows: SLICE_EVENT_ROWS * 2.5 }])
    expect(await planSlices(mapping, query)).toEqual([{ hi: 100 }, { lo: 100, hi: 200 }, { lo: 200 }])
  })
})

describe('baseUnits', () => {
  it('runs the concept list, the totals then the rankings, each over every slice', () => {
    const variables = { ...defaultCatalogVariables(), concept: conceptVariable }
    const units = baseUnits(compileCatalogPlan(catalog({ variables, crossings: [['concept', 'sex']] }), mapping), [{ hi: 5 }, { lo: 5 }])
    expect(units.map((u) => `${u.info.step}${u.info.ranked ? `:${u.info.ranked}` : ''} ${u.info.slice?.join('/')}`)).toEqual([
      'concepts 1/2', 'concepts 2/2', 'totals 1/2', 'totals 2/2', 'ranking:concept 1/2', 'ranking:concept 2/2',
    ])
  })

  it('adds up the counts of disjoint patient slices', async () => {
    const perSlice: CatalogQuery = async (sql) => {
      if (sql.includes('total_patients')) return [{ total_patients: sql.includes('>= 5') ? 3 : 4, total_visits: 10, total_records: 100 }]
      return [{ concept_id: 1, concept_name: 'Heart rate', dictionary_key: 'concept', patient_count: 2, record_count: 7, visit_count: 3 }]
    }
    const state = emptyRunState()
    for (const u of baseUnits(compileCatalogPlan(catalog(), mapping), [{ hi: 5 }, { lo: 5 }])) await runUnit(u, state, perSlice)
    expect(state.totals).toEqual({ totalPatients: 7, totalVisits: 20, totalRecords: 200 })
    expect([...state.concepts.values()]).toMatchObject([{ conceptId: 1, patientCount: 4, recordCount: 14, visitCount: 6 }])
  })
})

describe('planCrossings', () => {
  it('plans the 1-way marginals first, then the chosen crossings', () => {
    const plan = planCrossings(compileCatalogPlan(catalog({ crossings: [['age', 'period']] }), mapping), emptyRunState())
    expect(plan.units.map((u) => u.info.crossing?.join('-'))).toEqual(['period', 'age', 'sex', 'period-age'])
  })

  it('splits a concept crossing into chunks and slices, the concept marginal from the ranking', async () => {
    const state = emptyRunState()
    state.slices = [{ hi: 5 }, { lo: 5 }]
    for (let i = 0; i < 4500; i++) state.conceptRank.set(String(i), { patients: 4500 - i, records: 1 })
    const variables = { ...defaultCatalogVariables(), concept: conceptVariable }
    const plan = planCrossings(compileCatalogPlan(catalog({ variables, crossings: [['concept', 'sex']] }), mapping), state)
    const units = plan.units.filter((u) => u.info.crossing?.join('-') === 'concept-sex')
    expect(units.map((u) => `${u.info.chunk?.join('/')} ${u.info.slice?.join('/')}`)).toEqual([
      '1/3 1/2', '1/3 2/2', '2/3 1/2', '2/3 2/2', '3/3 1/2', '3/3 2/2',
    ])
    await runUnit(plan.units.find((u) => u.info.crossing?.join('-') === 'concept')!, state, noQuery)
    expect(state.crossings.get('concept')!.cells.size).toBe(4500)
  })

  it('keeps the N largest services of a top-N grouping, ties by code units', () => {
    const state = emptyRunState()
    state.serviceRank = new Map([['C', 1], ['A', 9], ['Éveil', 5], ['Zed', 5]])
    const variables = { ...defaultCatalogVariables(), service: { enabled: true, level: 'visit' as const, grouping: 'top' as const, topN: 2, groups: {}, unassigned: 'other' as const } }
    const plan = planCrossings(compileCatalogPlan(catalog({ variables, crossings: [['service']] }), mapping), state)
    expect(plan.fill.topServices).toEqual(['A', 'Zed'])
    expect(plan.units.find((u) => u.info.crossing?.join('-') === 'service')?.sql).toContain("IN ('A', 'Zed')")
  })
})

/** A warehouse of two slices: each query answers for the slice its SQL names. */
const warehouse: CatalogQuery = async (sql, signal) => {
  await new Promise((r) => setTimeout(r, 1))
  signal?.throwIfAborted()
  const second = sql.includes('>= 5')
  if (sql.includes('event_rows')) return [{ event_rows: SLICE_EVENT_ROWS * 1.5 }]
  if (sql.includes('ROW_NUMBER()')) return [{ b: 5 }]
  if (sql.includes('total_patients')) return [{ total_patients: second ? 3 : 4, total_visits: 10, total_records: 100 }]
  if (sql.includes('per_concept')) return [{ concept_id: 1, concept_name: 'HR', dictionary_key: 'concept', patient_count: 2, record_count: 7, visit_count: 3 }]
  if (sql.includes('AS v_age')) return [{ v_period: '2024', v_age: '[0;10[', patients: second ? 1 : 2, stays: 3 }]
  if (sql.includes('AS v_period')) return [{ v_period: '2024', patients: second ? 5 : 6, stays: 8 }]
  if (sql.includes('AS v_sex')) return [{ v_sex: 'male', patients: 1, stays: 1 }]
  return []
}

describe('stateFromCache', () => {
  const stored = (work: unknown, patch: Partial<CatalogResultCache> = {}) =>
    ({ concepts: [], grandTotal: {}, completedSteps: 2, work, ...patch }) as unknown as CatalogResultCache
  const good = { slices: [{ hi: 5 }, { lo: 5, hi: 'x' }, { lo: 'x' }], services: [['ICU', 3]], concepts: [['c:1', 2, 4]] }

  it('takes back a state as a run saved it', () => {
    const state = stateFromCache(stored(good))
    expect(state.slices).toEqual(good.slices)
    expect(state.serviceRank.get('ICU')).toBe(3)
    expect(state.conceptRank.get('c:1')).toEqual({ patients: 2, records: 4 })
  })

  it('takes back only the scalars a run saves', () => {
    for (const work of [
      { ...good, slices: 'x' },
      { ...good, slices: [{ lo: ['1'] }] },
      { ...good, slices: [{ hi: { a: 1 } }] },
      { ...good, slices: [null] },
      { ...good, services: [[['ICU'], 3]] },
      { ...good, services: [['ICU', '3']] },
      { ...good, concepts: [[{}, 1, 1]] },
    ]) expect(() => stateFromCache(stored(work))).toThrow()
    expect(() => stateFromCache(stored(good, { completedSteps: -1 }))).toThrow()
  })

  it('stops a resume on such a state before any query', async () => {
    const queries: string[] = []
    const failed = runCatalogComputation({
      catalog: catalog({ crossings: [['period']] }), mapping,
      query: async (sql: string) => { queries.push(sql); return [] },
      resumeFrom: stored({ ...good, slices: [{ lo: ['1'] }] }),
      persist: async () => {},
    } as unknown as Parameters<typeof runCatalogComputation>[0], new AbortController().signal)
    await expect(failed).rejects.toThrow()
    expect(queries).toEqual([])
  })
})

describe('catalog run', () => {
  function run(resumeFrom: CatalogResultCache | null, pauseAfter?: number): Promise<CatalogResultCache> {
    return new Promise((resolve) => {
      let latest: CatalogResultCache | null = null
      const id = `run-${Math.random()}`
      let seen = 0
      const stop = watchCatalogRun(id, (s) => {
        if (pauseAfter != null && s.computed != null && s.computed >= pauseAfter && seen++ === 0) pauseCatalogRun(id)
        if (!s.running && latest) { stop(); resolve(latest) }
      })
      startCatalogRun({
        catalog: catalog({ id, crossings: [['period', 'age']] }),
        mapping,
        ensureMounted: async () => {},
        query: warehouse,
        resumeFrom: resumeFrom ? { cache: { ...resumeFrom, catalogId: id } } : null,
        persist: async (cache) => { latest = cache },
        persistError: async () => {},
      })
      void getCatalogRunSnapshot(id)
    })
  }

  it('gives the same result paused and resumed as in one go', async () => {
    const whole = await run(null)
    expect(whole.totalPatients).toBe(7)
    expect(whole.crossings.find((c) => c.id === 'period')!.rows[0].patients).toBe(11)
    expect(whole.work).toBeUndefined()

    const paused = await run(null, 3)
    expect(paused.work).toBeDefined()
    expect(paused.completedSteps).toBeGreaterThanOrEqual(3)
    const resumed = await run(paused)
    expect(resumed.crossings).toEqual(whole.crossings)
    expect(resumed.grandTotal).toEqual(whole.grandTotal)
    expect(resumed.concepts).toEqual(whole.concepts)
  })
})

describe('orderModalities', () => {
  it('orders periods with their gaps, services by patients with Other last', () => {
    const variables = { ...defaultCatalogVariables(), service: { enabled: true, level: 'visit' as const, grouping: 'top' as const, topN: 1, groups: {}, unassigned: 'other' as const } }
    const crossings: CatalogCrossingResult[] = [
      { id: 'period', variables: ['period'], rows: [{ values: ['2024'], patients: 5 }, { values: ['2021'], patients: 5 }] },
      { id: 'service', variables: ['service'], rows: [{ values: ['__other__'], patients: 99 }, { values: ['ICU'], patients: 20 }] },
      { id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 5 }] },
    ]
    const out = orderModalities(modalityPlanOf(variables), crossings)
    expect(out.period).toEqual(['2021', '2022', '2023', '2024'])
    expect(out.service).toEqual(['ICU', '__other__'])
    expect(out.sex).toEqual(['male', 'female'])
    expect(out.age?.[0]).toBe('[0;10[')
  })
})
