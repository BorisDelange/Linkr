import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Workflow, Plus, Trash2, Pencil, Download, History, Database, ArrowRight, MoreHorizontal, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
import { useEtlStore } from '@/stores/etl-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
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

  const [dialogOpen, setDialogOpen] = useState(false)
  const [pipelineToDelete, setPipelineToDelete] = useState<EtlPipeline | null>(null)
  const [pipelineToEdit, setPipelineToEdit] = useState<EtlPipeline | null>(null)

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  const pipelines = activeWorkspaceId ? getWorkspacePipelines(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? t('etl.unknown_source')

  const handleCreated = (pipelineId: string) => {
    navigate(pipelineId)
  }

  const handleDelete = async () => {
    if (pipelineToDelete) {
      await deletePipeline(pipelineToDelete.id)
      setPipelineToDelete(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('etl.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('etl.description')}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button variant="outline" size="sm" disabled className="gap-1 text-xs">
                    <Upload size={14} />
                    {t('common.import')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('common.coming_soon')}</TooltipContent>
            </Tooltip>
            <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1 text-xs">
              <Plus size={14} />
              {t('etl.new_pipeline')}
            </Button>
          </div>
        </div>

        {pipelines.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Workflow size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('etl.no_pipelines')}
              </p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('etl.no_pipelines_description')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3">
            {pipelines.map((pipeline) => {
              const statusInfo = STATUS_BADGE[pipeline.status]
              return (
                <Card
                  key={pipeline.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(pipeline.id)}
                >
                  <div className="flex items-start gap-4 p-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                      <Workflow size={20} className="text-teal-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {pipeline.name}
                        </span>
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setPipelineToEdit(pipeline) }}>
                          <Pencil size={14} />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled>
                          <Download size={14} />
                          {t('common.export')}
                          <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled>
                          <History size={14} />
                          {t('common.history')}
                          <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); setPipelineToDelete(pipeline) }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateEtlDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />

      <CreateEtlDialog
        open={!!pipelineToEdit}
        onOpenChange={(open) => { if (!open) setPipelineToEdit(null) }}
        editingPipeline={pipelineToEdit}
      />

      <AlertDialog open={!!pipelineToDelete} onOpenChange={(open) => { if (!open) setPipelineToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('etl.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('etl.delete_confirm_description', { name: pipelineToDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
