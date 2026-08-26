import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { SquareTerminal } from 'lucide-react'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { cn } from '@/lib/utils'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { localized, setLocalized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import JSZip from 'jszip'
import { attachTreeIds, buildSqlCollectionFolder, parseImportZip, readImportedManifest, readImportedTree, reconstructTreeFiles } from '@/lib/entity-io'
import { withEntityDocs } from '@/lib/entity-docs-pull'
import type { TreeImportNode } from '@/lib/entity-io'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateSqlScriptsDialog } from './CreateSqlScriptsDialog'
import { useSqlCollectionActions } from './use-sql-collection-actions'
import type { SqlScriptCollection, SqlScriptFile } from '@/types'

export function SqlScriptsListPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const language = useAppStore((s) => s.language)
  const { collectionsLoaded, loadCollections, collections: allCollections } = useSqlScriptsStore()
  const sqlActions = useSqlCollectionActions()

  useEffect(() => {
    if (!collectionsLoaded) loadCollections()
  }, [collectionsLoaded, loadCollections])

  const collections = useMemo(
    () => (activeWorkspaceId ? allCollections.filter((c) => c.workspaceId === activeWorkspaceId) : []),
    [allCollections, activeWorkspaceId],
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const filteredCollections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = collections.filter((c) => {
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
  }, [collections, searchQuery, badgeFilter, sort, language])

  // Distinct badges across the workspace's items, first-seen colour per label so the
  // filter options match the chips drawn on the cards.
  const badgeCategories = useBadgeCategories()
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const c of collections) for (const b of c.badges ?? []) {
      const label = localized(b.label, language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [collections, language])

  const filterGroups: FilterGroup[] = allBadges.length > 0 ? [{
    key: 'badges',
    label: t('common.badges'),
    selected: badgeFilter,
    onChange: setBadgeFilter,
    options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
  }] : []

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: SqlScriptCollection; pendingFiles: TreeImportNode[] } | null>(null)

  const doImport = useCallback(async (collection: SqlScriptCollection, files: TreeImportNode[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : collection.id
    // The cloned HEAD rides in on gitRemoteConfig.syncedOid but must not be
    // persisted — capture it for anchoring, then strip it from the stored config.
    const syncedOid = collection.gitRemoteConfig?.syncedOid
    const gitRemoteConfig = collection.gitRemoteConfig
      ? { url: collection.gitRemoteConfig.url, branch: collection.gitRemoteConfig.branch, authToken: collection.gitRemoteConfig.authToken }
      : collection.gitRemoteConfig
    const entity: SqlScriptCollection = {
      ...collection,
      gitRemoteConfig,
      id,
      workspaceId: activeWorkspaceId ?? collection.workspaceId,
      name: duplicate ? setLocalized(collection.name, language, `${localized(collection.name, language)} (copy)`) : collection.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      // Overwrite of an existing collection: clear its files/row first. A fresh
      // import (git clone of a collection not on this server) has nothing to
      // clear — the file delete 404s ("Not found") on the missing collection, so
      // swallow it like the collection delete below.
      await getStorage().sqlScriptFiles.deleteByCollection(collection.id).catch(() => {})
      await getStorage().sqlScriptCollections.delete(collection.id).catch(() => {})
    }
    await getStorage().sqlScriptCollections.create(entity)
    // Anchor sync state to the commit we cloned (server-mode git import only): it's
    // the base this workspace imported from, so a later push elsewhere is detected
    // as "behind". Best-effort — a failure just means no banner yet.
    if (syncedOid) {
      try {
        const { gitSetSyncState } = await import('@/lib/api/git')
        await gitSetSyncState('sql-script-collections', id, gitRemoteConfig?.branch ?? 'main', syncedOid)
      } catch { /* leave unanchored — lazy adoption may still catch a clean sync */ }
    }
    // Ids are derived from (target collection id, path), so a duplicate — which
    // gets a fresh collection id — automatically gets a distinct, collision-free
    // set without re-minting anything by hand.
    for (const f of attachTreeIds<SqlScriptFile>(files, id, 'collectionId')) {
      await getStorage().sqlScriptFiles.create(f)
    }
    await loadCollections()
  }, [activeWorkspaceId, language, loadCollections])

  /** Duplicate = export to a ZIP and re-import it in duplicate mode, reusing the
   *  import path's cloning rules rather than repeating them here. */
  const handleDuplicate = useCallback(async (collection: SqlScriptCollection) => {
    const zip = new JSZip()
    await buildSqlCollectionFolder(zip, '', collection, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    const parsed = await parseImportZip(new File([blob], 'dup.zip'))
    const parsedCollection = readImportedManifest<SqlScriptCollection>(parsed, 'sql-collection', 'collection.json')
    if (!parsedCollection?.id) return
    withEntityDocs(parsedCollection, parsed)
    const { tree, filePrefix } = readImportedTree(parsed, 'files.json')
    const files = reconstructTreeFiles(tree, parsed, filePrefix)
    await doImport(parsedCollection, files, true)
  }, [doImport])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseImportZip(file)
    // New git-friendly layout (_collection.json + _tree.json + raw files) with a fallback
    // to the legacy layout (collection.json + files.json).
    const collection = readImportedManifest<SqlScriptCollection>(parsed, 'sql-collection', 'collection.json')
    if (!collection?.id) return
    // Imported from a git repo → pre-link the Versioning page to that repo (with
    // the token, if supplied). The export strips gitRemoteConfig, so it's only
    // ever set from the import source.
    if (gitRemote) collection.gitRemoteConfig = gitRemote
    withEntityDocs(collection, parsed)
    const { tree, filePrefix } = readImportedTree(parsed, 'files.json')
    const files = reconstructTreeFiles(tree, parsed, filePrefix)
    const existing = await getStorage().sqlScriptCollections.getById(collection.id)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: collection, pendingFiles: files })
    } else {
      await doImport(collection, files, false)
    }
  }, [doImport, language])

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) doImport(conflict.pending, conflict.pendingFiles, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) doImport(conflict.pending, conflict.pendingFiles, false); setConflict(null) }}
    />
    <ListPageTemplate<SqlScriptCollection>
      canEdit={atLeast('editor')}
      canDelete={atLeast('owner')}
      titleKey="sql_scripts.title"
      descriptionKey="sql_scripts.description"
      newButtonKey="sql_scripts.new_collection"
      emptyTitleKey="sql_scripts.no_collections"
      emptyDescriptionKey="sql_scripts.no_collections_description"
      deleteConfirmTitleKey={sqlActions.deleteConfirmTitleKey}
      deleteConfirmDescriptionKey={sqlActions.deleteConfirmDescriptionKey}
      emptyIcon={SquareTerminal}
      items={filteredCollections}
      toolbar={
        collections.length > 0 ? (
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
      onDelete={sqlActions.onDelete}
      onDuplicate={handleDuplicate}
      onExport={sqlActions.onExport}
      getGitRemote={sqlActions.getGitRemote}
      docs={sqlActions.docs}
      // The collection page owns these as tabs, so open it there rather than
      // stacking a dialog over the list.
      onOpenDocs={(item, tab) => navigate(`${item.id}?tab=${tab}`)}
      onVersioningOverride={(item) => navigate(`${item.id}?tab=versioning`)}
      onSaveGitRemote={sqlActions.onSaveGitRemote}
      exportSupportsIncludeData={sqlActions.exportSupportsIncludeData}
      syncScope="sql-script-collections"
      onImport={handleImport}
      renderCardBody={(collection, actionsMenu) => (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS['sql-collection'].bg)}>
              <SquareTerminal size={20} className={ENTITY_COLORS['sql-collection'].icon} />
            </div>
            <TruncatedText text={localized(collection.name, language)} readOnly className="min-w-0 flex-1 text-sm font-medium" />
            <div className="ml-auto shrink-0">{actionsMenu}</div>
          </div>
          <div className="mt-2 h-4">
            {localized(collection.description, language) && (
              <TruncatedText text={localized(collection.description, language)} readOnly className="text-xs text-muted-foreground" />
            )}
          </div>
          <BadgeStrip badges={collection.badges ?? []} className="mt-1.5 h-5" />
        </div>
      )}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateSqlScriptsDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={sqlActions.renderEditDialog}
    />
    </>
  )
}
