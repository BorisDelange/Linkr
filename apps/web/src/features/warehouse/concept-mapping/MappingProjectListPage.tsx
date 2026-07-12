import { useCallback, useEffect, useMemo } from 'react'
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
import { ListPageToolbar, type FilterGroup } from '@/components/ui/list-page-toolbar'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { parseImportZip, readBinaryFromImportZip } from '@/lib/entity-io'
import { isServerMode } from '@/lib/api-client'
import { restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
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
import { TruncatedText } from '@/components/ui/truncated-text'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { MAPPING_STATUS_COLORS } from './CreateMappingProjectDialog'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import { useMappingProjectActions } from './use-mapping-project-actions'
import type { MappingProject, MappingProjectStatus } from '@/types'
import { useState } from 'react'

const ALL_STATUSES: MappingProjectStatus[] = ['in_progress', 'on_hold', 'completed']

/** Total source concepts: prefer the persisted stats value, fall back to the
 *  file source row count for file-based projects (already in memory, no query). */
function getTotalSourceConcepts(project: MappingProject): number {
  const fromStats = project.stats?.totalSourceConcepts ?? 0
  if (fromStats > 0) return fromStats
  if (project.sourceType === 'file' && project.fileSourceData) {
    return project.fileSourceData.totalRowCount ?? project.fileSourceData.rows.length ?? 0
  }
  return 0
}

function getProgress(project: MappingProject) {
  const total = getTotalSourceConcepts(project)
  if (total === 0) return 0
  return Math.round(((project.stats?.mappedCount ?? 0) / total) * 100)
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
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { mappingProjectsLoaded, loadMappingProjects, getWorkspaceProjects } = useConceptMappingStore()
  // Subscribe to the mappingProjects slice itself so the list re-renders after an
  // import/create refresh — reading only getWorkspaceProjects (a stable fn) left
  // the widgets stale until a full reload.
  const allMappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const mappingActions = useMappingProjectActions()

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  const projects = useMemo(
    () => (activeWorkspaceId ? allMappingProjects.filter((p) => p.workspaceId === activeWorkspaceId) : []),
    [allMappingProjects, activeWorkspaceId],
  )
  // Stats are persisted in MappingProject.stats and refreshed on every mapping mutation
  // (via createMapping / updateMapping / deleteMapping in the store). No need to recompute
  // them on every list-page mount.
  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? t('concept_mapping.unknown_source')

  // Search + filter state (only used in the projects list sub-view)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])

  // All distinct custom badges across the workspace's projects, keeping the first-seen
  // colour per label so the filter options match the badges shown on the cards.
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of projects) for (const b of p.badges ?? []) if (b.label && !byLabel.has(b.label)) byLabel.set(b.label, b.color)
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [projects])

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return projects.filter((p) => {
      if (q && !(`${localized(p.name, language)} ${localized(p.description, language)}`.toLowerCase().includes(q))) return false
      if (statusFilter.length > 0 && (!p.status || !statusFilter.includes(p.status))) return false
      if (badgeFilter.length > 0) {
        const labels = new Set((p.badges ?? []).map((b) => b.label))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
  }, [projects, searchQuery, statusFilter, badgeFilter, language])

  const filterGroups: FilterGroup[] = [
    {
      key: 'status',
      label: t('concept_mapping.project_status'),
      selected: statusFilter,
      onChange: setStatusFilter,
      options: ALL_STATUSES.map((s) => ({
        value: s,
        label: t(`concept_mapping.project_status_${s}`),
        dotClass: MAPPING_STATUS_COLORS[s].dot,
      })),
    },
    {
      key: 'badges',
      label: t('concept_mapping.project_badges'),
      selected: badgeFilter,
      onChange: setBadgeFilter,
      options: allBadges.map((b) => ({
        value: b.label,
        label: b.label,
        badgeClass: getBadgeClasses(b.color),
        badgeStyle: getBadgeStyle(b.color),
      })),
    },
  ]

  type ImportChildren = {
    mappings: import('@/types').ConceptMapping[]
    sourceIdRanges?: unknown
    sourceIdEntries?: unknown
    scoresFile?: File
  }
  const [conflict, setConflict] = useState<{ name: string; existingId: string; pending: MappingProject; children: ImportChildren } | null>(null)
  const [newIdWarning, setNewIdWarning] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

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
        if (!duplicate) setNewIdWarning(localized(project.name, language))
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
      ...(duplicate ? { name: setLocalized(project.name, language, `${localized(project.name, language)} (copy)`), createdAt: now } : {}),
    }
    // The project row is created first; the mappings + registry follow. Any
    // failure in those later steps must NOT skip the list refresh — the project
    // already exists server-side, so it has to appear without a manual reload.
    try {
      await getStorage().mappingProjects.create(entity)

      const toCreate = children.mappings.map((m) => {
        // Migrate legacy `comment` string → `comments[]` array
        const legacy = (m as unknown as Record<string, unknown>).comment
        const migratedComments = (!m.comments?.length && typeof legacy === 'string' && legacy.trim())
          ? [{ id: crypto.randomUUID(), authorId: m.mappedBy ?? 'unknown', text: legacy.trim(), createdAt: m.mappedOn ?? new Date().toISOString() }]
          : m.comments
        return { ...m, comments: migratedComments, id: crypto.randomUUID(), projectId }
      })
      if (toCreate.length > 0) await getStorage().conceptMappings.createBatch(toCreate)

      // Restore assigned source-concept-ids into the workspace registry (retargeted
      // to this workspace). Best-effort: never let it fail the whole import.
      if (children.sourceIdRanges || children.sourceIdEntries) {
        try {
          const { parseSourceConceptIdEntries } = await import('@/lib/concept-mapping/source-concept-ids-io')
          const ws = entity.workspaceId
          const ranges = (children.sourceIdRanges as import('@/types').SourceConceptIdRange[] | undefined) ?? []
          for (const r of ranges) await getStorage().sourceConceptIdRanges.save({ ...r, workspaceId: ws })
          if (children.sourceIdEntries) {
            const entries = parseSourceConceptIdEntries(
              children.sourceIdEntries as Parameters<typeof parseSourceConceptIdEntries>[0], ws,
            )
            if (entries.length > 0) await getStorage().sourceConceptIdEntries.saveBatch(entries)
          }
        } catch {
          /* leave the registry as-is */
        }
      }

      // Precomputed suggestion scores (best-effort — a failure must not fail the
      // whole import). Server mode validates + indexes the parquet server-side;
      // front-only persists it to OPFS/IDB and builds the index via DuckDB-WASM.
      if (children.scoresFile) {
        try {
          if (isServerMode()) {
            const { persistScoresFileOnServer } = await import('@/lib/api/scores')
            await persistScoresFileOnServer(projectId, children.scoresFile)
          } else {
            const { persistScoresFile } = await import('@/lib/concept-mapping/scores-engine')
            const { validateScoresFile } = await import('@/lib/concept-mapping/scores-parser')
            const validation = await validateScoresFile(children.scoresFile)
            if (validation.ok) await persistScoresFile(projectId, children.scoresFile)
          }
        } catch {
          /* leave the project without scores */
        }
      }
    } finally {
      await loadMappingProjects()
    }
  }, [activeWorkspaceId, loadMappingProjects]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleImport = useCallback(async (file: File) => {
    try {
      const parsed = await parseImportZip(file)
      const project = parsed['project.json'] as MappingProject | undefined
      if (!project?.id) {
        setImportError(t('concept_mapping.import_invalid_zip'))
        return
      }
      const mappings = (parsed['mappings.json'] ?? []) as import('@/types').ConceptMapping[]
      // Precomputed suggestion scores (optional, large binary — read as bytes, not
      // via parseImportZip which decodes every entry as text and corrupts parquet).
      const scoresBuf = await readBinaryFromImportZip(file, 'similarity-scores.parquet')
      const scoresFile = scoresBuf
        ? new File([scoresBuf as BlobPart], `${project.id}.parquet`, { type: 'application/octet-stream' })
        : undefined
      // Assigned source-concept-ids (optional folder — absent in older ZIPs).
      const children: ImportChildren = {
        mappings,
        sourceIdRanges: parsed['source-concept-ids/ranges.json'],
        sourceIdEntries: parsed['source-concept-ids/entries.json'],
        scoresFile,
      }

      // Restore rawFileBuffer from source-concepts.csv in the ZIP (if file-based project)
      if (project.sourceType === 'file' && project.fileSourceData) {
        const sourceCsv = parsed['source-concepts.csv']
        if (typeof sourceCsv === 'string' && sourceCsv.length > 0) {
          restoreFileSourceDataFromCsv(project, sourceCsv)
        }
      }

      // Check for conflict by entityId or name within the current workspace
      const wsProjects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : []
      const existing = wsProjects.find(p =>
        (project.entityId && p.entityId === project.entityId) || localized(p.name, 'en') === localized(project.name, 'en')
      )
      if (existing) {
        setConflict({ name: localized(existing.name, language), existingId: existing.id, pending: project, children })
      } else {
        await doImport(project, children, false)
      }
    } catch (err) {
      setImportError(t('concept_mapping.import_error', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [activeWorkspaceId, t, doImport]) // eslint-disable-line react-hooks/exhaustive-deps

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
        canEdit={atLeast('editor')}
        canDelete={atLeast('owner')}
        titleKey="concept_mapping.projects_widget_title"
        descriptionKey="concept_mapping.new_project_description"
        newButtonKey="concept_mapping.new_project"
        emptyTitleKey="concept_mapping.no_projects"
        emptyDescriptionKey="concept_mapping.no_projects_description"
        emptyIcon={ArrowRightLeft}
        items={filteredProjects}
        onNavigate={(id) => navigate(id)}
        onDelete={mappingActions.onDelete}
        onExportOverride={mappingActions.onExportOverride}
        onVersioningOverride={mappingActions.onVersioningOverride}
        getGitRemote={mappingActions.getGitRemote}
        onSaveGitRemote={mappingActions.onSaveGitRemote}
        exportSupportsIncludeData={mappingActions.exportSupportsIncludeData}
        deleteConfirmTitleKey={mappingActions.deleteConfirmTitleKey}
        deleteConfirmDescriptionKey={mappingActions.deleteConfirmDescriptionKey}
        onImport={handleImport}
        backAction={backButton}
        toolbar={
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('common.search')}
            filterGroups={filterGroups}
          />
        }
        renderCardBody={(project) => {
          const progress = getProgress(project)
          const total = getTotalSourceConcepts(project)
          const mapped = project.stats?.mappedCount ?? 0
          const approved = project.stats?.approvedCount ?? 0
          return (
            <>
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <ArrowRightLeft size={20} className="text-teal-600" />
              </div>
              <div className="min-w-0 flex-1">
                {/* Title row: name + status pill (right) */}
                <div className="flex items-start justify-between gap-3">
                  <span className="truncate text-sm font-medium">{localized(project.name, language)}</span>
                  {project.status && (
                    <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${MAPPING_STATUS_COLORS[project.status].bg} ${MAPPING_STATUS_COLORS[project.status].text}`}>
                      <span className={`size-1.5 rounded-full ${MAPPING_STATUS_COLORS[project.status].dot}`} />
                      {t(`concept_mapping.project_status_${project.status}`)}
                    </span>
                  )}
                </div>
                {/* Source row */}
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {project.sourceType === 'file' ? (
                    <>
                      <FileSpreadsheet size={12} />
                      <span className="truncate">{project.fileSourceData?.fileName ?? t('concept_mapping.source_file')}</span>
                    </>
                  ) : (
                    <>
                      <Database size={12} />
                      <span className="truncate">{getSourceName(project.dataSourceId)}</span>
                    </>
                  )}
                </div>
                {localized(project.description, language) && (
                  <TruncatedText
                    text={localized(project.description, language)}
                    className="mt-0.5 text-xs text-muted-foreground"
                  />
                )}
                {/* Badges + approved count (right) */}
                {((project.badges && project.badges.length > 0) || total > 0) && (
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    {project.badges?.map((badge) => (
                      <span
                        key={badge.id}
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${getBadgeClasses(badge.color)}`}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                      </span>
                    ))}
                    {mapped > 0 && (
                      <span className="ml-auto text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        {t('concept_mapping.card_approved_label', { approved, total: mapped })}
                      </span>
                    )}
                  </div>
                )}
                {/* Progress bar */}
                {total > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{t('concept_mapping.card_progress_label', { mapped, total })}</span>
                      <span className="tabular-nums">{progress}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-muted/60">
                      <div
                        className="h-full rounded bg-teal-500 transition-all"
                        style={{ width: `${progress}%` }}
                      />
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
        renderEditDialog={mappingActions.renderEditDialog}
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
