import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { SquareTerminal } from 'lucide-react'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { parseImportZip, reconstructTreeFiles } from '@/lib/entity-io'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateSqlScriptsDialog } from './CreateSqlScriptsDialog'
import { useSqlCollectionActions } from './use-sql-collection-actions'
import type { SqlScriptCollection } from '@/types'

export function SqlScriptsListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const language = useAppStore((s) => s.language)
  const { collectionsLoaded, loadCollections, getWorkspaceCollections } = useSqlScriptsStore()
  const sqlActions = useSqlCollectionActions()

  useEffect(() => {
    if (!collectionsLoaded) loadCollections()
  }, [collectionsLoaded, loadCollections])

  const collections = activeWorkspaceId ? getWorkspaceCollections(activeWorkspaceId) : []

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const filteredCollections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? collections.filter((c) => `${localized(c.name, language)} ${localized(c.description, language)}`.toLowerCase().includes(q))
      : collections
    return applySort(filtered, sort, {
      name: (c) => localized(c.name, language),
      createdAt: (c) => c.createdAt,
      updatedAt: (c) => c.updatedAt,
    })
  }, [collections, searchQuery, sort, language])

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: SqlScriptCollection; pendingFiles: import('@/types').SqlScriptFile[] } | null>(null)

  const doImport = useCallback(async (collection: SqlScriptCollection, files: import('@/types').SqlScriptFile[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : collection.id
    const entity: SqlScriptCollection = {
      ...collection,
      id,
      workspaceId: activeWorkspaceId ?? collection.workspaceId,
      name: duplicate ? setLocalized(collection.name, language, `${localized(collection.name, language)} (copy)`) : collection.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      await getStorage().sqlScriptFiles.deleteByCollection(collection.id)
      await getStorage().sqlScriptCollections.delete(collection.id).catch(() => {})
    }
    await getStorage().sqlScriptCollections.create(entity)
    for (const f of files) {
      await getStorage().sqlScriptFiles.create({
        ...f,
        id: duplicate ? crypto.randomUUID() : f.id,
        collectionId: id,
      })
    }
    await loadCollections()
  }, [activeWorkspaceId, language, loadCollections])

  const handleImport = useCallback(async (file: File) => {
    const parsed = await parseImportZip(file)
    // New git-friendly layout (_collection.json + _tree.json + raw files) with a fallback
    // to the legacy layout (collection.json + files.json).
    const collection = (parsed['_collection.json'] ?? parsed['collection.json']) as SqlScriptCollection | undefined
    if (!collection?.id) return
    const tree = parsed['_tree.json'] as import('@/types').SqlScriptFile[] | undefined
    const files = tree
      ? reconstructTreeFiles(tree, parsed)
      : ((parsed['files.json'] ?? []) as import('@/types').SqlScriptFile[])
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
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        ) : undefined
      }
      onNavigate={(id) => navigate(id)}
      onDelete={sqlActions.onDelete}
      onExport={sqlActions.onExport}
      getGitRemote={sqlActions.getGitRemote}
      onSaveGitRemote={sqlActions.onSaveGitRemote}
      exportSupportsIncludeData={sqlActions.exportSupportsIncludeData}
      syncScope="sql-script-collections"
      onImport={handleImport}
      renderCardBody={(collection) => (
        <>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
            <SquareTerminal size={20} className="text-teal-500" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="truncate text-sm font-medium">{localized(collection.name, language)}</span>
            {localized(collection.description, language) && (
              <TruncatedText
                text={localized(collection.description, language)}
                className="mt-0.5 text-xs text-muted-foreground"
              />
            )}
          </div>
        </>
      )}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateSqlScriptsDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={sqlActions.renderEditDialog}
    />
    </>
  )
}
