import { useParams } from 'react-router'
import { MappingProjectListPage } from './concept-mapping/MappingProjectListPage'
import { MappingProjectPage } from './concept-mapping/MappingProjectPage'

export function ConceptMappingPage() {
  const { mappingProjectId } = useParams()

  if (mappingProjectId) {
    return <MappingProjectPage projectId={mappingProjectId} />
  }

  return <MappingProjectListPage />
}
