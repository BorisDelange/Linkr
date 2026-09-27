import { useEffect } from 'react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useTranslation } from 'react-i18next'
import { EntityNotFound } from '@/components/layout/EntityNotFound'
import { paths } from '@/lib/paths'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { SqlScriptsListPage } from './sql-scripts/SqlScriptsListPage'
import { SqlScriptsEditorPage } from './sql-scripts/SqlScriptsEditorPage'

export function SqlScriptsPage() {
  const { t } = useTranslation()
  const { raw } = useResolvedParams()
  const { collections, collectionsLoaded, loadCollections } = useSqlScriptsStore()

  useEffect(() => {
    if (!collectionsLoaded) loadCollections()
  }, [collectionsLoaded, loadCollections])

  if (raw.collectionId) {
    if (!collectionsLoaded) return null
    const collectionId = resolveByIdPrefix(collections, raw.collectionId, (c) => c.id)?.id
    if (collectionId) {
      return <SqlScriptsEditorPage collectionId={collectionId} />
    }
    return (
      <EntityNotFound
        entityLabel={t('common.entity_sql_collection')}
        entityId={raw.collectionId}
        backTo={paths.warehouseSqlScripts(raw.wsUid ?? '')}
        backLabel={t('common.back_to_sql_collections')}
      />
    )
  }

  return <SqlScriptsListPage />
}
