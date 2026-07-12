import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useVisitStore } from '@/stores/visit-store'
import { unmountFileSource } from '@/lib/duckdb/engine'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
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
    loadProjectMappings, updateMappingProject,
  } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
    if (!conceptSetsLoaded) loadConceptSets()
  }, [mappingProjectsLoaded, loadMappingProjects, conceptSetsLoaded, loadConceptSets])

  useEffect(() => {
    loadProjectMappings(projectId)
  }, [projectId, loadProjectMappings])

  useEffect(() => {
    if (!projectId) return
    const id = setTimeout(() => useVisitStore.getState().recordVisit('mapping-project', projectId), 400)
    return () => clearTimeout(id)
  }, [projectId])

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
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tabs — centered */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="flex justify-center">
          <TabsList className="mt-2 mb-0 w-fit">
            <TabsTrigger value="progress">{t('concept_mapping.tab_progress')}</TabsTrigger>
            <TabsTrigger value="concept-sets">{t('concept_mapping.tab_concept_sets')}</TabsTrigger>
            <TabsTrigger value="editor">{t('concept_mapping.tab_editor')}</TabsTrigger>
            <TabsTrigger value="mappings">{t('concept_mapping.tab_mappings')}</TabsTrigger>
            <TabsTrigger value="export">{t('concept_mapping.tab_export')}</TabsTrigger>
            <TabsTrigger value="versioning">{t('common.versioning')}</TabsTrigger>
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
        <TabsContent value="versioning" className="min-h-0 flex-1 overflow-hidden">
          {activeTab === 'versioning' && (
            <div className="mx-auto flex min-h-0 h-full w-full max-w-3xl flex-col px-6 py-6">
              {/* Git repository link + push-only sync panel. The mapping project
                  has its own Export tab, so no export UI here. */}
              <GitRepositoryTab
                gitRemote={project.gitRemoteConfig ?? null}
                onSave={(cfg) => updateMappingProject(project.id, { gitRemoteConfig: cfg ?? undefined })}
                syncScope="mapping-projects"
                syncId={project.id}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
