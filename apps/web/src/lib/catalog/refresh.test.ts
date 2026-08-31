import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Which stores an install reloads.
 *
 * Cloned rows land straight in storage, so any store already holding a list is
 * stale. The ones that bite are those loaded ONCE by the App shell at startup —
 * cohorts and pipelines — because nothing else ever re-reads them: an installed
 * project's cohorts sat in storage while the page rendered the pre-install list
 * until the user reloaded by hand. This pins the set, so a store added to the
 * startup path is not silently left out of the refresh.
 */

const calls = vi.hoisted(() => ({ list: [] as string[] }))
const spy = (name: string) => async () => { calls.list.push(name) }

const store = (name: string, method: string, extra: Record<string, unknown> = {}) => ({
  getState: () => ({ [method]: spy(name), ...extra }),
  setState: () => {},
})

vi.mock('@/stores/workspace-store', () => ({ useWorkspaceStore: store('workspaces', 'loadWorkspaces') }))
vi.mock('@/stores/app-store', () => ({ useAppStore: store('projects', 'loadProjects') }))
vi.mock('@/stores/cohort-store', () => ({ useCohortStore: store('cohorts', 'loadCohorts') }))
vi.mock('@/stores/pipeline-store', () => ({ usePipelineStore: store('pipelines', 'loadPipelines') }))
vi.mock('@/stores/data-source-store', () => ({
  useDataSourceStore: {
    getState: () => ({ loadDataSources: async (force?: boolean) => { calls.list.push(`databases${force ? ':forced' : ''}`) } }),
  },
}))
vi.mock('@/stores/concept-mapping-store', () => ({ useConceptMappingStore: store('mapping-projects', 'loadMappingProjects') }))
vi.mock('@/stores/sql-scripts-store', () => ({ useSqlScriptsStore: store('sql', 'loadCollections') }))
vi.mock('@/stores/etl-store', () => ({ useEtlStore: store('etl', 'loadEtlPipelines') }))
vi.mock('@/stores/dq-store', () => ({ useDqStore: store('dq', 'loadDqRuleSets') }))
vi.mock('@/stores/catalog-store', () => ({ useCatalogStore: store('catalogs', 'loadCatalogs') }))
vi.mock('@/stores/schema-preset-store', () => ({ useSchemaPresetStore: store('presets', 'loadPresets') }))
vi.mock('@/stores/dataset-store', () => ({ useDatasetStore: { setState: () => {} } }))
vi.mock('@/stores/dashboard-store', () => ({ useDashboardStore: { setState: () => {} } }))

const { refreshStoresAfterInstall } = await import('./refresh')

describe('refreshStoresAfterInstall', () => {
  beforeEach(() => { calls.list = [] })

  it('reloads the startup-only stores after a workspace install', async () => {
    await refreshStoresAfterInstall('workspace', 'ws-1')
    // The two that nothing else re-reads — the reason a cohort went missing.
    expect(calls.list).toContain('cohorts')
    expect(calls.list).toContain('pipelines')
    // And the databases must be FORCED: the clones rewrote rows after the
    // in-flight load began, so joining it would return pre-clone data.
    expect(calls.list).toContain('databases:forced')
  })

  it('reloads them after a project install too — a project carries cohorts', async () => {
    await refreshStoresAfterInstall('project', 'ws-1')
    expect(calls.list).toContain('cohorts')
    expect(calls.list).toContain('pipelines')
  })

  it('always reloads the workspace list, whatever the type', async () => {
    await refreshStoresAfterInstall('database', 'ws-1')
    expect(calls.list).toContain('workspaces')
  })
})
