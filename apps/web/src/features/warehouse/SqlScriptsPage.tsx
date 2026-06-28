import { useEffect } from 'react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { SqlScriptsListPage } from './sql-scripts/SqlScriptsListPage'
import { SqlScriptsEditorPage } from './sql-scripts/SqlScriptsEditorPage'

export function SqlScriptsPage() {
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
  }

  return <SqlScriptsListPage />
}
