import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'

let serverMode = false
vi.mock('@/lib/api-client', () => ({ isServerMode: () => serverMode }))
const query = vi.fn<(ds: string, sql: string) => Promise<Record<string, unknown>[]>>()
vi.mock('./engine', () => ({
  queryDataSource: (ds: string, sql: string) => query(ds, sql),
  discoverTables: async () => ['person', 'visit', 'note'],
}))
const runQueryJob = vi.fn()
vi.mock('./run-query-job', () => ({ runQueryJob: (...args: unknown[]) => runQueryJob(...args) }))

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
  runQueryJob.mockReset()
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

  it('runs as one keep-going server job, and a cancel from the jobs panel reads as a stop', async () => {
    serverMode = true
    runQueryJob.mockImplementation(async (_ds, _label, queries: { key: string }[], onResult) => {
      await onResult(0, [{ cnt: 7 }], { ms: 1, error: null })
      return { status: 'cancelled', delivered: 1, error: null, total: queries.length }
    })
    await expect(computeDatabaseStats('ds', mapping, { label: 'Stats' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(query).not.toHaveBeenCalled()
    const [, label, queries, , opts] = runQueryJob.mock.calls[0]
    expect(label).toBe('Stats')
    expect(queries[0]).toEqual({ key: 'patientCount', sql: expect.stringContaining('linkr_patient') })
    expect(opts.keepGoing).toBe(true)
  })
})

describe('streamTableCounts', () => {
  it('keeps the tables counted before a stop', async () => {
    serverMode = true
    runQueryJob.mockImplementation(async (_ds, _label, _queries, onResult) => {
      await onResult(0, [{ cnt: 5 }], { ms: 1, error: null })
      await onResult(1, [], { ms: 1, error: 'boom' })
      return { status: 'cancelled', delivered: 2, error: null }
    })
    const batches: { tableName: string; rowCount: number }[][] = []
    await expect(streamTableCounts('ds', mapping, (b) => batches.push(b))).rejects.toMatchObject({ name: 'AbortError' })
    // Mapped tables first; a failed count reads as 0.
    expect(batches.flat()).toEqual([{ tableName: 'person', rowCount: 5 }, { tableName: 'visit', rowCount: 0 }])
  })
})
