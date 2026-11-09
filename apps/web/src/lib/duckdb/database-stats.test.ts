import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'

let serverMode = false
vi.mock('@/lib/api-client', () => ({ isServerMode: () => serverMode }))
const query = vi.fn<(ds: string, sql: string) => Promise<Record<string, unknown>[]>>()
vi.mock('./engine', () => ({
  queryDataSource: (ds: string, sql: string) => query(ds, sql),
  discoverTables: async () => ['person', 'visit', 'note'],
}))
const followServerPlan = vi.fn()
vi.mock('@/lib/server-runs/query-plan', () => ({
  preparePlan: async (_ds: string, plan: unknown) => plan,
  followServerPlan: (...args: unknown[]) => followServerPlan(...args),
}))

const { computeDatabaseStats, streamTableCounts } = await import('./database-stats')

const mapping = mappingV1ToV2({
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'start', typeColumn: 'type' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {},
  genderValues: { male: 'M', female: 'F' },
} as unknown as SchemaMappingV1)

beforeEach(() => {
  serverMode = false
  query.mockReset()
  followServerPlan.mockReset()
})

describe('computeDatabaseStats', () => {
  it('shows a block that failed as empty, without losing the others', async () => {
    query.mockImplementation(async (_ds, sql) => {
      if (sql.includes('FILTER')) throw new Error('no gender column')
      if (sql.includes('COUNT(*) as cnt') && sql.includes('linkr_patient')) return [{ cnt: 42 }]
      return []
    })
    const stats = await computeDatabaseStats('ds', mapping)
    expect(stats.summary.patientCount).toBe(42)
    expect(stats.summary.tableCount).toBe(3)
    expect(stats.genderDistribution).toEqual({ male: 0, female: 0, other: 0 })
  })

  it('runs as one keep-going server run, and a cancel from the jobs panel reads as a stop', async () => {
    serverMode = true
    followServerPlan.mockImplementation(async (_kind, _scope, _plan, onRows) => {
      onRows(0, [{ cnt: 7 }])
      return { status: 'cancelled', error: null }
    })
    await expect(computeDatabaseStats('ds', mapping, { label: 'Stats' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(query).not.toHaveBeenCalled()
    const [kind, scope, plan] = followServerPlan.mock.calls[0]
    expect([kind, scope]).toEqual(['database_stats', 'ds:stats'])
    expect(plan.label).toBe('Stats')
    expect(plan.items[0]).toMatchObject({ key: 'patientCount', sql: expect.stringContaining('linkr_patient') })
    expect(plan.keepGoing).toBe(true)
  })

  it('joins, after a reload, the run going on — and says when there is none', async () => {
    serverMode = true
    followServerPlan.mockResolvedValue(null)
    await expect(computeDatabaseStats('ds', mapping, { resumeOnly: true })).rejects.toMatchObject({ name: 'AbortError' })
    expect(followServerPlan.mock.calls[0][4]).toMatchObject({ resumeOnly: true })
  })
})

describe('streamTableCounts', () => {
  it('keeps the tables counted before a stop', async () => {
    serverMode = true
    followServerPlan.mockImplementation(async (_kind, _scope, _plan, onRows) => {
      onRows(0, [{ cnt: 5 }])
      onRows(1, null, 'boom')
      return { status: 'cancelled', error: null }
    })
    const batches: { tableName: string; rowCount: number }[][] = []
    await expect(streamTableCounts('ds', mapping, (b) => batches.push(b))).rejects.toMatchObject({ name: 'AbortError' })
    // Mapped tables first; a failed count reads as 0.
    expect(batches.flat()).toEqual([{ tableName: 'person', rowCount: 5 }, { tableName: 'visit', rowCount: 0 }])
  })
})
