import { useCallback } from 'react'
import JSZip from 'jszip'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { buildSqlCollectionFolder, downloadBlob, slugify } from '@/lib/entity-io'
import { CreateSqlScriptsDialog } from './CreateSqlScriptsDialog'
import type { GitRemoteConfig, SqlScriptCollection } from '@/types'

export interface SqlCollectionActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: SqlScriptCollection) => void
  getGitRemote: (item: SqlScriptCollection) => GitRemoteConfig | null
  onSaveGitRemote: (item: SqlScriptCollection, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: SqlScriptCollection; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a SQL script collection (delete / export /
 * git link / edit). Used by both the list page cards and the header badge menu
 * so the two stay behaviourally identical.
 */
export function useSqlCollectionActions(): SqlCollectionActions {
  const deleteCollection = useSqlScriptsStore((s) => s.deleteCollection)
  const loadCollections = useSqlScriptsStore((s) => s.loadCollections)

  const onExport = useCallback(async (collection: SqlScriptCollection) => {
    const zip = new JSZip()
    await buildSqlCollectionFolder(zip, '', collection, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(localized(collection.name, 'en'))}.zip`)
  }, [])

  const onSaveGitRemote = useCallback(async (c: SqlScriptCollection, config: GitRemoteConfig | null) => {
    await getStorage().sqlScriptCollections.update(c.id, { gitRemoteConfig: config ?? undefined })
    await loadCollections()
  }, [loadCollections])

  return {
    onDelete: (id) => deleteCollection(id),
    onExport,
    getGitRemote: (c) => c.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateSqlScriptsDialog open onOpenChange={onOpenChange} editingCollection={item} />
    ),
    deleteConfirmTitleKey: 'sql_scripts.delete_confirm_title',
    deleteConfirmDescriptionKey: 'sql_scripts.delete_confirm_description',
  }
}
