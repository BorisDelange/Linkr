/**
 * Where an installed catalog entry lives in the app — the entity itself, not the list
 * page it sits on.
 *
 * Shared by the Catalog page and the import dialog's catalog tab, so a card behaves the
 * same wherever it is drawn: once installed, clicking it opens the entity; before that,
 * it opens the repo it would come from.
 *
 * Types with no detail route of their own (sql collections, data catalogs) return
 * undefined, and their card keeps opening the repo — more useful than a list page that
 * does not say which row was just installed.
 */
import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { paths } from '@/lib/paths'
import type { InstalledInfo } from '@/lib/catalog/installed'
import type { CatalogEntry } from '@/lib/catalog/types'

export type OpenInstalled = (entry: CatalogEntry, info?: InstalledInfo) => (() => void) | undefined

export function useOpenInstalled(workspaceId: string, onNavigate?: () => void): OpenInstalled {
  const navigate = useNavigate()
  return useCallback(
    (entry, info) => {
      if (!info || !workspaceId) return undefined
      const to =
        entry.type === 'project' ? paths.projectSummary(workspaceId, info.id)
        : entry.type === 'mapping-project' ? paths.warehouseConceptMappingProject(workspaceId, info.id)
        : entry.type === 'etl-pipeline' ? paths.warehouseEtlPipeline(workspaceId, info.id)
        : entry.type === 'dq-rule-set' ? paths.warehouseDqRuleSet(workspaceId, info.id)
        : entry.type === 'schema-preset' ? paths.warehouseSchema(workspaceId, info.id)
        : null
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
