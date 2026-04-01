import { useState } from 'react'
import { useParams } from 'react-router'
import { MappingProjectListPage } from './concept-mapping/MappingProjectListPage'
import { MappingProjectPage } from './concept-mapping/MappingProjectPage'
import { GlobalSummaryView } from './concept-mapping/GlobalSummaryView'

export function ConceptMappingPage() {
  const { mappingProjectId } = useParams()
  const [showGlobal, setShowGlobal] = useState(false)

  if (mappingProjectId) {
    return <MappingProjectPage projectId={mappingProjectId} />
  }

  if (showGlobal) {
    return <GlobalSummaryView onBack={() => setShowGlobal(false)} />
  }

  return <MappingProjectListPage onShowGlobal={() => setShowGlobal(true)} />
}
