import { describe, it, expect } from 'vitest'
import { databaseOptions } from './use-database-options'
import type { DataSource } from '@/types'

const ds = (over: Partial<DataSource>): DataSource =>
  ({
    id: 'x',
    alias: 'x',
    name: { en: 'X' },
    description: {},
    sourceType: 'database',
    connectionConfig: { engine: 'duckdb' },
    status: 'connected',
    workspaceId: 'ws-1',
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as DataSource

describe('useDatabaseOptions', () => {
  it('offers only the given workspace’s databases', () => {
    const out = databaseOptions(
      [ds({ id: 'mine', workspaceId: 'ws-1' }), ds({ id: 'theirs', workspaceId: 'ws-2' })],
      'ws-1',
    )
    expect(out.map((d) => d.id)).toEqual(['mine'])
  })

  it('offers nothing while the workspace is unknown', () => {
    // The id resolves a URL prefix through the workspace store, so it is briefly
    // undefined on a cold render. Falling back to the full list is exactly how
    // the leak looked, so absence must mean "nothing yet", never "everything".
    const rows = [ds({ id: 'a', workspaceId: 'ws-1' }), ds({ id: 'b', workspaceId: 'ws-2' })]
    expect(databaseOptions(rows, undefined)).toEqual([])
    expect(databaseOptions(rows, null)).toEqual([])
    expect(databaseOptions(rows, '')).toEqual([])
  })

  it('leaves out vocabulary references and non-database sources', () => {
    const out = databaseOptions(
      [
        ds({ id: 'db' }),
        ds({ id: 'vocab', isVocabularyReference: true }),
        ds({ id: 'fhir', sourceType: 'fhir' }),
      ],
      'ws-1',
    )
    expect(out.map((d) => d.id)).toEqual(['db'])
  })

  it('leaves out a database with no workspace at all', () => {
    // A row written before workspaces existed is migrated on load; until then it
    // belongs to no workspace, so no picker should offer it.
    expect(databaseOptions([ds({ id: 'orphan', workspaceId: undefined })], 'ws-1')).toEqual([])
  })

  describe('project scope', () => {
    const rows = [ds({ id: 'linked' }), ds({ id: 'unlinked' })]

    it('offers only the databases the project has linked', () => {
      const out = databaseOptions(rows, 'ws-1', ['linked'])
      expect(out.map((d) => d.id)).toEqual(['linked'])
    })

    it('offers the whole workspace when no project scope is given', () => {
      expect(databaseOptions(rows, 'ws-1', undefined).map((d) => d.id)).toEqual([
        'linked',
        'unlinked',
      ])
    })

    it('offers nothing for a project that has linked nothing', () => {
      // Distinct from `undefined`: an empty link list is an answer, not a
      // missing scope, so it must not fall back to the whole workspace.
      expect(databaseOptions(rows, 'ws-1', [])).toEqual([])
    })

    it('still applies the workspace scope to a linked database', () => {
      // A stale link may name a database that has since moved workspaces.
      const out = databaseOptions([ds({ id: 'moved', workspaceId: 'ws-2' })], 'ws-1', ['moved'])
      expect(out).toEqual([])
    })
  })
})
