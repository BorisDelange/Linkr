import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from '@dnd-kit/modifiers'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table'
import {
  Workflow,
  Play,
  Square,
  PanelRight,
  Code,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Database,
  History,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Eye,
  GripVertical,
  FileCode,
  Users,
  Activity,
  Table2,
  Power,
  Ban,
  Building2,
  GitCompare,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import type { EtlFile, DatabaseStatsCache } from '@/types'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  pipelineId: string
  onSelectFile?: (fileId: string) => void
}

export function EtlPipelineTab({ pipelineId, onSelectFile }: Props) {
  const { t } = useTranslation()
  const { etlPipelines, files, pipelineRunning, scriptStatuses, runHistory, startPipelineRun, stopPipelineRun, setScriptStatus, finishPipelineRun, updateFile, updatePipeline } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const sourceDs = dataSources.find((ds) => ds.id === pipeline?.sourceDataSourceId)
  const targetDs = dataSources.find((ds) => ds.id === pipeline?.targetDataSourceId)

  const hasSource = !!pipeline?.sourceDataSourceId
  const hasTarget = !!pipeline?.targetDataSourceId

  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showComparison, setShowComparison] = useState(false)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  const sqlFiles = useMemo(() =>
    files
      .filter((f) => f.type === 'file' && f.language === 'sql')
      .sort((a, b) => a.order - b.order),
    [files],
  )

  // Run pipeline — execute scripts sequentially
  const handleRunPipeline = useCallback(async () => {
    if (!pipeline?.targetDataSourceId || sqlFiles.length === 0) return
    startPipelineRun()
    const abort = useEtlStore.getState().pipelineRunAbort
    const { testConnection } = useDataSourceStore.getState()

    // Ensure source + target + vocabulary databases are mounted
    if (pipeline.sourceDataSourceId) await testConnection(pipeline.sourceDataSourceId)
    await testConnection(pipeline.targetDataSourceId)

    // Mount any vocabulary reference databases (needed by 00a_vocabulary_tables)
    const allDs = useDataSourceStore.getState().dataSources
    const vocabSources = allDs.filter((ds) => ds.isVocabularyReference && ds.status === 'connected')
    for (const vs of vocabSources) {
      await testConnection(vs.id)
    }

    let hasError = false
    for (const file of sqlFiles) {
      if (abort?.signal.aborted) break
      if (file.disabled || !file.content) {
        setScriptStatus(file.id, {
          id: `log-${file.id}-${Date.now()}`,
          pipelineId,
          fileId: file.id,
          status: 'skipped',
        })
        continue
      }

      // Resolve per-file data source or fallback to pipeline target
      const dsId = file.dataSourceId ?? pipeline.targetDataSourceId

      setScriptStatus(file.id, {
        id: `log-${file.id}-${Date.now()}`,
        pipelineId,
        fileId: file.id,
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const start = Date.now()
      try {
        await testConnection(dsId)
        const rows = await duckdbEngine.queryDataSource(dsId, file.content)
        const duration = Date.now() - start
        setScriptStatus(file.id, {
          id: `log-${file.id}-${Date.now()}`,
          pipelineId,
          fileId: file.id,
          status: 'success',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: duration,
          rowsAffected: rows.length,
          output: `${rows.length} row${rows.length !== 1 ? 's' : ''} in ${duration}ms`,
        })
      } catch (err) {
        const duration = Date.now() - start
        hasError = true
        setScriptStatus(file.id, {
          id: `log-${file.id}-${Date.now()}`,
          pipelineId,
          fileId: file.id,
          status: 'error',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: duration,
          error: err instanceof Error ? err.message : String(err),
        })
        // Auto-select the failed node and open sidebar
        setSelectedNodeId(file.id)
        setSidebarVisible(true)
        break
      }
    }

    finishPipelineRun(hasError || abort?.signal.aborted ? 'error' : 'success')
  }, [pipeline, sqlFiles, pipelineId, startPipelineRun, setScriptStatus, finishPipelineRun])

  // Get selected node info for sidebar
  const selectedNodeInfo = useMemo(() => {
    if (!selectedNodeId) return null
    if (selectedNodeId === '__source__') return { type: 'source' as const, ds: sourceDs }
    if (selectedNodeId === '__target__') return { type: 'target' as const, ds: targetDs }
    const file = files.find((f) => f.id === selectedNodeId)
    const log = scriptStatuses.get(selectedNodeId)
    const fileDsId = file?.dataSourceId ?? pipeline?.targetDataSourceId
    const fileDs = dataSources.find((ds) => ds.id === fileDsId)
    return file ? { type: 'script' as const, file, log, ds: fileDs, isOverride: !!file.dataSourceId } : null
  }, [selectedNodeId, sourceDs, targetDs, files, scriptStatuses, dataSources, pipeline?.sourceDataSourceId])

  // Empty state
  if (sqlFiles.length === 0 && !hasSource && !hasTarget) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Workflow size={32} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.pipeline_empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{t('etl.pipeline_empty_hint')}</p>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          {!pipelineRunning ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={handleRunPipeline}>
                  <Play size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.run_pipeline')}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={stopPipelineRun}>
                  <Square size={14} className="text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.stop')}</TooltipContent>
            </Tooltip>
          )}

          <span className="text-xs text-muted-foreground">
            {sqlFiles.filter((f) => !f.disabled).length}/{sqlFiles.length} {t('etl.pipeline_scripts_count')}
          </span>

          {pipelineRunning && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <Loader2 size={12} className="animate-spin" />
              {t('etl.status_running')}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={showComparison ? 'secondary' : 'ghost'}
              size="xs"
              className="gap-1.5 text-xs"
              onClick={() => { setShowComparison(!showComparison); if (!showComparison) setShowHistory(false) }}
            >
              <GitCompare size={14} />
              {t('etl.comparison')}
            </Button>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => { for (const f of sqlFiles) { if (f.disabled) updateFile(f.id, { disabled: false }) } }}
                >
                  <Power size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.enable_all')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => { for (const f of sqlFiles) { if (!f.disabled) updateFile(f.id, { disabled: true }) } }}
                >
                  <Ban size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.disable_all')}</TooltipContent>
            </Tooltip>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showHistory ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => { setShowHistory(!showHistory); if (!showHistory) setShowComparison(false) }}
                >
                  <History size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.run_history')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={sidebarVisible ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setSidebarVisible(!sidebarVisible)}
                >
                  <PanelRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.pipeline_toggle_detail')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content: canvas + sidebar */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Allotment proportionalLayout={false}>
            {/* Script list, comparison, or history */}
            <Allotment.Pane minSize={400}>
              {showComparison ? (
                <ComparisonView
                  pipeline={pipeline}
                  sourceDs={sourceDs}
                  targetDs={targetDs}
                  mappingProjectId={pipeline?.mappingProjectId}
                  onMappingProjectChange={(id) => pipeline && updatePipeline(pipeline.id, { mappingProjectId: id || undefined })}
                />
              ) : showHistory ? (
                <RunHistoryPanel
                  runHistory={runHistory}
                  files={files}
                  expandedRunId={expandedRunId}
                  onToggleRun={(id) => setExpandedRunId(expandedRunId === id ? null : id)}
                />
              ) : (
                <ScriptOrderList
                  sqlFiles={sqlFiles}
                  sourceDs={sourceDs}
                  targetDs={targetDs}
                  dataSources={dataSources}
                  pipeline={pipeline}
                  scriptStatuses={scriptStatuses}
                  hasSource={hasSource}
                  hasTarget={hasTarget}
                  updateFile={updateFile}
                  onSelectFile={onSelectFile}
                  onSelectNode={(id) => { setSelectedNodeId(id); setSidebarVisible(true) }}
                />
              )}
            </Allotment.Pane>

            {/* Right sidebar — node detail */}
            <Allotment.Pane preferredSize={300} minSize={220} maxSize={450} visible={sidebarVisible}>
              <div className="flex h-full min-h-0 flex-col overflow-hidden border-l">
                <NodeDetailSidebar
                  info={selectedNodeInfo}
                  onViewCode={onSelectFile ? (fileId: string) => onSelectFile(fileId) : undefined}
                />
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Node detail sidebar
// ---------------------------------------------------------------------------

