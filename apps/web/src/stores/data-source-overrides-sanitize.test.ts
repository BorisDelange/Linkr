import { describe, it, expect, vi } from 'vitest'
import type { SchemaMapping } from '@/types/schema-mapping'

const evil = 'visits" ; ATTACH \'https://evil/x.db\' AS e; --'

const BASE: SchemaMapping = {
  formatVersion: 2, presetId: 't', presetLabel: { en: 't' },
  patient: { from: { table: 'persons', alias: 'p' }, fields: { patient_id: 'p.id' } },
  visit: { from: { table: 'stays', alias: 's' }, fields: { visit_id: 's.id', patient_id: 's.pid' } },
}

vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    dataSources: {
      getAll: async () => [{
        id: 'db-1', alias: 'db_1', workspaceId: 'ws-1',
        schemaMapping: BASE,
        schemaOverrides: {
          relations: {
            visit: { from: { table: evil, alias: 's' }, fields: { visit_id: 's.id' } },
            'events.labs': { label: 'labs', from: { table: 'labs', alias: `l"` }, fields: { patient_id: 'l.pid' } },
          },
          baseAtOverride: { visit: 'abcd1234', orphan: 'ffff0000' },
        },
      }],
      update: async () => {},
    },
  }),
}))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ activeWorkspaceId: 'ws-1' }) },
}))
vi.mock('@/stores/app-store', () => ({
  useAppStore: { getState: () => ({ getProjectLinkedDataSourceIds: () => [] }) },
}))

const { useDataSourceStore } = await import('./data-source-store')

// Overrides reach storage from the API, the MCP server, a git clone and the seed
// without passing an import sanitizer, and are merged into the mapping every
// query reads: the load is the gate they share with the base mapping.
describe('loadDataSources — overrides', () => {
  it('sanitizes the overrides before merging them into the effective mapping', async () => {
    await useDataSourceStore.getState().loadDataSources(true)
    const [ds] = useDataSourceStore.getState().dataSources
    expect(JSON.stringify(ds.schemaMapping)).not.toContain('ATTACH')
    expect(ds.schemaMapping!.visit!.from).toBeUndefined()
    expect(ds.schemaMapping!.events![0].from).toEqual({ table: 'labs' })
    expect(ds.schemaOverrides!.baseAtOverride).toEqual({ visit: 'abcd1234' })
    expect(ds.schemaBaseMapping).toEqual(BASE)
  })
})

describe('updateDataSource — overrides', () => {
  it('sanitizes overrides written by an update before they reach the effective mapping', async () => {
    await useDataSourceStore.getState().loadDataSources(true)
    await useDataSourceStore.getState().updateDataSource('db-1', {
      schemaOverrides: {
        relations: { patient: { from: { table: evil, alias: 'p' }, fields: { patient_id: 'p.id' } } },
      },
    })
    const [ds] = useDataSourceStore.getState().dataSources
    expect(JSON.stringify(ds.schemaMapping)).not.toContain('ATTACH')
    expect(JSON.stringify(ds.schemaOverrides)).not.toContain('ATTACH')
    expect(ds.schemaMapping!.patient!.from).toBeUndefined()
  })
})
