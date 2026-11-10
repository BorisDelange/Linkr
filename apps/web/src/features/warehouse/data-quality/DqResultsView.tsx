import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { ShieldCheck, Play, Loader2, PanelRight, BarChart3, History, X, AlertTriangle, Square, Pause, RotateCcw, FileText, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useServerRun } from '@/hooks/use-server-run'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { isServerMode } from '@/lib/api-client'
import { formatDuration } from '@/lib/format-helpers'
import { readStoredReport, type DqCheck, type DqReport } from '@/lib/duckdb/data-quality'
import type { DqRunHistoryEntry } from '@/types'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import {
  failuresFirst, groupPathLabel, isProblem, nodeKeys, pruneTree, resultRows, resultTree, type DqResultRow,
} from '@/lib/dq-report/tally'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DqScoreBadge } from './DqScoreBadge'
import { DqCheckDetailPanel } from './DqCheckDetailPanel'
import { DqHistoryDialog } from './DqHistoryDialog'
import { DqResultsSummary } from './results/DqResultsSummary'
import { DqResultsTree } from './results/DqResultsTree'
import { DqReportDialog } from './results/DqReportDialog'
import { useFoldState } from './use-fold-state'
import { CATEGORY_COLORS, STATUS_CONFIG, SEVERITY_CONFIG } from './DqConstants'
import {
  clearDqRunError, compileDqRun, dqRunEta, dqRunReport, dqRunSignature, getDqRun, lastDqReport, startDqRun, stopDqRun,
  watchDqRun, type DqRunKind, type DqRunState,
} from './dq-run'

interface Props {
  /** A rule set's run or a quality profile's (server mode). */
  runKind: DqRunKind
  /** The rule set's or the profile's id: the run's scope. */
  runKey: string
  /** The run's name in the jobs panel (server mode). */
  runLabel?: string
  dataSourceId: string
  /** What a run executes (`runnableChecks`, or a profile's `profileRunChecks`). */
  checks: DqCheck[]
  /** The past runs, for the History dialog; the newest is shown until a run starts. */
  history?: {
    entries: DqRunHistoryEntry[]
    onDelete: (id: string) => void
    onClear: () => void
  }
  /** Front-only mode: called after a scan with the full report, to record it. */
  onScanComplete?: (report: DqReport) => void
  /** Server mode: a run ended, recorded by the server — the history and the last score to read again. */
  onServerRunDone?: () => void
  /** Mount function to call before scanning (e.g. mountProjectSources). */
  onBeforeScan?: () => Promise<void>
  /** Opens the rule set's investigation console with this query. */
  onInvestigate?: (sql: string) => void
  /** A quality profile's: what its report is titled and run on; offers the Report button. */
  reportMeta?: { title: string; description?: string; version?: string; databaseName: string }
}

type Row = DqResultRow
type ResultsView = 'tree' | 'table'
type StatusFilter = 'all' | 'problems' | 'pass' | 'not_applicable'

const VIEW_KEY = 'dq:results-view'
// Up to this many results every group starts open; beyond, only those with a failure.
const OPEN_ALL_UP_TO = 60

function readView(): ResultsView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'tree'
  } catch {
    return 'tree'
  }
}

const storedReport = (entry: { report?: unknown }) => readStoredReport(entry.report)

const keepStatus: Record<StatusFilter, (row: Row) => boolean> = {
  all: () => true,
  problems: (r) => isProblem(r.result.status),
  pass: (r) => r.result.status === 'pass',
  not_applicable: (r) => r.result.status === 'not_applicable',
}

