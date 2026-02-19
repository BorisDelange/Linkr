import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { ConceptSetsTab } from './ConceptSetsTab'
import { MappingEditorTab } from './MappingEditorTab'
import { ProgressTab } from './ProgressTab'
import { ExportTab } from './ExportTab'

interface MappingProjectPageProps {
  projectId: string
}

export function MappingProjectPage({ projectId }: MappingProjectPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useParams()
  const {
    mappingProjects, mappingProjectsLoaded, loadMappingProjects,
    conceptSetsLoaded, loadConceptSets,
    loadProjectMappings,
  } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
    if (!conceptSetsLoaded) loadConceptSets()
  }, [mappingProjectsLoaded, loadMappingProjects, conceptSetsLoaded, loadConceptSets])

  useEffect(() => {
    loadProjectMappings(projectId)
  }, [projectId, loadProjectMappings])

  const project = mappingProjects.find((p) => p.id === projectId)
  const dataSource = project ? dataSources.find((ds) => ds.id === project.dataSourceId) : undefined

  if (!mappingProjectsLoaded) return null

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concept_mapping.project_not_found')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/workspaces/${wsUid}/warehouse/concept-mapping`)}>
          <ArrowLeft size={16} />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{project.name}</h1>
          {dataSource && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} />
              <span>{dataSource.name}</span>
              {dataSource.schemaMapping?.presetLabel && (
                <Badge variant="outline" className="text-[10px]">
                  {dataSource.schemaMapping.presetLabel}
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="editor" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="mx-4 mt-2 w-fit">
          <TabsTrigger value="concept-sets">{t('concept_mapping.tab_concept_sets')}</TabsTrigger>
          <TabsTrigger value="editor">{t('concept_mapping.tab_editor')}</TabsTrigger>
          <TabsTrigger value="progress">{t('concept_mapping.tab_progress')}</TabsTrigger>
          <TabsTrigger value="export">{t('concept_mapping.tab_export')}</TabsTrigger>
        </TabsList>
        <TabsContent value="concept-sets" className="flex-1 overflow-hidden">
          <ConceptSetsTab project={project} dataSource={dataSource} />
        </TabsContent>
        <TabsContent value="editor" className="flex-1 overflow-hidden">
          <MappingEditorTab project={project} dataSource={dataSource} />
        </TabsContent>
        <TabsContent value="progress" className="flex-1 overflow-hidden">
          <ProgressTab project={project} />
        </TabsContent>
        <TabsContent value="export" className="flex-1 overflow-hidden">
          <ExportTab project={project} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
