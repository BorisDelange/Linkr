import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { SquareTerminal } from 'lucide-react'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getStorage } from '@/lib/storage'
import { exportEntityZip, parseImportZip, slugify } from '@/lib/entity-io'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { ListPageTemplate } from '../ListPageTemplate'
import { CreateSqlScriptsDialog } from './CreateSqlScriptsDialog'
import type { SqlScriptCollection } from '@/types'

export function SqlScriptsListPage() {
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { collectionsLoaded, loadCollections, getWorkspaceCollections, deleteCollection } = useSqlScriptsStore()

  useEffect(() => {
    if (!collectionsLoaded) loadCollections()
  }, [collectionsLoaded, loadCollections])

  const collections = activeWorkspaceId ? getWorkspaceCollections(activeWorkspaceId) : []

  // --- Export / Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: SqlScriptCollection; pendingFiles: import('@/types').SqlScriptFile[] } | null>(null)

  const handleExport = useCallback(async (collection: SqlScriptCollection) => {
    const files = await getStorage().sqlScriptFiles.getByCollection(collection.id)
    await exportEntityZip(
      [
        { filename: 'collection.json', data: collection },
        { filename: 'files.json', data: files },
      ],
      `${slugify(collection.name)}.zip`,
    )
  }, [])

  const handleImport = useCallback(async (file: File) => {
    const parsed = await parseImportZip(file)
    const collection = parsed['collection.json'] as SqlScriptCollection | undefined
    if (!collection?.id) return
    const files = (parsed['files.json'] ?? []) as import('@/types').SqlScriptFile[]
    const existing = await getStorage().sqlScriptCollections.getById(collection.id)
    if (existing) {
      setConflict({ name: existing.name, pending: collection, pendingFiles: files })
    } else {
      await doImport(collection, files, false)
    }
  }, [activeWorkspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  const doImport = useCallback(async (collection: SqlScriptCollection, files: import('@/types').SqlScriptFile[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : collection.id
    const entity: SqlScriptCollection = {
      ...collection,
      id,
      workspaceId: activeWorkspaceId ?? collection.workspaceId,
      name: duplicate ? `${collection.name} (copy)` : collection.name,
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
  }, [activeWorkspaceId, loadCollections])

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
      titleKey="sql_scripts.title"
      descriptionKey="sql_scripts.description"
      newButtonKey="sql_scripts.new_collection"
      emptyTitleKey="sql_scripts.no_collections"
      emptyDescriptionKey="sql_scripts.no_collections_description"
      deleteConfirmTitleKey="sql_scripts.delete_confirm_title"
      deleteConfirmDescriptionKey="sql_scripts.delete_confirm_description"
      emptyIcon={SquareTerminal}
      items={collections}
      onNavigate={(id) => navigate(id)}
      onDelete={(id) => deleteCollection(id)}
      onExport={handleExport}
      onImport={handleImport}
      renderCardBody={(collection) => (
        <>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
            <SquareTerminal size={20} className="text-teal-500" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="truncate text-sm font-medium">{collection.name}</span>
            {collection.description && (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                {collection.description}
              </p>
            )}
          </div>
        </>
      )}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateSqlScriptsDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={({ item, onOpenChange }) => (
        <CreateSqlScriptsDialog open onOpenChange={onOpenChange} editingCollection={item} />
      )}
    />
    </>
  )
}
