import { useCallback } from 'react'
import { useCatalogStore } from '@/stores/catalog-store'
import { localized } from '@/lib/localized'
import { exportEntityZip, slugify } from '@/lib/entity-io'
import { CreateCatalogDialog } from './CreateCatalogDialog'
import type { DataCatalog } from '@/types'

export interface CatalogActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: DataCatalog) => void
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

  const onExport = useCallback(async (catalog: DataCatalog) => {
    await exportEntityZip(
      [{ filename: 'catalog.json', data: catalog }],
      `${slugify(localized(catalog.name, 'en'))}.zip`,
    )
  }, [])

  return {
    onDelete: (id) => deleteCatalog(id),
    onExport,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateCatalogDialog open onOpenChange={onOpenChange} editingCatalog={item} />
    ),
    deleteConfirmTitleKey: 'data_catalog.delete_title',
    deleteConfirmDescriptionKey: 'data_catalog.delete_description',
  }
}
