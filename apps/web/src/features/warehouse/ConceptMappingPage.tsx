import { useEffect, useState } from 'react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { MappingProjectListPage } from './concept-mapping/MappingProjectListPage'
import { MappingProjectPage } from './concept-mapping/MappingProjectPage'
import { GlobalSummaryView } from './concept-mapping/GlobalSummaryView'

type View = 'home' | 'projects' | 'global'

export function ConceptMappingPage() {
  const { raw } = useResolvedParams()
  const [view, setView] = useState<View>('home')
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects } = useConceptMappingStore()

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  if (raw.mappingProjectId) {
    if (!mappingProjectsLoaded) return null
    const mappingProjectId = resolveByIdPrefix(mappingProjects, raw.mappingProjectId, (p) => p.id)?.id
    if (mappingProjectId) {
      return <MappingProjectPage projectId={mappingProjectId} />
    }
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
