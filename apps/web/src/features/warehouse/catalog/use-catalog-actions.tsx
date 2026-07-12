import { useCallback } from 'react'
import { useCatalogStore } from '@/stores/catalog-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { exportEntityZip, slugify } from '@/lib/entity-io'
import { CreateCatalogDialog } from './CreateCatalogDialog'
import type { DataCatalog, GitRemoteConfig } from '@/types'

export interface CatalogActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: DataCatalog) => void
  getGitRemote: (item: DataCatalog) => GitRemoteConfig | null
  onSaveGitRemote: (item: DataCatalog, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: DataCatalog; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a data catalog (delete / export / edit).
 * Used by both the list page cards and the header badge menu so the two stay
 * behaviourally identical.
 */
export function useCatalogActions(): CatalogActions {
  const deleteCatalog = useCatalogStore((s) => s.deleteCatalog)
  const loadCatalogs = useCatalogStore((s) => s.loadCatalogs)

  const onExport = useCallback(async (catalog: DataCatalog) => {
    await exportEntityZip(
      [{ filename: 'catalog.json', data: catalog }],
      `${slugify(localized(catalog.name, 'en'))}.zip`,
    )
  }, [])

  const onSaveGitRemote = useCallback(async (c: DataCatalog, config: GitRemoteConfig | null) => {
    await getStorage().dataCatalogs.update(c.id, { gitRemoteConfig: config ?? undefined })
    await loadCatalogs()
  }, [loadCatalogs])

  return {
    onDelete: (id) => deleteCatalog(id),
    onExport,
    getGitRemote: (c) => c.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateCatalogDialog open onOpenChange={onOpenChange} editingCatalog={item} />
    ),
    deleteConfirmTitleKey: 'data_catalog.delete_title',
    deleteConfirmDescriptionKey: 'data_catalog.delete_description',
  }
}
