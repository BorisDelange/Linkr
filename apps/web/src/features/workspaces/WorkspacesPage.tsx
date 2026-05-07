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
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { formatDate } from '@/lib/format-helpers'
import { Plus, Building2, Upload, MoreHorizontal, Download, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
  const { t, i18n } = useTranslation()
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

  // Import progress state — modal shown while doImport is running.
  // `phaseKey` is an i18n key under workspaces.import_phase_*.
  // `done`/`total` count items inside the current phase (e.g. mappings imported / total).
  interface ImportProgress {
    phaseKey: string
    done?: number
    total?: number
  }
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)

  // Delete progress state — modal shown while a workspace is being cascaded.
  const [deleteProgress, setDeleteProgress] = useState<{ phaseKey: string } | null>(null)

  const handleOpenWorkspace = (id: string, name: string) => {
    openWorkspace(id, name)
    navigate(`/workspaces/${id}/home`)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    // Hide the confirmation dialog right away, then show the progress modal.
    setDeleteTarget(null)
    setDeleteConfirm('')
    setDeleteProgress({ phaseKey: 'workspaces.delete_phase_projects' })
    try {
      await deleteWorkspace(target.id, (phaseKey) => setDeleteProgress({ phaseKey }))
    } finally {
      setDeleteProgress(null)
    }
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

    /** Report a phase to the progress modal. Called between blocks of work. */
    const reportPhase = (phaseKey: string, done?: number, total?: number) => {
      setImportProgress({ phaseKey, done, total })
    }
    /** Yield to the browser so React paints the new progress before the next sync block. */
    const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    reportPhase('workspaces.import_phase_workspace')
    await yieldToBrowser()

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
    if (parsed.projects.size > 0) {
      reportPhase('workspaces.import_phase_projects', 0, parsed.projects.size)
      await yieldToBrowser()
    }
    let projectIdx = 0
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

      // Always remap sub-entity IDs to avoid collisions with existing records
      const idMap = new Map<string, string>()
      const mapId = (oldId: string): string => {
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
      for (const tab of parsedProject.dashboardTabs) {
        await storage.dashboardTabs.create({ ...tab, id: mapId(tab.id), dashboardId: mapId(tab.dashboardId) })
      }
      for (const w of parsedProject.dashboardWidgets) {
        await storage.dashboardWidgets.create({
          ...w,
          id: mapId(w.id),
          tabId: mapId(w.tabId),
          datasetFileId: w.datasetFileId ? mapId(w.datasetFileId) : w.datasetFileId,
        })
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
      projectIdx++
      reportPhase('workspaces.import_phase_projects', projectIdx, parsed.projects.size)
      await yieldToBrowser()
    }

    // --- Import lightweight project entries (catalog-only) ---
    if (parsed.projectEntries.length > 0) {
      reportPhase('workspaces.import_phase_project_entries', 0, parsed.projectEntries.length)
      await yieldToBrowser()
    }
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
    if (parsed.schemas.length > 0) {
      reportPhase('workspaces.import_phase_schemas', 0, parsed.schemas.length)
      await yieldToBrowser()
    }
    for (const sp of parsed.schemas) {
      const id = duplicate ? crypto.randomUUID() : sp.id
      if (!duplicate) await storage.schemaPresets.delete(sp.id).catch(() => {})
      await storage.schemaPresets.save({ ...sp, id, workspaceId: targetWsId })
    }

    // --- Import databases (metadata only, no credentials/files) ---
    if (parsed.databases.length > 0) {
      reportPhase('workspaces.import_phase_databases', 0, parsed.databases.length)
      await yieldToBrowser()
    }
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
      reportPhase('workspaces.import_phase_wiki', 0, parsed.wikiPages.length)
      await yieldToBrowser()
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
    if (parsed.sqlCollections.length > 0) {
      reportPhase('workspaces.import_phase_sql', 0, parsed.sqlCollections.length)
      await yieldToBrowser()
    }
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
    if (parsed.etlPipelines.length > 0) {
      reportPhase('workspaces.import_phase_etl', 0, parsed.etlPipelines.length)
      await yieldToBrowser()
    }
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
    if (parsed.dqRuleSets.length > 0) {
      reportPhase('workspaces.import_phase_dq', 0, parsed.dqRuleSets.length)
      await yieldToBrowser()
    }
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
    if (parsed.conceptSets.length > 0) {
      reportPhase('workspaces.import_phase_concept_sets', 0, parsed.conceptSets.length)
      await yieldToBrowser()
    }
    for (const cs of parsed.conceptSets) {
      const id = duplicate ? crypto.randomUUID() : cs.id
      if (!duplicate) await storage.conceptSets.delete(cs.id).catch(() => {})
      await storage.conceptSets.create({
        ...cs, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${cs.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import mapping projects ---
    if (parsed.mappingProjects.length > 0) {
      const totalMappings = parsed.mappingProjects.reduce((s, mp) => s + mp.mappings.length, 0)
      reportPhase('workspaces.import_phase_mappings', 0, totalMappings)
      await yieldToBrowser()
      let mappingIdx = 0
      const reportEvery = Math.max(1, Math.floor(totalMappings / 100)) // ~100 UI updates max
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
          mappingIdx++
          if (mappingIdx % reportEvery === 0) {
            reportPhase('workspaces.import_phase_mappings', mappingIdx, totalMappings)
            await yieldToBrowser()
          }
        }
      }
      reportPhase('workspaces.import_phase_mappings', totalMappings, totalMappings)
      await yieldToBrowser()
    }

    // --- Import source concept ID registry (ranges + entries) ---
    if (parsed.sourceConceptIdRanges.length > 0) {
      reportPhase('workspaces.import_phase_source_id_registry', 0, parsed.sourceConceptIdEntries.length)
      await yieldToBrowser()
      if (!duplicate) {
        await storage.sourceConceptIdRanges.deleteByWorkspace(targetWsId).catch(() => {})
        await storage.sourceConceptIdEntries.deleteByWorkspace(targetWsId).catch(() => {})
      }
      for (const range of parsed.sourceConceptIdRanges) {
        const badgeLabel = duplicate ? `${range.badgeLabel} (copy)` : range.badgeLabel
        await storage.sourceConceptIdRanges.save({
          ...range, workspaceId: targetWsId, badgeLabel, updatedAt: now,
        })
      }
      if (parsed.sourceConceptIdEntries.length > 0) {
        await storage.sourceConceptIdEntries.saveBatch(
          parsed.sourceConceptIdEntries.map(entry => {
            const badgeLabel = duplicate ? `${entry.badgeLabel} (copy)` : entry.badgeLabel
            const newId = duplicate
              ? `${targetWsId}__${badgeLabel}__${entry.vocabularyId}__${entry.conceptCode}`
              : entry.id
            return { ...entry, id: newId, workspaceId: targetWsId, badgeLabel }
          })
        )
      }
    }

    // --- Import catalogs ---
    if (parsed.catalogs.length > 0) {
      reportPhase('workspaces.import_phase_catalogs', 0, parsed.catalogs.length)
      await yieldToBrowser()
    }
    for (const cat of parsed.catalogs) {
      const id = duplicate ? crypto.randomUUID() : cat.id
      if (!duplicate) await storage.dataCatalogs.delete(cat.id).catch(() => {})
      await storage.dataCatalogs.create({
        ...cat, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${cat.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import service mappings ---
    if (parsed.serviceMappings.length > 0) {
      reportPhase('workspaces.import_phase_service_mappings', 0, parsed.serviceMappings.length)
      await yieldToBrowser()
    }
    for (const sm of parsed.serviceMappings) {
      const id = duplicate ? crypto.randomUUID() : sm.id
      if (!duplicate) await storage.serviceMappings.delete(sm.id).catch(() => {})
      await storage.serviceMappings.create({
        ...sm, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${sm.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import plugins ---
    if (parsed.plugins.length > 0) {
      reportPhase('workspaces.import_phase_plugins', 0, parsed.plugins.length)
      await yieldToBrowser()
    }
    for (const plugin of parsed.plugins) {
      const id = duplicate ? crypto.randomUUID() : plugin.id
      if (!duplicate) await storage.userPlugins.delete(plugin.id).catch(() => {})
      await storage.userPlugins.create({
        ...plugin, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { createdAt: now } : {}),
      })
    }

    reportPhase('workspaces.import_phase_finalizing')
    await yieldToBrowser()

    // Invalidate in-memory caches so stores reload from IDB on next open
    useDashboardStore.setState({ activeProjectUid: null, loaded: false })
    useDatasetStore.setState({ activeProjectUid: null })
    useFileStore.setState({ activeProjectUid: null })
    useWikiStore.setState({ pagesLoaded: false, currentWorkspaceId: null })
    useSqlScriptsStore.setState({ collectionsLoaded: false })
    useEtlStore.setState({ etlPipelinesLoaded: false })
    useDqStore.setState({ dqRuleSetsLoaded: false })
    // Concept mapping: also clear the in-memory `mappings` array — leftover entries from a
    // previously-deleted workspace would otherwise pollute the new project view.
    useConceptMappingStore.setState({
      mappingProjectsLoaded: false,
      conceptSetsLoaded: false,
      mappings: [],
      mappingsLoaded: false,
      activeProjectId: null,
      otherProjectsMappedKeys: new Set(),
      otherProjectsMappings: new Map(),
      _otherKeysLoadedFor: null,
      _otherDetailsLoadedFor: null,
    })
    await useWorkspaceStore.getState().loadWorkspaces()
    await loadProjects()
  }, [loadProjects])

  /** Run an import while showing the progress modal and clearing it afterwards. */
  const runImport = useCallback(async (parsed: ParsedWorkspaceZip, duplicate: boolean) => {
    setImportProgress({ phaseKey: 'workspaces.import_phase_workspace' })
    try {
      await doImport(parsed, duplicate)
    } catch (err) {
      setImportError(t('workspaces.import_error', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setImportProgress(null)
    }
  }, [doImport, t])

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    try {
      // Show the modal immediately while we parse the ZIP — that step alone can take a while
      // for large workspaces.
      setImportProgress({ phaseKey: 'workspaces.import_phase_parsing' })
      const parsed = await parseWorkspaceZip(file)
      if (!parsed) {
        setImportProgress(null)
        setImportError(t('workspaces.import_invalid_zip'))
        return
      }

      const existingWs = await getStorage().workspaces.getById(parsed.workspace.id)
      if (existingWs) {
        // Conflict: hide the progress modal, show the conflict dialog instead.
        setImportProgress(null)
        const name = typeof existingWs.name === 'string' ? existingWs.name : (existingWs.name.en || Object.values(existingWs.name)[0] || '')
        setImportConflict({ name, pending: parsed })
      } else {
        await runImport(parsed, false)
      }
    } catch (err) {
      setImportProgress(null)
      setImportError(t('workspaces.import_error', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [runImport, t])

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
                          {ws.organizationName && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {ws.organizationName}
                            </span>
                          )}
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
                      <span>{formatDate(ws.createdAt, i18n.language)}</span>
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
        onDuplicate={() => { if (importConflict) runImport(importConflict.pending, true); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) runImport(importConflict.pending, false); setImportConflict(null) }}
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

      {/* Import progress modal — non-dismissable while doImport runs.
          Close button hidden, Escape & click-outside disabled. */}
      <Dialog open={!!importProgress} onOpenChange={() => { /* not dismissable */ }}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin text-primary" />
              {t('workspaces.import_progress_title')}
            </DialogTitle>
          </DialogHeader>
          {importProgress && (
            <div className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">{t(importProgress.phaseKey)}</p>
              {typeof importProgress.total === 'number' && importProgress.total > 0 && (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.min(100, Math.round(((importProgress.done ?? 0) / importProgress.total) * 100))}%` }}
                    />
                  </div>
                  <p className="text-[10px] tabular-nums text-muted-foreground">
                    {(importProgress.done ?? 0).toLocaleString()} / {importProgress.total.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete progress modal — non-dismissable while deleteWorkspace runs. */}
      <Dialog open={!!deleteProgress} onOpenChange={() => { /* not dismissable */ }}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin text-primary" />
              {t('workspaces.delete_progress_title')}
            </DialogTitle>
          </DialogHeader>
          {deleteProgress && (
            <div className="pt-2">
              <p className="text-xs text-muted-foreground">{t(deleteProgress.phaseKey)}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
