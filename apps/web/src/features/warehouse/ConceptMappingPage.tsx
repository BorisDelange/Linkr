import { useState } from 'react'
import { useParams } from 'react-router'
import { MappingProjectListPage } from './concept-mapping/MappingProjectListPage'
import { MappingProjectPage } from './concept-mapping/MappingProjectPage'
import { GlobalSummaryView } from './concept-mapping/GlobalSummaryView'

type View = 'home' | 'projects' | 'global'

export function ConceptMappingPage() {
  const { mappingProjectId } = useParams()
  const [view, setView] = useState<View>('home')

  if (mappingProjectId) {
    return <MappingProjectPage projectId={mappingProjectId} />
  }

  if (view === 'global') {
    return <GlobalSummaryView onBack={() => setView('home')} />
  }

  if (view === 'projects') {
    return <MappingProjectListPage onBack={() => setView('home')} />
  }

  return (
    <MappingProjectListPage
      view="home"
      onShowProjects={() => setView('projects')}
      onShowGlobal={() => setView('global')}
    />
  )
}
