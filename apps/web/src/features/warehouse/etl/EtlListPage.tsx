import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Workflow, Database, ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useEtlStore } from '@/stores/etl-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { buildEtlPipelineFolder, downloadBlob, parseImportZip, reconstructTreeFiles, slugify } from '@/lib/entity-io'
import JSZip from 'jszip'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { ListPageTemplate } from '../ListPageTemplate'
import { CreateEtlDialog } from './CreateEtlDialog'
import type { EtlPipeline, EtlPipelineStatus } from '@/types'

const STATUS_BADGE: Record<EtlPipelineStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'secondary', label: 'etl.status_draft' },
  ready: { variant: 'outline', label: 'etl.status_ready' },
  running: { variant: 'default', label: 'etl.status_running' },
  success: { variant: 'default', label: 'etl.status_success' },
  error: { variant: 'destructive', label: 'etl.status_error' },
}

export function EtlListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const language = useAppStore((s) => s.language)
  const { etlPipelinesLoaded, loadEtlPipelines, getWorkspacePipelines, deletePipeline } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  const pipelines = activeWorkspaceId ? getWorkspacePipelines(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? t('etl.unknown_source')

  // --- Export / Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: EtlPipeline; pendingFiles: import('@/types').EtlFile[] } | null>(null)

  const handleExport = useCallback(async (pipeline: EtlPipeline) => {
    const zip = new JSZip()
    await buildEtlPipelineFolder(zip, '', pipeline, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(localized(pipeline.name, 'en'))}.zip`)
  }, [])

  const doImport = useCallback(async (pipeline: EtlPipeline, files: import('@/types').EtlFile[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : pipeline.id
    const entity: EtlPipeline = {
      ...pipeline,
      id,
      workspaceId: activeWorkspaceId ?? pipeline.workspaceId,
      name: duplicate ? setLocalized(pipeline.name, language, `${localized(pipeline.name, language)} (copy)`) : pipeline.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      // Overwrite: delete old children first
      await getStorage().etlFiles.deleteByPipeline(pipeline.id)
      await getStorage().etlPipelines.delete(pipeline.id).catch(() => {})
    }
    await getStorage().etlPipelines.create(entity)
    for (const f of files) {
      await getStorage().etlFiles.create({
        ...f,
        id: duplicate ? crypto.randomUUID() : f.id,
        pipelineId: id,
      })
    }
    await loadEtlPipelines()
  }, [activeWorkspaceId, language, loadEtlPipelines])

  const handleImport = useCallback(async (file: File) => {
    const parsed = await parseImportZip(file)
    // New git-friendly layout (_pipeline.json + _tree.json + raw files) with a fallback
    // to the legacy layout (pipeline.json + files.json).
    const pipeline = (parsed['_pipeline.json'] ?? parsed['pipeline.json']) as EtlPipeline | undefined
    if (!pipeline?.id) return
    const tree = parsed['_tree.json'] as import('@/types').EtlFile[] | undefined
    const files = tree
      ? reconstructTreeFiles(tree, parsed)
      : ((parsed['files.json'] ?? []) as import('@/types').EtlFile[])
    const existing = await getStorage().etlPipelines.getById(pipeline.id)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: pipeline, pendingFiles: files })
    } else {
      await doImport(pipeline, files, false)
    }
  }, [activeWorkspaceId, language, doImport])

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) doImport(conflict.pending, conflict.pendingFiles, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) doImport(conflict.pending, conflict.pendingFiles, false); setConflict(null) }}
    />
    <ListPageTemplate<EtlPipeline>
      titleKey="etl.title"
      descriptionKey="etl.description"
      newButtonKey="etl.new_pipeline"
      emptyTitleKey="etl.no_pipelines"
      emptyDescriptionKey="etl.no_pipelines_description"
      deleteConfirmTitleKey="etl.delete_confirm_title"
      deleteConfirmDescriptionKey="etl.delete_confirm_description"
      emptyIcon={Workflow}
      items={pipelines}
      onNavigate={(id) => navigate(id)}
      onDelete={(id) => deletePipeline(id)}
      onExport={handleExport}
      getGitRemote={(p) => p.gitRemoteConfig ?? null}
      onSaveGitRemote={async (p, config) => {
        await getStorage().etlPipelines.update(p.id, { gitRemoteConfig: config ?? undefined })
        await loadEtlPipelines()
      }}
      exportSupportsIncludeData={false}
      onImport={handleImport}
      renderCardBody={(pipeline) => {
        const statusInfo = STATUS_BADGE[pipeline.status]
        return (
          <>
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
              <Workflow size={20} className="text-teal-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{localized(pipeline.name, language)}</span>
                <Badge variant={statusInfo.variant} className="text-[10px]">
                  {t(statusInfo.label)}
                </Badge>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database size={12} />
                <span>{getSourceName(pipeline.sourceDataSourceId)}</span>
                {pipeline.targetDataSourceId && (
                  <>
                    <ArrowRight size={10} />
                    <span>{getSourceName(pipeline.targetDataSourceId)}</span>
                  </>
                )}
              </div>
              {pipeline.lastRunAt && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t('etl.last_run')}: {new Date(pipeline.lastRunAt).toLocaleString()}
                  {pipeline.lastRunDurationMs != null && ` (${(pipeline.lastRunDurationMs / 1000).toFixed(1)}s)`}
                </p>
              )}
            </div>
          </>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateEtlDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={({ item, onOpenChange }) => (
        <CreateEtlDialog open onOpenChange={onOpenChange} editingPipeline={item} />
      )}
    />
    </>
  )
}
