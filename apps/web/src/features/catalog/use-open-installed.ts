/**
 * Where an installed catalog entry lives in the app — the entity itself, not the list
 * page it sits on.
 *
 * Shared by the Catalog page and the import dialog's catalog tab, so a card behaves the
 * same wherever it is drawn: once installed, clicking it opens the entity; before that,
 * it opens the repo it would come from.
 *
 * Every catalog entry type has a detail route, so a missing branch below is a bug, not a
 * fallback: the card would silently open the git repo of an entity already installed.
 */
import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { paths } from '@/lib/paths'
import type { InstalledInfo } from '@/lib/catalog/installed'
import type { CatalogEntry } from '@/lib/catalog/types'

export type OpenInstalled = (entry: CatalogEntry, info?: InstalledInfo) => (() => void) | undefined

/** Exhaustive over CatalogEntry['type']: adding a type without a route fails typecheck. */
function detailPath(type: CatalogEntry['type'], wsId: string, id: string): string | null {
  switch (type) {
    case 'project':
      return paths.projectSummary(wsId, id)
    case 'mapping-project':
      return paths.warehouseConceptMappingProject(wsId, id)
    case 'etl-pipeline':
      return paths.warehouseEtlPipeline(wsId, id)
    case 'dq-rule-set':
      return paths.warehouseDqRuleSet(wsId, id)
    case 'schema-preset':
      return paths.warehouseSchema(wsId, id)
    case 'database':
      return paths.warehouseDatabase(wsId, id)
    case 'sql-collection':
      return paths.warehouseSqlCollection(wsId, id)
    case 'data-catalog':
      return paths.warehouseDataCatalog(wsId, id)
    default: {
      const _exhaustive: never = type
      return _exhaustive
    }
  }
}

export function useOpenInstalled(workspaceId: string, onNavigate?: () => void): OpenInstalled {
  const navigate = useNavigate()
  return useCallback(
    (entry, info) => {
      if (!info || !workspaceId) return undefined
      const to = detailPath(entry.type, workspaceId, info.id)
      if (!to) return undefined
      return () => {
        // The dialog host closes itself first: navigating out from under an open
        // modal leaves its overlay stranded over the page it lands on.
        onNavigate?.()
        navigate(to)
      }
    },
    [workspaceId, navigate, onNavigate],
  )
}
