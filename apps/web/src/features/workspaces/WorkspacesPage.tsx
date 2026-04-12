import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { useWikiStore } from '@/stores/wiki-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useEtlStore } from '@/stores/etl-store'
import { useDqStore } from '@/stores/dq-store'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { Plus, Building2, Upload, MoreHorizontal, Download, Trash2 } from 'lucide-react'
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
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { parseWorkspaceZip, deleteProjectData } from '@/lib/entity-io'
import type { ParsedWorkspaceZip } from '@/lib/entity-io'
import { getStorage } from '@/lib/storage'
import type { Project, ReadmeAttachment, WikiAttachment } from '@/types'

export function WorkspacesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { workspaces, _workspacesRaw, openWorkspace, deleteWorkspace } = useWorkspaceStore()
  const { getWorkspaceProjects, loadProjects } = useAppStore()
  const { exportZip } = useWorkspaceVersioningStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // Export dialog state
  const [exportTarget, setExportTarget] = useState<string | null>(null)

  // Import conflict state
  const [importConflict, setImportConflict] = useState<{ name: string; pending: ParsedWorkspaceZip } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const handleOpenWorkspace = (id: string, name: string) => {
    openWorkspace(id, name)
    navigate(`/workspaces/${id}/home`)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteWorkspace(deleteTarget.id)
    setDeleteTarget(null)
    setDeleteConfirm('')
  }

  const handleExportWorkspace = useCallback(async (options: { includeDataFiles: boolean }) => {
    if (!exportTarget) return
    await exportZip(exportTarget, { includeDataFiles: options.includeDataFiles })
  }, [exportZip, exportTarget])

  // --- Import logic ---
  const doImport = useCallback(async (parsed: ParsedWorkspaceZip, duplicate: boolean) => {
    const storage = getStorage()
    const now = new Date().toISOString()
    const { appVersion: _av, ...wsMeta } = parsed.workspace
    const targetWsId = duplicate ? crypto.randomUUID() : wsMeta.id

    // Create workspace if it doesn't exist yet, or update if overwriting
    const existingWs = await storage.workspaces.getById(targetWsId)
    if (existingWs && !duplicate) {
      await storage.workspaces.update(targetWsId, { ...wsMeta, updatedAt: now })
    } else {
      await storage.workspaces.create({
        ...wsMeta,
        id: targetWsId,
        name: duplicate
          ? (typeof wsMeta.name === 'string'
            ? `${wsMeta.name} (copy)` as unknown as typeof wsMeta.name
            : Object.fromEntries(Object.entries(wsMeta.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as typeof wsMeta.name)
          : wsMeta.name,
        updatedAt: now,
        ...(duplicate ? { createdAt: now } : {}),
      })
    }

    // --- Import projects ---
    for (const [, parsedProject] of parsed.projects) {
      const { project } = parsedProject
      if (!project?.uid) continue

      const uid = duplicate ? crypto.randomUUID() : project.uid
      const entity: Project = {
        ...project,
        uid,
        projectId: duplicate ? (project.projectId ? `${project.projectId}-copy` : undefined) : project.projectId,
        workspaceId: targetWsId,
        name: duplicate
          ? (typeof project.name === 'string'
            ? `${project.name} (copy)` as unknown as Project['name']
            : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
          : project.name,
        updatedAt: now,
        ...(duplicate ? { createdAt: now } : {}),
      }

      // Clean up existing data
      await deleteProjectData(storage, uid)
      await storage.projects.delete(uid).catch(() => {})

      await storage.projects.create(entity)

      const idMap = new Map<string, string>()
      const mapId = (oldId: string): string => {
        if (!duplicate) return oldId
        if (!idMap.has(oldId)) idMap.set(oldId, crypto.randomUUID())
        return idMap.get(oldId)!
      }

      for (const f of parsedProject.ideFiles) {
        await storage.ideFiles.create({ ...f, id: mapId(f.id), projectUid: uid, parentId: f.parentId ? mapId(f.parentId) : null })
      }
      for (const p of parsedProject.pipelines) {
        await storage.pipelines.create({ ...p, id: mapId(p.id), projectUid: uid })
      }
      for (const c of parsedProject.cohorts) {
        await storage.cohorts.create({ ...c, id: mapId(c.id), projectUid: uid })
      }
      for (const c of parsedProject.connections) {
        await storage.connections.create({ ...c, id: mapId(c.id), projectUid: uid })
      }
      for (const d of parsedProject.dashboards) {
        await storage.dashboards.create({ ...d, id: mapId(d.id), projectUid: uid })
      }
      for (const tab of parsedProject.dashboardTabs) {
        await storage.dashboardTabs.create({ ...tab, id: mapId(tab.id), dashboardId: mapId(tab.dashboardId) })
      }
      for (const w of parsedProject.dashboardWidgets) {
        await storage.dashboardWidgets.create({ ...w, id: mapId(w.id), tabId: mapId(w.tabId) })
      }
      for (const df of parsedProject.datasetFiles) {
        await storage.datasetFiles.create({ ...df, id: mapId(df.id), projectUid: uid, parentId: df.parentId ? mapId(df.parentId) : null })
      }
      for (const a of parsedProject.datasetAnalyses) {
        await storage.datasetAnalyses.create({ ...a, id: mapId(a.id), datasetFileId: mapId(a.datasetFileId) })
      }
      for (const dd of parsedProject.datasetData) {
        await storage.datasetData.save({ datasetFileId: mapId(dd.datasetFileId), rows: dd.rows })
      }
      for (const meta of parsedProject.attachmentsMeta) {
        const blobData = parsedProject.attachmentBlobs.get(meta.id)
        if (blobData) {
          await storage.readmeAttachments.create({
            ...meta, id: mapId(meta.id), projectUid: uid, data: blobData,
          } as ReadmeAttachment)
        }
      }
    }

    // --- Import lightweight project entries (catalog-only) ---
    for (const entry of parsed.projectEntries) {
      const { project } = entry
      if (!project?.uid) continue
      const uid = duplicate ? crypto.randomUUID() : project.uid
      const existing = await storage.projects.getById(uid)
      if (existing && !duplicate) {
        // Update metadata + readme only
        await storage.projects.update(uid, {
          ...project, uid, workspaceId: targetWsId, readme: entry.readme ?? existing.readme, updatedAt: now,
        })
      } else {
        await storage.projects.create({
          ...project, uid, workspaceId: targetWsId,
          name: duplicate
            ? (typeof project.name === 'string'
              ? `${project.name} (copy)` as unknown as Project['name']
              : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
            : project.name,
          readme: entry.readme ?? '',
          updatedAt: now,
          ...(duplicate ? { createdAt: now } : {}),
        })
      }
    }

    // --- Import schema presets ---
    for (const sp of parsed.schemas) {
      const id = duplicate ? crypto.randomUUID() : sp.id
      if (!duplicate) await storage.schemaPresets.delete(sp.id).catch(() => {})
      await storage.schemaPresets.save({ ...sp, id, workspaceId: targetWsId })
    }

    // --- Import databases (metadata only, no credentials/files) ---
    for (const ds of parsed.databases) {
      if (!ds.id) continue
      const id = duplicate ? crypto.randomUUID() : ds.id
      if (!duplicate) {
        const existing = await storage.dataSources.getById(ds.id)
        if (existing) {
          // Update metadata only, keep existing credentials and file refs
          await storage.dataSources.update(ds.id, {
            name: ds.name, description: ds.description, alias: ds.alias,
            schemaMapping: ds.schemaMapping, updatedAt: now,
          })
          continue
        }
      }
      await storage.dataSources.create({
        ...ds,
        id,
        workspaceId: targetWsId,
        status: 'disconnected',
        createdAt: now,
        updatedAt: now,
      } as import('@/types').DataSource)
    }

    // --- Import wiki pages ---
    if (parsed.wikiPages.length > 0) {
      if (!duplicate) {
        await storage.wikiAttachments.deleteByWorkspace(targetWsId).catch(() => {})
        await storage.wikiPages.deleteByWorkspace(targetWsId).catch(() => {})
      }
      const wikiIdMap = new Map<string, string>()
      const mapWikiId = (oldId: string): string => {
        if (!duplicate) return oldId
        if (!wikiIdMap.has(oldId)) wikiIdMap.set(oldId, crypto.randomUUID())
        return wikiIdMap.get(oldId)!
      }
      for (const page of parsed.wikiPages) {
        await storage.wikiPages.create({
          ...page,
          id: mapWikiId(page.id),
          workspaceId: targetWsId,
          parentId: page.parentId ? mapWikiId(page.parentId) : null,
          updatedAt: now,
        })
      }
      for (const meta of parsed.wikiAttachmentsMeta) {
        const blobData = parsed.wikiAttachmentBlobs.get(meta.id)
        if (blobData) {
          await storage.wikiAttachments.create({
            ...meta,
            id: duplicate ? crypto.randomUUID() : meta.id,
            pageId: mapWikiId(meta.pageId),
            workspaceId: targetWsId,
            data: blobData,
          } as WikiAttachment)
        }
      }
    }

    // --- Import SQL script collections ---
    for (const { collection, files } of parsed.sqlCollections) {
      const id = duplicate ? crypto.randomUUID() : collection.id
      if (!duplicate) {
        await storage.sqlScriptFiles.deleteByCollection(collection.id).catch(() => {})
        await storage.sqlScriptCollections.delete(collection.id).catch(() => {})
      }
      await storage.sqlScriptCollections.create({
        ...collection, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${collection.name} (copy)`, createdAt: now } : {}),
      })
      const fileIdMap = new Map<string, string>()
      const mapFileId = (oldId: string): string => {
        if (!duplicate) return oldId
        if (!fileIdMap.has(oldId)) fileIdMap.set(oldId, crypto.randomUUID())
        return fileIdMap.get(oldId)!
      }
      for (const f of files) {
        await storage.sqlScriptFiles.create({
          ...f, id: mapFileId(f.id), collectionId: id,
          parentId: f.parentId ? mapFileId(f.parentId) : null,
        })
      }
    }

    // --- Import ETL pipelines ---
    for (const { pipeline, files } of parsed.etlPipelines) {
      const id = duplicate ? crypto.randomUUID() : pipeline.id
      if (!duplicate) {
        await storage.etlFiles.deleteByPipeline(pipeline.id).catch(() => {})
        await storage.etlPipelines.delete(pipeline.id).catch(() => {})
      }
      await storage.etlPipelines.create({
        ...pipeline, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${pipeline.name} (copy)`, createdAt: now } : {}),
      })
      const fileIdMap = new Map<string, string>()
      const mapFileId = (oldId: string): string => {
        if (!duplicate) return oldId
        if (!fileIdMap.has(oldId)) fileIdMap.set(oldId, crypto.randomUUID())
        return fileIdMap.get(oldId)!
      }
      for (const f of files) {
        await storage.etlFiles.create({
          ...f, id: mapFileId(f.id), pipelineId: id,
          parentId: f.parentId ? mapFileId(f.parentId) : null,
        })
      }
    }

    // --- Import DQ rule sets ---
    for (const { ruleSet, checks } of parsed.dqRuleSets) {
      const id = duplicate ? crypto.randomUUID() : ruleSet.id
      if (!duplicate) {
        await storage.dqCustomChecks.deleteByRuleSet(ruleSet.id).catch(() => {})
        await storage.dqRuleSets.delete(ruleSet.id).catch(() => {})
      }
      await storage.dqRuleSets.create({
        ...ruleSet, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${ruleSet.name} (copy)`, createdAt: now } : {}),
      })
      for (const check of checks) {
        await storage.dqCustomChecks.create({
          ...check, id: duplicate ? crypto.randomUUID() : check.id, ruleSetId: id,
        })
      }
    }

    // --- Import concept sets ---
    for (const cs of parsed.conceptSets) {
      const id = duplicate ? crypto.randomUUID() : cs.id
      if (!duplicate) await storage.conceptSets.delete(cs.id).catch(() => {})
      await storage.conceptSets.create({
        ...cs, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${cs.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import mapping projects ---
    for (const { project: mp, mappings } of parsed.mappingProjects) {
      const id = duplicate ? crypto.randomUUID() : mp.id
      if (!duplicate) {
        await storage.conceptMappings.deleteByProject(mp.id).catch(() => {})
        await storage.mappingProjects.delete(mp.id).catch(() => {})
      }
      await storage.mappingProjects.create({
        ...mp, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${mp.name} (copy)`, createdAt: now } : {}),
      })
      for (const m of mappings) {
        await storage.conceptMappings.create({
          ...m, id: duplicate ? crypto.randomUUID() : m.id, projectId: id,
        })
      }
    }

    // --- Import catalogs ---
    for (const cat of parsed.catalogs) {
      const id = duplicate ? crypto.randomUUID() : cat.id
      if (!duplicate) await storage.dataCatalogs.delete(cat.id).catch(() => {})
      await storage.dataCatalogs.create({
        ...cat, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${cat.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import service mappings ---
    for (const sm of parsed.serviceMappings) {
      const id = duplicate ? crypto.randomUUID() : sm.id
      if (!duplicate) await storage.serviceMappings.delete(sm.id).catch(() => {})
      await storage.serviceMappings.create({
        ...sm, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${sm.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import plugins ---
    for (const plugin of parsed.plugins) {
      const id = duplicate ? crypto.randomUUID() : plugin.id
      if (!duplicate) await storage.userPlugins.delete(plugin.id).catch(() => {})
      await storage.userPlugins.create({
        ...plugin, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { createdAt: now } : {}),
      })
    }

    // Invalidate in-memory caches so stores reload from IDB on next open
    useDashboardStore.setState({ activeProjectUid: null, loaded: false })
    useDatasetStore.setState({ activeProjectUid: null })
    useFileStore.setState({ activeProjectUid: null })
    useWikiStore.setState({ pagesLoaded: false, currentWorkspaceId: null })
    useSqlScriptsStore.setState({ collectionsLoaded: false })
    useEtlStore.setState({ etlPipelinesLoaded: false })
    useDqStore.setState({ dqRuleSetsLoaded: false })
    await useWorkspaceStore.getState().loadWorkspaces()
    await loadProjects()
  }, [loadProjects])

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    try {
      const parsed = await parseWorkspaceZip(file)
      if (!parsed) {
        setImportError(t('workspaces.import_invalid_zip'))
        return
      }

      const existingWs = await getStorage().workspaces.getById(parsed.workspace.id)
      if (existingWs) {
        const name = typeof existingWs.name === 'string' ? existingWs.name : (existingWs.name.en || Object.values(existingWs.name)[0] || '')
        setImportConflict({ name, pending: parsed })
      } else {
        await doImport(parsed, false)
      }
    } catch (err) {
      setImportError(t('workspaces.import_error', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [doImport, t])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('workspaces.title')}
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
              {t('workspaces.create')}
            </Button>
          </div>
        </div>

        {workspaces.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Building2 size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('workspaces.no_workspaces')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('workspaces.no_workspaces_description')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {workspaces.map((ws) => {
              const projectCount = getWorkspaceProjects(ws.id).length
              const raw = _workspacesRaw.find((w) => w.id === ws.id)
              const badges = raw?.badges ?? []
              return (
                <Card
                  key={ws.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => handleOpenWorkspace(ws.id, ws.name)}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <Building2 size={16} className="text-primary" />
                        </div>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium text-card-foreground">
                            {ws.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {ws.organizationName}
                          </span>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setExportTarget(ws.id) }}>
                            <Download size={14} />
                            {t('common.export')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: ws.id, name: ws.name }) }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 size={14} className="text-destructive" />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {ws.description && (
                      <p className="mt-2 truncate text-xs text-muted-foreground" title={ws.description}>
                        {ws.description}
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
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span>
                        {projectCount} {projectCount === 1 ? t('workspaces.project_count_one') : t('workspaces.project_count_other')}
                      </span>
                      <span>{ws.createdAt}</span>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      {/* Export workspace dialog */}
      <ExportDialog
        open={exportTarget !== null}
        onOpenChange={(open) => { if (!open) setExportTarget(null) }}
        onExport={handleExportWorkspace}
      />

      {/* Import conflict dialog */}
      <ImportConflictDialog
        open={!!importConflict}
        onOpenChange={(open) => { if (!open) setImportConflict(null) }}
        existingName={importConflict?.name ?? ''}
        onDuplicate={() => { if (importConflict) doImport(importConflict.pending, true); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) doImport(importConflict.pending, false); setImportConflict(null) }}
      />

      {/* Delete workspace confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirm('') } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workspaces.delete_workspace')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('workspaces.delete_workspace_description')}</p>
                <p className="text-sm">
                  {t('workspaces.delete_workspace_confirm')}{' '}
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
              {t('workspaces.delete_workspace')}
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
