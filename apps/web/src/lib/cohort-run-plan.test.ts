import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/projects/warehouse/cohorts/relation-narrowing', () => ({ cohortRelationNarrowing: async () => undefined }))
vi.mock('@/features/projects/warehouse/patient-data/timeline-relations', () => ({ relationsCountedAt: async () => null }))

import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import type { PlanResults } from '@/lib/server-runs/query-plan'
import type { Cohort, CohortLevel } from '@/types'
import { compileCohortRun, MAX_RESULT_ROWS, OUTPUT_KEY, outputOf } from './cohort-run-plan'

// A cohort's run as a plan of independent queries — what a `cohort_run` runs
// on the server — and the result the page assembles from what they returned.

const mapping = mappingV1ToV2({
  presetId: 'test',
  presetLabel: { en: 'Test' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'start', endDateColumn: 'end' },
})

function cohortOf(level: CohortLevel, extra: Partial<Cohort> = {}): Cohort {
  return {
    id: 'c1', projectUid: 'p1', name: { en: 'Women' }, description: {}, level,
    criteriaTree: {
      kind: 'group', id: 'root', operator: 'AND', exclude: false, enabled: true,
      children: [{ kind: 'criterion', id: 's1', type: 'sex', config: { values: ['F'] }, operator: 'AND', exclude: false, enabled: true }],
    },
    schemaVersion: 4, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...extra,
  } as unknown as Cohort
}

const compile = async (cohort: Cohort) => (await compileCohortRun(cohort, 'ds1', mapping, false))!

describe('a cohort run, compiled', () => {
  it('lists the members query and every attrition step but the last, the cohort itself', async () => {
    const { plan } = await compile(cohortOf('patient'))
    expect(plan.items.map((i) => i.key)).toEqual(['results', 'step_0'])
    expect(plan.keepGoing).toBe(true)
    expect(plan.meta).toMatchObject({ draft: false, dataSourceId: 'ds1' })
  })

  it('signs what it computes: the same definition the same, another one differently', async () => {
    const sign = async (cohort: Cohort) => (await compile(cohort)).plan.meta?.signature
    expect(await sign(cohortOf('patient'))).toBe(await sign(cohortOf('patient')))
    expect(await sign(cohortOf('patient'))).not.toBe(await sign(cohortOf('visit')))
  })

  it('assembles the members, the count and the attrition from the results', async () => {
    const { assemble } = await compile(cohortOf('patient'))
    const results: PlanResults = new Map([
      ['results', [{ patient_id: 1, cohort_total: 2 }, { patient_id: 2, cohort_total: 2 }]],
      ['step_0', [{ cnt: 5 }]],
    ])
    const got = assemble(results)
    expect(got.totalCount).toBe(2)
    expect(got.rows).toEqual([{ patient_id: 1 }, { patient_id: 2 }])
    expect(got.attrition.map((s) => [s.nodeId, s.count, s.excluded])).toEqual([['__total__', 5, 0], ['s1', 2, 3]])
    // The rows handed in are left as they were.
    expect(results.get('results')).toEqual([{ patient_id: 1, cohort_total: 2 }, { patient_id: 2, cohort_total: 2 }])
  })

  it('fails when a step failed, rather than count it as nobody', async () => {
    const { assemble } = await compile(cohortOf('patient'))
    expect(() => assemble(new Map<string, Record<string, unknown>[] | Error>([['results', []], ['step_0', new Error('cut')]]))).toThrow('cut')
  })

  it('shows the members ids as its own output when no SQL is written', async () => {
    const { assemble, ownOutput } = await compile(cohortOf('patient'))
    const result = assemble(new Map([['results', [{ patient_id: 7, cohort_total: 3 }]], ['step_0', [{ cnt: 3 }]]]))
    expect(ownOutput(result)).toEqual({ rows: [{ patient_id: 7 }], truncated: true })
  })
})

describe('a hand-written cohort run', () => {
  const custom = () => cohortOf('patient', { customSql: 'SELECT person_id AS patient_id FROM person' })

  it('runs its SQL as written first, and has no output of its own', async () => {
    const { plan, ownOutput, assemble } = await compile(custom())
    expect(plan.items[0].key).toBe(OUTPUT_KEY)
    expect(ownOutput(assemble(new Map(plan.items.map((i) => [i.key, []]))))).toBeNull()
  })

  it('reads that output, or its error', () => {
    const full = Array.from({ length: MAX_RESULT_ROWS }, (_, i) => ({ i }))
    expect(outputOf(new Map([[OUTPUT_KEY, full]]), Date.now())).toMatchObject({ truncated: true })
    expect(outputOf(new Map([[OUTPUT_KEY, [{ i: 1 }]]]), Date.now())).toMatchObject({ rows: [{ i: 1 }], truncated: false })
    expect(outputOf(new Map([[OUTPUT_KEY, new Error('syntax')]]), Date.now())).toMatchObject({ rows: [], error: 'syntax' })
  })
})
