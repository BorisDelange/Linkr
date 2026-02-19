import { useParams } from 'react-router'
import { CatalogListPage } from './catalog/CatalogListPage'
import { CatalogDetailPage } from './catalog/CatalogDetailPage'

export function DataCatalogPage() {
  const { catalogId } = useParams()
  if (catalogId) return <CatalogDetailPage catalogId={catalogId} />
  return <CatalogListPage />
}
