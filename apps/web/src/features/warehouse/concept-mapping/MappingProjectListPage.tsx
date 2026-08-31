import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import {
  ArrowLeft,
  ArrowRightLeft,
  BarChart3,
  ChevronRight,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ListPageToolbar, type FilterGroup } from '@/components/ui/list-page-toolbar'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { applySort, visitSortFields } from '@/lib/list-sort'
import { usePersistedSort } from '@/lib/use-persisted-sort'
import { getStorage } from '@/lib/storage'
import { parseImportZip, readBinaryFromImportZip, readImportedManifest } from '@/lib/entity-io'
import { withEntityDocs } from '@/lib/entity-docs-pull'
import JSZip from 'jszip'
import { buildMappingProjectFolder, restoreFileSourceDataFromCsv } from '@/lib/concept-mapping/export'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { ImportErrorDialog } from '@/components/ui/import-error-dialog'
import { formatApiError, type FormattedError } from '@/lib/api-client'
import { TruncatedText } from '@/components/ui/truncated-text'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { MAPPING_STATUS_COLORS } from './CreateMappingProjectDialog'
import { ListPageTemplate } from '../ListPageTemplate'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import { useMappingProjectActions } from './use-mapping-project-actions'
import type { MappingProject, MappingProjectStatus } from '@/types'
import { getTotalSourceConcepts, readsFromFlatSource } from '@/lib/concept-mapping/mapping-status'
import { useState } from 'react'

