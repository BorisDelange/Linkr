import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { SquareTerminal } from 'lucide-react'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
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

  return (
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
  )
}
