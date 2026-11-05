import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'

const queryDataSource = vi.fn()
vi.mock('@/lib/duckdb/engine', () => ({ queryDataSource: (...args: unknown[]) => queryDataSource(...args) }))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/concept-cache', () => ({ queryConceptCache: vi.fn() }))

const { fetchConceptInfos } = await import('./concept-info')

const mapping = mappingV1ToV2({ presetId: 't', presetLabel: { en: 't' }, conceptTables: [
  { key: 'a', table: 'dict_a', idColumn: 'id', nameColumn: 'name' },
] })

describe('fetchConceptInfos', () => {
  beforeEach(() => queryDataSource.mockReset())

  it('reads the concepts not read yet in one query, and the next time none', async () => {
    queryDataSource.mockResolvedValue([{ concept_id: 1, concept_name: 'a' }, { concept_id: 2, concept_name: 'b' }])
    const first = await fetchConceptInfos('db1', mapping, [1, 2, 3, 2])
    expect(queryDataSource).toHaveBeenCalledTimes(1)
    expect(String(queryDataSource.mock.calls[0][1])).toContain('IN (1, 2, 3)')
    expect(first.get(1)).toMatchObject({ concept_name: 'a' })
    expect(first.get(3)).toBeNull()

    const again = await fetchConceptInfos('db1', mapping, [2, 3])
    expect(queryDataSource).toHaveBeenCalledTimes(1)
    expect(again.get(2)).toMatchObject({ concept_name: 'b' })
  })

  it('reads them again after a failure', async () => {
    queryDataSource.mockRejectedValueOnce(new Error('down')).mockResolvedValue([{ concept_id: 7, concept_name: 'x' }])
    expect((await fetchConceptInfos('db2', mapping, [7])).get(7)).toBeNull()
    expect((await fetchConceptInfos('db2', mapping, [7])).get(7)).toMatchObject({ concept_name: 'x' })
  })
})
