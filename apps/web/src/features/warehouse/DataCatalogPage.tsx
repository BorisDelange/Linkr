import { useEffect } from 'react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useTranslation } from 'react-i18next'
import { EntityNotFound } from '@/components/layout/EntityNotFound'
import { paths } from '@/lib/paths'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useCatalogStore } from '@/stores/catalog-store'
import { CatalogListPage } from './catalog/CatalogListPage'
import { CatalogDetailPage } from './catalog/CatalogDetailPage'

export function DataCatalogPage() {
  const { t } = useTranslation()
  const { raw } = useResolvedParams()
  const { catalogs, catalogsLoaded, loadCatalogs } = useCatalogStore()

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  if (raw.catalogId) {
    if (!catalogsLoaded) return null
    const catalogId = resolveByIdPrefix(catalogs, raw.catalogId, (c) => c.id)?.id
    if (catalogId) return <CatalogDetailPage catalogId={catalogId} />
    return (
      <EntityNotFound
        entityLabel={t('common.entity_data_catalog')}
        entityId={raw.catalogId}
        backTo={paths.warehouseDataCatalogs(raw.wsUid ?? '')}
        backLabel={t('common.back_to_data_catalogs')}
      />
    )
  }

  return <CatalogListPage />
}
