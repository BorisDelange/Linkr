import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  ArrowLeft,
  ArrowRightLeft,
  BarChart3,
  ChevronRight,
  Database,
  FileSpreadsheet,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import JSZip from 'jszip'
import { getStorage } from '@/lib/storage'
import { downloadBlob, parseImportZip, slugify, timestamp } from '@/lib/entity-io'
import { buildMappingProjectFolder } from '@/lib/concept-mapping/export'
import { queryDataSource } from '@/lib/duckdb/engine'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { AlertTriangle } from 'lucide-react'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { MAPPING_STATUS_COLORS } from './CreateMappingProjectDialog'
import { ListPageTemplate } from '../ListPageTemplate'
import { CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import type { MappingProject } from '@/types'
import { useState } from 'react'

function getProgress(project: MappingProject) {
  if (!project.stats || project.stats.totalSourceConcepts === 0) return 0
  return Math.round((project.stats.mappedCount / project.stats.totalSourceConcepts) * 100)
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HomeProps {
  view: 'home'
  onShowProjects: () => void
  onShowGlobal: () => void
  onBack?: never
}

interface ProjectsProps {
  view?: never
  onShowProjects?: never
  onShowGlobal?: never
  onBack: () => void
}

type MappingProjectListPageProps = HomeProps | ProjectsProps

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MappingProjectListPage(props: MappingProjectListPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { mappingProjectsLoaded, loadMappingProjects, getWorkspaceProjects, deleteMappingProject } = useConceptMappingStore()
  const loadConceptSets = useConceptMappingStore((s) => s.loadConceptSets)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  const projects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : []
  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? t('concept_mapping.unknown_source')

  type ImportChildren = { mappings: import('@/types').ConceptMapping[] }
  const [conflict, setConflict] = useState<{ name: string; existingId: string; pending: MappingProject; children: ImportChildren } | null>(null)
  const [newIdWarning, setNewIdWarning] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const handleExport = useCallback(async (project: MappingProject) => {
    const zip = new JSZip()
    await buildMappingProjectFolder(zip, '', project, getStorage(), {
      queryDataSource,
      ensureMounted,
      dataSources,
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(project.name)}-${timestamp()}.zip`)
  }, [dataSources, ensureMounted])

  const handleImport = useCallback(async (file: File) => {
    try {
      const parsed = await parseImportZip(file)
      const project = parsed['project.json'] as MappingProject | undefined
      if (!project?.id) {
        setImportError(t('concept_mapping.import_invalid_zip'))
        return
      }
      const mappings = (parsed['mappings.json'] ?? []) as import('@/types').ConceptMapping[]

      // Restore rawFileBuffer from source-concepts.csv in the ZIP (if file-based project)
      // The exported CSV uses normalized column names (terminology, concept_code, concept_name, etc.)
      // so we must update columnMapping and columns to match.
      if (project.sourceType === 'file' && project.fileSourceData) {
        const sourceCsv = parsed['source-concepts.csv']
        if (typeof sourceCsv === 'string' && sourceCsv.length > 0) {
          const encoder = new TextEncoder()
          project.fileSourceData.rawFileBuffer = encoder.encode(sourceCsv)
          // Parse actual CSV header to update columns
          const headerLine = sourceCsv.split('\n')[0]?.trim()
          if (headerLine) {
            const csvColumns = headerLine.split(',')
            project.fileSourceData.columns = csvColumns
            project.fileSourceData.totalRowCount = sourceCsv.split('\n').length - 1
            // Rebuild columnMapping to match the normalized CSV column names
            const normalizedMapping: Record<string, string | undefined> = {
              terminologyColumn: csvColumns.includes('terminology') ? 'terminology' : undefined,
              conceptCodeColumn: csvColumns.includes('concept_code') ? 'concept_code' : undefined,
              conceptIdColumn: csvColumns.includes('concept_id') ? 'concept_id' : undefined,
              conceptNameColumn: csvColumns.includes('concept_name') ? 'concept_name' : undefined,
              domainColumn: csvColumns.includes('domain') ? 'domain' : undefined,
              conceptClassColumn: csvColumns.includes('concept_class') ? 'concept_class' : undefined,
              recordCountColumn: csvColumns.includes('record_count') ? 'record_count' : undefined,
              patientCountColumn: csvColumns.includes('patient_count') ? 'patient_count' : undefined,
              infoJsonColumn: csvColumns.includes('info_json') ? 'info_json' : undefined,
              categoryColumn: csvColumns.includes('category') ? 'category' : undefined,
              subcategoryColumn: csvColumns.includes('subcategory') ? 'subcategory' : undefined,
            }
            // Keep extra columns that are in the CSV but not in the standard roles
            const standardCols = new Set(['terminology', 'concept_code', 'concept_id', 'concept_name',
              'domain', 'concept_class', 'record_count', 'patient_count', 'info_json', 'category', 'subcategory'])
            const extras = csvColumns.filter(c => !standardCols.has(c))
            if (extras.length > 0) normalizedMapping.extraColumns = extras as unknown as string | undefined
            project.fileSourceData.columnMapping = normalizedMapping as typeof project.fileSourceData.columnMapping
          }
        }
      }

      // Check for conflict by entityId or name within the current workspace
      const wsProjects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : []
      const existing = wsProjects.find(p =>
        (project.entityId && p.entityId === project.entityId) || p.name === project.name
      )
      if (existing) {
        setConflict({ name: existing.name, existingId: existing.id, pending: project, children: { mappings } })
      } else {
        await doImport(project, { mappings }, false)
      }
    } catch (err) {
      setImportError(t('concept_mapping.import_error', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [activeWorkspaceId, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const doImport = useCallback(async (project: MappingProject, children: ImportChildren, duplicate: boolean, existingId?: string) => {
    const now = new Date().toISOString()
    // Overwrite: reuse the existing ID after deleting
    if (existingId) {
      await getStorage().conceptMappings.deleteByProject(existingId).catch(() => {})
      await getStorage().mappingProjects.delete(existingId).catch(() => {})
    }
    // Reuse original UUID if available, generate new one if already taken globally
    let projectId: string
    if (existingId) {
      projectId = existingId
    } else {
      const globalExisting = await getStorage().mappingProjects.getById(project.id)
      if (globalExisting) {
        projectId = crypto.randomUUID()
        if (!duplicate) setNewIdWarning(project.name)
      } else {
        projectId = project.id
      }
    }
    const entity: MappingProject = {
      ...project,
      id: projectId,
      workspaceId: activeWorkspaceId ?? project.workspaceId,
      conceptSetIds: project.conceptSetIds ?? [],
      updatedAt: now,
      ...(duplicate ? { name: `${project.name} (copy)`, createdAt: now } : {}),
    }
    await getStorage().mappingProjects.create(entity)
    for (const m of children.mappings) {
      await getStorage().conceptMappings.create({
        ...m,
        id: crypto.randomUUID(),
        projectId,
      })
    }
    await loadMappingProjects()
  }, [activeWorkspaceId, loadMappingProjects])

  // ---------------------------------------------------------------------------
  // Home view — two clickable entry-point widgets
  // ---------------------------------------------------------------------------

  if (props.view === 'home') {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('concept_mapping.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('concept_mapping.description')}</p>
          </div>

          <div className="mt-8 grid grid-cols-2 gap-4">
            {/* Mapping Projects widget — teal */}
            <Card
              className="group relative cursor-pointer overflow-hidden transition-all hover:shadow-lg hover:-translate-y-0.5"
              onClick={props.onShowProjects}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-teal-500/5 to-teal-600/10 opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="relative flex flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                    <ArrowRightLeft size={18} className="text-teal-600" />
                  </div>
                  <p className="text-sm font-semibold">{t('concept_mapping.projects_widget_title')}</p>
                  {projects.length > 0 && (
                    <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
                      {projects.length}
                    </Badge>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('concept_mapping.projects_widget_description')}
                </p>
                <div className="flex items-center gap-1 text-xs font-medium text-teal-600">
                  {t('concept_mapping.projects_widget_open')}
                  <ChevronRight size={13} />
                </div>
              </div>
            </Card>

            {/* Cross-project Overview widget — indigo */}
            <Card
              className="group relative cursor-pointer overflow-hidden transition-all hover:shadow-lg hover:-translate-y-0.5"
              onClick={props.onShowGlobal}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-indigo-600/10 opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="relative flex flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
                    <BarChart3 size={18} className="text-indigo-600" />
                  </div>
                  <p className="text-sm font-semibold">{t('concept_mapping.global_widget_title')}</p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('concept_mapping.global_widget_description')}
                </p>
                <div className="flex items-center gap-1 text-xs font-medium text-indigo-600">
                  {t('concept_mapping.global_widget_open')}
                  <ChevronRight size={13} />
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Projects list sub-view — uses ListPageTemplate (exact same UI as before)
  // ---------------------------------------------------------------------------

  const backButton = (
    <button
      onClick={props.onBack}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft size={13} />
      {t('common.back')}
    </button>
  )

  return (
    <>
      <ImportConflictDialog
        open={!!conflict}
        onOpenChange={(open) => { if (!open) setConflict(null) }}
        existingName={conflict?.name ?? ''}
        onDuplicate={() => { if (conflict) doImport(conflict.pending, conflict.children, true); setConflict(null) }}
        onOverwrite={() => { if (conflict) doImport(conflict.pending, conflict.children, false, conflict.existingId); setConflict(null) }}
      />

      {/* New ID warning */}
      <AlertDialog open={!!newIdWarning} onOpenChange={(open) => { if (!open) setNewIdWarning(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              {t('concept_mapping.import_new_id_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.import_new_id_warning', { name: newIdWarning })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setNewIdWarning(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ListPageTemplate<MappingProject>
        titleKey="concept_mapping.projects_widget_title"
        descriptionKey="concept_mapping.new_project_description"
        newButtonKey="concept_mapping.new_project"
        emptyTitleKey="concept_mapping.no_projects"
        emptyDescriptionKey="concept_mapping.no_projects_description"
        deleteConfirmTitleKey="concept_mapping.delete_confirm_title"
        deleteConfirmDescriptionKey="concept_mapping.delete_confirm_description"
        emptyIcon={ArrowRightLeft}
        items={projects}
        onNavigate={(id) => navigate(id)}
        onDelete={(id) => deleteMappingProject(id)}
        onExport={handleExport}
        onImport={handleImport}
        backAction={backButton}
        renderCardBody={(project) => {
          const progress = getProgress(project)
          return (
            <>
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <ArrowRightLeft size={20} className="text-teal-600" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="truncate text-sm font-medium">{project.name}</span>
                  {project.status && (
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${MAPPING_STATUS_COLORS[project.status].bg} ${MAPPING_STATUS_COLORS[project.status].text}`}>
                      <span className={`size-1.5 rounded-full ${MAPPING_STATUS_COLORS[project.status].dot}`} />
                      {t(`concept_mapping.project_status_${project.status}`)}
                    </span>
                  )}
                  {project.stats && (
                    <Badge variant="secondary" className="text-[10px]">
                      {project.stats.approvedCount}/{project.stats.totalSourceConcepts}
                    </Badge>
                  )}
                </div>
                {project.badges && project.badges.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {project.badges.map((badge) => (
                      <span
                        key={badge.id}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${getBadgeClasses(badge.color)}`}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {project.sourceType === 'file' ? (
                    <>
                      <FileSpreadsheet size={12} />
                      <span>{project.fileSourceData?.fileName ?? t('concept_mapping.source_file')}</span>
                    </>
                  ) : (
                    <>
                      <Database size={12} />
                      <span>{getSourceName(project.dataSourceId)}</span>
                    </>
                  )}
                </div>
                {project.stats && project.stats.totalSourceConcepts > 0 && (
                  <div className="mt-2">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-teal-500 transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
                      <span>{t('concept_mapping.mapped_count', { count: project.stats.mappedCount })}</span>
                      <span>{progress}%</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )
        }}
        renderCreateDialog={({ open, onOpenChange, onCreated }) => (
          <CreateMappingProjectDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
        )}
        renderEditDialog={({ item, onOpenChange }) => (
          <CreateMappingProjectDialog open onOpenChange={onOpenChange} editingProject={item} />
        )}
      />

      {/* Import error dialog */}
      <AlertDialog open={importError !== null} onOpenChange={(open) => { if (!open) setImportError(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common.import_error_title')}</AlertDialogTitle>
            <AlertDialogDescription>{importError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setImportError(null)}>
              {t('common.ok')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
