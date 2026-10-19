import { describe, it, expect, vi } from 'vitest'

const calls = vi.hoisted(() => ({ ddl: [] as string[], files: 0, cleared: [] as (string | undefined)[] }))

vi.mock('@/lib/duckdb/engine', () => ({
  mountDataSource: async () => { calls.files++ },
  mountDataSourceFromHandles: async () => {},
  mountEmptyFromDDL: async (id: string) => { calls.ddl.push(id) },
  requestHandlePermissions: async () => true,
  computeStats: async () => ({}),
  generateAlias: (s: string) => s,
  ensureUniqueAlias: (s: string) => s,
  setMountGuard: () => {},
  setMappingResolver: () => {},
  unmountDataSource: async () => {},
  forgetSourceTables: () => {},
  isAttached: () => false,
}))
vi.mock('@/features/projects/warehouse/patient-data/patient-prefetch', () => ({
  clearPatientQueries: (id?: string) => { calls.cleared.push(id) },
}))

const stored = vi.hoisted(() => ({ row: undefined as unknown }))
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    dataSources: { getAll: async () => [], getById: async () => stored.row, update: async () => {} },
    files: { getByDataSource: async () => [] },
    fileHandles: { getByDataSource: async () => [] },
  }),
}))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/data-sources', () => ({
  createFromDdlOnServer: async () => {},
  fetchDataSourceSchema: async () => [],
}))
vi.mock('@/lib/entity-io', () => ({ DB_ERROR_NO_DATA_ON_IMPORT: 'no-data' }))
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ activeWorkspaceId: 'ws-1' }) },
}))
vi.mock('@/stores/app-store', () => ({
  useAppStore: { getState: () => ({ getProjectLinkedDataSourceIds: () => ['omop'] }) },
}))

const TARGET = {
  id: 'omop',
  name: 'OMOP target',
  alias: 'omop',
  workspaceId: 'ws-1',
  sourceType: 'database',
  status: 'connected',
  connectionConfig: { engine: 'duckdb', inMemory: true },
  schemaMapping: { ddl: 'CREATE TABLE person (person_id INT);' },
}

async function freshStore(source: object) {
  vi.resetModules()
  calls.ddl = []
  calls.files = 0
  calls.cleared = []
  const { useDataSourceStore } = await import('./data-source-store')
  useDataSourceStore.setState({ dataSources: [source as never], dataSourcesLoaded: true })
  return useDataSourceStore
}

describe('mounting a project’s sources', () => {
  // A linked ETL target ships no rows: it used to be marked "no files stored".
  it('creates an in-memory database empty from its DDL', async () => {
    stored.row = TARGET
    const store = await freshStore(TARGET)
    await store.getState().mountProjectSources('proj-1')
    expect(calls.ddl).toEqual(['omop'])
    expect(calls.files).toBe(0)
    expect(store.getState().dataSources[0].status).toBe('connected')
  })

  it('mounts with the connection read back after the seed, not the copy taken before', async () => {
    stored.row = TARGET
    const store = await freshStore({ ...TARGET, connectionConfig: { engine: 'duckdb' } })
    await store.getState().mountProjectSources('proj-1')
    expect(calls.ddl).toEqual(['omop'])
  })

  it('drops the patient rows kept for a database once it is mounted or unmounted', async () => {
    stored.row = TARGET
    const store = await freshStore(TARGET)
    await store.getState().mountProjectSources('proj-1')
    await store.getState().invalidateMount('omop')
    expect(calls.cleared).toEqual(['omop', 'omop'])
  })
})
