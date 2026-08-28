import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { GatedButton } from '@/components/ui/gated-button'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useCohortStore } from '@/stores/cohort-store'
import { getStorage } from '@/lib/storage'
import { paths, type SummaryTab } from '@/lib/paths'
import { buildProjectZip, parseProjectZip, deleteProjectData, importProjectContent, sameProjectSlug } from '@/lib/entity-io'
import type { ParsedProjectZip } from '@/lib/entity-io'
import { Plus, FolderOpen, Search, Upload, MoreHorizontal, Download, GitBranch, Copy, Trash2, Pencil, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection, selectedCardClass } from '@/components/ui/use-card-selection'
import { Card } from '@/components/ui/card'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { GitContentStatusBadge } from '@/components/versioning/GitContentStatusBadge'
import { useGitContentStatuses } from '@/components/versioning/use-git-content-statuses'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { applySort, visitSortFields } from '@/lib/list-sort'
import { localized } from '@/lib/localized'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { ImportErrorDialog } from '@/components/ui/import-error-dialog'
import { formatValidationIssues } from '@/lib/import-validation'
import { formatApiError, isServerMode, type FormattedError } from '@/lib/api-client'
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { CreateProjectDialog } from './CreateProjectDialog'
import { getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import type { GitRemoteConfig, LocalizedString, Project } from '@/types'

export function ProjectsPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { wsUid } = useResolvedParams()
  const { _projectsRaw, projects, getWorkspaceProjects, openProject, deleteProject, loadProjects } = useAppStore()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { statuses: contentStatuses, refetch: refetchContentStatuses } = useGitContentStatuses(activeWorkspaceId)
  /** The "content not imported" badge for a project card, or null when it doesn't
   *  apply. Sits in the footer's trailing slot, pinned right of the meta chips. */
  const projectContentBadge = (
    project: { uid: string; name: string | LocalizedString },
    raw: { gitRemoteConfig?: GitRemoteConfig } | undefined,
  ): React.ReactNode => {
    const status = contentStatuses.get(`projects:${project.uid}`)
    if (!activeWorkspaceId || !raw?.gitRemoteConfig?.url || !status) return null
    return (
      <GitContentStatusBadge
        workspaceId={activeWorkspaceId}
        scope="projects"
        type="project"
        id={project.uid}
        name={typeof project.name === 'string' ? project.name : project.uid}
        gitRemote={raw.gitRemoteConfig}
        status={status}
        onResolved={refetchContentStatuses}
      />
    )
  }
  // A project shows its origin org: its own inlined snapshot (imports) when present,
  // else the workspace's org resolved live — same fallback as ListPageTemplate, so a
  // freshly-created project (no inline snapshot) still shows the workspace org.
  const workspaceOrgId = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === s.activeWorkspaceId)?.organizationId,
  )
  const { atLeast: hasWsRole } = useMyWorkspaceRole()
  const canEditWs = hasWsRole('editor')
  const canDeleteWs = hasWsRole('owner')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<{ uid: string; name: string } | null>(null)

  // Import conflict state
  const [importConflict, setImportConflict] = useState<{ name: string; pending: ParsedProjectZip; gitRemote?: ImportGitRemote } | null>(null)
  const [importError, setImportError] = useState<FormattedError | null>(null)
  /** Format issues on a project that DID import — reported, never blocking. */
  const [importWarning, setImportWarning] = useState<FormattedError | null>(null)

  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      setDialogOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const displayProjects = wsUid ? getWorkspaceProjects(wsUid) : projects

  const rawByUid = useMemo(() => new Map(_projectsRaw.map((p) => [p.uid, p])), [_projectsRaw])

  const badgeCategories = useBadgeCategories()

  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of displayProjects) for (const b of rawByUid.get(p.uid)?.badges ?? []) {
      const label = localized(b.label, i18n.language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [displayProjects, rawByUid, i18n.language])

  const filteredProjects = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = displayProjects.filter((p) => {
      if (words.length) {
        const text = `${p.name} ${p.description ?? ''}`.toLowerCase()
        if (!words.every((w) => text.includes(w))) return false
      }
      const raw = rawByUid.get(p.uid)
      if (statusFilter.length && !statusFilter.includes(raw?.status ?? 'active')) return false
      if (badgeFilter.length) {
        const labels = new Set((raw?.badges ?? []).map((b) => localized(b.label, i18n.language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (p) => p.name,
      createdAt: (p) => p.createdAt,
      updatedAt: (p) => p.updatedAt,
      entityType: 'project',
      id: (p) => p.uid,
    })
  }, [displayProjects, searchQuery, statusFilter, badgeFilter, rawByUid, sort, i18n.language])

  const selection = useCardSelection(useMemo(() => filteredProjects.map((p) => p.uid), [filteredProjects]))

  const filterGroups = useMemo<FilterGroup[]>(() => [
    {
      key: 'status',
      label: t('project_settings.status'),
      selected: statusFilter,
      onChange: setStatusFilter,
      options: (['active', 'completed', 'archived', 'draft'] as const).map((s) => ({
        value: s,
        label: t(`project_settings.status_${s}`),
        dotClass: getStatusDotClass(s),
      })),
    },
    {
      key: 'badges',
      label: t('project_settings.badges'),
      selected: badgeFilter,
      onChange: setBadgeFilter,
      options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
    },
  ], [t, statusFilter, badgeFilter, allBadges])

  const handleOpenProject = (uid: string, name: string, tab?: SummaryTab) => {
    openProject(uid, name)
    navigate(paths.projectSummary(wsUid ?? activeWorkspaceId ?? '', uid, tab))
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteProject(deleteTarget.uid)
    setDeleteTarget(null)
  }


  // --- Import ---
  const doImport = useCallback(async (parsed: ParsedProjectZip, duplicate: boolean, gitRemote?: ImportGitRemote) => {
    const { project } = parsed
    // A clean/git export strips `uid` (buildProjectZip), so guard on the project
    // object itself — the uid-minting branch below handles the missing uid. Bailing
    // on `!project.uid` here silently dropped every stripped-export import (the
    // modal just closed with nothing created).
    if (!project) return

    const now = new Date().toISOString()
    const storage = getStorage()

    // Resolve the target uid. A duplicate always gets a fresh one. A plain import
    // keeps the ZIP's uid so a git round-trip and a workspace-scoped overwrite line
    // up — EXCEPT when that uid already belongs to a project in ANOTHER workspace:
    // importing here is meant to be an independent copy, and reusing the uid would
    // make the delete-then-create below wipe that other workspace's project (silent
    // cross-workspace data loss). In that case mint a fresh uid, keeping lineageId.
    // (Mirrors the global-collision guard in MappingProjectListPage.)
    let uid: string
    if (duplicate) {
      uid = crypto.randomUUID()
    } else if (!project.uid) {
      // A clean/git export strips uid (buildProjectZip). Overwrite must still
      // target the matching project (by lineageId, or by the permanent projectId
      // — a git-pointer import has no lineageId), else "Overwrite" would mint a
      // fresh uid and CREATE A COPY next to the existing one. Mint only when the
      // project genuinely isn't here yet.
      const currentWs = wsUid ?? activeWorkspaceId
      const match = useAppStore.getState()._projectsRaw.find((p) =>
        p.workspaceId === currentWs
        && ((project.lineageId && p.lineageId === project.lineageId)
          || sameProjectSlug(p, project)))
      uid = match?.uid ?? crypto.randomUUID()
    } else {
      const currentWs = wsUid ?? activeWorkspaceId
      const globalExisting = useAppStore.getState()._projectsRaw.find((p) => p.uid === project.uid)
      uid = globalExisting && globalExisting.workspaceId !== currentWs ? crypto.randomUUID() : project.uid
    }

    // The project's organization travels inline (project.organization) as an
    // immutable provenance snapshot — like the author snapshot. We do NOT create
    // a local org entity from it (the live org link belongs to the workspace,
    // not the project); the snapshot rides along on the project record, kept for
    // the catalog and the author/org hover.

    // Resolve to a workspace that exists on the target backend. In server mode the project
    // row carries a FK to workspaces; a workspaceId from the imported ZIP that doesn't exist
    // here fails the insert (500), and every sub-entity create then 404s ("Project not found").
    const existingWorkspaces = useWorkspaceStore.getState()._workspacesRaw
    const workspaceExists = (id: string | null | undefined): boolean =>
      !!id && existingWorkspaces.some((w) => w.id === id)
    const workspaceId =
      [wsUid, activeWorkspaceId, project.workspaceId].find(workspaceExists)
      ?? existingWorkspaces[0]?.id
      ?? undefined

    const entity: Project = {
      ...project,
      uid,
      // An imported ZIP carries the original author's display snapshot
      // (createdBy/createdByDetails) but no meaningful local id — in server mode
      // the backend re-resolves createdById by ORCID/email; here we just make
      // sure a stray foreign id never lands verbatim.
      createdById: undefined,
      ...(() => {
        // Both slug names carry the same value; a duplicate suffixes it so the two
        // rows stay tellable apart in exports and URLs.
        const slug = project.entityId ?? project.projectId
        const next = duplicate ? (slug ? `${slug}-copy` : undefined) : slug
        return { entityId: next, projectId: next }
      })(),
      workspaceId,
      name: duplicate
        ? (typeof project.name === 'string'
          ? `${project.name} (copy)` as unknown as Project['name']
          : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
        : project.name,
      updatedAt: now,
      // Export strips instance fields (createdAt/updatedAt); re-stamp on import so
      // consumers that split() createdAt don't crash. A duplicate always gets a fresh date.
      createdAt: duplicate ? now : (project.createdAt ?? now),
      // Lineage: a duplicate is a fork — mint a fresh lineageId and record the
      // source in parentLineageId. A plain import is the *same work*, so keep the
      // ZIP's lineageId verbatim (mint one only if a legacy export lacked it).
      ...(duplicate
        ? { lineageId: crypto.randomUUID(), parentLineageId: project.lineageId }
        : { lineageId: project.lineageId ?? crypto.randomUUID() }),
      // Imported from a git repo → pre-link its Versioning page to that repo
      // (with the token, if one was supplied at import). syncedOid is transient:
      // it anchors sync state below and must not be stored, or the next export
      // writes a stale commit id into the repo's own entity.json.
      ...(gitRemote
        ? { gitRemoteConfig: { url: gitRemote.url, branch: gitRemote.branch, authToken: gitRemote.authToken } }
        : {}),
    }

    // Always clean up existing data for the target uid to avoid IDB constraint errors
    await deleteProjectData(storage, uid)
    await storage.projects.delete(uid).catch(() => {})

    await storage.projects.create(entity)

    // Anchor sync state to the commit we cloned, like every other git-imported
    // entity: it is the base this instance imported from, so a later push
    // elsewhere reads as "behind". Best-effort — a failure just means no banner.
    if (gitRemote?.syncedOid) {
      try {
        const { gitSetSyncState } = await import('@/lib/api/git')
        await gitSetSyncState('projects', uid, gitRemote.branch, gitRemote.syncedOid)
      } catch { /* leave unanchored — lazy adoption may still catch a clean sync */ }
    }

    // Write all sub-entities (child ids remapped to fresh UUIDs to avoid collisions).
    await importProjectContent(parsed, uid, storage)

    // Invalidate in-memory caches so stores reload from IDB on next project open
    useDashboardStore.setState({ activeProjectUid: null, loaded: false })
    useDatasetStore.setState({ activeProjectUid: null })
    useFileStore.setState({ activeProjectUid: null })

    // Reload global stores (pipelines, cohorts) instead of invalidating their loaded flags,
    // because App.tsx gates rendering on those flags being true.
    await usePipelineStore.getState().loadPipelines()
    await useCohortStore.getState().loadCohorts()

    await loadProjects()

    // A manual import over a badged git-pointer resolves its "content not
    // imported" status (advisory — best effort on both backends).
    if (workspaceId) {
      if (isServerMode()) {
        const { gitClearContentStatus } = await import('@/lib/api/git')
        await gitClearContentStatus(workspaceId, 'projects', uid).catch(() => {})
      } else {
        const { setLocalGitContentStatus } = await import('@/components/versioning/use-git-content-statuses')
        setLocalGitContentStatus(workspaceId, 'projects', uid, null)
      }
      await refetchContentStatuses()
    }

    // The project is in; this only reports what is off about it. A duplicate is
    // exempt: its source was just exported by this app, so any issue is one the
    // user already saw on the original.
    if (!duplicate && parsed.validation?.length) {
      setImportWarning(formatValidationIssues(parsed.validation, t))
    }
  }, [wsUid, activeWorkspaceId, loadProjects, refetchContentStatuses, t])

  // --- Duplicate a project (export then re-import as copy) ---
  const handleDuplicateProject = useCallback(async (projectUid: string) => {
    const result = await buildProjectZip(projectUid, getStorage())
    if (!result) return
    const parsed = await parseProjectZip(new File([result.blob], 'dup.zip'))
    if (!parsed) return
    await doImport(parsed, true)
  }, [doImport])

  const handleImportSource = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    try {
      const parsed = await parseProjectZip(file)
      if (!parsed) {
        setImportError({ summary: t('projects.import_invalid_zip'), detail: null })
        return
      }

      // A conflict is "the same work already here" — same lineageId, same
      // permanent projectId (a clean/git export strips uid, and a git-pointer
      // project imported from a workspace ZIP has no lineageId — projectId is the
      // identity that survives both), or same uid — *within the target workspace*.
      // The same project living in another workspace is fine: importing it here
      // is a legitimate, independent copy, so we don't warn about it anymore.
      const currentWs = wsUid ?? activeWorkspaceId
      const all = useAppStore.getState()._projectsRaw
      const existing = all.find((p) =>
        p.workspaceId === currentWs
        && ((parsed.project.lineageId && p.lineageId === parsed.project.lineageId)
          || sameProjectSlug(p, parsed.project)
          || p.uid === parsed.project.uid))
      if (existing) {
        const existingName = typeof existing.name === 'string' ? existing.name : (existing.name.en || Object.values(existing.name)[0] || '')
        setImportConflict({ name: existingName, pending: parsed, gitRemote })
      } else {
        await doImport(parsed, false, gitRemote)
      }
    } catch (err) {
      setImportError(formatApiError(err))
    }
  }, [doImport, t, wsUid, activeWorkspaceId])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('projects.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('projects.description')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selection.active ? (
              <BulkDeleteAction
                selection={selection}
                canDelete={canDeleteWs}
                names={(uid) => filteredProjects.find((p) => p.uid === uid)?.name ?? uid}
                onDeleteMany={async (uids) => { for (const uid of uids) await deleteProject(uid) }}
              />
            ) : (
              <>
                <GatedButton
                  allowed={canEditWs}
                  notAllowedReason={t('common.insufficient_permissions')}
                  variant="outline"
                  size="sm"
                  className="gap-1 text-xs"
                  onClick={() => setImportOpen(true)}
                >
                  <Upload size={14} />
                  {t('common.import')}
                </GatedButton>
                <GatedButton allowed={canEditWs} notAllowedReason={t('common.insufficient_permissions')} size="sm" onClick={() => setDialogOpen(true)} className="gap-1 text-xs">
                  <Plus size={14} />
                  {t('projects.create')}
                </GatedButton>
              </>
            )}
          </div>
        </div>

        {displayProjects.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('projects.search_placeholder')}
            filterGroups={filterGroups}
            sort={{ options: visitSortFields(t), value: sort, onChange: setSort }}
          />
        )}

        {displayProjects.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <FolderOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('projects.no_projects')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('projects.no_projects_description')}
              </p>
            </div>
          </Card>
        ) : filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <Search size={32} className="text-muted-foreground/30" />
            <p className="mt-2 text-sm text-muted-foreground">{t('projects.no_results')}</p>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {filteredProjects.map((project) => {
              const raw = _projectsRaw.find((p) => p.uid === project.uid)
              const badges = raw?.badges ?? []
              const status = raw?.status ?? 'active'
              return (
                <Card
                  key={project.uid}
                  className={cn(
                    'relative flex min-h-44 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent',
                    selection.isSelected(project.uid) && selectedCardClass,
                  )}
                  onClick={(e) => {
                    if (selection.onCardClick(e, project.uid)) return
                    handleOpenProject(project.uid, project.name)
                  }}
                >
                  <div className="flex flex-1 flex-col px-4 pt-5">
                   <div className="flex flex-1 flex-col justify-center">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                          <FolderOpen size={20} className="text-blue-600 dark:text-blue-400" />
                        </div>
                        <TruncatedText text={project.name} readOnly className="min-w-0 flex-1 text-sm font-medium text-card-foreground" />
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusClasses(status)}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
                          {t(`project_settings.status_${status}`)}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" className={cardMenuTriggerClass} onClick={(e) => e.stopPropagation()}>
                              <MoreHorizontal size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem disabled={!canEditWs} onClick={(e) => { e.stopPropagation(); const raw = _projectsRaw.find((p) => p.uid === project.uid); if (raw) setEditingProject(raw) }}>
                              <Pencil size={14} />
                              {t('common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); const w = rawByUid.get(project.uid)?.workspaceId ?? wsUid ?? activeWorkspaceId; if (w) navigate(paths.projectVersioning(w, project.uid, 'export')) }}>
                              <Download size={14} />
                              {t('common.export')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); const w = rawByUid.get(project.uid)?.workspaceId ?? wsUid ?? activeWorkspaceId; if (w) navigate(paths.projectVersioning(w, project.uid, 'git')) }}>
                              <GitBranch size={14} />
                              {t('common.versioning')}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!canEditWs} onClick={(e) => { e.stopPropagation(); handleDuplicateProject(project.uid) }}>
                              <Copy size={14} />
                              {t('common.duplicate')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); const w = rawByUid.get(project.uid)?.workspaceId ?? wsUid ?? activeWorkspaceId; if (w) navigate(paths.projectSettings(w, project.uid)) }}>
                              <Settings2 size={14} />
                              {t('nav.settings')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!canDeleteWs}
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget({ uid: project.uid, name: project.name }) }}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 size={14} className="text-destructive" />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <div className="mt-2 h-4">
                      {project.description && (
                        <TruncatedText text={project.description} readOnly className="text-xs text-muted-foreground" />
                      )}
                    </div>
                    <BadgeStrip badges={badges} className="mt-1.5 h-5" />
                   </div>
                    <CardMetaFooter
                      createdById={raw?.createdById}
                      createdBy={raw?.createdBy}
                      createdByDetails={raw?.createdByDetails}
                      organizationId={raw?.organization ? undefined : workspaceOrgId}
                      organization={raw?.organization}
                      createdAt={project.createdAt}
                      updatedAt={project.updatedAt}
                      // Author + date + licence + the badge overflows one row, so
                      // the dates move into the author tooltip.
                      datesInAuthorTooltip={!!projectContentBadge(project, raw)}
                      trailing={projectContentBadge(project, raw)}
                      license={raw?.license}
                      onOpenLicense={() => {
                        openProject(project.uid, localized(project.name, i18n.language))
                        navigate(`${paths.projectSummary(wsUid ?? '', project.uid)}?tab=license`)
                      }}
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={wsUid}
        onCreated={handleOpenProject}
      />

      <CreateProjectDialog
        open={!!editingProject}
        editingProject={editingProject ?? undefined}
        onOpenChange={(open) => { if (!open) setEditingProject(null) }}
        workspaceId={wsUid}
      />

      {/* Import conflict dialog */}
      <ImportConflictDialog
        open={!!importConflict}
        onOpenChange={(open) => { if (!open) setImportConflict(null) }}
        existingName={importConflict?.name ?? ''}
        onDuplicate={() => { if (importConflict) doImport(importConflict.pending, true, importConflict.gitRemote); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) doImport(importConflict.pending, false, importConflict.gitRemote); setImportConflict(null) }}
      />

      {/* Import project (ZIP upload, git clone, or catalog install) */}
      <ImportSourceDialog open={importOpen} onOpenChange={setImportOpen} accept=".zip" onImport={handleImportSource} scope="projects" />

      {/* Delete project confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('project_settings.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('project_settings.delete_confirm_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t('project_settings.delete_project')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import error dialog */}
      <ImportErrorDialog error={importError} onClose={() => setImportError(null)} />
      <ImportErrorDialog
        error={importWarning}
        onClose={() => setImportWarning(null)}
        title={t('projects.import_validation_title')}
        variant="warning"
      />
    </div>
  )
}
