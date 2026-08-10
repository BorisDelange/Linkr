import { useState, useMemo, useCallback, useEffect } from 'react'
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
  Eye,
  GripVertical,
  FileCode,
  Users,
  Activity,
  Table2,
  Power,
  Ban,
  Building2,
  ArrowDownAZ,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import { isServerMode } from '@/lib/api-client'
import { localized } from '@/lib/localized'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { orderByNamePatch } from './etl-file-language'
import { usePipelineRunner } from './use-pipeline-runner'
import { RunProgressBar } from './RunProgressBar'
import { splitSentences } from './role-presentation'
import type { EtlFile, DatabaseStatsCache } from '@/types'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  pipelineId: string
  onSelectFile?: (fileId: string) => void
  /** Show a database's tables in the Schemas tab (same view, no modal). */
  onBrowseSchema?: (dataSourceId: string) => void
}

export function EtlPipelineTab({ pipelineId, onSelectFile, onBrowseSchema }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const { etlPipelines, files, pipelineRunning, scriptStatuses, runHistory, stopPipelineRun, updateFile } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const sourceDs = dataSources.find((ds) => ds.id === pipeline?.sourceDataSourceId)
  const targetDs = dataSources.find((ds) => ds.id === pipeline?.targetDataSourceId)

  const hasSource = !!pipeline?.sourceDataSourceId
  const hasTarget = !!pipeline?.targetDataSourceId


  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Reveal the script that failed, so the error is not buried in the DAG.
  const revealFailedScript = useCallback((fileId: string) => {
    setSelectedNodeId(fileId)
    setSidebarVisible(true)
  }, [])

  const { runScripts } = usePipelineRunner(pipeline, { onScriptError: revealFailedScript })
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  /**
   * What the right sidebar shows. One subject at a time: the history and a node's
   * detail answer different questions, and side by side they left neither enough
   * width in a pane that is 300px to begin with.
   */
  const [sidebarView, setSidebarView] = useState<'node' | 'history'>('node')
  const showHistory = sidebarVisible && sidebarView === 'history'

  const sqlFiles = useMemo(() =>
    files
      .filter((f) => f.type === 'file' && f.language === 'sql')
      .sort((a, b) => a.order - b.order),
    [files],
  )

  /**
   * Align execution order with the script names.
   *
   * A pipeline runs in `order`, which the user sets by dragging — but the scripts
   * are named for the sequence they belong in (`00_`, `10_`, `35_`). When the two
   * drift apart the run does not fail, it silently produces wrong data: a step
   * reads a table an earlier step has not written yet.
   */
  const orderPatch = useMemo(() => orderByNamePatch(sqlFiles), [sqlFiles])
  const orderByNameChanges = orderPatch.size
  const sortByName = useCallback(() => {
    for (const [fileId, order] of orderPatch) updateFile(fileId, { order })
  }, [orderPatch, updateFile])

  // Run pipeline — execute scripts sequentially
  const handleRunPipeline = useCallback(async () => {
    if (!pipeline?.targetDataSourceId) return
    await runScripts(sqlFiles)
  }, [pipeline?.targetDataSourceId, sqlFiles, runScripts])

  // Get selected node info for sidebar
  const selectedNodeInfo = useMemo(() => {
    if (!selectedNodeId) return null
    if (selectedNodeId === '__source__') return { type: 'source' as const, ds: sourceDs }
    if (selectedNodeId === '__target__') return { type: 'target' as const, ds: targetDs }
    const file = files.find((f) => f.id === selectedNodeId)
    const log = scriptStatuses.get(selectedNodeId)
    return file ? { type: 'script' as const, file, log } : null
  }, [selectedNodeId, sourceDs, targetDs, files, scriptStatuses])

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
                <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={handleRunPipeline}>
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

          {/* Replaces a bare "Running…": which script, how far through the set and
              how long it has been going — the same readout as the Scripts tab. */}
          <RunProgressBar files={sqlFiles} />


          <div className="ml-auto flex items-center gap-1">
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!canWrite || orderByNameChanges === 0}
                  onClick={sortByName}
                >
                  <ArrowDownAZ size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                {orderByNameChanges === 0
                  ? t('etl.sort_by_name_done')
                  : t('etl.sort_by_name_hint', { count: orderByNameChanges })}
              </TooltipContent>
            </Tooltip>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showHistory ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => {
                    // Toggle off if it is already the subject, else take over the
                    // sidebar from whatever it was showing.
                    if (showHistory) { setSidebarVisible(false); return }
                    setSidebarView('history')
                    setSidebarVisible(true)
                  }}
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
            {/* Always the script list: the history moved into the sidebar, and the
                source/target comparison is its own tab (EtlQualityTab). */}
            <Allotment.Pane minSize={400}>
              {(
                <ScriptOrderList
                  sqlFiles={sqlFiles}
                  sourceDs={sourceDs}
                  targetDs={targetDs}
                  scriptStatuses={scriptStatuses}
                  hasSource={hasSource}
                  hasTarget={hasTarget}
                  updateFile={updateFile}
                  onSelectFile={onSelectFile}
                  onSelectNode={(id) => {
                    setSelectedNodeId(id)
                    // Selecting a node makes it the sidebar's subject, replacing
                    // the history rather than appearing beside it.
                    setSidebarView('node')
                    setSidebarVisible(true)
                  }}
                  onBrowseSchema={onBrowseSchema}
                />
              )}
            </Allotment.Pane>

            {/* Right sidebar — the run history OR the selected node, never both */}
            <Allotment.Pane preferredSize={340} minSize={240} maxSize={520} visible={sidebarVisible}>
              <div className="flex h-full min-h-0 flex-col overflow-hidden border-l">
                {sidebarView === 'history' ? (
                  <RunHistoryPanel
                    runHistory={runHistory}
                    files={files}
                    expandedRunId={expandedRunId}
                    onToggleRun={(id) => setExpandedRunId(expandedRunId === id ? null : id)}
                  />
                ) : (
                  <NodeDetailSidebar
                    info={selectedNodeInfo}
                    onViewCode={onSelectFile ? (fileId: string) => onSelectFile(fileId) : undefined}
                    onBrowseSchema={onBrowseSchema}
                  />
                )}
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
  | { type: 'script'; file: import('@/types').EtlFile; log: import('@/types').EtlRunLog | undefined }

