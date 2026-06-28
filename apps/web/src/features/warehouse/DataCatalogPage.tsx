import { useEffect } from 'react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useCatalogStore } from '@/stores/catalog-store'
import { CatalogListPage } from './catalog/CatalogListPage'
import { CatalogDetailPage } from './catalog/CatalogDetailPage'

export function DataCatalogPage() {
  const { raw } = useResolvedParams()
  const { catalogs, catalogsLoaded, loadCatalogs } = useCatalogStore()

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  if (raw.catalogId) {
    if (!catalogsLoaded) return null
    const catalogId = resolveByIdPrefix(catalogs, raw.catalogId, (c) => c.id)?.id
    if (catalogId) return <CatalogDetailPage catalogId={catalogId} />
  }

  return <CatalogListPage />
}
