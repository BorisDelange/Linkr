import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams, useParams } from 'react-router'
import JSZip from 'jszip'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getStorage } from '@/lib/storage'
import { buildProjectZip, downloadBlob, slugify, timestamp } from '@/lib/entity-io'
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
import { CreateProjectDialog } from './CreateProjectDialog'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'
import type { Project, IdeFile, Pipeline, Cohort, IdeConnection, Dashboard, DashboardTab, DashboardWidget, DatasetFile, DatasetAnalysis, ReadmeAttachment } from '@/types'

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

  // Import conflict state
  const [importConflict, setImportConflict] = useState<{ name: string; pending: Record<string, unknown> } | null>(null)

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
  const handleExportProject = useCallback(async (projectUid: string) => {
    const result = await buildProjectZip(projectUid, getStorage())
    if (!result) return
    downloadBlob(result.blob, `${slugify(result.projectName)}-${timestamp()}.zip`)
  }, [])

  // --- Duplicate a project (export then re-import as copy) ---
  const handleDuplicateProject = useCallback(async (projectUid: string) => {
    const result = await buildProjectZip(projectUid, getStorage())
    if (!result) return
    // Parse the ZIP we just built, then import as duplicate
    const zip = await JSZip.loadAsync(result.blob)
    const parsed: Record<string, unknown> = {}
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      if (path.startsWith('attachments/')) {
        parsed[path] = await entry.async('arraybuffer')
      } else {
        const content = await entry.async('string')
        try { parsed[path] = JSON.parse(content) } catch { parsed[path] = content }
      }
    }
    await doImport(parsed, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Import ---
  const doImport = useCallback(async (parsed: Record<string, unknown>, duplicate: boolean) => {
    const project = parsed['project.json'] as Project | undefined
    if (!project?.uid) return

    const now = new Date().toISOString()
    const uid = duplicate ? crypto.randomUUID() : project.uid
    const storage = getStorage()

    // Build the project entity
    const projectName = typeof project.name === 'string'
      ? project.name
      : (project.name?.en || Object.values(project.name ?? {})[0] || 'Imported project')
    const entity: Project = {
      ...project,
      uid,
      workspaceId: wsUid ?? activeWorkspaceId ?? project.workspaceId,
      name: duplicate
        ? (typeof project.name === 'string'
          ? `${project.name} (copy)` as unknown as Project['name']
          : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
        : project.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }

    if (!duplicate) {
      // Overwrite: delete old project and children
      await storage.ideFiles.deleteByProject(project.uid).catch(() => {})
      await storage.connections.deleteByProject(project.uid).catch(() => {})
      await storage.readmeAttachments.deleteByProject(project.uid).catch(() => {})
      await storage.datasetFiles.deleteByProject(project.uid).catch(() => {})
      // Delete dashboards + children
      const oldDashboards = await storage.dashboards.getByProject(project.uid)
      for (const d of oldDashboards) {
        const tabs = await storage.dashboardTabs.getByDashboard(d.id)
        for (const tab of tabs) await storage.dashboardWidgets.deleteByTab(tab.id)
        await storage.dashboardTabs.deleteByDashboard(d.id)
        await storage.dashboards.delete(d.id)
      }
      // Delete pipelines
      const oldPipelines = await storage.pipelines.getByProject(project.uid)
      for (const p of oldPipelines) await storage.pipelines.delete(p.id)
      // Delete cohorts
      const oldCohorts = await storage.cohorts.getByProject(project.uid)
      for (const c of oldCohorts) await storage.cohorts.delete(c.id)
      // Delete dataset analyses
      const oldDatasetFiles = await storage.datasetFiles.getByProject(project.uid)
      for (const df of oldDatasetFiles) {
        if (df.type === 'file') await storage.datasetAnalyses.deleteByDataset(df.id).catch(() => {})
      }
      await storage.projects.delete(project.uid).catch(() => {})
    }

    // Create project
    await storage.projects.create(entity)

    // Helper to remap IDs when duplicating
    const idMap = new Map<string, string>()
    const mapId = (oldId: string): string => {
      if (!duplicate) return oldId
      if (!idMap.has(oldId)) idMap.set(oldId, crypto.randomUUID())
      return idMap.get(oldId)!
    }

    // IDE files
    const ideFiles = (parsed['ide-files.json'] ?? []) as IdeFile[]
    for (const f of ideFiles) {
      await storage.ideFiles.create({
        ...f,
        id: mapId(f.id),
        projectUid: uid,
        parentId: f.parentId ? mapId(f.parentId) : null,
      })
    }

    // Pipelines
    const pipelines = (parsed['pipelines.json'] ?? []) as Pipeline[]
    for (const p of pipelines) {
      await storage.pipelines.create({
        ...p,
        id: mapId(p.id),
        projectUid: uid,
      })
    }

    // Cohorts
    const cohorts = (parsed['cohorts.json'] ?? []) as Cohort[]
    for (const c of cohorts) {
      await storage.cohorts.create({
        ...c,
        id: mapId(c.id),
        projectUid: uid,
      })
    }

    // Connections
    const connections = (parsed['connections.json'] ?? []) as IdeConnection[]
    for (const c of connections) {
      await storage.connections.create({
        ...c,
        id: mapId(c.id),
        projectUid: uid,
      })
    }

    // Dashboards + tabs + widgets
    const dashboards = (parsed['dashboards.json'] ?? []) as Dashboard[]
    const dashboardTabs = (parsed['dashboard-tabs.json'] ?? []) as DashboardTab[]
    const dashboardWidgets = (parsed['dashboard-widgets.json'] ?? []) as DashboardWidget[]
    for (const d of dashboards) {
      await storage.dashboards.create({
        ...d,
        id: mapId(d.id),
        projectUid: uid,
      })
    }
    for (const tab of dashboardTabs) {
      await storage.dashboardTabs.create({
        ...tab,
        id: mapId(tab.id),
        dashboardId: mapId(tab.dashboardId),
      })
    }
    for (const w of dashboardWidgets) {
      await storage.dashboardWidgets.create({
        ...w,
        id: mapId(w.id),
        tabId: mapId(w.tabId),
      })
    }

    // Dataset files + analyses
    const datasetFiles = (parsed['dataset-files.json'] ?? []) as DatasetFile[]
    const datasetAnalyses = (parsed['dataset-analyses.json'] ?? []) as DatasetAnalysis[]
    for (const df of datasetFiles) {
      await storage.datasetFiles.create({
        ...df,
        id: mapId(df.id),
        projectUid: uid,
        parentId: df.parentId ? mapId(df.parentId) : null,
      })
    }
    for (const a of datasetAnalyses) {
      await storage.datasetAnalyses.create({
        ...a,
        id: mapId(a.id),
        datasetFileId: mapId(a.datasetFileId),
      })
    }

    // Readme attachments (metadata + binary blobs)
    const attachmentsMeta = (parsed['readme-attachments.json'] ?? []) as Omit<ReadmeAttachment, 'data'>[]
    for (const meta of attachmentsMeta) {
      const blobKey = `attachments/${meta.id}-${meta.fileName}`
      const blobData = parsed[blobKey]
      if (blobData instanceof ArrayBuffer) {
        await storage.readmeAttachments.create({
          ...meta,
          id: mapId(meta.id),
          projectUid: uid,
          data: blobData,
        } as ReadmeAttachment)
      }
    }

    await loadProjects()
  }, [wsUid, activeWorkspaceId, loadProjects])

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const zip = await JSZip.loadAsync(file)
    const parsed: Record<string, unknown> = {}
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      // Binary files (attachments/)
      if (path.startsWith('attachments/')) {
        parsed[path] = await entry.async('arraybuffer')
      } else {
        const content = await entry.async('string')
        try { parsed[path] = JSON.parse(content) } catch { parsed[path] = content }
      }
    }

    const project = parsed['project.json'] as Project | undefined
    if (!project?.uid) return

    const existing = await getStorage().projects.getById(project.uid)
    if (existing) {
      const existingName = typeof existing.name === 'string' ? existing.name : (existing.name.en || Object.values(existing.name)[0] || '')
      setImportConflict({ name: existingName, pending: parsed })
    } else {
      await doImport(parsed, false)
    }
  }, [doImport])

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
              <Button onClick={() => setDialogOpen(true)} className="mt-4 gap-2">
                <Plus size={16} />
                {t('projects.create')}
              </Button>
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
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleExportProject(project.uid) }}>
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
                              <span className="ml-auto text-[10px] text-muted-foreground">{t('common.server_only')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget({ uid: project.uid, name: project.name }) }}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 size={14} />
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
    </div>
  )
}
