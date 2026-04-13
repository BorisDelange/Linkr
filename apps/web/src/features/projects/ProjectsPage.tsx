import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams, useParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useCohortStore } from '@/stores/cohort-store'
import { getStorage } from '@/lib/storage'
import { buildProjectZip, parseProjectZip, downloadBlob, slugify, timestamp, deleteProjectData } from '@/lib/entity-io'
import type { ParsedProjectZip } from '@/lib/entity-io'
import { Plus, FolderOpen, Search, Upload, MoreHorizontal, Download, Copy, History, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import { ExportDialog } from '@/components/ui/export-dialog'
import { CreateProjectDialog } from './CreateProjectDialog'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'
import type { Project, ReadmeAttachment } from '@/types'

export function ProjectsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { wsUid } = useParams()
  const { _projectsRaw, projects, getWorkspaceProjects, openProject, deleteProject, loadProjects } = useAppStore()
  const { activeWorkspaceId } = useWorkspaceStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ uid: string; name: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // Export dialog state
  const [exportTarget, setExportTarget] = useState<string | null>(null)

  // Import conflict state
  const [importConflict, setImportConflict] = useState<{ name: string; pending: ParsedProjectZip } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      setDialogOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Filter projects by workspace if we're inside one
  const displayProjects = wsUid ? getWorkspaceProjects(wsUid) : projects

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return displayProjects
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return displayProjects.filter((p) => {
      const text = `${p.name} ${p.description ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }, [displayProjects, searchQuery])

  const handleOpenProject = (uid: string, name: string) => {
    openProject(uid, name)
    if (wsUid) {
      navigate(`/workspaces/${wsUid}/projects/${uid}/summary`)
    } else {
      navigate(`/workspaces/${activeWorkspaceId}/projects/${uid}/summary`)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteProject(deleteTarget.uid)
    setDeleteTarget(null)
    setDeleteConfirm('')
  }

  // --- Export a single project ---
  const handleExportProject = useCallback(async (options: { includeDataFiles: boolean }) => {
    if (!exportTarget) return
    const result = await buildProjectZip(exportTarget, getStorage(), options)
    if (!result) return
    downloadBlob(result.blob, `${slugify(result.projectName)}-${timestamp()}.zip`)
  }, [exportTarget])

  // --- Duplicate a project (export then re-import as copy) ---
  const handleDuplicateProject = useCallback(async (projectUid: string) => {
    const result = await buildProjectZip(projectUid, getStorage())
    if (!result) return
    const parsed = await parseProjectZip(new File([result.blob], 'dup.zip'))
    if (!parsed) return
    await doImport(parsed, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Import ---
  const doImport = useCallback(async (parsed: ParsedProjectZip, duplicate: boolean) => {
    const { project } = parsed
    if (!project?.uid) return

    const now = new Date().toISOString()
    const uid = duplicate ? crypto.randomUUID() : project.uid
    const storage = getStorage()

    const entity: Project = {
      ...project,
      uid,
      projectId: duplicate ? (project.projectId ? `${project.projectId}-copy` : undefined) : project.projectId,
      workspaceId: wsUid ?? activeWorkspaceId ?? project.workspaceId,
      name: duplicate
        ? (typeof project.name === 'string'
          ? `${project.name} (copy)` as unknown as Project['name']
          : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
        : project.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }

    // Always clean up existing data for the target uid to avoid IDB constraint errors
    await deleteProjectData(storage, uid)
    await storage.projects.delete(uid).catch(() => {})

    await storage.projects.create(entity)

    // Always remap sub-entity IDs to fresh UUIDs.  Even when not duplicating
    // the *project* uid, the child IDs (dashboards, tabs, widgets, datasets…)
    // may collide with existing records from other projects — especially when
    // the ZIP was exported from a different instance that used sequential IDs.
    const idMap = new Map<string, string>()
    const mapId = (oldId: string): string => {
      if (!idMap.has(oldId)) idMap.set(oldId, crypto.randomUUID())
      return idMap.get(oldId)!
    }

    for (const f of parsed.ideFiles) {
      await storage.ideFiles.create({ ...f, id: mapId(f.id), projectUid: uid, parentId: f.parentId ? mapId(f.parentId) : null })
    }
    for (const p of parsed.pipelines) {
      await storage.pipelines.create({ ...p, id: mapId(p.id), projectUid: uid })
    }
    for (const c of parsed.cohorts) {
      await storage.cohorts.create({ ...c, id: mapId(c.id), projectUid: uid })
    }
    for (const c of parsed.connections) {
      await storage.connections.create({ ...c, id: mapId(c.id), projectUid: uid })
    }
    for (const d of parsed.dashboards) {
      const filterConfig = (d.filterConfig ?? []).map(f => ({
        ...f,
        id: mapId(f.id),
        datasetFileId: mapId(f.datasetFileId),
        ...(f.scope?.type === 'tabs' ? { scope: { ...f.scope, tabIds: f.scope.tabIds.map(mapId) } } : {}),
        ...(f.scope?.type === 'widgets' ? { scope: { ...f.scope, widgetIds: f.scope.widgetIds.map(mapId) } } : {}),
      }))
      await storage.dashboards.create({
        ...d,
        id: mapId(d.id),
        projectUid: uid,
        filterConfig,
        defaultDatasetFileId: d.defaultDatasetFileId ? mapId(d.defaultDatasetFileId) : d.defaultDatasetFileId,
      })
    }
    for (const tab of parsed.dashboardTabs) {
      await storage.dashboardTabs.create({ ...tab, id: mapId(tab.id), dashboardId: mapId(tab.dashboardId) })
    }
    for (const w of parsed.dashboardWidgets) {
      await storage.dashboardWidgets.create({
        ...w,
        id: mapId(w.id),
        tabId: mapId(w.tabId),
        datasetFileId: w.datasetFileId ? mapId(w.datasetFileId) : w.datasetFileId,
      })
    }
    for (const df of parsed.datasetFiles) {
      await storage.datasetFiles.create({ ...df, id: mapId(df.id), projectUid: uid, parentId: df.parentId ? mapId(df.parentId) : null })
    }
    for (const a of parsed.datasetAnalyses) {
      await storage.datasetAnalyses.create({ ...a, id: mapId(a.id), datasetFileId: mapId(a.datasetFileId) })
    }
    for (const dd of parsed.datasetData) {
      await storage.datasetData.save({ datasetFileId: mapId(dd.datasetFileId), rows: dd.rows })
    }
    for (const meta of parsed.attachmentsMeta) {
      const blobData = parsed.attachmentBlobs.get(meta.id)
      if (blobData) {
        await storage.readmeAttachments.create({
          ...meta, id: mapId(meta.id), projectUid: uid, data: blobData,
        } as ReadmeAttachment)
      }
    }

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

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    try {
      const parsed = await parseProjectZip(file)
      if (!parsed) {
        setImportError(t('projects.import_invalid_zip'))
        return
      }

      const existing = await getStorage().projects.getById(parsed.project.uid)
      if (existing) {
        const existingName = typeof existing.name === 'string' ? existing.name : (existing.name.en || Object.values(existing.name)[0] || '')
        setImportConflict({ name: existingName, pending: parsed })
      } else {
        await doImport(parsed, false)
      }
    } catch (err) {
      setImportError(t('projects.import_error', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [doImport, t])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('projects.title')}
          </h1>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={14} />
              {t('common.import')}
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={handleImportFile}
            />
            <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1 text-xs">
              <Plus size={14} />
              {t('projects.create')}
            </Button>
          </div>
        </div>

        {displayProjects.length > 0 && (
          <div className="relative mt-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('projects.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
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
                  className="relative cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => handleOpenProject(project.uid, project.name)}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <FolderOpen size={16} className="text-primary" />
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
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setExportTarget(project.uid) }}>
                              <Download size={14} />
                              {t('common.export')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDuplicateProject(project.uid) }}>
                              <Copy size={14} />
                              {t('common.duplicate')}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled>
                              <History size={14} />
                              {t('common.history')}
                              <span className="ml-auto inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground leading-none">{t('common.server_only')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
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
                    {project.description && (
                      <p className="mt-2 truncate text-xs text-muted-foreground" title={project.description}>
                        {project.description}
                      </p>
                    )}
                    {badges.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {badges.map((badge) => (
                          <span
                            key={badge.id}
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getBadgeClasses(badge.color)}`}
                            style={getBadgeStyle(badge.color)}
                          >
                            {badge.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} workspaceId={wsUid} />

      {/* Export project dialog */}
      <ExportDialog
        open={exportTarget !== null}
        onOpenChange={(open) => { if (!open) setExportTarget(null) }}
        onExport={handleExportProject}
      />

      {/* Import conflict dialog */}
      <ImportConflictDialog
        open={!!importConflict}
        onOpenChange={(open) => { if (!open) setImportConflict(null) }}
        existingName={importConflict?.name ?? ''}
        onDuplicate={() => { if (importConflict) doImport(importConflict.pending, true); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) doImport(importConflict.pending, false); setImportConflict(null) }}
      />

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
