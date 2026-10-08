import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IntrospectedTable } from '@/lib/duckdb/engine'

const discoverFullSchema = vi.fn<(id: string) => Promise<IntrospectedTable[]>>()
vi.mock('@/lib/duckdb/engine', () => ({ discoverFullSchema: (id: string) => discoverFullSchema(id) }))

const { toSqlCatalog, loadSourceTables } = await import('./sql-catalog')

describe('toSqlCatalog', () => {
  it('groups bare names under main and qualified names under their schema', () => {
    const catalog = toSqlCatalog([
      { name: 'person', columns: [{ name: 'person_id', type: 'BIGINT', nullable: false }] },
      { name: 'hosp.patients', columns: [{ name: 'subject_id', type: 'INTEGER', nullable: true }] },
    ])
    expect(catalog.schemas.map((s) => [s.name, s.tables.map((t) => t.name)])).toEqual([
      ['main', ['person']],
      ['hosp', ['patients']],
    ])
    expect(catalog.schemas[1].tables[0].columns).toEqual([{ name: 'subject_id', type: 'INTEGER' }])
    // Every schema is on the search path, so all of them are reachable unqualified.
    expect(catalog.defaultSchemas).toEqual(['main', 'hosp'])
  })
})

describe('loadSourceTables', () => {
  const v1: IntrospectedTable[] = [{ name: 'person', columns: [] }]
  const v2: IntrospectedTable[] = [{ name: 'visit', columns: [] }]
  const flush = () => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    discoverFullSchema.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('keeps serving the last good schema while a refresh is pending', async () => {
    discoverFullSchema.mockResolvedValueOnce(v1)
    expect(await loadSourceTables('pending')).toBe(v1)

    let resolve!: (t: IntrospectedTable[]) => void
    discoverFullSchema.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    vi.advanceTimersByTime(61_000)
    expect(await loadSourceTables('pending')).toBe(v1)
    expect(await loadSourceTables('pending')).toBe(v1)
    expect(discoverFullSchema).toHaveBeenCalledTimes(2)

    resolve(v2)
    await flush()
    expect(await loadSourceTables('pending')).toBe(v2)
  })

  it('keeps the last good schema when the refresh fails', async () => {
    discoverFullSchema.mockResolvedValueOnce(v1)
    expect(await loadSourceTables('failing')).toBe(v1)

    discoverFullSchema.mockRejectedValueOnce(new Error('down'))
    vi.advanceTimersByTime(61_000)
    expect(await loadSourceTables('failing')).toBe(v1)
    await flush()
    expect(await loadSourceTables('failing')).toBe(v1)
    expect(discoverFullSchema).toHaveBeenCalledTimes(2)
  })
})