function NodeDetailSidebar({ info, onViewCode, onBrowseSchema }: {
  info: NodeInfo | null
  onViewCode?: (fileId: string) => void
  onBrowseSchema?: (dataSourceId: string) => void
}) {
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
        accentColor={info.type === 'source' ? 'text-orange-500' : 'text-emerald-500'}
        onBrowseSchema={onBrowseSchema}
      />
    )
  }

  // Script node
  const { file, log } = info
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Code size={14} className="text-blue-500" />
          <h3 className="truncate text-xs font-medium">{file.name}</h3>
          {log && <RunStatusIcon status={log.status} />}
        </div>
      </div>
      {/* The viewport must be allowed to be narrower than its content, or a long
          unbreakable line pushes the whole pane past the edge of the screen. */}
      <ScrollArea className="min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]]:min-w-0">
        <div className="min-w-0 space-y-3 p-3 text-xs">
          <DetailRow label={t('etl.pipeline_script_order')} value={String(file.order)} />
          <DetailRow label={t('etl.pipeline_script_lang')} value={file.language ?? 'sql'} />

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
                <div className="min-w-0 rounded-md bg-red-500/10 p-2 text-red-600 dark:text-red-400">
                  <p className="text-[10px] font-medium">{t('etl.status_error')}</p>
                  {/* A SQL error is one long unbroken string with no spaces to
                      wrap at, so it widened the pane instead of fitting in it. */}
                  <p className="mt-0.5 break-all font-mono text-[10px] whitespace-pre-wrap">
                    {log.error}
                  </p>
                </div>
              )}
              {log.output && !log.error && (
                <div className="min-w-0 rounded-md bg-muted p-2">
                  <p className="break-all text-[10px] text-muted-foreground">{log.output}</p>
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
      {/* min-w-0 + break-words: a long value (a path, a schema name) would
          otherwise set the row's width and widen the whole sidebar. */}
      <span className="min-w-0 break-words text-right">{value}</span>
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
  onBrowseSchema,
}: {
  ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  label: string
  accentColor: string
  onBrowseSchema?: (dataSourceId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [stats, setStats] = useState<DatabaseStatsCache | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!ds?.id || !ds.schemaMapping) {
      setStats(null)
      return
    }
    // Server mode: never auto-run COUNT(*) — the source may be a huge database.
    if (isServerMode()) {
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
            <DetailRow label={t('etl.pipeline_db_engine')} value={(ds.connectionConfig && 'engine' in ds.connectionConfig ? ds.connectionConfig.engine : undefined) ?? '—'} />
            {ds.schemaMapping?.presetLabel && (
              <DetailRow label={t('etl.pipeline_db_schema')} value={localized(ds.schemaMapping.presetLabel, i18n.language)} />
            )}
            <DetailRow label={t('etl.pipeline_db_type')} value={ds.sourceType ?? '—'} />
          </div>

          {/* Opens the Schemas tab on this database rather than a modal — the same
              browser either way, and the same affordance the Scripts toolbar has. */}
          {onBrowseSchema && (
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 text-xs"
              onClick={() => onBrowseSchema(ds.id)}
            >
              <Table2 size={12} />
              {t('etl.browse_schema')}
            </Button>
          )}

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

/**
 * Status of one script or run. Every state carries a tooltip — a coloured glyph
 * alone does not say why a script is amber rather than green.
 */
function RunStatusIcon({ status }: { status: string }) {
  const { t } = useTranslation()
  const icon = (() => {
    switch (status) {
      case 'success': return <CheckCircle2 size={12} className="text-emerald-500" />
      case 'error': return <AlertCircle size={12} className="text-red-500" />
      case 'running': return <Loader2 size={12} className="animate-spin text-blue-500" />
      case 'pending': return <Clock size={12} className="text-muted-foreground/50" />
      case 'skipped': return <AlertCircle size={12} className="text-amber-500" />
      case 'stopped': return <Square size={12} className="text-amber-500" />
      default: return null
    }
  })()
  if (!icon) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">{icon}</span>
      </TooltipTrigger>
      {/* One sentence per line: "stopped" explains both what happened and what it
          means for the data, which ran together as a wall of text. */}
      <TooltipContent className="max-w-[300px]">
        {splitSentences(t(`etl.run_status_${status}`)).map((line) => (
          <span key={line} className="block [&+&]:mt-1">{line}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
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
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const running = useEtlStore((s) => s.pipelineRunning)
  const clearRunHistory = useEtlStore((s) => s.clearRunHistory)
  const [confirmClear, setConfirmClear] = useState(false)
  const fileMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files])

  const header = (
    <div className="flex items-center gap-2 border-b px-3 py-2.5">
      <History size={14} className="text-muted-foreground" />
      <h3 className="flex-1 truncate text-xs font-medium">{t('etl.run_history')}</h3>
      {runHistory.length > 0 && (
        <Button
          variant="ghost"
          size="icon-xs"
          // Disabled mid-run: clearing would wipe the statuses the run is writing.
          disabled={!canWrite || running}
          onClick={() => setConfirmClear(true)}
          title={t('etl.clear_run_history')}
        >
          <Trash2 size={12} />
        </Button>
      )}
    </div>
  )

  if (runHistory.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <History size={24} className="text-muted-foreground/50" />
          <p className="mt-3 text-xs text-muted-foreground">{t('etl.no_run_history')}</p>
          {/* Said here rather than discovered: the list is empty again after a
              reload, which looks like data loss if it is not stated. */}
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            {t('etl.run_history_session_only')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <ScrollArea className="min-h-0 flex-1">
      <div className="p-3 space-y-2">
        {runHistory.map((run) => {
          const isExpanded = expandedRunId === run.id
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
                  {formatDateTimeLocale(run.startedAt, i18n.language)}
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
                    <div className="mt-2 min-w-0 rounded bg-red-500/10 p-2">
                      {run.scripts.filter((s) => s.error).map((s) => (
                        <p
                          key={s.id}
                          className="break-all font-mono text-[10px] whitespace-pre-wrap text-red-600 dark:text-red-400"
                        >
                          {s.error}
                        </p>
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

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('etl.clear_run_history_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('etl.clear_run_history_confirm_body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { clearRunHistory(); setConfirmClear(false) }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('etl.clear_run_history')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Script order list — drag-and-drop reorderable list view
// ---------------------------------------------------------------------------

interface ScriptOrderListProps {
  sqlFiles: EtlFile[]
  sourceDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  targetDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  scriptStatuses: Map<string, import('@/types').EtlRunLog>
  hasSource: boolean
  hasTarget: boolean
  updateFile: (id: string, changes: Partial<EtlFile>) => Promise<void>
  onSelectFile?: (fileId: string) => void
  onSelectNode: (id: string) => void
  /** Double-clicking a database node opens its tables, as the sidebar button does. */
  onBrowseSchema?: (dataSourceId: string) => void
}

function ScriptOrderList({
  sqlFiles,
  sourceDs,
  targetDs,
  scriptStatuses,
  hasSource,
  hasTarget,
  updateFile,
  onSelectFile,
  onSelectNode,
  onBrowseSchema,
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
                // Double-click goes straight to the tables, the same as the
                // sidebar's Browse schema — one click to inspect, two to open.
                onDoubleClick={() => { if (sourceDs) onBrowseSchema?.(sourceDs.id) }}
                className="flex w-full items-center gap-3 rounded-lg border-2 border-orange-500/30 bg-card px-3 py-2.5 text-left transition-colors hover:border-orange-500/60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-orange-500/15">
                  <Database size={16} className="text-orange-600 dark:text-orange-400" />
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
                return (
                  <SortableScriptRow
                    key={file.id}
                    file={file}
                    index={idx}
                    log={log}
                    isLast={idx === sqlFiles.length - 1}
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
                onDoubleClick={() => { if (targetDs) onBrowseSchema?.(targetDs.id) }}
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
  isLast,
  onSelectFile,
  onSelectNode,
  onToggleDisabled,
}: {
  file: EtlFile
  index: number
  log: import('@/types').EtlRunLog | undefined
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
        // The whole card selects on click and opens the script on double-click;
        // the drag handle and the action buttons sit above it and stop the event,
        // so only the empty space between them falls through to here.
        onClick={() => onSelectNode(file.id)}
        onDoubleClick={() => onSelectFile?.(file.id)}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-lg border-2 bg-card px-2 py-2 transition-colors relative overflow-hidden',
          borderClass,
        )}
      >
        {/* Left accent strip */}
        <div className={cn('absolute left-0 top-0 bottom-0 w-1 rounded-l-md', accentColor)} />

        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
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

        {/* File info — the click handlers live on the card, so this is just layout. */}
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-xs font-medium', isDisabled && 'line-through text-muted-foreground/60')} title={file.name}>{file.name}</span>
            {log && !isDisabled && <RunStatusIcon status={log.status} />}
            {isDisabled && (
              <span className="rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[9px] text-muted-foreground/60">
                {t('etl.disabled')}
              </span>
            )}
          </div>
          {/* No database here: scripts no longer carry a per-file override, so
              this only ever repeated the pipeline target on every single card. The
              roles (source./target./vocab.) decide what a script reaches, and the
              target is shown once in the header. */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {log?.durationMs != null && !isDisabled && (
              <span>{log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}</span>
            )}
            {log?.rowsAffected != null && !isDisabled && (
              <span>{log.rowsAffected.toLocaleString()} rows</span>
            )}
          </div>
        </div>

        {/* View code button */}
        {onSelectFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => { e.stopPropagation(); onSelectFile(file.id) }}
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
              onClick={(e) => { e.stopPropagation(); onToggleDisabled(file.id) }}
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

      {/* Connector between two scripts — shorter than the source/target ones,
          which keep their full height to set those two apart from the chain. */}
      {!isLast && (
        <div className="flex justify-center py-0.5">
          <div className={cn('h-2 w-px', isDisabled ? 'bg-border/50' : 'bg-border')} />
        </div>
      )}
    </>
  )
}