type NodeInfo =
  | { type: 'source'; ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined }
  | { type: 'target'; ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined }
  | { type: 'script'; file: import('@/types').EtlFile; log: import('@/types').EtlRunLog | undefined; ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined; isOverride: boolean }

function NodeDetailSidebar({ info, onViewCode }: { info: NodeInfo | null; onViewCode?: (fileId: string) => void }) {
  const { t } = useTranslation()

  if (!info) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <Workflow size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('etl.pipeline_click_node')}</p>
      </div>
    )
  }

  if (info.type === 'source' || info.type === 'target') {
    return (
      <DatabaseSidebarDetail
        ds={info.ds}
        label={t(info.type === 'source' ? 'etl.source' : 'etl.target')}
        accentColor={info.type === 'source' ? 'text-teal-500' : 'text-emerald-500'}
      />
    )
  }

  // Script node
  const { file, log, ds: scriptDs, isOverride } = info
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Code size={14} className="text-blue-500" />
          <h3 className="truncate text-xs font-medium">{file.name}</h3>
          {log && <RunStatusIcon status={log.status} />}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3 text-xs">
          <DetailRow label={t('etl.pipeline_script_order')} value={String(file.order)} />
          <DetailRow label={t('etl.pipeline_script_lang')} value={file.language ?? 'sql'} />
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 text-muted-foreground">{t('etl.script_db_label')}</span>
            <span className="flex items-center gap-1 text-right">
              {scriptDs?.name ?? '—'}
              {isOverride && (
                <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-600 dark:text-amber-400">
                  {t('etl.script_db_override')}
                </span>
              )}
            </span>
          </div>

          {log && (
            <div className="space-y-2 border-t pt-3">
              <DetailRow label={t('etl.pipeline_run_status')} value={t(`etl.status_${log.status}`)} />
              {log.durationMs != null && (
                <DetailRow
                  label={t('etl.pipeline_run_duration')}
                  value={log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}
                />
              )}
              {log.rowsAffected != null && (
                <DetailRow label={t('etl.pipeline_run_rows')} value={log.rowsAffected.toLocaleString()} />
              )}
              {log.error && (
                <div className="rounded-md bg-red-500/10 p-2 text-red-600 dark:text-red-400">
                  <p className="text-[10px] font-medium">{t('etl.status_error')}</p>
                  <p className="mt-0.5 font-mono text-[10px]">{log.error}</p>
                </div>
              )}
              {log.output && !log.error && (
                <div className="rounded-md bg-muted p-2">
                  <p className="text-[10px] text-muted-foreground">{log.output}</p>
                </div>
              )}
            </div>
          )}

          {onViewCode && (
            <div className="border-t pt-3">
              <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={() => onViewCode(file.id)}>
                <Code size={12} />
                {t('etl.pipeline_view_code')}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Database sidebar detail — rich stats for source/target nodes
// ---------------------------------------------------------------------------

function DatabaseSidebarDetail({
  ds,
  label,
  accentColor,
}: {
  ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  label: string
  accentColor: string
}) {
  const { t } = useTranslation()
  const [stats, setStats] = useState<DatabaseStatsCache | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!ds?.id || !ds.schemaMapping) {
      setStats(null)
      return
    }
    let cancelled = false
    setLoading(true)
    computeDatabaseStats(ds.id, ds.schemaMapping).then((result) => {
      if (!cancelled) {
        setStats(result)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [ds?.id, ds?.schemaMapping])

  if (!ds) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Database size={14} className={accentColor} />
            <h3 className="text-xs font-medium">{label}</h3>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-xs text-muted-foreground">{t('etl.pipeline_no_db_selected')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Database size={14} className={accentColor} />
          <h3 className="text-xs font-medium">{label}</h3>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {/* Basic info */}
          <div className="space-y-2 text-xs">
            <DetailRow label={t('etl.pipeline_db_name')} value={ds.name} />
            <DetailRow label={t('etl.pipeline_db_engine')} value={ds.connectionConfig?.engine ?? '—'} />
            {ds.schemaMapping?.presetLabel && (
              <DetailRow label={t('etl.pipeline_db_schema')} value={ds.schemaMapping.presetLabel} />
            )}
            <DetailRow label={t('etl.pipeline_db_type')} value={ds.sourceType ?? '—'} />
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              {t('common.loading')}…
            </div>
          )}

          {/* Overview stats */}
          {stats && (
            <>
              <div className="border-t pt-3">
                <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('etl.sidebar_overview')}
                </h4>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border p-2 text-center">
                    <Users size={14} className="mx-auto mb-1 text-blue-500" />
                    <div className="text-sm font-semibold tabular-nums">{stats.summary.patientCount.toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_patients')}</div>
                  </div>
                  <div className="rounded-md border p-2 text-center">
                    <Activity size={14} className="mx-auto mb-1 text-emerald-500" />
                    <div className="text-sm font-semibold tabular-nums">{stats.summary.visitCount.toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_visits')}</div>
                  </div>
                  <div className="rounded-md border p-2 text-center">
                    <Building2 size={14} className="mx-auto mb-1 text-amber-500" />
                    <div className="text-sm font-semibold tabular-nums">{stats.summary.visitDetailCount.toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_visit_units')}</div>
                  </div>
                </div>
              </div>

              {/* Gender distribution */}
              {(stats.genderDistribution.male > 0 || stats.genderDistribution.female > 0) && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_gender')}
                  </h4>
                  <GenderBar distribution={stats.genderDistribution} />
                </div>
              )}

              {/* Descriptive stats */}
              {stats.descriptiveStats.ageMean != null && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_age_stats')}
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    {stats.descriptiveStats.ageMean != null && (
                      <DetailRow label={t('etl.sidebar_mean')} value={String(stats.descriptiveStats.ageMean)} />
                    )}
                    {stats.descriptiveStats.ageMedian != null && (
                      <DetailRow label={t('etl.sidebar_median')} value={String(stats.descriptiveStats.ageMedian)} />
                    )}
                    {stats.descriptiveStats.ageMin != null && stats.descriptiveStats.ageMax != null && (
                      <DetailRow label={t('etl.sidebar_range')} value={`${stats.descriptiveStats.ageMin} – ${stats.descriptiveStats.ageMax}`} />
                    )}
                    {stats.descriptiveStats.ageQ1 != null && stats.descriptiveStats.ageQ3 != null && (
                      <DetailRow label="IQR" value={`${stats.descriptiveStats.ageQ1} – ${stats.descriptiveStats.ageQ3}`} />
                    )}
                  </div>
                </div>
              )}

              {/* Visit stats */}
              {stats.descriptiveStats.losMean != null && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_visit_stats')}
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    {stats.descriptiveStats.admissionDateMin && stats.descriptiveStats.admissionDateMax && (
                      <DetailRow
                        label={t('etl.sidebar_date_range')}
                        value={`${stats.descriptiveStats.admissionDateMin.slice(0, 10)} → ${stats.descriptiveStats.admissionDateMax.slice(0, 10)}`}
                      />
                    )}
                    {stats.descriptiveStats.losMean != null && (
                      <DetailRow label={`${t('etl.sidebar_los')} (${t('etl.sidebar_mean')})`} value={`${stats.descriptiveStats.losMean} j`} />
                    )}
                    {stats.descriptiveStats.losMedian != null && (
                      <DetailRow label={`${t('etl.sidebar_los')} (${t('etl.sidebar_median')})`} value={`${stats.descriptiveStats.losMedian} j`} />
                    )}
                    {stats.descriptiveStats.visitsPerPatientMean != null && (
                      <DetailRow label={t('etl.sidebar_visits_per_patient')} value={`${stats.descriptiveStats.visitsPerPatientMean} (${t('etl.sidebar_mean')})`} />
                    )}
                  </div>
                </div>
              )}

              {/* Table list with row counts */}
              {stats.tableCounts.length > 0 && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_tables')} ({stats.tableCounts.length})
                  </h4>
                  <div className="space-y-0.5">
                    {stats.tableCounts.map((tc) => (
                      <div key={tc.tableName} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/30">
                        <Table2 size={10} className="shrink-0 text-blue-500/60" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={tc.tableName}>{tc.tableName}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{tc.rowCount.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// Simple gender distribution bar
function GenderBar({ distribution }: { distribution: { male: number; female: number; other: number } }) {
  const total = distribution.male + distribution.female + distribution.other
  if (total === 0) return null
  const malePct = Math.round((distribution.male / total) * 100)
  const femalePct = Math.round((distribution.female / total) * 100)
  const otherPct = 100 - malePct - femalePct

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full">
        {malePct > 0 && <div className="bg-blue-500" style={{ width: `${malePct}%` }} />}
        {femalePct > 0 && <div className="bg-pink-500" style={{ width: `${femalePct}%` }} />}
        {otherPct > 0 && <div className="bg-gray-400" style={{ width: `${otherPct}%` }} />}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
          {distribution.male.toLocaleString()} ({malePct}%)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-pink-500" />
          {distribution.female.toLocaleString()} ({femalePct}%)
        </span>
        {distribution.other > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
            {distribution.other.toLocaleString()} ({otherPct}%)
          </span>
        )}
      </div>
    </div>
  )
}

function RunStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'success': return <CheckCircle2 size={12} className="text-emerald-500" />
    case 'error': return <AlertCircle size={12} className="text-red-500" />
    case 'running': return <Loader2 size={12} className="animate-spin text-blue-500" />
    case 'pending': return <Clock size={12} className="text-muted-foreground/50" />
    case 'skipped': return <AlertCircle size={12} className="text-amber-500" />
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Comparison view — side-by-side source vs target stats + concept mapping diff
// ---------------------------------------------------------------------------

interface ComparisonViewProps {
  pipeline: import('@/types').EtlPipeline | undefined
  sourceDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  targetDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  mappingProjectId?: string
  onMappingProjectChange: (id: string) => void
}

type ComparisonTab = 'statistics' | 'concepts'

interface ConceptMappingRow {
  sourceVocabularyId: string
  sourceCode: string
  sourceDescription: string
  targetConceptId: number
  targetVocabularyId: string
  sourcePatients: number
  sourceRows: number
  targetPatients: number
  targetRows: number
  diff: 'match' | 'fewer' | 'more' | 'missing'
}

function ComparisonView({ pipeline, sourceDs, targetDs, mappingProjectId, onMappingProjectChange }: ComparisonViewProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ComparisonTab>('statistics')
  const [sourceStats, setSourceStats] = useState<DatabaseStatsCache | null>(null)
  const [targetStats, setTargetStats] = useState<DatabaseStatsCache | null>(null)
  const [loading, setLoading] = useState(false)

  // Mapping projects for concept tab
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects } = useConceptMappingStore()

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  // Auto-select first mapping project if none is set
  const workspaceId = pipeline?.workspaceId
  const availableProjects = useMemo(
    () => mappingProjects.filter((p) => !workspaceId || p.workspaceId === workspaceId),
    [mappingProjects, workspaceId],
  )
  useEffect(() => {
    if (!mappingProjectId && availableProjects.length > 0) {
      onMappingProjectChange(availableProjects[0].id)
    }
  }, [mappingProjectId, availableProjects, onMappingProjectChange])

  // Load stats for both databases
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const loadStats = async () => {
      const results = await Promise.all([
        sourceDs?.id && sourceDs.schemaMapping
          ? computeDatabaseStats(sourceDs.id, sourceDs.schemaMapping).catch(() => null)
          : Promise.resolve(null),
        targetDs?.id && targetDs.schemaMapping
          ? computeDatabaseStats(targetDs.id, targetDs.schemaMapping).catch(() => null)
          : Promise.resolve(null),
      ])
      if (!cancelled) {
        setSourceStats(results[0])
        setTargetStats(results[1])
        setLoading(false)
      }
    }
    loadStats()
    return () => { cancelled = true }
  }, [sourceDs?.id, sourceDs?.schemaMapping, targetDs?.id, targetDs?.schemaMapping])

  if (!sourceDs && !targetDs) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('etl.comparison_no_db')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 border-b px-3 py-1">
        {(['statistics', 'concepts'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              activeTab === tab
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {t(`etl.comparison_tab_${tab}`)}
          </button>
        ))}

        {/* Mapping project selector (shown on concepts tab) */}
        {activeTab === 'concepts' && availableProjects.length > 0 && (
          <div className="ml-auto">
            <Select value={mappingProjectId ?? ''} onValueChange={onMappingProjectChange}>
              <SelectTrigger className="h-6 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
                <SelectValue placeholder={t('etl.vocab_select_project')} />
              </SelectTrigger>
              <SelectContent>
                {availableProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === 'statistics' ? (
          <ScrollArea className="h-full">
            <div className="p-4 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <ComparisonColumn
                  label={t('etl.source')}
                  ds={sourceDs}
                  stats={sourceStats}
                  loading={loading}
                  accentColor="teal"
                />
                <ComparisonColumn
                  label={t('etl.target')}
                  ds={targetDs}
                  stats={targetStats}
                  loading={loading}
                  accentColor="emerald"
                />
              </div>
            </div>
          </ScrollArea>
        ) : (
          <ConceptComparisonTab
            sourceDs={sourceDs}
            targetDs={targetDs}
            mappingProjectId={mappingProjectId}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Concept comparison tab — concept mapping datatable with source vs target counts
// Uses TanStack Table with column filters, sorting, pagination, resizable columns.
//
// Counts logic: both source and target counts are queried from the TARGET DB.
// - "Source" columns show counts using *_source_concept_id columns
// - "Target" columns show counts using *_concept_id columns
// ---------------------------------------------------------------------------

function ConceptComparisonTab({
  sourceDs,
  targetDs,
  mappingProjectId,
}: {
  sourceDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  targetDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  mappingProjectId?: string
}) {
  const { t } = useTranslation()
  const [mappingRows, setMappingRows] = useState<ConceptMappingRow[]>([])
  const [mappingLoading, setMappingLoading] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!targetDs?.id) return
    let cancelled = false
    setMappingLoading(true)

    const loadMapping = async () => {
      try {
        // Read STCM from target database (include source_concept_id for source counts)
        const stcmRows = await duckdbEngine.queryDataSource(targetDs.id, `
          SELECT source_vocabulary_id, source_code, source_code_description,
                 source_concept_id, target_concept_id, target_vocabulary_id
          FROM source_to_concept_map
          WHERE target_concept_id != 0
        `).catch(() => [])

        if (cancelled || stcmRows.length === 0) {
          if (!cancelled) { setMappingRows([]); setMappingLoading(false) }
          return
        }

        // Collect all concept IDs we need counts for
        const sourceConceptIds = new Set<number>()
        const targetConceptIds = new Set<number>()
        for (const row of stcmRows) {
          const sci = Number(row.source_concept_id)
          const tci = Number(row.target_concept_id)
          if (sci > 0) sourceConceptIds.add(sci)
          if (tci > 0) targetConceptIds.add(tci)
        }

        // Count concept occurrences in target DB clinical tables
        const countConceptsInTargetDb = async (conceptIds: number[], useSourceCol: boolean) => {
          if (conceptIds.length === 0) return new Map<number, { patients: number; rows: number }>()
          const counts = new Map<number, { patients: number; rows: number }>()

          const clinicalTables = [
            { table: 'condition_occurrence', col: useSourceCol ? 'condition_source_concept_id' : 'condition_concept_id' },
            { table: 'drug_exposure', col: useSourceCol ? 'drug_source_concept_id' : 'drug_concept_id' },
            { table: 'measurement', col: useSourceCol ? 'measurement_source_concept_id' : 'measurement_concept_id' },
            { table: 'procedure_occurrence', col: useSourceCol ? 'procedure_source_concept_id' : 'procedure_concept_id' },
            { table: 'observation', col: useSourceCol ? 'observation_source_concept_id' : 'observation_concept_id' },
            { table: 'device_exposure', col: useSourceCol ? 'device_source_concept_id' : 'device_concept_id' },
            { table: 'specimen', col: useSourceCol ? 'specimen_source_concept_id' : 'specimen_concept_id' },
          ]

          const idList = conceptIds.join(',')
          for (const ct of clinicalTables) {
            try {
              const sql = `
                SELECT "${ct.col}" as cid,
                       COUNT(DISTINCT person_id)::INTEGER as patients,
                       COUNT(*)::INTEGER as rows
                FROM "${ct.table}"
                WHERE "${ct.col}" IN (${idList})
                GROUP BY "${ct.col}"
              `
              const rows = await duckdbEngine.queryDataSource(targetDs.id, sql)
              for (const r of rows) {
                const cid = Number(r.cid)
                const prev = counts.get(cid) ?? { patients: 0, rows: 0 }
                counts.set(cid, { patients: prev.patients + Number(r.patients), rows: prev.rows + Number(r.rows) })
              }
            } catch { /* table may not exist */ }
          }
          return counts
        }

        // Source counts: use *_source_concept_id columns
        const sourceCounts = await countConceptsInTargetDb([...sourceConceptIds], true)
        // Target counts: use *_concept_id columns
        const targetCounts = await countConceptsInTargetDb([...targetConceptIds], false)

        // Aggregate total source rows per target_concept_id (N:1 mappings share the same target)
        const totalSourceRowsByTarget = new Map<number, number>()
        for (const row of stcmRows) {
          const sci = Number(row.source_concept_id ?? 0)
          const tcid = Number(row.target_concept_id)
          const sr = sci > 0 ? (sourceCounts.get(sci)?.rows ?? 0) : 0
          totalSourceRowsByTarget.set(tcid, (totalSourceRowsByTarget.get(tcid) ?? 0) + sr)
        }

        const comparisonRows: ConceptMappingRow[] = []
        for (const row of stcmRows) {
          const sci = Number(row.source_concept_id ?? 0)
          const tcid = Number(row.target_concept_id)
          const sc = sci > 0 ? (sourceCounts.get(sci) ?? { patients: 0, rows: 0 }) : { patients: 0, rows: 0 }
          const tc = targetCounts.get(tcid) ?? { patients: 0, rows: 0 }
          const totalSourceRows = totalSourceRowsByTarget.get(tcid) ?? 0

          // Compare target rows against aggregated source rows for this target (exact match)
          let diff: ConceptMappingRow['diff'] = 'match'
          if (sc.rows > 0 && tc.rows === 0) diff = 'missing'
          else if (totalSourceRows > 0 && tc.rows < totalSourceRows) diff = 'fewer'
          else if (totalSourceRows > 0 && tc.rows > totalSourceRows) diff = 'more'

          comparisonRows.push({
            sourceVocabularyId: String(row.source_vocabulary_id ?? ''),
            sourceCode: String(row.source_code ?? ''),
            sourceDescription: String(row.source_code_description ?? ''),
            targetConceptId: tcid,
            targetVocabularyId: String(row.target_vocabulary_id ?? ''),
            sourcePatients: sc.patients,
            sourceRows: sc.rows,
            targetPatients: tc.patients,
            targetRows: tc.rows,
            diff,
          })
        }

        if (!cancelled) {
          setMappingRows(comparisonRows)
          setMappingLoading(false)
        }
      } catch {
        if (!cancelled) { setMappingRows([]); setMappingLoading(false) }
      }
    }
    loadMapping()
    return () => { cancelled = true }
  }, [targetDs?.id])

  // TanStack Table column definitions
  const columns = useMemo<ColumnDef<ConceptMappingRow>[]>(() => [
    {
      accessorKey: 'sourceVocabularyId',
      header: t('etl.comparison_source_vocab'),
      size: 140,
      filterFn: 'includesString',
      cell: ({ getValue }) => <span className="font-mono">{getValue<string>()}</span>,
    },
    {
      accessorKey: 'sourceCode',
      header: t('etl.comparison_source_code'),
      size: 180,
      filterFn: 'includesString',
      cell: ({ row }) => (
        <span className="font-mono truncate block" title={row.original.sourceDescription}>
          {row.original.sourceCode}
        </span>
      ),
    },
    {
      accessorKey: 'sourceDescription',
      header: t('etl.comparison_description'),
      size: 200,
      filterFn: 'includesString',
      cell: ({ getValue }) => (
        <span className="truncate block" title={getValue<string>()}>
          {getValue<string>()}
        </span>
      ),
    },
    {
      accessorKey: 'targetConceptId',
      header: t('etl.comparison_target_id'),
      size: 100,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-right block">{getValue<number>()}</span>
      ),
    },
    {
      accessorKey: 'sourcePatients',
      header: t('etl.comparison_source_patients'),
      size: 90,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-right block">{getValue<number>().toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'targetPatients',
      header: t('etl.comparison_target_patients'),
      size: 90,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-right block">{getValue<number>().toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'sourceRows',
      header: t('etl.comparison_source_rows'),
      size: 90,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-right block">{getValue<number>().toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'targetRows',
      header: t('etl.comparison_target_rows'),
      size: 90,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-right block">{getValue<number>().toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'diff',
      header: t('etl.comparison_status'),
      size: 90,
      filterFn: (row, _columnId, filterValue) => {
        if (!filterValue || filterValue === 'all') return true
        return row.original.diff === filterValue
      },
      cell: ({ getValue }) => <ComparisonDiffBadge diff={getValue<ConceptMappingRow['diff']>()} />,
    },
  ], [t])

  const table = useReactTable({
    data: mappingRows,
    columns,
    state: { sorting, columnFilters, columnSizing },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    columnResizeMode: 'onChange',
    initialState: { pagination: { pageSize: 50 } },
  })

  if (mappingLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {t('common.loading')}…
        </div>
      </div>
    )
  }

  if (mappingRows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <GitCompare size={24} className="mx-auto text-muted-foreground/30" />
          <p className="mt-2 text-xs text-muted-foreground">{t('etl.comparison_no_mappings')}</p>
        </div>
      </div>
    )
  }

  const diffCounts = { missing: 0, fewer: 0, more: 0, match: 0 }
  for (const row of mappingRows) diffCounts[row.diff]++

  const filteredCount = table.getFilteredRowModel().rows.length

  return (
    <div className="flex h-full flex-col">
      {/* Summary badges + pagination */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b flex-wrap">
        <span className="text-xs text-muted-foreground">
          {filteredCount !== mappingRows.length
            ? `${filteredCount} / ${mappingRows.length}`
            : mappingRows.length}{' '}
          {t('etl.comparison_mapping_concepts')}
        </span>
        <div className="flex items-center gap-1">
          {diffCounts.missing > 0 && (
            <button
              onClick={() => {
                const col = table.getColumn('diff')
                col?.setFilterValue(col.getFilterValue() === 'missing' ? undefined : 'missing')
              }}
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                table.getColumn('diff')?.getFilterValue() === 'missing'
                  ? 'bg-red-500/30 text-red-700 dark:text-red-300 ring-1 ring-red-500/50'
                  : 'bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25',
              )}
            >
              <AlertTriangle size={9} /> {diffCounts.missing} {t('etl.comparison_missing')}
            </button>
          )}
          {diffCounts.fewer > 0 && (
            <button
              onClick={() => {
                const col = table.getColumn('diff')
                col?.setFilterValue(col.getFilterValue() === 'fewer' ? undefined : 'fewer')
              }}
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                table.getColumn('diff')?.getFilterValue() === 'fewer'
                  ? 'bg-amber-500/30 text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/50'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25',
              )}
            >
              {diffCounts.fewer} {t('etl.comparison_fewer')}
            </button>
          )}
          {diffCounts.more > 0 && (
            <button
              onClick={() => {
                const col = table.getColumn('diff')
                col?.setFilterValue(col.getFilterValue() === 'more' ? undefined : 'more')
              }}
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                table.getColumn('diff')?.getFilterValue() === 'more'
                  ? 'bg-blue-500/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/50'
                  : 'bg-blue-500/15 text-blue-600 dark:text-blue-400 hover:bg-blue-500/25',
              )}
            >
              {diffCounts.more} {t('etl.comparison_more')}
            </button>
          )}
          {diffCounts.match > 0 && (
            <button
              onClick={() => {
                const col = table.getColumn('diff')
                col?.setFilterValue(col.getFilterValue() === 'match' ? undefined : 'match')
              }}
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                table.getColumn('diff')?.getFilterValue() === 'match'
                  ? 'bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/50'
                  : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25',
              )}
            >
              {diffCounts.match} OK
            </button>
          )}
          {table.getColumn('diff')?.getFilterValue() && (
            <button
              onClick={() => table.getColumn('diff')?.setFilterValue(undefined)}
              className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/80"
            >
              {t('common.clear')}
            </button>
          )}
        </div>

        {/* Pagination controls */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">
            {t('common.page')} {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <ChevronRight size={12} />
          </Button>
        </div>
      </div>

      {/* DataTable */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs" style={{ width: table.getCenterTotalSize() }}>
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="relative px-2 py-1.5 text-left font-medium"
                    style={{ width: header.getSize() }}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-1 select-none',
                        header.column.getCanSort() && 'cursor-pointer hover:text-foreground',
                      )}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <span className="truncate">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {header.column.getIsSorted() === 'asc' && <ArrowUp size={10} />}
                      {header.column.getIsSorted() === 'desc' && <ArrowDown size={10} />}
                      {header.column.getCanSort() && !header.column.getIsSorted() && (
                        <ArrowUpDown size={10} className="text-muted-foreground/40" />
                      )}
                    </div>
                    {/* Resize handle */}
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none hover:bg-primary/30"
                    />
                  </th>
                ))}
              </tr>
            ))}
            {/* Column filter row */}
            <tr className="border-b">
              {table.getHeaderGroups()[0]?.headers.map((header) => (
                <th key={`filter-${header.id}`} className="px-1.5 py-1" style={{ width: header.getSize() }}>
                  {header.column.id === 'diff' ? (
                    // Status filter is handled by the badges above
                    null
                  ) : header.column.getCanFilter() ? (
                    <input
                      type="text"
                      value={(header.column.getFilterValue() as string) ?? ''}
                      onChange={(e) => header.column.setFilterValue(e.target.value || undefined)}
                      placeholder="…"
                      className="h-5 w-full rounded border bg-transparent px-1 text-[10px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-t hover:bg-accent/30',
                  row.original.diff === 'missing' && 'bg-red-500/5',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="px-2 py-1.5"
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ComparisonColumn({
  label,
  ds,
  stats,
  loading,
  accentColor,
}: {
  label: string
  ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  stats: DatabaseStatsCache | null
  loading: boolean
  accentColor: 'teal' | 'emerald'
}) {
  const { t } = useTranslation()
  const borderColor = accentColor === 'teal' ? 'border-teal-500/30' : 'border-emerald-500/30'
  const iconColor = accentColor === 'teal' ? 'text-teal-500' : 'text-emerald-500'

  if (!ds) {
    return (
      <div className={cn('rounded-lg border-2 p-4 text-center', borderColor)}>
        <Database size={20} className="mx-auto text-muted-foreground/30" />
        <p className="mt-2 text-xs text-muted-foreground">{t('etl.pipeline_no_db_selected')}</p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-3 rounded-lg border-2 p-3', borderColor)}>
      <div className="flex items-center gap-2">
        <Database size={14} className={iconColor} />
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">— {ds.name}</span>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t('common.loading')}…
        </div>
      )}

      {stats && (
        <div className="space-y-3">
          {/* Key numbers */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border p-2 text-center">
              <Users size={12} className="mx-auto mb-0.5 text-blue-500" />
              <div className="text-sm font-semibold tabular-nums">{stats.summary.patientCount.toLocaleString()}</div>
              <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_patients')}</div>
            </div>
            <div className="rounded-md border p-2 text-center">
              <Activity size={12} className="mx-auto mb-0.5 text-emerald-500" />
              <div className="text-sm font-semibold tabular-nums">{stats.summary.visitCount.toLocaleString()}</div>
              <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_visits')}</div>
            </div>
            <div className="rounded-md border p-2 text-center">
              <Building2 size={12} className="mx-auto mb-0.5 text-amber-500" />
              <div className="text-sm font-semibold tabular-nums">{stats.summary.visitDetailCount.toLocaleString()}</div>
              <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_visit_units')}</div>
            </div>
          </div>

          {/* Gender */}
          {(stats.genderDistribution.male > 0 || stats.genderDistribution.female > 0) && (
            <GenderBar distribution={stats.genderDistribution} />
          )}

          {/* Table counts */}
          {stats.tableCounts.length > 0 && (
            <div className="space-y-0.5">
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('etl.sidebar_tables')} ({stats.tableCounts.length})
              </h4>
              {stats.tableCounts.map((tc) => (
                <div key={tc.tableName} className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px]">
                  <Table2 size={9} className="shrink-0 text-blue-500/60" />
                  <span className="min-w-0 flex-1 truncate font-mono">{tc.tableName}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{tc.rowCount.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ComparisonDiffBadge({ diff }: { diff: ConceptMappingRow['diff'] }) {
  const { t } = useTranslation()
  switch (diff) {
    case 'missing':
      return (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
          <AlertTriangle size={10} />
          {t('etl.comparison_missing')}
        </span>
      )
    case 'fewer':
      return (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          {t('etl.comparison_fewer')}
        </span>
      )
    case 'more':
      return (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
          {t('etl.comparison_more')}
        </span>
      )
    case 'match':
      return (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={10} />
        </span>
      )
  }
}

// ---------------------------------------------------------------------------
// Run history panel
// ---------------------------------------------------------------------------

interface RunHistoryPanelProps {
  runHistory: { id: string; startedAt: string; completedAt?: string; status: 'running' | 'success' | 'error'; scripts: import('@/types').EtlRunLog[] }[]
  files: import('@/types').EtlFile[]
  expandedRunId: string | null
  onToggleRun: (id: string) => void
}

function RunHistoryPanel({ runHistory, files, expandedRunId, onToggleRun }: RunHistoryPanelProps) {
  const { t } = useTranslation()
  const fileMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files])

  if (runHistory.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <History size={28} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.no_run_history')}</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-2">
        {runHistory.map((run) => {
          const isExpanded = expandedRunId === run.id
          const date = new Date(run.startedAt)
          const successCount = run.scripts.filter((s) => s.status === 'success').length
          const totalCount = run.scripts.length
          return (
            <div key={run.id} className="rounded-md border">
              <button
                onClick={() => onToggleRun(run.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/50"
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <RunStatusIcon status={run.status} />
                <span className="flex-1 font-medium">
                  {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground">
                  {successCount}/{totalCount}
                </span>
              </button>
              {isExpanded && (
                <div className="border-t px-3 py-2 space-y-1">
                  {run.scripts.map((script) => {
                    const file = fileMap.get(script.fileId)
                    return (
                      <div key={script.id} className="flex items-center gap-2 text-xs">
                        <RunStatusIcon status={script.status} />
                        <span className={cn('flex-1 truncate font-mono', script.status === 'error' && 'text-red-500')}>
                          {file?.name ?? script.fileId}
                        </span>
                        {script.durationMs != null && (
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {script.durationMs < 1000 ? `${script.durationMs}ms` : `${(script.durationMs / 1000).toFixed(1)}s`}
                          </span>
                        )}
                      </div>
                    )
                  })}
                  {run.scripts.some((s) => s.error) && (
                    <div className="mt-2 rounded bg-red-500/10 p-2">
                      {run.scripts.filter((s) => s.error).map((s) => (
                        <p key={s.id} className="font-mono text-[10px] text-red-600 dark:text-red-400">{s.error}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

// ---------------------------------------------------------------------------
// Script order list — drag-and-drop reorderable list view
// ---------------------------------------------------------------------------

interface ScriptOrderListProps {
  sqlFiles: EtlFile[]
  sourceDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  targetDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  dataSources: ReturnType<typeof useDataSourceStore.getState>['dataSources']
  pipeline: import('@/types').EtlPipeline | undefined
  scriptStatuses: Map<string, import('@/types').EtlRunLog>
  hasSource: boolean
  hasTarget: boolean
  updateFile: (id: string, changes: Partial<EtlFile>) => Promise<void>
  onSelectFile?: (fileId: string) => void
  onSelectNode: (id: string) => void
}

function ScriptOrderList({
  sqlFiles,
  sourceDs,
  targetDs,
  dataSources,
  pipeline,
  scriptStatuses,
  hasSource,
  hasTarget,
  updateFile,
  onSelectFile,
  onSelectNode,
}: ScriptOrderListProps) {
  const { t } = useTranslation()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = sqlFiles.findIndex((f) => f.id === active.id)
      const newIndex = sqlFiles.findIndex((f) => f.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      const reordered = arrayMove(sqlFiles, oldIndex, newIndex)
      // Persist new order values
      reordered.forEach((file, idx) => {
        if (file.order !== idx) {
          updateFile(file.id, { order: idx })
        }
      })
    },
    [sqlFiles, updateFile],
  )

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-lg space-y-0 p-4">
        {/* Source node (static) */}
          {hasSource && (
            <>
              <button
                onClick={() => onSelectNode('__source__')}
                className="flex w-full items-center gap-3 rounded-lg border-2 border-teal-500/30 bg-card px-3 py-2.5 text-left transition-colors hover:border-teal-500/60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal-500/15">
                  <Database size={16} className="text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{t('etl.source')}</div>
                  {sourceDs && <div className="text-[10px] text-muted-foreground">{sourceDs.name}</div>}
                </div>
              </button>
              <div className="flex justify-center py-1">
                <div className="h-4 w-px bg-border" />
              </div>
            </>
          )}

          {/* Sortable script list */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sqlFiles.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              {sqlFiles.map((file, idx) => {
                const log = scriptStatuses.get(file.id)
                const fileDsId = file.dataSourceId ?? pipeline?.targetDataSourceId
                const fileDs = dataSources.find((ds) => ds.id === fileDsId)
                return (
                  <SortableScriptRow
                    key={file.id}
                    file={file}
                    index={idx}
                    log={log}
                    fileDs={fileDs}
                    isOverride={!!file.dataSourceId}
                    isLast={idx === sqlFiles.length - 1 && !hasTarget}
                    onSelectFile={onSelectFile}
                    onSelectNode={onSelectNode}
                    onToggleDisabled={(id) => updateFile(id, { disabled: !file.disabled })}
                  />
                )
              })}
            </SortableContext>
          </DndContext>

          {/* Target node (static) */}
          {hasTarget && (
            <>
              {sqlFiles.length > 0 && (
                <div className="flex justify-center py-1">
                  <div className="h-4 w-px bg-border" />
                </div>
              )}
              <button
                onClick={() => onSelectNode('__target__')}
                className="flex w-full items-center gap-3 rounded-lg border-2 border-emerald-500/30 bg-card px-3 py-2.5 text-left transition-colors hover:border-emerald-500/60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/15">
                  <Database size={16} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{t('etl.target')}</div>
                  {targetDs && <div className="text-[10px] text-muted-foreground">{targetDs.name}</div>}
                </div>
              </button>
            </>
          )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortableScriptRow — individual draggable script in the list
// ---------------------------------------------------------------------------

function SortableScriptRow({
  file,
  index,
  log,
  fileDs,
  isOverride,
  isLast,
  onSelectFile,
  onSelectNode,
  onToggleDisabled,
}: {
  file: EtlFile
  index: number
  log: import('@/types').EtlRunLog | undefined
  fileDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  isOverride: boolean
  isLast: boolean
  onSelectFile?: (fileId: string) => void
  onSelectNode: (id: string) => void
  onToggleDisabled: (fileId: string) => void
}) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.id })

  const isDisabled = !!file.disabled

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : isDisabled ? 0.45 : 1,
  }

  // Border color based on status
  const borderClass = isDragging
    ? 'border-blue-500 shadow-lg'
    : isDisabled
      ? 'border-muted-foreground/20 hover:border-muted-foreground/40'
      : log?.status === 'success'
        ? 'border-emerald-500/40 hover:border-emerald-500/70'
        : log?.status === 'error'
          ? 'border-red-500/40 hover:border-red-500/70'
          : log?.status === 'running'
            ? 'border-blue-500/50 hover:border-blue-500/80'
            : 'border-blue-500/30 hover:border-blue-500/60'

  // Left accent strip color
  const accentColor = isDisabled
    ? 'bg-muted-foreground/20'
    : log?.status === 'success'
      ? 'bg-emerald-500'
      : log?.status === 'error'
        ? 'bg-red-500'
        : log?.status === 'running'
          ? 'bg-blue-500'
          : 'bg-blue-500/30'

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'flex items-center gap-2 rounded-lg border-2 bg-card px-2 py-2 transition-colors relative overflow-hidden',
          borderClass,
        )}
      >
        {/* Left accent strip */}
        <div className={cn('absolute left-0 top-0 bottom-0 w-1 rounded-l-md', accentColor)} />

        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing ml-1"
        >
          <GripVertical size={14} />
        </button>

        {/* Order number */}
        <span className={cn('w-5 shrink-0 text-center text-[10px] font-medium tabular-nums', isDisabled ? 'text-muted-foreground/40' : 'text-muted-foreground')}>
          {index + 1}
        </span>

        {/* Icon */}
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          isDisabled ? 'bg-muted-foreground/10' : 'bg-blue-500/15',
        )}>
          {isDisabled
            ? <Ban size={14} className="text-muted-foreground/40" />
            : <FileCode size={14} className="text-blue-600 dark:text-blue-400" />
          }
        </div>

        {/* File info */}
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => onSelectNode(file.id)}
        >
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-xs font-medium', isDisabled && 'line-through text-muted-foreground/60')} title={file.name}>{file.name}</span>
            {log && !isDisabled && <RunStatusIcon status={log.status} />}
            {isDisabled && (
              <span className="rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[9px] text-muted-foreground/60">
                {t('etl.disabled')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {fileDs && !isDisabled && (
              <span className="flex items-center gap-1">
                <Database size={9} />
                {fileDs.name}
                {isOverride && (
                  <span className="rounded bg-amber-500/15 px-1 text-[8px] text-amber-600 dark:text-amber-400">
                    {t('etl.script_db_override')}
                  </span>
                )}
              </span>
            )}
            {log?.durationMs != null && !isDisabled && (
              <span>{log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}</span>
            )}
            {log?.rowsAffected != null && !isDisabled && (
              <span>{log.rowsAffected.toLocaleString()} rows</span>
            )}
          </div>
        </button>

        {/* View code button */}
        {onSelectFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onSelectFile(file.id)}
                className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Eye size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('etl.pipeline_view_code')}</TooltipContent>
          </Tooltip>
        )}

        {/* Enable/disable toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onToggleDisabled(file.id)}
              className={cn(
                'shrink-0 rounded p-1 transition-colors',
                isDisabled
                  ? 'text-muted-foreground/30 hover:bg-accent hover:text-foreground'
                  : 'text-emerald-500/60 hover:bg-accent hover:text-emerald-600',
              )}
            >
              <Power size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{isDisabled ? t('etl.enable_script') : t('etl.disable_script')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Connector line between items */}
      {!isLast && (
        <div className="flex justify-center py-1">
          <div className={cn('h-4 w-px', isDisabled ? 'bg-border/50' : 'bg-border')} />
        </div>
      )}
    </>
  )
}