export function DqResultsView({
  runKind, runKey, runLabel, dataSourceId, checks, history, onScanComplete, onServerRunDone, onBeforeScan, onInvestigate, reportMeta,
}: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const serverMode = isServerMode()

  // Front-only mode: the run outlives this view (dq-run.ts), it is read from there.
  const local = useSyncExternalStore(
    useCallback((notify: () => void) => watchDqRun(runKey, notify), [runKey]),
    () => getDqRun(runKey),
  )
  // Server mode: the server's run, read again while it goes on.
  const server = useServerRun<DqRunState>(runKind, runKey, serverMode && !!runKey)
  const serverRun = server.run
  const signature = useMemo(() => dqRunSignature(checks), [checks])
  const sameChecks = serverRun?.state.meta?.signature === signature

  const loading = serverMode ? server.active : local.running
  const pausing = serverRun?.status === 'pausing'
  const paused = serverMode && server.resumable
  const scanError = serverMode
    ? server.error ?? (serverRun?.status === 'failed' ? serverRun.error : null)
    : local.error
  const [errorClosed, setErrorClosed] = useState<string | null>(null)

  // A past run picked from the history, shown until closed or a new run starts.
  const [restored, setRestored] = useState<DqReport | null>(null)
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null)
  const [detailVisible, setDetailVisible] = useState(true)
  const [summaryVisible, setSummaryVisible] = useState(true)
  const [view, setViewState] = useState<ResultsView>(readView)
  const setView = (next: ResultsView) => {
    setViewState(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* private window: the choice just doesn't stick */ }
  }
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [reportOpen, setReportOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  // Set when the displayed report comes from a past run (not a fresh scan) —
  // drives the "viewing a historical run" banner. Cleared on a new scan.
  const [viewedRunAt, setViewedRunAt] = useState<string | null>(null)

  const newest = useMemo(
    () => (history?.entries ?? []).reduce<DqRunHistoryEntry | null>((a, b) => (!a || b.startedAt > a.startedAt ? b : a), null),
    [history?.entries],
  )
  const newestReport = useMemo(() => (newest ? storedReport(newest) : null), [newest])

  // A server run that ended while this view showed it: the server recorded it.
  const wasActive = useRef(false)
  useEffect(() => {
    if (wasActive.current && !server.active && serverRun?.status === 'done') onServerRunDone?.()
    wasActive.current = server.active
  }, [server.active, serverRun?.status, onServerRunDone])

  const startRun = useCallback(async () => {
    setRestored(null)
    setSelectedCheckId(null)
    setViewedRunAt(null)
    setErrorClosed(null)
    const label = runLabel ?? t('data_quality.run_scan')
    if (!serverMode) {
      startDqRun({
        runKey, dataSourceId, checks,
        prepare: onBeforeScan ?? (async () => {}),
        onComplete: (r: DqReport) => onScanComplete?.(r),
      })
      return
    }
    try {
      await onBeforeScan?.()
      await server.start(await compileDqRun(dataSourceId, checks, label))
    } catch {
      // The view shows the request's error (`server.error`).
    }
  }, [serverMode, runKey, dataSourceId, checks, runLabel, onBeforeScan, onScanComplete, server, t])

  const handleRunScan = () => {
    if (!loading) void startRun()
  }
  const handleResume = () => {
    setRestored(null)
    setViewedRunAt(null)
    setErrorClosed(null)
    void server.resume().catch(() => {})
  }
  const handleStop = () => (serverMode ? void server.pause().catch(() => {}) : stopDqRun(runKey))

  // The run going on or paused, as far as it went — when it runs the checks shown.
  const serverReport = useMemo(
    () => (serverRun && sameChecks && serverRun.status !== 'cancelled'
      ? dqRunReport(dataSourceId, checks, serverRun.state, serverRun.finishedAt ?? serverRun.updatedAt)
      : null),
    [serverRun, sameChecks, dataSourceId, checks],
  )
  const report = restored ?? (serverMode
    ? serverReport ?? (loading || paused ? null : newestReport)
    : (local.running ? null : lastDqReport(runKey) ?? newestReport))

  const done = serverMode ? serverRun?.state.next ?? 0 : local.done
  const total = serverMode ? serverRun?.state.total ?? checks.length : local.total
  const eta = serverMode && loading && sameChecks && serverRun ? dqRunEta(checks, serverRun.state, newestReport) : null

  const handleRestore = useCallback((entry: { report?: unknown; startedAt: string }) => {
    const past = storedReport(entry)
    if (!past) return
    setRestored(past)
    setSelectedCheckId(null)
    setViewedRunAt(entry.startedAt)
  }, [])

  const rows = useMemo<Row[]>(() => (report ? resultRows(report.checks, report.results) : []), [report])

  const tree = useMemo(() => failuresFirst(resultTree(rows, lang)), [rows, lang])
  const shownTree = useMemo(() => (statusFilter === 'all' ? tree : pruneTree(tree, keepStatus[statusFilter])), [tree, statusFilter])
  const openByDefault = useMemo(() => {
    if (rows.length <= OPEN_ALL_UP_TO) return null
    const open = new Set<string>()
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        if (n.kind === 'ruleSet' || n.tally.failed + n.tally.errors > 0) open.add(n.key)
        walk(n.children)
      }
    }
    walk(tree)
    return open
  }, [rows.length, tree])
  const fold = useFoldState((key) => !openByDefault || openByDefault.has(key))
  const treeKeys = useMemo(() => nodeKeys(shownTree), [shownTree])
  const allOpen = treeKeys.every((k) => fold.isOpen(k))
  const allClosed = treeKeys.every((k) => !fold.isOpen(k))

  // A profile's run draws from several rule sets: say which one each check is from.
  const fromSeveralRuleSets = !!report?.checks.some((c) => c.ruleSetName)

  const columns = useMemo<DataTableColumn<Row>[]>(() => [
    ...(fromSeveralRuleSets ? [{
      id: 'ruleSet',
      header: t('data_quality.col_rule_set'),
      accessor: (r: Row) => r.check.ruleSetName ?? '',
      filter: 'select' as const,
      size: 150, minSize: 80,
      tooltip: true as const,
    }] : []),
    {
      id: 'status',
      header: t('data_quality.col_status'),
      accessor: (r) => r.result.status,
      filter: 'select',
      selectOptionLabel: (v) => t(`data_quality.status_${v}`),
      size: 90, minSize: 60, center: true,
      cell: (r) => {
        const cfg = STATUS_CONFIG[r.result.status]
        const Icon = cfg.icon
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center justify-center" aria-label={t(`data_quality.${cfg.label}`)}>
                <Icon size={14} className={cfg.color} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t(`data_quality.${cfg.label}`)}</TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: 'check',
      header: t('data_quality.col_check'),
      accessor: (r) => localized(r.check.name, lang) || localized(r.check.description, lang),
      filter: 'text',
      size: 260, minSize: 120,
      tooltip: 'font-medium',
    },
    {
      id: 'category',
      header: t('data_quality.col_category'),
      accessor: (r) => t(`data_quality.category_${r.check.category}`),
      filter: 'select',
      size: 130, minSize: 80,
      cell: (r) => (
        <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', CATEGORY_COLORS[r.check.category])}>
          {t(`data_quality.category_${r.check.category}`)}
        </span>
      ),
    },
    {
      id: 'subcategory',
      header: t('data_quality.col_subcategory'),
      accessor: (r) => (r.check.subcategory ? t(`data_quality.subcategory_${r.check.subcategory}`) : ''),
      filter: 'select',
      size: 110, minSize: 70,
      cell: (r) => (r.check.subcategory
        ? <span className="text-muted-foreground">{t(`data_quality.subcategory_${r.check.subcategory}`)}</span>
        : <span className="text-muted-foreground/50">—</span>),
    },
    {
      id: 'group',
      header: t('data_quality.col_group'),
      accessor: (r) => groupPathLabel(r.check, lang),
      filter: 'select',
      size: 160, minSize: 70,
      tooltip: 'text-muted-foreground',
    },
    {
      id: 'violated',
      header: t('data_quality.col_violated'),
      accessor: (r) => (r.result.status === 'not_applicable' ? -1 : r.result.pctViolated),
      filter: 'none',
      size: 90, minSize: 60, center: true,
      cell: (r) => (
        <span className="tabular-nums">
          {r.result.status === 'not_applicable' ? '—' : `${r.result.pctViolated.toFixed(1)}%`}
        </span>
      ),
    },
    {
      id: 'severity',
      header: t('data_quality.col_severity'),
      accessor: (r) => r.check.severity,
      filter: 'select',
      selectOptionLabel: (v) => t(`data_quality.severity_${v}`),
      size: 90, minSize: 60, center: true,
      cell: (r) => {
        const cfg = SEVERITY_CONFIG[r.check.severity]
        const Icon = cfg.icon
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center justify-center" aria-label={t(`data_quality.severity_${r.check.severity}`)}>
                <Icon size={14} className={cfg.color} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t(`data_quality.severity_${r.check.severity}`)}</TooltipContent>
          </Tooltip>
        )
      },
    },
  ], [t, lang, fromSeveralRuleSets])

  const selectedItem = selectedCheckId
    ? rows.find((f) => f.check.id === selectedCheckId) ?? null
    : null

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          {loading ? (
            <Button size="sm" variant="outline" onClick={handleStop} disabled={pausing || !canWrite} className="h-6 gap-1 px-2 text-xs">
              {pausing ? <Loader2 size={12} className="animate-spin" /> : serverMode ? <Pause size={12} /> : <Square size={12} />}
              {serverMode ? (pausing ? t('data_quality.pausing_scan') : t('data_quality.pause_scan')) : t('data_quality.stop_scan')}
            </Button>
          ) : paused ? (
            <>
              <Button size="sm" onClick={handleResume} disabled={!canWrite} className="h-6 gap-1 px-2 text-xs">
                <Play size={14} />
                {t('data_quality.resume_scan')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmRestart(true)} disabled={!canWrite} className="h-6 gap-1 px-2 text-xs">
                <RotateCcw size={12} />
                {t('data_quality.restart_scan')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={handleRunScan} disabled={!canWrite || !checks.length || !dataSourceId} className="h-6 gap-1 px-2 text-xs">
              <Play size={14} />
              {t('data_quality.run_scan')}
            </Button>
          )}

          {history && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHistoryOpen(true)}
              className="h-6 gap-1 px-2 text-xs"
            >
              <History size={14} />
              {t('data_quality.history_title')}
            </Button>
          )}

          {reportMeta && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReportOpen(true)}
              disabled={!report || loading}
              className="h-6 gap-1 px-2 text-xs"
            >
              <FileText size={14} />
              {t('dq_report.button')}
            </Button>
          )}

          {loading && total > 0 && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              <span className="shrink-0 tabular-nums">{t('data_quality.progress', { done, total })}</span>
              {serverRun?.state.current && (
                <span className="min-w-0 truncate" title={serverRun.state.current.what}>· {serverRun.state.current.what}</span>
              )}
              {eta != null && <span className="shrink-0">· {t('run_steps.eta', { time: formatDuration(eta) })}</span>}
            </span>
          )}

          {paused && serverRun && (
            <span className="text-xs text-muted-foreground">
              {t(serverRun.status === 'interrupted' ? 'data_quality.scan_interrupted' : 'data_quality.scan_paused', { done, total })}
            </span>
          )}

          {report && !loading && !paused && <DqScoreBadge report={report} />}

          {report && !loading && !paused && (
            <span className="text-xs text-muted-foreground">
              {t('data_quality.checks_passed', { passed: report.summary.passed, total: report.summary.total - report.summary.notApplicable })}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {report && !loading && (
              <>
                {view === 'tree' && (
                  <>
                    <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                      <SelectTrigger size="xs" className="w-36 px-2 text-xs data-[size=xs]:h-6" aria-label={t('data_quality.results_status_filter')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper" align="end">
                        {(['all', 'problems', 'pass', 'not_applicable'] as const).map((f) => (
                          <SelectItem key={f} value={f}>{t(`data_quality.results_filter_${f}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" onClick={() => fold.setOpen(treeKeys, true)} disabled={!treeKeys.length || allOpen}>
                          <ChevronsUpDown size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.expand_all')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" onClick={() => fold.setOpen(treeKeys, false)} disabled={!treeKeys.length || allClosed}>
                          <ChevronsDownUp size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.collapse_all')}</TooltipContent>
                    </Tooltip>
                  </>
                )}
                <div className="flex items-center rounded-md border p-0.5">
                  {(['tree', 'table'] as const).map((v) => (
                    <Button
                      key={v}
                      variant={view === v ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setView(v)}
                      className="h-5 px-2 text-xs"
                    >
                      {t(`data_quality.results_view_${v}`)}
                    </Button>
                  ))}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={summaryVisible ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      onClick={() => setSummaryVisible(!summaryVisible)}
                    >
                      <BarChart3 size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('data_quality.results_summary_toggle')}</TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={detailVisible ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setDetailVisible(!detailVisible)}
                >
                  <PanelRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('data_quality.detail_title')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* A paused run of other checks than these resumes as it started. */}
        {paused && !sameChecks && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning-foreground">
            <AlertTriangle size={13} className="shrink-0" />
            <span>{t('data_quality.scan_checks_changed')}</span>
          </div>
        )}

        {/* Historical-run banner — shown when the table displays a past run. */}
        {viewedRunAt && !loading && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning-foreground">
            <History size={13} className="shrink-0" />
            <span>{t('data_quality.viewing_historical_run', { date: new Date(viewedRunAt).toLocaleString() })}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto h-5 w-5 text-warning-foreground hover:text-foreground"
              onClick={() => { setRestored(null); setViewedRunAt(null); setSelectedCheckId(null) }}
              title={t('common.close')}
            >
              <X size={13} />
            </Button>
          </div>
        )}

        {/* Scan-failure banner — surfaces an error that would otherwise be silent. */}
        {scanError && scanError !== errorClosed && !loading && (
          <div className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={scanError}>{t('data_quality.scan_failed', { message: scanError })}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto h-5 w-5 text-destructive"
              onClick={() => (serverMode ? setErrorClosed(scanError) : clearDqRunError(runKey))}
              title={t('common.close')}
            >
              <X size={13} />
            </Button>
          </div>
        )}

        {report && !loading && summaryVisible && (
          <div className="border-b">
            <DqResultsSummary rows={rows} />
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1">
          {!report && loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : !report ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <ShieldCheck size={32} className="mx-auto text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium text-foreground">{t('data_quality.no_results')}</p>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t('data_quality.no_results_description')}</p>
              </div>
            </div>
          ) : (
            <Allotment proportionalLayout={false}>
              <Allotment.Pane minSize={400}>
                {view === 'tree' ? (
                  <DqResultsTree
                    nodes={shownTree}
                    isOpen={fold.isOpen}
                    onToggle={fold.toggle}
                    selectedCheckId={selectedCheckId}
                    onSelect={(id) => {
                      setSelectedCheckId(id)
                      setDetailVisible(true)
                    }}
                    emptyMessage={t('common.no_results')}
                  />
                ) : (
                  <DataTable
                    pageSize={100}
                    data={rows}
                    columns={columns}
                    rowKey={(r) => r.check.id}
                    emptyMessage={t('data_quality.no_results')}
                    selectedRowKey={selectedCheckId}
                    onRowClick={(r) => {
                      setSelectedCheckId(r.check.id)
                      setDetailVisible(true)
                    }}
                  />
                )}
              </Allotment.Pane>

              <Allotment.Pane preferredSize={300} minSize={220} maxSize={500} visible={detailVisible}>
                <DqCheckDetailPanel item={selectedItem} onInvestigate={onInvestigate} />
              </Allotment.Pane>
            </Allotment>
          )}
        </div>
      </div>

      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_quality.restart_scan_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('data_quality.restart_scan_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { setConfirmRestart(false); void startRun() }}>
              {t('data_quality.restart_scan')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {reportMeta && report && (
        <DqReportDialog open={reportOpen} onOpenChange={setReportOpen} report={report} {...reportMeta} />
      )}

      {history && (
        <DqHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          {...history}
          onRestore={handleRestore}
        />
      )}
    </TooltipProvider>
  )
}
