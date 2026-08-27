import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
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
  Pause,
  Square,
  PanelRight,
  Code,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Database,
  ArrowRight,
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
  Copy,
  Check,
  CornerDownRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionLabel } from '@/components/ui/section-label'
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
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { useDataSourceStore } from '@/stores/data-source-store'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import { isServerMode } from '@/lib/api-client'
import {
  fetchDatabaseConnectionInfo,
  type DatabaseConnectionInfo,
  type ParquetTablePath,
} from '@/lib/api/data-sources'
import { localized } from '@/lib/localized'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDateTimeLocale, formatDuration } from '@/lib/format-helpers'
import { etlLanguageLabel, orderByNamePatch } from './etl-file-language'
import { usePipelineRunner } from './use-pipeline-runner'
import {
  columnCountFor,
  columnDropIndex,
  columnNeighbourIndex,
  columnStartIndex,
  splitIntoColumns,
} from './script-columns'
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
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const {
    etlPipelines,
    files,
    pipelineRunning,
    scriptStatuses,
    runHistory,
    stopPipelineRun,
    pausePipelineRun,
    pausedRun,
    discardPausedRun,
    updateFile,
    updatePipeline,
  } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  // Offered databases are scoped to the pipeline's OWN workspace. Resolving the
  // already-linked source/target below is deliberately not: a database that was
  // linked before must stay nameable even if it no longer qualifies.
  const dbSources = useDatabaseOptions(pipeline?.workspaceId)
  const sourceDs = dataSources.find((ds) => ds.id === pipeline?.sourceDataSourceId)
  const targetDs = dataSources.find((ds) => ds.id === pipeline?.targetDataSourceId)

  const hasSource = !!pipeline?.sourceDataSourceId
  const hasTarget = !!pipeline?.targetDataSourceId


  // Open on arrival: the detail panel is where a node's databases, code and last
  // run live, and starting collapsed hid the fact that clicking a card shows
  // anything at all. Toggling it shut is remembered for the session.
  const [sidebarVisible, setSidebarVisible] = useState(true)
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

  const handlePausePipeline = useCallback(() => { pausePipelineRun() }, [pausePipelineRun])

  /**
   * The scripts a resume would actually run.
   *
   * A pause is an indefinite hold, so a script it still owes may since have been
   * deleted, renamed, or switched away from SQL — those ids are simply absent
   * from `sqlFiles`. Deriving the list here (rather than inside the handler) is
   * what lets the toolbar promise the real number instead of the stale
   * `pendingFileIds.length`, which claimed scripts that no longer exist.
   */
  const resumableScripts = useMemo(() => {
    if (!pausedRun) return []
    const pending = new Set(pausedRun.pendingFileIds)
    return sqlFiles.filter((f) => pending.has(f.id))
  }, [pausedRun, sqlFiles])

  /** Continue the held run: the scripts it still owes, in the pipeline's order. */
  const handleResumePipeline = useCallback(async () => {
    if (!pausedRun) return
    // Nothing left to run: end the hold rather than leave an amber Resume button
    // that does nothing and a `pausedRun` stranded for ever.
    if (resumableScripts.length === 0) {
      discardPausedRun()
      return
    }
    await runScripts(resumableScripts, { resume: true })
  }, [pausedRun, resumableScripts, runScripts, discardPausedRun])

  /**
   * Run ONE script, as its own run.
   *
   * A fresh history entry covering just this script, so the run reads as what it
   * was — not as a pipeline that mysteriously skipped fifteen steps. Disabled
   * scripts are runnable this way on purpose: singling one out IS the ask.
   */
  const handleRunScript = useCallback(async (file: EtlFile) => {
    if (!pipeline?.targetDataSourceId) return
    await runScripts([{ ...file, disabled: false }])
  }, [pipeline?.targetDataSourceId, runScripts])

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
          {/* Running: Pause and Stop. Idle: Start, or Resume plus Stop when a run
              is held — a paused run is neither finished nor in flight, and both
              ways out of it have to be reachable. */}
          {pipelineRunning ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={handlePausePipeline}>
                    <Pause size={14} className="text-amber-500" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">{t('etl.pause_pipeline_hint')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={stopPipelineRun}>
                    <Square size={14} className="text-red-500" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('etl.stop')}</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={!canWrite}
                    onClick={pausedRun ? handleResumePipeline : handleRunPipeline}
                  >
                    <Play size={14} className={pausedRun ? 'text-amber-500' : undefined} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">
                  {pausedRun
                    ? t('etl.resume_pipeline_hint', { count: resumableScripts.length })
                    : t('etl.run_pipeline')}
                </TooltipContent>
              </Tooltip>
              {pausedRun && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-xs" onClick={discardPausedRun}>
                      <Square size={14} className="text-red-500" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('etl.stop')}</TooltipContent>
                </Tooltip>
              )}
            </>
          )}

          <span className="text-xs text-muted-foreground">
            {sqlFiles.filter((f) => !f.disabled).length}/{sqlFiles.length} {t('etl.pipeline_scripts_count')}
          </span>

          {/* Replaces a bare "Running…": which script, how far through the set and
              how long it has been going — the same readout as the Scripts tab. */}
          <RunProgressBar files={sqlFiles} />

          {/* Source → target. These live here rather than on the page's tab row
              because they are pipeline settings, not page chrome: they belong
              beside the scripts they govern, and only this tab needs them. */}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <Select
              value={pipeline?.sourceDataSourceId ?? ''}
              onValueChange={(value) => updatePipeline(pipelineId, { sourceDataSourceId: value })}
              disabled={!canWrite}
            >
              <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
                <Database size={12} className="text-muted-foreground" />
                <SelectValue placeholder={t('etl.select_source')} />
              </SelectTrigger>
              <SelectContent>
                {dbSources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>{localized(ds.name, i18n.language)}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <ArrowRight size={12} className="shrink-0 text-muted-foreground" />

            <Select
              value={pipeline?.targetDataSourceId ?? ''}
              onValueChange={(value) => updatePipeline(pipelineId, { targetDataSourceId: value || undefined })}
              disabled={!canWrite}
            >
              <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
                <Database size={12} className="text-muted-foreground" />
                <SelectValue placeholder={t('etl.select_target')} />
              </SelectTrigger>
              <SelectContent>
                {dbSources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>{localized(ds.name, i18n.language)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1">
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
                  selectedNodeId={selectedNodeId}
                  // The sidebar stays open, now showing "nothing selected": it
                  // is a persistent panel, and closing it on a stray background
                  // click would make the layout jump.
                  onClearSelection={() => setSelectedNodeId(null)}
                  onSelectNode={(id) => {
                    setSelectedNodeId(id)
                    // Selecting a node makes it the sidebar's subject, replacing
                    // the history rather than appearing beside it.
                    setSidebarView('node')
                    setSidebarVisible(true)
                  }}
                  onRunScript={handleRunScript}
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Code size={14} className="text-blue-500" />
          <h3 className="truncate text-xs font-medium">{file.name}</h3>
          {log && <RunStatusIcon status={log.status} />}
        </div>
      </div>
      {/* The viewport must be allowed to be narrower AND shorter than its content,
          or a long unbreakable line pushes the whole pane past the edge of the
          screen and a long error stretches the pane instead of scrolling in it. */}
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]]:min-w-0">
        <div className="min-w-0 space-y-3 p-3 text-xs">
          <DetailRow label={t('etl.pipeline_script_order')} value={String(file.order)} />
          <DetailRow label={t('etl.pipeline_script_lang')} value={etlLanguageLabel(file.language ?? 'sql')} />

          {log && (
            <div className="space-y-2 border-t pt-3">
              <DetailRow label={t('etl.pipeline_run_status')} value={t(`etl.status_${log.status}`)} />
              {log.durationMs != null && (
                <DetailRow
                  label={t('etl.pipeline_run_duration')}
                  value={formatDuration(log.durationMs)}
                />
              )}
              {/* Row count dropped here too: same misleading number as on the
                  card — the result set of the last statement, not what the
                  script wrote. */}
              {log.error && (
                <div className="min-w-0 rounded-md bg-red-500/10 p-2 text-red-600 dark:text-red-400">
                  <p className="text-[10px] font-medium">{t('etl.status_error')}</p>
                  {/* A SQL error is one long unbroken string with no spaces to
                      wrap at, so it widened the pane instead of fitting in it.
                      Capped and scrolled on its own: a DuckDB internal error
                      carries a ~60-frame stack trace, which would otherwise push
                      everything below it out of reach. */}
                  <p className="mt-0.5 max-h-64 overflow-y-auto break-all font-mono text-[10px] whitespace-pre-wrap">
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

/** A value plus a copy button: it is meant to be pasted into another tool, and a
 *  long path is impractical to select by hand in a narrow sidebar. */
function CopyableValue({ value, mono = true }: { value: string; mono?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* break-all, not break-words: a path has no spaces to wrap on, so it would
          otherwise widen the whole sidebar. */}
      <code
        className={cn(
          'block min-w-0 flex-1 break-all rounded bg-muted/50 px-1.5 py-1 text-[10px] leading-relaxed',
          !mono && 'font-sans',
        )}
      >
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            aria-label={t('files.copy')}
            // items-center on the row centres the button against the whole code
            // block; a hand-tuned top margin only lined up on a one-line value.
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? t('common.copied') : t('files.copy')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * How to reach this database from outside Linkr.
 *
 * What that means depends on the source, so this shows what applies: the file
 * path for a DuckDB/SQLite database, the directory for a folder of Parquet
 * tables, host/port/database for a network engine. The password is never part of
 * it — the server does not return it.
 */
function ConnectionInfoBlock({ info }: { info: DatabaseConnectionInfo }) {
  const { t } = useTranslation()

  if (info.kind === 'external') {
    const dsn = [
      info.host && `host=${info.host}`,
      info.port != null && `port=${info.port}`,
      info.database && `dbname=${info.database}`,
      info.username && `user=${info.username}`,
    ].filter(Boolean).join(' ')
    return (
      <div className="space-y-1.5 border-t pt-3">
        <span className="block mb-2 text-muted-foreground">{t('etl.pipeline_db_connection')}</span>
        {info.host && <DetailRow label={t('etl.pipeline_db_host')} value={info.host} />}
        {info.port != null && <DetailRow label={t('etl.pipeline_db_port')} value={String(info.port)} />}
        {info.database && <DetailRow label={t('etl.pipeline_db_database')} value={info.database} />}
        {info.schemaName && <DetailRow label={t('etl.pipeline_db_schema_name')} value={info.schemaName} />}
        {info.username && <DetailRow label={t('etl.pipeline_db_user')} value={info.username} />}
        {dsn && <CopyableValue value={dsn} />}
        <p className="text-[10px] text-muted-foreground/70">{t('etl.pipeline_db_no_password')}</p>
      </div>
    )
  }

  // A Parquet source has no single path: each table is its own blob, and the
  // directory holding them is the shared content-addressed store (other sources'
  // files live there too, none with a .parquet suffix). So list table → path.
  if (info.kind === 'parquet-folder') {
    if (info.tables.length === 0) return null
    return (
      <div className="space-y-1.5 border-t pt-3">
        {/* block + margin, not the parent's space-y: this label heads a list of
            table/path pairs, so it needs more air under it than the pairs need
            between themselves, or it reads as part of the first entry. */}
        <span className="block mb-2 text-muted-foreground">
          {t('etl.pipeline_db_parquet_tables', { count: info.tables.length })}
        </span>
        <ParquetTableList tables={info.tables} />
        <p className="text-[10px] text-muted-foreground/70">
          {t('etl.pipeline_db_parquet_blob_hint')}
        </p>
        {!info.exists && (
          <p className="text-[10px] text-amber-600 dark:text-amber-500">{t('etl.pipeline_db_missing')}</p>
        )}
      </div>
    )
  }

  if (!info.path) return null

  return (
    <div className="space-y-1.5 border-t pt-3">
      <span className="block mb-2 text-muted-foreground">{t('etl.pipeline_db_file')}</span>
      <CopyableValue value={info.path} />
      {/* An uploaded file is stored content-addressed: no .duckdb suffix, which a
          tool keying off the extension will refuse. Worth saying plainly. */}
      {info.blob && (
        <p className="text-[10px] text-muted-foreground/70">{t('etl.pipeline_db_blob_hint')}</p>
      )}
      {!info.exists && (
        <p className="text-[10px] text-amber-600 dark:text-amber-500">{t('etl.pipeline_db_missing')}</p>
      )}
    </div>
  )
}

/** Table → blob path for a Parquet source. Only a few rows are shown up front:
 *  a raw MIMIC import has 30+ tables, which would bury the rest of the sidebar. */
function ParquetTableList({ tables }: { tables: ParquetTablePath[] }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? tables : tables.slice(0, 4)
  const hidden = tables.length - visible.length

  return (
    // space-y-2.5 between tables against space-y-0.5 inside one: the name has to
    // group with its own path, not float between two.
    <div className="space-y-2.5">
      {visible.map((tb) => (
        <div key={tb.table} className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <code className="text-[10px] font-medium">{tb.table}</code>
            {!tb.exists && (
              <span className="text-[10px] text-amber-600 dark:text-amber-500">
                {t('etl.pipeline_db_table_missing')}
              </span>
            )}
          </div>
          {tb.paths.map((p) => (
            <CopyableValue key={p} value={p} />
          ))}
        </div>
      ))}
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-0.5 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {expanded
            ? t('common.show_less')
            : t('etl.pipeline_db_show_all_tables', { count: hidden })}
        </button>
      )}
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
  const [connInfo, setConnInfo] = useState<DatabaseConnectionInfo | null>(null)

  // How to reach the database from outside Linkr. Server mode only: the browser
  // build keeps its data inside the WASM sandbox, where there is no path to give.
  useEffect(() => {
    if (!ds?.id || !isServerMode()) {
      setConnInfo(null)
      return
    }
    let cancelled = false
    fetchDatabaseConnectionInfo(ds.id)
      .then((r) => { if (!cancelled) setConnInfo(r) })
      .catch(() => { if (!cancelled) setConnInfo(null) })
    return () => { cancelled = true }
  }, [ds?.id])

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
            <DetailRow label={t('etl.pipeline_db_name')} value={localized(ds.name, i18n.language)} />
            <DetailRow label={t('etl.pipeline_db_engine')} value={(ds.connectionConfig && 'engine' in ds.connectionConfig ? ds.connectionConfig.engine : undefined) ?? '—'} />
            {ds.schemaMapping?.presetLabel && (
              <DetailRow label={t('etl.pipeline_db_schema')} value={localized(ds.schemaMapping.presetLabel, i18n.language)} />
            )}
            <DetailRow label={t('etl.pipeline_db_type')} value={ds.sourceType ?? '—'} />
            {connInfo && <ConnectionInfoBlock info={connInfo} />}
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
                <SectionLabel as="h4" className="mb-2">
                  {t('etl.sidebar_overview')}
                </SectionLabel>
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
                  <SectionLabel as="h4" className="mb-2">
                    {t('etl.sidebar_gender')}
                  </SectionLabel>
                  <GenderBar distribution={stats.genderDistribution} />
                </div>
              )}

              {/* Descriptive stats */}
              {stats.descriptiveStats.ageMean != null && (
                <div className="border-t pt-3">
                  <SectionLabel as="h4" className="mb-2">
                    {t('etl.sidebar_age_stats')}
                  </SectionLabel>
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
                  <SectionLabel as="h4" className="mb-2">
                    {t('etl.sidebar_visit_stats')}
                  </SectionLabel>
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
                  <SectionLabel as="h4" className="mb-2">
                    {t('etl.sidebar_tables')} ({stats.tableCounts.length})
                  </SectionLabel>
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
      // A held run is still 'running' in the history — that is what lets a
      // resume continue it — but a spinner claims work is happening, so the
      // panel asks for this status explicitly instead.
      case 'paused': return <Pause size={12} className="text-amber-500" />
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
  const pausedRun = useEtlStore((s) => s.pausedRun)
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
          // Paused counts as mid-run — `running` is false there, so without this
          // the button stayed live and deleted the entry Resume writes into,
          // leaving the resumed scripts with nowhere to record their result.
          disabled={!canWrite || running || !!pausedRun}
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
                <RunStatusIcon status={run.id === pausedRun?.runId ? 'paused' : run.status} />
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
                      /* Keyed on fileId, not the log id: the latter embeds
                         Date.now(), and setScriptStatus dedupes on fileId — so
                         fileId is what is unique within a run, and it stays
                         stable when a resumed script re-logs itself. */
                      <div key={script.fileId} className="flex items-center gap-2 text-xs">
                        <RunStatusIcon status={script.status} />
                        <span className={cn('flex-1 truncate font-mono', script.status === 'error' && 'text-red-500')}>
                          {file?.name ?? script.fileId}
                        </span>
                        {script.durationMs != null && (
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {formatDuration(script.durationMs)}
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
                          className="max-h-64 overflow-y-auto break-all font-mono text-[10px] whitespace-pre-wrap text-red-600 dark:text-red-400"
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
  /** The selected node, so its card can show it — the keyboard moves act on it. */
  selectedNodeId: string | null
  /** Clicking the empty space around the cards clears the selection. */
  onClearSelection: () => void
  /** Run a single script as its own run, from the card's play button. */
  onRunScript?: (file: EtlFile) => void
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
  selectedNodeId,
  onClearSelection,
  onRunScript,
  onBrowseSchema,
}: ScriptOrderListProps) {
  const { t, i18n } = useTranslation()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  // Columns are chosen from the space actually available, not a breakpoint: this
  // pane is resizable (the detail sidebar takes from it), so a media query would
  // describe the window rather than the list.
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const columns = columnCountFor(width - 32, sqlFiles.length)
  const columnised = useMemo(() => splitIntoColumns(sqlFiles, columns), [sqlFiles, columns])

  const columnLengths = useMemo(() => columnised.map((c) => c.length), [columnised])

  const persistOrder = useCallback(
    (reordered: EtlFile[]) => {
      reordered.forEach((file, idx) => {
        if (file.order !== idx) {
          updateFile(file.id, { order: idx })
        }
      })
    },
    [updateFile],
  )

  /** Move the file at `from` to position `to` in the single pipeline sequence. */
  const moveTo = useCallback(
    (from: number, to: number) => {
      const clamped = Math.max(0, Math.min(sqlFiles.length - 1, to))
      if (from < 0 || from === clamped) return
      persistOrder(arrayMove(sqlFiles, from, clamped))
    },
    [sqlFiles, persistOrder],
  )

  /**
   * Apply a drop.
   *
   * Each column is its own SortableContext plus a droppable container (id
   * `column:<n>`), which is dnd-kit's standard multi-container sortable setup.
   * That gives real drop targets for the two cases a single list cannot express:
   * releasing on a column's empty space, and releasing past the last card. The
   * columns are only a presentation of ONE sequence, so a column + row position
   * is converted back into a single pipeline index here.
   */
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over) return
      const oldIndex = sqlFiles.findIndex((f) => f.id === active.id)
      if (oldIndex < 0) return

      const overId = String(over.id)
      const zoneMatch = /^column:(\d+):(start|end)$/.exec(overId)

      if (zoneMatch) {
        const col = Number(zoneMatch[1])
        if (col >= columnLengths.length) return


        // A zone marks the gap it sits in, and the useful move across that gap is
        // into the NEIGHBOURING column: the zone above a column means "foot of the
        // previous one", the zone below means "head of the next one".
        //
        // Reading it as "head/foot of THIS column" instead is what made a
        // mid-column card land at its own column's edge — the card had not crossed
        // anything, which is the only reason to aim at a gap in the first place.
        const atStart = zoneMatch[2] === 'start'
        const neighbour = atStart ? col - 1 : col + 1
        // The outermost gaps render no zone, so there is always a neighbour here.
        if (neighbour < 0 || neighbour >= columnLengths.length) return

        moveTo(
          oldIndex,
          atStart
            ? columnDropIndex(columnLengths, neighbour)
            : columnStartIndex(columnLengths, neighbour),
        )
        return
      }


      if (active.id === over.id) return
      const newIndex = sqlFiles.findIndex((f) => f.id === overId)
      if (newIndex < 0) return
      moveTo(oldIndex, newIndex)
    },
    [sqlFiles, moveTo, columnLengths],
  )

  /**
   * Move the selected card with the arrow keys, held with Cmd/Ctrl+Shift.
   *
   * Bound to the LIST, not to each card, and driven by `selectedNodeId` rather
   * than by DOM focus: a move across a column boundary reparents the card's node
   * into the other column's container, and the browser drops focus on a
   * reparented element. A per-card handler therefore died exactly when the card
   * reached a column edge and the next press had to cross — which looked like the
   * selection being lost at the top of a column.
   *
   * Alt is avoided deliberately: on a Mac layout it produces dead keys. A bare
   * arrow would fight the browser's scrolling and dnd-kit's keyboard sensor.
   */
  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || !event.shiftKey || !selectedNodeId) return
      const index = sqlFiles.findIndex((f) => f.id === selectedNodeId)
      if (index < 0) return

      const to = event.key === 'ArrowUp' ? index - 1
        : event.key === 'ArrowDown' ? index + 1
        : event.key === 'ArrowLeft' ? columnNeighbourIndex(columnLengths, index, -1)
        : event.key === 'ArrowRight' ? columnNeighbourIndex(columnLengths, index, 1)
        : null
      if (to === null) return

      event.preventDefault()
      moveTo(index, to)
    },
    [sqlFiles, moveTo, columnLengths, selectedNodeId],
  )

  // Also bound on the document: a reparent can leave focus on <body>, where a
  // container-scoped handler would never see the keydown. Guarded by there being
  // a selected script, so it cannot swallow the combo elsewhere in the app.
  useEffect(() => {
    if (!selectedNodeId) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal the combo from a text field or the code editor.
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      handleListKeyDown(event as unknown as React.KeyboardEvent)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedNodeId, handleListKeyDown])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto"
      // Clicking the empty space deselects. Testing for the absence of a node
      // ancestor, rather than target === currentTarget: the padding wrapper and
      // the column divs are all "background" too, and each would otherwise need
      // its own handler.
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('[data-pipeline-node]')) {
          onClearSelection()
        }
      }}
    >
      <div className="mx-auto space-y-0 p-4" style={{ maxWidth: columns > 1 ? undefined : '32rem' }}>
        {/* Source node (static) */}
          {/* Always shown, even undefined: a pipeline whose databases are missing
              still HAS a source and a target conceptually, and hiding the widget
              left the diagram looking complete while nothing could run. Red says
              it must be set. Databases are instance-local, so a git-imported
              pipeline always lands here. */}
          <>
              <button
                data-pipeline-node
                onClick={() => onSelectNode('__source__')}
                // Double-click goes straight to the tables, the same as the
                // sidebar's Browse schema — one click to inspect, two to open.
                onDoubleClick={() => { if (sourceDs) onBrowseSchema?.(sourceDs.id) }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border-2 bg-card px-3 py-2.5 text-left transition-colors',
                  hasSource
                    ? 'border-orange-500/30 hover:border-orange-500/60'
                    : 'border-destructive/50 hover:border-destructive',
                  // Same selected treatment as a script card, so "what the
                  // sidebar is describing" reads the same across all three.
                  selectedNodeId === '__source__' && 'bg-primary/[0.07] shadow-sm',
                )}
              >
                <div className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                  hasSource ? 'bg-orange-500/15' : 'bg-destructive/10',
                )}>
                  <Database size={16} className={hasSource ? 'text-orange-600 dark:text-orange-400' : 'text-destructive'} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{t('etl.source')}</div>
                  {sourceDs
                    ? <div className="text-[10px] text-muted-foreground">{localized(sourceDs.name, i18n.language)}</div>
                    : <div className="text-[10px] text-destructive">{t('etl.pipeline_define_source')}</div>}
                </div>
              </button>
              {/* Plain spacing, no connector line: the columns start with their
                  own reserved drop-zone strip, and a stub rule pointing into it
                  read as an artefact rather than as a link. Kept to h-1.5: the
                  column's own drop-zone strip already carries a mb-1, so the two
                  add up to the same gap the strip has below it. */}
              <div className="h-1.5" />
          </>

          {/* Sortable script list */}
          <DndContext
            sensors={sensors}
            // Stock collision detection, kept pure. The side-band highlight is
            // computed from pointermove instead — a setState inside a custom
            // detector re-renders, which recomputes collisions, which froze the
            // page as soon as a drag started.
            // Pointer first, geometry as fallback. The edge zones are much shorter
            // than a card, so any purely geometric detection (closestCenter /
            // closestCorners measures the DRAGGED RECT's centre or corners) puts a
            // neighbouring card closer than the zone and the zone can never win —
            // it rendered but was unselectable. pointerWithin picks whatever the
            // pointer is actually inside, which is what "drop it on the zone"
            // means; it returns nothing over a gap, hence the fallback.
            collisionDetection={collisionDetection}
            // Re-measure droppables continuously. The default (WhileDragging at
            // "optimized" frequency) measures once at drag start, but the sorting
            // strategy then animates the cards to open a gap, which moves the
            // in-flow edge zones with them. Their cached rects went stale exactly
            // while the pointer was aiming at them, so the zone that won the
            // collision was not the one on screen — a drop resolved against the
            // card's own column instead of the targeted one.
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            // No modifiers. restrictToParentElement clamps the dragged card to
            // its PARENT — which, now that each column wraps its own cards, is a
            // single column. The card physically could not travel far enough for
            // the pointer to reach another column's drop zone, so a cross-column
            // drop was unreachable and the card snapped back.
            onDragEnd={handleDragEnd}
          >
            <div
              className="grid items-start gap-x-4"
              style={{ gridTemplateColumns: `repeat(${columnised.length}, minmax(0, 1fr))` }}
            >
              {columnised.map((column, colIdx) => {
                // Where this column starts in the pipeline, so every card keeps
                // its true execution number rather than restarting at 1.
                const offset = columnised
                  .slice(0, colIdx)
                  .reduce((n, c) => n + c.length, 0)
                return (
                  <ScriptColumn
                    key={colIdx}
                    colIdx={colIdx}
                    isLastColumn={colIdx === columnised.length - 1}
                    items={column.map((f) => f.id)}
                  >
                    {column.map((file, idx) => (
                      <SortableScriptRow
                        key={file.id}
                        file={file}
                        index={offset + idx}
                        log={scriptStatuses.get(file.id)}
                        isLast={idx === column.length - 1}
                        onSelectFile={onSelectFile}
                        onSelectNode={onSelectNode}
                        isSelected={selectedNodeId === file.id}
                        onRunScript={onRunScript}
                        onToggleDisabled={(id) => updateFile(id, { disabled: !file.disabled })}
                      />
                    ))}
                  </ScriptColumn>
                )
              })}
            </div>
          </DndContext>

          {/* Target node (static) */}
          <>
              {/* Mirrors the spacing under the source node. */}
              {sqlFiles.length > 0 && <div className="h-1.5" />}
              <button
                data-pipeline-node
                onClick={() => onSelectNode('__target__')}
                onDoubleClick={() => { if (targetDs) onBrowseSchema?.(targetDs.id) }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border-2 bg-card px-3 py-2.5 text-left transition-colors',
                  hasTarget
                    ? 'border-emerald-500/30 hover:border-emerald-500/60'
                    : 'border-destructive/50 hover:border-destructive',
                  selectedNodeId === '__target__' && 'bg-primary/[0.07] shadow-sm',
                )}
              >
                <div className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                  hasTarget ? 'bg-emerald-500/15' : 'bg-destructive/10',
                )}>
                  <Database size={16} className={hasTarget ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{t('etl.target')}</div>
                  {targetDs
                    ? <div className="text-[10px] text-muted-foreground">{localized(targetDs.name, i18n.language)}</div>
                    : <div className="text-[10px] text-destructive">{t('etl.pipeline_define_target')}</div>}
                </div>
              </button>
          </>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortableScriptRow — individual draggable script in the list
// ---------------------------------------------------------------------------

/**
 * Show `true` once the pointer has rested on the element for `delay` ms.
 *
 * Radix's own `delayDuration` starts counting on pointer-enter and ignores
 * movement, so a pointer merely crossing the handle still pops the tooltip. Here
 * every move restarts the timer, so the hint only appears on a deliberate,
 * stationary hover.
 */
function useRestingHover(delay = 1000) {
  const [resting, setResting] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const restart = useCallback(() => {
    clear()
    timer.current = setTimeout(() => setResting(true), delay)
  }, [clear, delay])

  const onPointerLeave = useCallback(() => {
    clear()
    setResting(false)
  }, [clear])

  // A move while the tooltip is already up must not restart the timer, or the
  // hint would flicker as the pointer drifts over the handle.
  const onPointerMove = useCallback(() => {
    if (!resting) restart()
  }, [resting, restart])

  useEffect(() => clear, [clear])

  return {
    open: resting,
    handlers: { onPointerEnter: restart, onPointerMove, onPointerLeave },
  }
}

/**
 * Prefer whatever the pointer is inside, and fall back to geometry.
 *
 * A module-level pure function on purpose: computing this inside the component
 * and touching state from it is what caused an unbounded re-render loop earlier
 * (collision detection runs on every drag move, setState re-renders, which
 * recomputes collisions). Nothing here reads or writes React state.
 */
const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args)
  // An edge zone can overlap the cards around it, so the pointer may be inside
  // BOTH. pointerWithin ranks by distance to the rect corners, which favours the
  // taller card. An explicit zone wins: the pointer being inside one is an
  // unambiguous intent.
  const zone = byPointer.find((c) => String(c.id).startsWith('column:'))
  if (zone) return [zone]
  return byPointer.length > 0 ? byPointer : closestCenter(args)
}

