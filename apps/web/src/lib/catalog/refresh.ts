/**
 * Refresh the in-memory stores after a catalog install, so the freshly cloned entity
 * shows up on a page that is already open.
 *
 * The clone writes straight to storage; without this the Projects page (and its
 * siblings) keep rendering the list they loaded on mount. Same idea as
 * `refreshStoresAfterReseed`, keyed by catalog entry type rather than seed type.
 *
 * Lazy imports keep the catalog modules free of store dependencies until an install
 * actually runs.
 */
import type { CatalogEntryType } from './types'

export async function refreshStoresAfterInstall(
  type: CatalogEntryType,
  workspaceId: string,
): Promise<void> {
  // The workspace list carries per-workspace entity counts, so it is stale after any
  // install, whatever the type.
  const { useWorkspaceStore } = await import('@/stores/workspace-store')
  const reloads: Array<Promise<unknown>> = [useWorkspaceStore.getState().loadWorkspaces()]

  switch (type) {
    case 'project': {
      const { useAppStore } = await import('@/stores/app-store')
      reloads.push(useAppStore.getState().loadProjects())
      // A project carries datasets, dashboards and concept mappings, held by stores
      // that load lazily per project and early-return once their marker matches. An
      // overwrite rewrites those rows underneath a store that already believes it is
      // loaded, so the project's own pages keep rendering pre-install content until a
      // manual reload. Clearing the markers makes the next visit — or the page effect
      // re-running, if that project is open right now — re-read from storage.
      await clearProjectScopedMarkers()
      break
    }
    case 'mapping-project': {
      const { useConceptMappingStore } = await import('@/stores/concept-mapping-store')
      reloads.push(useConceptMappingStore.getState().loadMappingProjects())
      // Same staleness as above for the mappings of the project being viewed.
      useConceptMappingStore.setState({ activeProjectId: null })
      break
    }
    case 'etl-pipeline': {
      const { useEtlStore } = await import('@/stores/etl-store')
      reloads.push(useEtlStore.getState().loadEtlPipelines())
      break
    }
    case 'dq-rule-set': {
      const { useDqStore } = await import('@/stores/dq-store')
      reloads.push(useDqStore.getState().loadDqRuleSets())
      break
    }
    case 'data-catalog': {
      const { useCatalogStore } = await import('@/stores/catalog-store')
      reloads.push(useCatalogStore.getState().loadCatalogs())
      break
    }
    case 'sql-collection': {
      const { useSqlScriptsStore } = await import('@/stores/sql-scripts-store')
      reloads.push(useSqlScriptsStore.getState().loadCollections())
      break
    }
    case 'schema-preset': {
      // Scoped to the target workspace — the Schemas page loads the same way, and
      // an unscoped reload would list every workspace's presets.
      const { useSchemaPresetStore } = await import('@/stores/schema-preset-store')
      reloads.push(useSchemaPresetStore.getState().loadPresets(workspaceId))
      break
    }
    case 'database': {
      const { useDataSourceStore } = await import('@/stores/data-source-store')
      reloads.push(useDataSourceStore.getState().loadDataSources())
      break
    }
  }

  await Promise.all(reloads)
}

/**
 * Drop the active-project markers of the lazily-loaded, project-scoped stores.
 *
 * These stores key their cache on a project uid and skip the read when it already
 * matches, so a re-install that rewrites a project's content in place is invisible to
 * them. Resetting the marker (rather than reloading) is what `refreshStoresAfterReseed`
 * does for the same stores, and it avoids having to know which project was written.
 */
async function clearProjectScopedMarkers(): Promise<void> {
  const [{ useDatasetStore }, { useDashboardStore }, { useConceptMappingStore }] = await Promise.all([
    import('@/stores/dataset-store'),
    import('@/stores/dashboard-store'),
    import('@/stores/concept-mapping-store'),
  ])
  useDatasetStore.setState({ activeProjectUid: null })
  useDashboardStore.setState({ activeProjectUid: null, loaded: false })
  useConceptMappingStore.setState({ activeProjectId: null })
}
