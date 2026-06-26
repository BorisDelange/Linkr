/**
 * Refresh the in-memory Zustand stores after a targeted re-seed, so the UI reflects the
 * freshly re-imported entities without a full page reload.
 *
 * Each re-seeded entity type maps to the store(s) that hold it. Globally-loaded types
 * (projects, databases, mapping projects, ETL, DQ, catalogs, workspaces) have a no-arg
 * reloader that re-reads everything from IndexedDB. Project-scoped types (datasets,
 * dashboards, concept mappings) are loaded lazily per active project: we reset the
 * store's active-project marker so the next visit re-reads from IndexedDB.
 *
 * If a re-seeded type has no known refresh path, refreshStoresAfterReseed() reports it as
 * uncovered and the caller falls back to window.location.reload().
 */
import type { SeedChange, SeedEntityType } from '@/lib/seed-change-detector'

/** Entity types we know how to refresh in-memory. Anything else → full reload fallback. */
const REFRESHABLE: Set<SeedEntityType> = new Set([
  'workspace', 'project', 'database', 'dataset', 'dashboard',
  'conceptMapping', 'mappingProject', 'etlScript', 'dqRuleSet', 'catalog',
])

/**
 * Reload the stores affected by the given re-seeded changes.
 * Returns false if any change targets a type we can't refresh cleanly (caller should
 * then fall back to a full reload).
 */
export async function refreshStoresAfterReseed(changes: SeedChange[]): Promise<boolean> {
  const types = new Set(changes.map((c) => c.entityType))
  if ([...types].some((t) => !REFRESHABLE.has(t))) return false

  // Lazy imports keep this module (and targeted-reseed) free of store dependencies until
  // an actual re-seed runs.
  const [
    { useAppStore },
    { useWorkspaceStore },
    { useOrganizationStore },
    { useDataSourceStore },
    { useConceptMappingStore },
    { useEtlStore },
    { useDqStore },
    { useCatalogStore },
    { useDatasetStore },
    { useDashboardStore },
  ] = await Promise.all([
    import('@/stores/app-store'),
    import('@/stores/workspace-store'),
    import('@/stores/organization-store'),
    import('@/stores/data-source-store'),
    import('@/stores/concept-mapping-store'),
    import('@/stores/etl-store'),
    import('@/stores/dq-store'),
    import('@/stores/catalog-store'),
    import('@/stores/dataset-store'),
    import('@/stores/dashboard-store'),
  ])

  const reloads: Array<Promise<unknown>> = []

  if (types.has('workspace')) {
    reloads.push(useWorkspaceStore.getState().loadWorkspaces())
    reloads.push(useOrganizationStore.getState().loadOrganizations())
  }
  if (types.has('project')) reloads.push(useAppStore.getState().loadProjects())
  if (types.has('database')) reloads.push(useDataSourceStore.getState().loadDataSources())
  if (types.has('conceptMapping') || types.has('mappingProject')) {
    reloads.push(useConceptMappingStore.getState().loadMappingProjects())
  }
  if (types.has('etlScript')) reloads.push(useEtlStore.getState().loadEtlPipelines())
  if (types.has('dqRuleSet')) reloads.push(useDqStore.getState().loadDqRuleSets())
  if (types.has('catalog')) reloads.push(useCatalogStore.getState().loadCatalogs())

  // Project-scoped, lazily-loaded stores: drop the active-project marker so the next
  // page visit re-reads from IndexedDB. If that project is open right now, its page
  // effect re-runs loadProject*() on the cleared marker.
  if (types.has('dataset')) useDatasetStore.setState({ activeProjectUid: null })
  if (types.has('dashboard')) useDashboardStore.setState({ activeProjectUid: null, loaded: false })
  if (types.has('conceptMapping')) useConceptMappingStore.setState({ activeProjectId: null })

  await Promise.all(reloads)
  return true
}
