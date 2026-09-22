import { describe, it, expect, vi } from 'vitest'

/**
 * One source is mounted once, whoever asks.
 *
 * `mountProjectSources` (on entering a project) and `ensureMounted` (which every
 * front-only query now goes through) each used to guard themselves — busySources
 * for one, mountingPromises for the other — so neither saw the other's work. A
 * page reached directly ran both at once and DuckDB refused the second ATTACH:
 * "Failed to attach database: database with name ds_… already exists". Visiting
 * Databases first mounted everything before any page asked, which is why the bug
 * looked like it depended on navigation order.
 */

const mounts = vi.hoisted(() => ({ count: 0, release: () => {} }))

vi.mock('@/lib/duckdb/engine', () => ({
  mountDataSource: async () => {
    mounts.count++
    // Stay in flight until the test lets go, so both callers overlap.
    await new Promise<void>((resolve) => { mounts.release = resolve })
  },
  mountDataSourceFromHandles: async () => {},
  mountEmptyFromDDL: async () => {},
  requestHandlePermissions: async () => true,
  computeStats: async () => ({}),
  registerAlias: () => {},
  generateAlias: (s: string) => s,
  ensureUniqueAlias: (s: string) => s,
  setMountGuard: () => {},
  unmountDataSource: async () => {},
}))

vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    dataSources: { getAll: async () => [], update: async () => {} },
    files: { getByDataSource: async () => [{ id: 'f1', fileName: 'a.parquet', data: new Uint8Array() }] },
    fileHandles: { getByDataSource: async () => [] },
  }),
}))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/data-sources', () => ({
  createFromDdlOnServer: async () => {},
  fetchDataSourceSchema: async () => [],
  retestConnection: async () => {},
  queryDataSourceOnServer: async () => [],
}))
vi.mock('@/lib/entity-io', () => ({ DB_ERROR_NO_DATA_ON_IMPORT: 'no-data' }))
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ activeWorkspaceId: 'ws-1' }) },
}))
vi.mock('@/stores/app-store', () => ({
  useAppStore: { getState: () => ({ getProjectLinkedDataSourceIds: () => ['db-1'] }) },
}))

const SOURCE = {
  id: 'db-1',
  name: 'MIMIC-IV Demo',
  alias: 'mimic_iv_demo',
  workspaceId: 'ws-1',
  sourceType: 'database',
  status: 'connected',
  connectionConfig: {},
}

/**
 * `mountedSources` and the in-flight registry are module-level, so each case
 * needs a fresh copy of the store rather than a reset of the old one.
 */
async function freshStore() {
  vi.resetModules()
  mounts.count = 0
  mounts.release = () => {}
  const { useDataSourceStore } = await import('./data-source-store')
  useDataSourceStore.setState({ dataSources: [SOURCE as never], dataSourcesLoaded: true })
  return useDataSourceStore.getState()
}

describe('mounting the same source from both paths', () => {
  it('mounts once when a query races the project mount', async () => {
    const store = await freshStore()

    // Entering the project starts the mount; a page query arrives mid-flight.
    const viaProject = store.mountProjectSources('proj-1')
    await Promise.resolve()
    const viaQuery = store.ensureMounted('db-1')

    mounts.release()
    await Promise.all([viaProject, viaQuery])

    expect(mounts.count).toBe(1)
  })

  it('mounts once when the query gets there first', async () => {
    const store = await freshStore()

    const viaQuery = store.ensureMounted('db-1')
    await Promise.resolve()
    const viaProject = store.mountProjectSources('proj-1')

    mounts.release()
    await Promise.all([viaQuery, viaProject])

    expect(mounts.count).toBe(1)
  })
})
