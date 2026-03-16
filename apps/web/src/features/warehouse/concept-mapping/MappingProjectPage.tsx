import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, FileSpreadsheet, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { ConceptSetsTab } from './ConceptSetsTab'
import { MappingEditorTab } from './MappingEditorTab'
import { MappingsTab } from './MappingsTab'
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
  const isFileSource = project?.sourceType === 'file'
  const dataSource = project && !isFileSource ? dataSources.find((ds) => ds.id === project.dataSourceId) : undefined

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
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/workspaces/${wsUid}/warehouse/concept-mapping`)}>
          <ArrowLeft size={16} />
        </Button>
        <span className="truncate text-sm font-semibold">{project.name}</span>
        {isFileSource && project.fileSourceData && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <FileSpreadsheet size={12} />
            {project.fileSourceData.fileName}
            <span className="text-[10px]">
              ({project.fileSourceData.rows.length.toLocaleString()} {t('concept_mapping.file_rows')})
            </span>
          </span>
        )}
        {!isFileSource && dataSource && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Database size={12} />
            {dataSource.name}{dataSource.schemaMapping?.presetLabel ? ` (${dataSource.schemaMapping.presetLabel})` : ''}
          </span>
        )}
      </div>

      {/* Tabs — centered */}
      <Tabs defaultValue="editor" className="flex flex-1 flex-col overflow-hidden">
        <div className="flex justify-center">
          <TabsList className="mt-2 mb-0 w-fit">
            <TabsTrigger value="concept-sets">{t('concept_mapping.tab_concept_sets')}</TabsTrigger>
            <TabsTrigger value="editor">{t('concept_mapping.tab_editor')}</TabsTrigger>
            <TabsTrigger value="mappings">{t('concept_mapping.tab_mappings')}</TabsTrigger>
            <TabsTrigger value="progress">{t('concept_mapping.tab_progress')}</TabsTrigger>
            <TabsTrigger value="export">{t('concept_mapping.tab_export')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="concept-sets" className="flex-1 overflow-hidden">
          <ConceptSetsTab project={project} dataSource={dataSource} />
        </TabsContent>
        <TabsContent value="editor" className="flex-1 overflow-hidden">
          <MappingEditorTab project={project} dataSource={dataSource} />
        </TabsContent>
        <TabsContent value="mappings" className="flex-1 overflow-hidden">
          <MappingsTab project={project} />
        </TabsContent>
        <TabsContent value="progress" className="flex-1 overflow-hidden">
          <ProgressTab project={project} dataSource={dataSource} />
        </TabsContent>
        <TabsContent value="export" className="flex-1 overflow-hidden">
          <ExportTab project={project} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
