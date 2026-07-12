import { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { localized } from '@/lib/localized'
import { FileSpreadsheet, Database, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { unmountFileSource } from '@/lib/duckdb/engine'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { MAPPING_STATUS_COLORS, CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import { ConceptSetsTab } from './ConceptSetsTab'
import { MappingEditorTab } from './MappingEditorTab'
import { MappingsTab } from './MappingsTab'
import { ProgressTab } from './ProgressTab'
import { ExportTab } from './ExportTab'

interface MappingProjectPageProps {
  projectId: string
}

export function MappingProjectPage({ projectId }: MappingProjectPageProps) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') ?? 'progress'
  const setActiveTab = (value: string) => {
    setSearchParams((prev) => {
      if (value === 'progress') prev.delete('tab')
      else prev.set('tab', value)
      return prev
    })
  }
  // Once the editor has been opened at least once, keep its component mounted so
  // its (expensive) source-concepts query and DuckDB cache survive tab switches.
  // The other tabs stay lazy — their store subscriptions are too heavy to leave
  // running in the background.
  const editorEverOpened = useRef(false)
  useEffect(() => {
    if (activeTab === 'editor') editorEverOpened.current = true
  }, [activeTab])
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

  // Free DuckDB memory when leaving the project. The CSV file source can hold ~200 MB
  // of in-memory tables — releasing it lets the user open another large project without
  // accumulating heap pressure.
  useEffect(() => {
    return () => {
      void unmountFileSource(projectId).catch(() => {})
    }
  }, [projectId])

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
    <>
    <CreateMappingProjectDialog
      open={editDialogOpen}
      onOpenChange={setEditDialogOpen}
      editingProject={project}
    />
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        {project.status && (
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${MAPPING_STATUS_COLORS[project.status].bg} ${MAPPING_STATUS_COLORS[project.status].text}`}>
            <span className={`size-1.5 rounded-full ${MAPPING_STATUS_COLORS[project.status].dot}`} />
            {t(`concept_mapping.project_status_${project.status}`)}
          </span>
        )}
        {project.badges && project.badges.map((badge) => (
          <span
            key={badge.id}
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${getBadgeClasses(badge.color)}`}
            style={getBadgeStyle(badge.color)}
          >
            {badge.label}
          </span>
        ))}
        {isFileSource && project.fileSourceData && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <FileSpreadsheet size={12} />
            {project.fileSourceData.fileName}
            <span className="text-[10px]">
              ({(project.fileSourceData.totalRowCount ?? project.fileSourceData.rows.length).toLocaleString()} {t('concept_mapping.file_rows')})
            </span>
          </span>
        )}
        {!isFileSource && dataSource && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Database size={12} />
            {dataSource.name}{dataSource.schemaMapping?.presetLabel ? ` (${localized(dataSource.schemaMapping.presetLabel, i18n.language)})` : ''}
          </span>
        )}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!canWrite} onClick={() => setEditDialogOpen(true)}>
              <Settings2 size={15} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.edit_project')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Tabs — centered */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="flex justify-center">
          <TabsList className="mt-2 mb-0 w-fit">
            <TabsTrigger value="progress">{t('concept_mapping.tab_progress')}</TabsTrigger>
            <TabsTrigger value="concept-sets">{t('concept_mapping.tab_concept_sets')}</TabsTrigger>
            <TabsTrigger value="editor">{t('concept_mapping.tab_editor')}</TabsTrigger>
            <TabsTrigger value="mappings">{t('concept_mapping.tab_mappings')}</TabsTrigger>
            <TabsTrigger value="export">{t('concept_mapping.tab_export')}</TabsTrigger>
          </TabsList>
        </div>
        {/* Render only the active tab — except the editor, which is kept mounted
            once first opened so the source-concepts table (a multi-second DuckDB
            query for large projects) doesn't reload on every tab switch. The
            other tabs stay lazy because their subscriptions to the mappings
            store would otherwise stall the UI on every vote. */}
        <TabsContent value="progress" className="flex-1 overflow-hidden">
          {activeTab === 'progress' && <ProgressTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="concept-sets" className="flex-1 overflow-hidden">
          {activeTab === 'concept-sets' && <ConceptSetsTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="editor" forceMount className={`flex-1 overflow-hidden ${activeTab === 'editor' ? '' : 'hidden'}`}>
          {/* eslint-disable-next-line react-hooks/refs -- monotonic "sticky mount" latch: once true it never flips back, and it is set in an activeTab effect that already re-renders this component, so reading it here keeps the editor mounted without going stale */}
          {(activeTab === 'editor' || editorEverOpened.current) && (
            <MappingEditorTab project={project} dataSource={dataSource} onGoToConceptSets={() => setActiveTab('concept-sets')} />
          )}
        </TabsContent>
        <TabsContent value="mappings" className="flex-1 overflow-hidden">
          {activeTab === 'mappings' && <MappingsTab project={project} dataSource={dataSource} />}
        </TabsContent>
        <TabsContent value="export" className="flex-1 overflow-hidden">
          {activeTab === 'export' && <ExportTab project={project} dataSource={dataSource} />}
        </TabsContent>
      </Tabs>
    </div>
    </>
  )
}
