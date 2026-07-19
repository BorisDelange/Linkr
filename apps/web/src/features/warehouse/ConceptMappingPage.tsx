import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { MappingProjectListPage } from './concept-mapping/MappingProjectListPage'
import { MappingProjectPage } from './concept-mapping/MappingProjectPage'
import { GlobalSummaryView } from './concept-mapping/GlobalSummaryView'

type View = 'home' | 'projects' | 'global'

/**
 * The three list-level views (home, projects, cross-project overview) each have
 * their own URL (…/concept-mapping, /projects, /overview) so the browser back
 * button and shared links work. `view` is set by the matched route; the base
 * path is `home`. A specific project (…/concept-mapping/:id) is handled by the
 * base route resolving `mappingProjectId`.
 */
export function ConceptMappingPage({ view = 'home' }: { view?: View }) {
  const { raw } = useResolvedParams()
  const navigate = useNavigate()
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects } = useConceptMappingStore()

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  // The base route also carries a project id (…/concept-mapping/:mappingProjectId).
  // Literal /projects and /overview match their own routes (view prop), so they
  // never reach this branch.
  if (view === 'home' && raw.mappingProjectId) {
    if (!mappingProjectsLoaded) return null
    const mappingProjectId = resolveByIdPrefix(mappingProjects, raw.mappingProjectId, (p) => p.id)?.id
    if (mappingProjectId) {
      return <MappingProjectPage projectId={mappingProjectId} />
    }
  }

  const base = `/workspaces/${raw.wsUid}/warehouse/concept-mapping`

  if (view === 'global') {
    return <GlobalSummaryView onBack={() => navigate(base)} />
  }

  if (view === 'projects') {
    return <MappingProjectListPage onBack={() => navigate(base)} />
  }

  return (
    <MappingProjectListPage
      view="home"
      onShowProjects={() => navigate(`${base}/projects`)}
      onShowGlobal={() => navigate(`${base}/overview`)}
    />
  )
}
