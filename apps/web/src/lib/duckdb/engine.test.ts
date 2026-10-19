import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchDataSourceSchema = vi.fn<(id: string) => Promise<{ name: string }[]>>()
const queryDataSourceOnServer = vi.fn<(id: string, sql: string) => Promise<Record<string, unknown>[]>>()
vi.mock('@/lib/api-client', () => ({ isServerMode: () => true }))
vi.mock('@/lib/api/data-sources', () => ({
  fetchDataSourceSchema: (id: string) => fetchDataSourceSchema(id),
  queryDataSourceOnServer: (id: string, sql: string) => queryDataSourceOnServer(id, sql),
  planQueryOnServer: vi.fn(),
}))
// The relations pruned against the table list: the SQL names the tables it was given.
vi.mock('@/lib/schema-classes/inject', () => ({
  injectClassRelations: (sql: string, _mapping: unknown, tables: string[] | null) => `${sql} /* ${tables?.join(',')} */`,
}))

const { queryDataSource, setMappingResolver, forgetSourceTables } = await import('./engine')

const SQL = 'SELECT * FROM linkr_visit'
const MISSING = new Error('Catalog Error: Table with name visit_detail does not exist!')

beforeEach(() => {
  forgetSourceTables('ds')
  fetchDataSourceSchema.mockReset()
  queryDataSourceOnServer.mockReset()
  setMappingResolver(() => ({}) as never)
})

describe('queryDataSource, stale table list', () => {
  it('retries once against a fresh table list when a table it named is gone', async () => {
    fetchDataSourceSchema
      .mockResolvedValueOnce([{ name: 'visit_occurrence' }, { name: 'visit_detail' }])
      .mockResolvedValueOnce([{ name: 'visit_occurrence' }])
    queryDataSourceOnServer.mockRejectedValueOnce(MISSING).mockResolvedValueOnce([{ n: 1 }])

    expect(await queryDataSource('ds', SQL)).toEqual([{ n: 1 }])
    expect(fetchDataSourceSchema).toHaveBeenCalledTimes(2)
    expect(queryDataSourceOnServer.mock.calls.map((c) => c[1])).toEqual([
      `${SQL} /* visit_occurrence,visit_detail */`,
      `${SQL} /* visit_occurrence */`,
    ])
  })

  it('does not retry when the fresh list writes the same query', async () => {
    fetchDataSourceSchema.mockResolvedValue([{ name: 'visit_occurrence' }])
    queryDataSourceOnServer.mockRejectedValue(MISSING)

    await expect(queryDataSource('ds', SQL)).rejects.toBe(MISSING)
    expect(queryDataSourceOnServer).toHaveBeenCalledOnce()
  })

  it('does not retry on any other error, nor drop the cached list', async () => {
    const other = new Error('Binder Error: column x not found')
    fetchDataSourceSchema.mockResolvedValue([{ name: 'visit_occurrence' }])
    queryDataSourceOnServer.mockRejectedValue(other)

    await expect(queryDataSource('ds', SQL)).rejects.toBe(other)
    expect(queryDataSourceOnServer).toHaveBeenCalledOnce()
    await expect(queryDataSource('ds', SQL)).rejects.toBe(other)
    expect(fetchDataSourceSchema).toHaveBeenCalledOnce()
  })
})
