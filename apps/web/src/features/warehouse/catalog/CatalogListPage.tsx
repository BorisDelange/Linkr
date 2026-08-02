import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BookOpen, Database } from 'lucide-react'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import { parseImportZip } from '@/lib/entity-io'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateCatalogDialog } from './CreateCatalogDialog'
import { useCatalogActions } from './use-catalog-actions'
import type { DataCatalog } from '@/types'

export function CatalogListPage() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { catalogsLoaded, loadCatalogs, getWorkspaceCatalogs } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const catalogActions = useCatalogActions()

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  const catalogs = activeWorkspaceId ? getWorkspaceCatalogs(activeWorkspaceId) : []

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const filteredCatalogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? catalogs.filter((c) => `${localized(c.name, language)} ${localized(c.description, language)}`.toLowerCase().includes(q))
      : catalogs
    return applySort(filtered, sort, {
      name: (c) => localized(c.name, language),
      createdAt: (c) => c.createdAt,
      updatedAt: (c) => c.updatedAt,
    })
  }, [catalogs, searchQuery, sort, language])

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: DataCatalog } | null>(null)

  const doImport = useCallback(async (catalog: DataCatalog, duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : catalog.id
    // The cloned HEAD rides in on gitRemoteConfig.syncedOid but must not be
    // persisted — capture it for anchoring, then strip it from the stored config.
    const syncedOid = catalog.gitRemoteConfig?.syncedOid
    const gitRemoteConfig = catalog.gitRemoteConfig
      ? { url: catalog.gitRemoteConfig.url, branch: catalog.gitRemoteConfig.branch, authToken: catalog.gitRemoteConfig.authToken }
      : catalog.gitRemoteConfig
    const entity: DataCatalog = {
      ...catalog,
      gitRemoteConfig,
      id,
      workspaceId: activeWorkspaceId ?? catalog.workspaceId,
      name: duplicate ? setLocalized(catalog.name, language, `${localized(catalog.name, language)} (copy)`) : catalog.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      await getStorage().dataCatalogs.delete(catalog.id).catch(() => {})
    }
    await getStorage().dataCatalogs.create(entity)
    // Anchor sync state to the commit we cloned (server-mode git import only): it's
    // the base this workspace imported from, so a later push elsewhere is detected
    // as "behind". Best-effort — a failure just means no banner yet.
    if (syncedOid) {
      try {
        const { gitSetSyncState } = await import('@/lib/api/git')
        await gitSetSyncState('data-catalogs', id, gitRemoteConfig?.branch ?? 'main', syncedOid)
      } catch { /* leave unanchored — lazy adoption may still catch a clean sync */ }
    }
    await loadCatalogs()
  }, [activeWorkspaceId, loadCatalogs])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseImportZip(file)
    const catalog = parsed['catalog.json'] as DataCatalog | undefined
    if (!catalog?.id) return
    // Imported from a git repo → pre-link the Versioning page to that repo (with
    // the token, if supplied). The export strips gitRemoteConfig, so it's only
    // ever set from the import source.
    if (gitRemote) catalog.gitRemoteConfig = gitRemote
    const existing = await getStorage().dataCatalogs.getById(catalog.id)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: catalog })
    } else {
      await doImport(catalog, false)
    }
  }, [doImport])

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) doImport(conflict.pending, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) doImport(conflict.pending, false); setConflict(null) }}
    />
    <ListPageTemplate<DataCatalog>
      canEdit={atLeast('editor')}
      canDelete={atLeast('owner')}
      titleKey="data_catalog.title"
      descriptionKey="data_catalog.description"
      newButtonKey="data_catalog.new_catalog"
      emptyTitleKey="data_catalog.no_catalogs"
      emptyDescriptionKey="data_catalog.no_catalogs_description"
      deleteConfirmTitleKey={catalogActions.deleteConfirmTitleKey}
      deleteConfirmDescriptionKey={catalogActions.deleteConfirmDescriptionKey}
      emptyIcon={BookOpen}
      items={filteredCatalogs}
      toolbar={
        catalogs.length > 0 ? (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('common.search')}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        ) : undefined
      }
      onNavigate={(id) => navigate(id)}
      onDelete={catalogActions.onDelete}
      onExport={catalogActions.onExport}
      getGitRemote={catalogActions.getGitRemote}
      onSaveGitRemote={catalogActions.onSaveGitRemote}
      exportSupportsIncludeData={catalogActions.exportSupportsIncludeData}
      syncScope="data-catalogs"
      onImport={handleImport}
      renderCardBody={(catalog, actionsMenu) => {
        return (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <BookOpen size={20} className="text-teal-500" />
              </div>
              <span className="truncate text-sm font-medium">{localized(catalog.name, language)}</span>
              <div className="ml-auto shrink-0">{actionsMenu}</div>
            </div>
            <div className="mt-2 h-4">
              {localized(catalog.description, language) && (
                <TruncatedText text={localized(catalog.description, language)} className="text-xs text-muted-foreground" />
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} className="shrink-0" />
              <span className="truncate">{getSourceName(catalog.dataSourceId)}</span>
            </div>
          </div>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateCatalogDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={catalogActions.renderEditDialog}
    />
    </>
  )
}
