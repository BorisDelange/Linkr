import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BookOpen } from 'lucide-react'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getStorage } from '@/lib/storage'
import JSZip from 'jszip'
import { buildDataCatalogFolder, parseImportZip, readImportedManifest } from '@/lib/entity-io'
import { withEntityDocs } from '@/lib/entity-docs-pull'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateCatalogDialog } from './CreateCatalogDialog'
import { useCatalogActions } from './use-catalog-actions'
import type { DataCatalog } from '@/types'

export function CatalogListPage() {
  const { t, i18n } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { catalogsLoaded, loadCatalogs, catalogs: allCatalogs } = useCatalogStore()
  const catalogActions = useCatalogActions()

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  const catalogs = useMemo(
    () => (activeWorkspaceId ? allCatalogs.filter((c) => c.workspaceId === activeWorkspaceId) : []),
    [allCatalogs, activeWorkspaceId],
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const filteredCatalogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = catalogs.filter((c) => {
      if (q && !`${localized(c.name, language)} ${localized(c.description, language)}`.toLowerCase().includes(q)) return false
      if (badgeFilter.length > 0) {
        const labels = new Set((c.badges ?? []).map((b) => localized(b.label, language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (c) => localized(c.name, language),
      createdAt: (c) => c.createdAt,
      updatedAt: (c) => c.updatedAt,
    })
  }, [catalogs, searchQuery, badgeFilter, sort, language])

  // Distinct badges across the workspace's items, first-seen colour per label so the
  // filter options match the chips drawn on the cards.
  const badgeCategories = useBadgeCategories()
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const c of catalogs) for (const b of c.badges ?? []) {
      const label = localized(b.label, language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [catalogs, language])

  const filterGroups: FilterGroup[] = allBadges.length > 0 ? [{
    key: 'badges',
    label: t('common.badges'),
    selected: badgeFilter,
    onChange: setBadgeFilter,
    options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
  }] : []

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

  /** Duplicate = export to a ZIP and re-import it in duplicate mode, reusing the
   *  import path's cloning rules rather than repeating them here. */
  const handleDuplicate = useCallback(async (catalog: DataCatalog) => {
    const zip = new JSZip()
    await buildDataCatalogFolder(zip, '', catalog, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    const parsed = await parseImportZip(new File([blob], 'dup.zip'))
    const parsedCatalog = readImportedManifest<DataCatalog>(parsed, 'data-catalog')
    if (!parsedCatalog?.id) return
    withEntityDocs(parsedCatalog, parsed)
    await doImport(parsedCatalog, true)
  }, [doImport])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseImportZip(file)
    const catalog = readImportedManifest<DataCatalog>(parsed, 'data-catalog')
    if (!catalog?.id) return
    // Imported from a git repo → pre-link the Versioning page to that repo (with
    // the token, if supplied). The export strips gitRemoteConfig, so it's only
    // ever set from the import source.
    if (gitRemote) catalog.gitRemoteConfig = gitRemote
    withEntityDocs(catalog, parsed)
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
            filterGroups={filterGroups}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        ) : undefined
      }
      onNavigate={(id) => navigate(id)}
      onDelete={catalogActions.onDelete}
      onDuplicate={handleDuplicate}
      onExport={catalogActions.onExport}
      getGitRemote={catalogActions.getGitRemote}
      docs={catalogActions.docs}
      // The catalog page owns these as tabs, so open it there rather than
      // stacking a dialog over the list.
      onOpenDocs={(item, tab) => navigate(`${item.id}?tab=${tab}`)}
      onVersioningOverride={(item) => navigate(`${item.id}?tab=versioning`)}
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
              <TruncatedText text={localized(catalog.name, language)} readOnly className="min-w-0 flex-1 text-sm font-medium" />
              <div className="ml-auto shrink-0">{actionsMenu}</div>
            </div>
            <div className="mt-2 h-4">
              {localized(catalog.description, language) && (
                <TruncatedText text={localized(catalog.description, language)} readOnly className="text-xs text-muted-foreground" />
              )}
            </div>
            <BadgeStrip badges={catalog.badges ?? []} className="mt-1.5 h-5" />
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
