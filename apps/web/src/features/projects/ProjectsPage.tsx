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
import { paths } from '@/lib/paths'
import { buildProjectZip, parseProjectZip, deleteProjectData, importProjectContent } from '@/lib/entity-io'
import type { ParsedProjectZip } from '@/lib/entity-io'
import { Plus, FolderOpen, Search, Upload, MoreHorizontal, Download, GitBranch, Copy, Trash2, Pencil, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
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
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { CreateProjectDialog } from './CreateProjectDialog'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'
import type { Project } from '@/types'

export function ProjectsPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { wsUid } = useResolvedParams()
  const { _projectsRaw, projects, getWorkspaceProjects, openProject, deleteProject, loadProjects } = useAppStore()
  const { activeWorkspaceId } = useWorkspaceStore()
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

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ uid: string; name: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // Import conflict state
  const [importConflict, setImportConflict] = useState<{ name: string; pending: ParsedProjectZip; otherWorkspaceName?: string; gitRemote?: ImportGitRemote } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      setDialogOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Filter projects by workspace if we're inside one
  const displayProjects = wsUid ? getWorkspaceProjects(wsUid) : projects

  const rawByUid = useMemo(() => new Map(_projectsRaw.map((p) => [p.uid, p])), [_projectsRaw])

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
      options: allBadges.map((b) => ({
        value: b.label,
        label: b.label,
        badgeClass: getBadgeClasses(b.color),
        badgeStyle: getBadgeStyle(b.color),
      })),
    },
  ], [t, statusFilter, badgeFilter, allBadges])

  const handleOpenProject = (uid: string, name: string) => {
    openProject(uid, name)
    if (wsUid) {
      navigate(paths.projectSummary(wsUid, uid))
    } else {
      navigate(paths.projectSummary(activeWorkspaceId ?? '', uid))
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteProject(deleteTarget.uid)
    setDeleteTarget(null)
    setDeleteConfirm('')
  }


  // --- Import ---
  const doImport = useCallback(async (parsed: ParsedProjectZip, duplicate: boolean, gitRemote?: ImportGitRemote) => {
    const { project } = parsed
    if (!project?.uid) return

    const now = new Date().toISOString()
    const uid = duplicate ? crypto.randomUUID() : project.uid
    const storage = getStorage()

    // Reconstitute the project's organization (inherited from its workspace at
    // export) before creating the project. Upsert by UUID: created only when
    // absent, so an org already on this instance (or shared by a sibling) is
    // left untouched.
    if (parsed.organization?.id) {
      const existingOrg = await storage.organizations.getById(parsed.organization.id)
      if (!existingOrg) await storage.organizations.create(parsed.organization)
    }

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
      projectId: duplicate ? (project.projectId ? `${project.projectId}-copy` : undefined) : project.projectId,
      workspaceId,
      name: duplicate
        ? (typeof project.name === 'string'
          ? `${project.name} (copy)` as unknown as Project['name']
          : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
        : project.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
      // Imported from a git repo → pre-link its Versioning page to that repo
      // (with the token, if one was supplied at import).
      ...(gitRemote ? { gitRemoteConfig: gitRemote } : {}),
    }

    // Always clean up existing data for the target uid to avoid IDB constraint errors
    await deleteProjectData(storage, uid)
    await storage.projects.delete(uid).catch(() => {})

    await storage.projects.create(entity)

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
  }, [wsUid, activeWorkspaceId, loadProjects])

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
        setImportError(t('projects.import_invalid_zip'))
        return
      }

      const existing = await getStorage().projects.getById(parsed.project.uid)
      if (existing) {
        const existingName = typeof existing.name === 'string' ? existing.name : (existing.name.en || Object.values(existing.name)[0] || '')
        // If the existing project lives in a different workspace, surface which one — the user
        // can't see it from here, so a bare "already exists" is confusing.
        const currentWs = wsUid ?? activeWorkspaceId
        let otherWorkspaceName: string | undefined
        if (existing.workspaceId && existing.workspaceId !== currentWs) {
          const ws = await getStorage().workspaces.getById(existing.workspaceId)
          if (ws) otherWorkspaceName = typeof ws.name === 'string' ? ws.name : (ws.name.en || Object.values(ws.name)[0] || '')
        }
        setImportConflict({ name: existingName, pending: parsed, otherWorkspaceName, gitRemote })
      } else {
        await doImport(parsed, false, gitRemote)
      }
    } catch (err) {
      setImportError(t('projects.import_error', { error: err instanceof Error ? err.message : String(err) }))
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
                  className="relative flex min-h-44 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent/50"
                  onClick={() => handleOpenProject(project.uid, project.name)}
                >
                  <div className="flex flex-1 flex-col px-4 pt-5">
                   <div className="flex flex-1 flex-col justify-center">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                          <FolderOpen size={20} className="text-blue-600 dark:text-blue-400" />
                        </div>
                        <span className="truncate text-sm font-medium text-card-foreground">{project.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusClasses(status)}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
                          {t(`project_settings.status_${status}`)}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
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
                        <TruncatedText text={project.description} className="text-xs text-muted-foreground" />
                      )}
                    </div>
                    <BadgeStrip badges={badges} className="mt-1.5 h-5" />
                   </div>
                    <CardMetaFooter
                      createdById={raw?.createdById}
                      createdBy={raw?.createdBy}
                      createdByDetails={raw?.createdByDetails}
                      createdAt={project.createdAt}
                      updatedAt={project.updatedAt}
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} workspaceId={wsUid} />

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
        existingWorkspaceName={importConflict?.otherWorkspaceName}
        onDuplicate={() => { if (importConflict) doImport(importConflict.pending, true, importConflict.gitRemote); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) doImport(importConflict.pending, false, importConflict.gitRemote); setImportConflict(null) }}
      />

      {/* Import project (ZIP upload or git clone) */}
      <ImportSourceDialog open={importOpen} onOpenChange={setImportOpen} accept=".zip" onImport={handleImportSource} />

      {/* Delete project confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirm('') } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('project_settings.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('project_settings.delete_confirm_description')}</p>
                <p className="text-sm">
                  {t('project_settings.delete_confirm_type')}{' '}
                  <span className="font-semibold text-foreground">{deleteTarget?.name}</span>
                </p>
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={deleteTarget?.name}
                  className="mt-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); setDeleteConfirm('') }}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteConfirm !== deleteTarget?.name}
              className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
              onClick={handleDelete}
            >
              {t('project_settings.delete_project')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  )
}