/**
 * One newspaper column of the pipeline: a sortable context over its own cards,
 * inside a droppable container.
 *
 * This is dnd-kit's standard multi-container sortable arrangement. The container
 * droppable is what makes a column's EMPTY space a valid target, so a card can be
 * dropped past the last row or into a short column — the two moves a single flat
 * list cannot express, and the reason a card at the top or bottom of its column
 * previously had nowhere to go.
 */
function ScriptColumn({
  colIdx,
  isLastColumn,
  items,
  children,
}: {
  colIdx: number
  isLastColumn: boolean
  items: string[]
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const dragging = !!useDndContext().active

  return (
    <div className="relative min-w-0">
      {/* Both zones are absolutely positioned, OUTSIDE the sortable's flow. In
          flow they were pushed around by the transforms the sorting strategy
          applies to open a gap, so the zone under the pointer stopped being the
          one on screen and a drop resolved against the wrong column. */}
      {/* No zone above the FIRST column: a zone means "cross into the neighbouring
          column", and there is none that way. The label names the destination,
          since that is what the zone actually does. */}
      {colIdx > 0 && (
        <ColumnEdgeZone
          id={`column:${colIdx}:start`}
          dragging={dragging}
          label={t('etl.pipeline_drop_at_start')}
          className="absolute inset-x-0 top-0 z-20"
        />
      )}

      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {/* Padding reserves the two strips' space so revealing them mid-drag
            never shifts the cards. */}
        <div className="pb-8 pt-8">{children}</div>
      </SortableContext>

      {/* The foot holds two things that never coexist: the "continues" note at
          rest, the drop zone during a drag. Same box, so the height is stable. */}
      <div className="absolute inset-x-0 bottom-0 z-20 h-7">
        {/* Likewise no zone below the LAST column. */}
        {dragging && !isLastColumn ? (
          <ColumnEdgeZone
            id={`column:${colIdx}:end`}
            dragging
            label={t('etl.pipeline_drop_at_end')}
            className="absolute inset-0"
          />
        ) : (
          !isLastColumn && (
            <div className="absolute inset-x-0 top-1 flex items-center justify-end gap-1 pr-1 text-[10px] text-muted-foreground">
              {t('etl.pipeline_continues_next_column')}
              <CornerDownRight size={11} />
            </div>
          )
        )}
      </div>
    </div>
  )
}

/**
 * A drop target at the very top or bottom of a column — the positions a
 * card-to-card sortable cannot express, and the reason a card first or last in
 * its column previously had nowhere to land.
 *
 * Kept in the layout at rest (as empty reserved space) so that showing it during a
 * drag does not move the cards under the pointer.
 */
function ColumnEdgeZone({
  id,
  dragging,
  label,
  className,
}: {
  id: string
  dragging: boolean
  label: string
  className?: string
}) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mb-1 flex h-7 items-center justify-center rounded-md border border-dashed text-[10px] transition-colors',
        dragging
          ? isOver
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground/60'
          : 'border-transparent text-transparent',
        className,
      )}
    >
      {dragging ? label : null}
    </div>
  )
}

