import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { describe, expect, it } from 'vitest'
import type { CatalogCrossingResult, CatalogResultCache, DataCatalog } from '@/types'
import { defaultCatalogVariables } from '@/lib/data-catalog/config'
import { baseUnits, emptyRunState, orderModalities, planCrossings, planSlices, runUnit, SLICE_EVENT_ROWS, type CatalogQuery } from './catalog-compute'
import { CatalogPhaseCancelled, runCatalogComputation, type CatalogPhaseExecutor } from './catalog-run'
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
    const units = baseUnits(catalog({ variables, crossings: [['concept', 'sex']] }), mapping, [{ hi: 5 }, { lo: 5 }])
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
    for (const u of baseUnits(catalog(), mapping, [{ hi: 5 }, { lo: 5 }])) await runUnit(u, state, perSlice)
    expect(state.totals).toEqual({ totalPatients: 7, totalVisits: 20, totalRecords: 200 })
    expect([...state.concepts.values()]).toMatchObject([{ conceptId: 1, patientCount: 4, recordCount: 14, visitCount: 6 }])
  })
})

describe('planCrossings', () => {
  it('plans the 1-way marginals first, then the chosen crossings', () => {
    const plan = planCrossings(catalog({ crossings: [['age', 'period']] }), mapping, emptyRunState())
    expect(plan.units.map((u) => u.info.crossing?.join('-'))).toEqual(['period', 'age', 'sex', 'period-age'])
  })

  it('splits a concept crossing into chunks and slices, the concept marginal from the ranking', async () => {
    const state = emptyRunState()
    state.slices = [{ hi: 5 }, { lo: 5 }]
    for (let i = 0; i < 4500; i++) state.conceptRank.set(String(i), { patients: 4500 - i, records: 1 })
    const variables = { ...defaultCatalogVariables(), concept: conceptVariable }
    const plan = planCrossings(catalog({ variables, crossings: [['concept', 'sex']] }), mapping, state)
    const units = plan.units.filter((u) => u.info.crossing?.join('-') === 'concept-sex')
    expect(units.map((u) => `${u.info.chunk?.join('/')} ${u.info.slice?.join('/')}`)).toEqual([
      '1/3 1/2', '1/3 2/2', '2/3 1/2', '2/3 2/2', '3/3 1/2', '3/3 2/2',
    ])
    await runUnit(plan.units.find((u) => u.info.crossing?.join('-') === 'concept')!, state, noQuery)
    expect(state.crossings.get('concept')!.cells.size).toBe(4500)
  })

  it('keeps the N largest services of a top-N grouping', () => {
    const state = emptyRunState()
    state.serviceRank = new Map([['C', 1], ['A', 9], ['B', 5]])
    const variables = { ...defaultCatalogVariables(), service: { enabled: true, level: 'visit' as const, grouping: 'top' as const, topN: 2, groups: {}, unassigned: 'other' as const } }
    expect(planCrossings(catalog({ variables }), mapping, state).ctx.topServices).toEqual(['A', 'B'])
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

describe('catalog run on a phase executor', () => {
  const input = (resumeFrom: CatalogResultCache | null, executor: CatalogPhaseExecutor, saved: CatalogResultCache[]) => ({
    catalog: catalog({ crossings: [['period', 'age']] }),
    mapping,
    query: warehouse,
    resumeFrom,
    persist: async (cache: CatalogResultCache) => { saved.push(cache) },
    executor,
  })

  /** A server stand-in: each phase is one job computed at once, its results read back in order. */
  function jobServer() {
    const jobs = new Map<string, Record<string, unknown>[][]>()
    const resumed: (string | null)[] = []
    let deliveries = 0
    let sizings = 0
    let interrupt: ((n: number) => 'abort' | 'cancel' | null) = () => null
    const executor: CatalogPhaseExecutor = async ({ name, queries, resumeJob, jobStarted, starting, onRows, signal }) => {
      // The sizing's queries are jobs too, but nothing a resume follows.
      if (name === 'sizing') {
        sizings++
        for (const q of queries) await onRows(q.offset, await warehouse(q.sql))
        return
      }
      resumed.push(resumeJob)
      let id = resumeJob && jobs.has(resumeJob) ? resumeJob : null
      if (!id) {
        id = `job-${jobs.size + 1}`
        jobs.set(id, [])
        const results = jobs.get(id)!
        for (const q of queries) results[q.offset] = await warehouse(q.sql)
        await jobStarted(id)
      }
      const results = jobs.get(id)!
      for (const q of queries) {
        starting(q.offset)
        const stop = interrupt(++deliveries)
        if (stop === 'cancel') throw new CatalogPhaseCancelled()
        await onRows(q.offset, results[q.offset])
        if (stop === 'abort') controller.abort()
        signal.throwIfAborted()
      }
    }
    let controller = new AbortController()
    return {
      executor, resumed,
      sizings: () => sizings,
      signal: () => (controller = new AbortController()).signal,
      stopAt: (n: number, how: 'abort' | 'cancel') => { deliveries = 0; interrupt = (k) => (k === n ? how : null) },
      go: () => { interrupt = () => null },
    }
  }

  const whole = async () => {
    const saved: CatalogResultCache[] = []
    await runCatalogComputation(input(null, async (p) => {
      for (const q of p.queries) await p.onRows(q.offset, await warehouse(q.sql))
    }, saved), new AbortController().signal)
    return saved.at(-1)!
  }

  it('gives what the one-by-one run gives', async () => {
    const server = jobServer()
    const saved: CatalogResultCache[] = []
    expect(await runCatalogComputation(input(null, server.executor, saved), server.signal())).toBe('done')
    const reference = await whole()
    expect(saved.at(-1)!.crossings).toEqual(reference.crossings)
    expect(saved.at(-1)!.grandTotal).toEqual(reference.grandTotal)
    expect(server.resumed).toEqual([null, null])
    expect(server.sizings()).toBeGreaterThan(0)
  })

  it('saves the job a phase runs in, and a resume follows it rather than starting over', async () => {
    const server = jobServer()
    const saved: CatalogResultCache[] = []
    server.stopAt(2, 'abort')
    expect(await runCatalogComputation(input(null, server.executor, saved), server.signal())).toBe('paused')
    const paused = saved.at(-1)!
    expect(paused.work?.job).toEqual({ id: 'job-1', phase: 'base' })

    server.go()
    const after: CatalogResultCache[] = []
    expect(await runCatalogComputation(input(paused, server.executor, after), server.signal())).toBe('done')
    expect(server.resumed).toEqual([null, 'job-1', null])
    const reference = await whole()
    expect(after.at(-1)!.crossings).toEqual(reference.crossings)
    expect(after.at(-1)!.concepts).toEqual(reference.concepts)
  })

  it('saves the job as soon as it starts, before any result comes back', async () => {
    const server = jobServer()
    const saved: CatalogResultCache[] = []
    server.stopAt(1, 'cancel')
    await runCatalogComputation(input(null, server.executor, saved), server.signal())
    expect(saved[0].work?.job).toEqual({ id: 'job-1', phase: 'base' })
    expect(saved[0].completedSteps).toBe(0)
  })

  it('takes a job cancelled from the jobs panel as a pause, keeping what it counted', async () => {
    const server = jobServer()
    const saved: CatalogResultCache[] = []
    server.stopAt(3, 'cancel')
    expect(await runCatalogComputation(input(null, server.executor, saved), server.signal())).toBe('paused')
    expect(saved.at(-1)!.completedSteps).toBe(2)
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
    const out = orderModalities({ variables }, crossings)
    expect(out.period).toEqual(['2021', '2022', '2023', '2024'])
    expect(out.service).toEqual(['ICU', '__other__'])
    expect(out.sex).toEqual(['male', 'female'])
    expect(out.age?.[0]).toBe('[0;10[')
  })
})
