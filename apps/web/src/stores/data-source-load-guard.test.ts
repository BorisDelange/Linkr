import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The in-flight guard on `loadDataSources`.
 *
 * Deduplicating concurrent READERS is right — several pages mount at once and
 * must not each re-read storage. But a caller that just WROTE (a workspace
 * import, whose git clones rewrite rows after the load began) cannot be served
 * the in-flight promise: it resolves with pre-write data, leaving the store
 * stale until a manual page reload. That is how a cohort's database dropdown
 * came up empty right after installing a workspace — both sides correct in
 * storage, the store holding the older read.
 */

const rows = vi.hoisted(() => ({ current: [] as { id: string }[], reads: 0 }))

vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    dataSources: {
      getAll: async () => {
        rows.reads++
        // Yield, so a second call lands while this one is still in flight.
        await Promise.resolve()
        return rows.current.map((r) => ({ ...r, alias: r.id, workspaceId: 'ws-1' }))
      },
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

describe('loadDataSources — the in-flight guard', () => {
  beforeEach(() => {
    rows.current = [{ id: 'db-1' }]
    rows.reads = 0
    useDataSourceStore.setState({ dataSources: [], dataSourcesLoaded: false })
  })

  it('joins the in-flight load for concurrent readers (one read, not two)', async () => {
    const store = useDataSourceStore.getState()
    await Promise.all([store.loadDataSources(), store.loadDataSources()])
    expect(rows.reads).toBe(1)
  })

  it('re-reads when forced, so a writer never gets the pre-write result', async () => {
    const store = useDataSourceStore.getState()
    const reader = store.loadDataSources()
    // The import's clones land here — after the read above started.
    rows.current = [{ id: 'db-1' }, { id: 'db-2' }]
    await Promise.all([reader, store.loadDataSources(true)])

    expect(rows.reads).toBe(2)
    expect(useDataSourceStore.getState().dataSources.map((d) => d.id)).toEqual(['db-1', 'db-2'])
  })

  it('leaves the slot usable after a forced reload overlapped a plain one', async () => {
    const store = useDataSourceStore.getState()
    await Promise.all([store.loadDataSources(), store.loadDataSources(true)])
    rows.reads = 0
    // If the overlapping finally had nulled a slot it did not own, this would
    // find a stale promise instead of starting a fresh read.
    await store.loadDataSources()
    expect(rows.reads).toBe(1)
  })
})