function SortableScriptRow({
  file,
  index,
  log,
  isLast,
  onSelectFile,
  onSelectNode,
  isSelected,
  onRunScript,
  onToggleDisabled,
}: {
  file: EtlFile
  index: number
  log: import('@/types').EtlRunLog | undefined
  isLast: boolean
  onSelectFile?: (fileId: string) => void
  onSelectNode: (id: string) => void
  isSelected: boolean
  onRunScript?: (file: EtlFile) => void
  onToggleDisabled: (fileId: string) => void
}) {
  const { t } = useTranslation()
  const running = useEtlStore((s) => s.pipelineRunning)
  const hint = useRestingHover()
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
        // Focusable so Tab walks the pipeline in execution order. Focus does NOT
        // select: the move shortcuts read the selection from state, and selecting
        // on focus made a Tab pass rewrite the sidebar on every card.
        tabIndex={0}
        data-pipeline-node={file.id}
        aria-label={t('etl.pipeline_move_hint_aria', { name: file.name })}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-lg border-2 bg-card px-2 py-2 transition-colors relative overflow-hidden',
          // The selected styling below is the signal; a focus ring on top of it
          // would double up, and it is the harsher of the two.
          'outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
          borderClass,
          // A tinted background rather than a ring: the border already encodes run
          // status (so it must stay visible), and a hard outline around a card
          // this small reads as an error state.
          isSelected && 'bg-primary/[0.07] shadow-sm',
        )}
      >
        {/* Left accent strip — it thickens for the selected card, which reads as
            "this one" without adding a second colour to a card that already
            carries a status border. */}
        <div
          className={cn(
            'absolute left-0 top-0 bottom-0 rounded-l-md transition-all',
            isSelected ? 'w-1.5' : 'w-1',
            accentColor,
          )}
        />

        {/* Drag handle. The reorder hint hangs off it rather than sitting above
            the list: it is advice about this gesture, wanted the first time and
            noise on every visit after. */}
        <Tooltip open={hint.open}>
          <TooltipTrigger asChild>
            <button
              {...attributes}
              {...listeners}
              {...hint.handlers}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing ml-1"
            >
              <GripVertical size={14} />
            </button>
          </TooltipTrigger>
          {/* pointer-events-none: the content is positioned next to the handle
              and would otherwise take the pointer itself, firing pointerleave on
              the trigger — which closed the tooltip the instant it opened. */}
          <TooltipContent side="right" className="pointer-events-none max-w-[280px]">
            {t('etl.pipeline_reorder_hint')}
          </TooltipContent>
        </Tooltip>

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
          {/* Duration only. `rowsAffected` is the row count of the statement's
              RESULT SET, not what it wrote: an ETL script full of INSERTs ends on
              a statement returning nothing, so the card read "0 rows" for a
              script that had just written millions.

              The row keeps its height whether or not a duration is in it, so a
              finishing script doesn't grow its card and shift every card below
              it down. */}
          <div className="flex h-3.5 items-center gap-2 text-[10px] leading-none text-muted-foreground">
            {log?.durationMs != null && !isDisabled && (
              <span>{formatDuration(log.durationMs)}</span>
            )}
          </div>
        </div>

        {/* Run just this script — its own run, from scratch. Refused while
            something is already in flight: the store allows one run at a time,
            and a click that silently did nothing would read as a broken button. */}
        {onRunScript && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => { e.stopPropagation(); onRunScript(file) }}
                disabled={running}
                className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-emerald-600 disabled:pointer-events-none disabled:opacity-30"
              >
                <Play size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px]">{t('etl.pipeline_run_script_hint')}</TooltipContent>
          </Tooltip>
        )}

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
