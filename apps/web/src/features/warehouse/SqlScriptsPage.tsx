import { useParams } from 'react-router'
import { SqlScriptsListPage } from './sql-scripts/SqlScriptsListPage'
import { SqlScriptsEditorPage } from './sql-scripts/SqlScriptsEditorPage'

export function SqlScriptsPage() {
  const { collectionId } = useParams()

  if (collectionId) {
    return <SqlScriptsEditorPage collectionId={collectionId} />
  }

  return <SqlScriptsListPage />
}
