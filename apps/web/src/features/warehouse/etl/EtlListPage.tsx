import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Workflow, Database, ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useEtlStore } from '@/stores/etl-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
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
  const { etlPipelinesLoaded, loadEtlPipelines, getWorkspacePipelines, deletePipeline } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  const pipelines = activeWorkspaceId ? getWorkspacePipelines(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? t('etl.unknown_source')

  return (
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
      renderCardBody={(pipeline) => {
        const statusInfo = STATUS_BADGE[pipeline.status]
        return (
          <>
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
              <Workflow size={20} className="text-teal-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{pipeline.name}</span>
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
  )
}