const ALL_STATUSES: MappingProjectStatus[] = ['in_progress', 'on_hold', 'completed']

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
  const { t, i18n } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  // Absolute concept-mapping base: the list renders at BOTH /concept-mapping (home)
  // and /concept-mapping/projects, so a relative navigate(id) would land at the
  // wrong depth. Build the project path from the base explicitly.
  const { wsUid } = useParams()
  const cmBase = `/workspaces/${wsUid}/warehouse/concept-mapping`
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { mappingProjectsLoaded, loadMappingProjects, getWorkspaceProjects } = useConceptMappingStore()
  // Subscribe to the mappingProjects slice itself so the list re-renders after an
  // import/create refresh — reading only getWorkspaceProjects (a stable fn) left
  // the widgets stale until a full reload.
  const allMappingProjects = useConceptMappingStore((s) => s.mappingProjects)
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
  // Search + filter state (only used in the projects list sub-view)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [sort, setSort] = usePersistedSort('mapping-projects')

  // All distinct custom badges across the workspace's projects, keeping the first-seen
  // colour per label so the filter options match the badges shown on the cards.
  const badgeCategories = useBadgeCategories()
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of projects) for (const b of p.badges ?? []) {
      const label = localized(b.label, language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [projects, language])

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = projects.filter((p) => {
      if (q && !(`${localized(p.name, language)} ${localized(p.description, language)}`.toLowerCase().includes(q))) return false
      if (statusFilter.length > 0 && (!p.status || !statusFilter.includes(p.status))) return false
      if (badgeFilter.length > 0) {
        const labels = new Set((p.badges ?? []).map((b) => localized(b.label, language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (p) => localized(p.name, language),
      createdAt: (p) => p.createdAt,
      updatedAt: (p) => p.updatedAt,
      entityType: 'mapping-project',
      id: (p) => p.id,
    })
  }, [projects, searchQuery, statusFilter, badgeFilter, sort, language])

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
      options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
    },
  ]

  type ImportChildren = {
    mappings: import('@/types').ConceptMapping[]
    sourceIdRanges?: unknown
    sourceIdEntries?: unknown
    scoresFile?: File
  }
  const [conflict, setConflict] = useState<{ name: string; existingId: string; pending: MappingProject; children: ImportChildren } | null>(null)
  const [importError, setImportError] = useState<FormattedError | null>(null)

  const doImport = useCallback(async (project: MappingProject, children: ImportChildren, duplicate: boolean, existingId?: string) => {
    const now = new Date().toISOString()
    // Overwrite: reuse the existing ID after deleting
    if (existingId) {
      await getStorage().conceptMappings.deleteByProject(existingId).catch(() => {})
      await getStorage().mappingProjects.delete(existingId).catch(() => {})
    }
    // The local id (PK) may need regenerating to avoid a global collision — that's
    // an internal detail, not something to warn about. Cross-instance identity is
    // carried by lineageId, handled below.
    // Exports carry no `id` (it was the writing instance's PK), so anything not
    // landing on a resolved existing row mints its own.
    const projectId = existingId ?? crypto.randomUUID()
    // The cloned HEAD rides in on gitRemoteConfig.syncedOid but must not be
    // persisted — capture it for anchoring, then strip it from the stored config.
    const syncedOid = project.gitRemoteConfig?.syncedOid
    const gitRemoteConfig = project.gitRemoteConfig
      ? { url: project.gitRemoteConfig.url, branch: project.gitRemoteConfig.branch, authToken: project.gitRemoteConfig.authToken }
      : project.gitRemoteConfig
    const entity: MappingProject = {
      ...project,
      gitRemoteConfig,
      id: projectId,
      workspaceId: activeWorkspaceId ?? project.workspaceId,
      conceptSetIds: project.conceptSetIds ?? [],
      // Export strips createdAt (an instance field), so a plain import of a stripped
      // ZIP has none — re-stamp it (server mode NOT-NULL rejects undefined; client
      // mode would persist a record the type says can't exist).
      createdAt: project.createdAt ?? now,
      updatedAt: now,
      ...(duplicate ? { name: setLocalized(project.name, language, `${localized(project.name, language)} (copy)`), createdAt: now } : {}),
      // Lineage: overwrite keeps the existing element's identity; a duplicate is a
      // fork (new lineageId + parent → source); a plain import is the same work,
      // so keep the ZIP's lineageId (mint one only for a legacy export lacking it).
      ...(existingId
        ? {}
        : duplicate
          ? { lineageId: crypto.randomUUID(), parentLineageId: project.lineageId }
          : { lineageId: project.lineageId ?? crypto.randomUUID() }),
    }
    // The project row is created first; the mappings + registry follow. Any
    // failure in those later steps must NOT skip the list refresh — the project
    // already exists server-side, so it has to appear without a manual reload.
    try {
      await getStorage().mappingProjects.create(entity)

      // Anchor sync state to the commit we cloned (server mode git import only):
      // it's the base this workspace imported from, so a later push elsewhere is
      // detected as "behind". Best-effort — a failure just means no banner yet.
      if (syncedOid) {
        try {
          const { gitSetSyncState } = await import('@/lib/api/git')
          await gitSetSyncState('mapping-projects', projectId, gitRemoteConfig?.branch ?? 'main', syncedOid)
        } catch { /* leave unanchored — lazy adoption may still catch a clean sync */ }
      }

      const toCreate = children.mappings.map((m) => {
        // Migrate legacy `comment` string → `comments[]` array
        const legacy = (m as unknown as Record<string, unknown>).comment
        const migratedComments = (!m.comments?.length && typeof legacy === 'string' && legacy.trim())
          ? [{ id: crypto.randomUUID(), authorId: m.mappedBy ?? 'unknown', text: legacy.trim(), createdAt: m.mappedOn ?? new Date().toISOString() }]
          : m.comments
        // createdAt rides in from mappings.json — kept, so a round-trip preserves when
        // the mapping was really made. Older exports stripped it: fall back to now.
        return {
          ...m,
          comments: migratedComments,
          id: crypto.randomUUID(),
          projectId,
          createdAt: m.createdAt ?? now,
        }
      })
      if (toCreate.length > 0) await getStorage().conceptMappings.createBatch(toCreate)

      // `stats` rides in on project.json but is DERIVED from the mappings, so an
      // export written with stale counters would keep showing the wrong number
      // here forever (mapping ids are regenerated above — nothing reconciles it
      // later). Recompute from the rows we just wrote.
      const { recomputeImportedStats } = await import('@/lib/concept-mapping/import')
      await recomputeImportedStats(projectId, entity, getStorage())

      // Restore assigned source-concept-ids into the workspace registry (retargeted
      // to this workspace). Best-effort: never let it fail the whole import.
      if (children.sourceIdRanges || children.sourceIdEntries) {
        try {
          const { parseSourceConceptIdEntries } = await import('@/lib/concept-mapping/source-concept-ids-io')
          const ws = entity.workspaceId
          const ranges = (children.sourceIdRanges as Array<Partial<import('@/types').SourceConceptIdRange>> | undefined) ?? []
          // Portable ranges drop timestamps (instance bookkeeping) — re-stamp them
          // so the persisted row is valid.
          for (const r of ranges) await getStorage().sourceConceptIdRanges.save({ ...r, workspaceId: ws, createdAt: r.createdAt ?? now, updatedAt: now } as import('@/types').SourceConceptIdRange)
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
          // importScores persists (server or front-only, with its own validation)
          // AND pushes the fresh index into the scores store, so the editor shows
          // suggestions immediately — a bare persist left the store's cached index
          // stale until a full app reload.
          const { useSuggestionScoresStore } = await import('@/stores/suggestion-scores-store')
          await useSuggestionScoresStore.getState().importScores(projectId, children.scoresFile)
        } catch {
          /* leave the project without scores */
        }
      }
    } finally {
      await loadMappingProjects()
    }
  }, [activeWorkspaceId, loadMappingProjects]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Read a mapping-project ZIP into the project row and its children. Shared by
   *  import and duplicate, which differ only in where the ZIP comes from and
   *  whether the result is written as a copy. */
  const readProjectZip = useCallback(async (file: File): Promise<{ project: MappingProject; children: ImportChildren } | null> => {
    const parsed = await parseImportZip(file)
    const project = readImportedManifest<MappingProject>(parsed, 'project', '_project.json')
    if (!project) return null
    withEntityDocs(project, parsed)
    const mappings = (parsed['mappings.json'] ?? []) as import('@/types').ConceptMapping[]
    // Precomputed suggestion scores (optional, large binary — read as bytes, not
    // via parseImportZip which decodes every entry as text and corrupts parquet).
    // The File's name is inert — importScores binds the parquet to the id it is
    // given, which is only resolved later, in doImport.
    const scoresBuf = await readBinaryFromImportZip(file, 'similarity-scores.parquet')
    const scoresFile = scoresBuf
      ? new File([scoresBuf as BlobPart], 'similarity-scores.parquet', { type: 'application/octet-stream' })
      : undefined
    const children: ImportChildren = {
      mappings,
      sourceIdRanges: parsed['source-concept-ids/ranges.json'],
      sourceIdEntries: parsed['source-concept-ids/entries.json'],
      scoresFile,
    }
    // Restore rawFileBuffer from source-concepts.csv in the ZIP (if file-based
    // project). The file is kept verbatim; duplicate source concepts are dropped
    // (and counted) later, in the DuckDB source_concepts view.
    if (readsFromFlatSource(project) && project.fileSourceData) {
      const sourceCsv = parsed['source-concepts.csv']
      if (typeof sourceCsv === 'string' && sourceCsv.length > 0) {
        restoreFileSourceDataFromCsv(project, sourceCsv)
      }
    }
    return { project, children }
  }, [])

  const handleDuplicate = useCallback(async (source: MappingProject) => {
    const zip = new JSZip()
    await buildMappingProjectFolder(zip, '', source, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    const read = await readProjectZip(new File([blob], 'dup.zip'))
    if (!read) return
    await doImport(read.project, read.children, true)
  }, [readProjectZip, doImport])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    try {
      const read = await readProjectZip(file)
      if (!read) {
        setImportError({ summary: t('concept_mapping.import_invalid_zip'), detail: null })
        return
      }
      const { project, children } = read
      // Imported from a git repo → pre-link the Versioning page to that repo (with
      // the token, if supplied), mirroring project import. buildMappingProjectFolder
      // strips gitRemoteConfig on export, so it's only ever set from the import source.
      if (gitRemote) project.gitRemoteConfig = gitRemote

      // A conflict is "the same work already in THIS workspace" — same lineageId
      // (falling back to entityId for legacy exports). The same mapping project in
      // another workspace is a legitimate independent copy, so we don't flag it.
      const wsProjects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : []
      const existing = wsProjects.find(p =>
        (project.lineageId && p.lineageId === project.lineageId)
        || (project.entityId && p.entityId === project.entityId)
      )
      if (existing) {
        setConflict({ name: localized(existing.name, language), existingId: existing.id, pending: project, children })
      } else {
        await doImport(project, children, false)
      }
    } catch (err) {
      setImportError(formatApiError(err))
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
                    <Badge variant="secondary" className="ml-auto shrink-0">
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
        onNavigate={(id) => navigate(`${cmBase}/${id}`)}
        onDelete={mappingActions.onDelete}
        onDuplicate={handleDuplicate}
        onExportOverride={mappingActions.onExportOverride}
        onVersioningOverride={mappingActions.onVersioningOverride}
        getGitRemote={mappingActions.getGitRemote}
        docs={mappingActions.docs}
        onOpenDocs={(item, tab) => navigate(`${cmBase}/${item.id}?tab=${tab}`)}
        onSaveGitRemote={mappingActions.onSaveGitRemote}
        syncScope="mapping-projects"
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
            sort={{ options: visitSortFields(t), value: sort, onChange: setSort }}
          />
        }
        renderCardBody={(project, actionsMenu) => {
          const progress = getProgress(project)
          const total = getTotalSourceConcepts(project)
          const mapped = project.stats?.mappedCount ?? 0
          const approved = project.stats?.approvedCount ?? 0
          return (
            <div className="min-w-0 flex-1">
                {/* Row 1: icon + title + status pill + actions */}
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                    <ArrowRightLeft size={20} className="text-teal-600" />
                  </div>
                  <TruncatedText text={localized(project.name, language)} readOnly className="min-w-0 flex-1 text-sm font-medium" />
                  {project.status && (
                    <span className={`ml-auto shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${MAPPING_STATUS_COLORS[project.status].bg} ${MAPPING_STATUS_COLORS[project.status].text}`}>
                      <span className={`size-1.5 rounded-full ${MAPPING_STATUS_COLORS[project.status].dot}`} />
                      {t(`concept_mapping.project_status_${project.status}`)}
                    </span>
                  )}
                  <div className={project.status ? 'shrink-0' : 'ml-auto shrink-0'}>{actionsMenu}</div>
                </div>
                {/* Description */}
                <div className="mt-2 h-4">
                  {localized(project.description, language) && (
                    <TruncatedText text={localized(project.description, language)} className="text-xs text-muted-foreground" />
                  )}
                </div>
                {/* The source — database or file — is on the project's Overview,
                    where there is room to name it. On a card competing with the
                    badges and the progress bar it cost a row and said little. */}
                {/* Badges + approved count (right) */}
                <div className="mt-2 flex h-5 items-center gap-1.5">
                  <BadgeStrip badges={project.badges ?? []} className="min-w-0 flex-1" />
                  {mapped > 0 && (
                    <span className="ml-auto shrink-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      {t('concept_mapping.card_approved_label', { approved, total: mapped })}
                    </span>
                  )}
                </div>
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
          )
        }}
        renderCreateDialog={({ open, onOpenChange, onCreated }) => (
          <CreateMappingProjectDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
        )}
        renderEditDialog={mappingActions.renderEditDialog}
      />

      {/* Import error dialog */}
      <ImportErrorDialog error={importError} onClose={() => setImportError(null)} />
    </>
  )
}
