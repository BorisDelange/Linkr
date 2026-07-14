import { useState, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { ShieldCheck, Play, Loader2, PanelRight, BarChart3, History, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { generateChecks, runAllChecks } from '@/lib/duckdb/data-quality'
import type { DqCheck, DqCheckResult, DqReport } from '@/lib/duckdb/data-quality'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DqCustomCheck } from '@/types'
import { useDqStore } from '@/stores/dq-store'
import { cn } from '@/lib/utils'
import { DqScoreBadge } from './DqScoreBadge'
import { DqCheckDetailPanel } from './DqCheckDetailPanel'
import { DqCategoryCharts } from './DqCategoryCharts'
import { DqHistoryDialog } from './DqHistoryDialog'
import { CATEGORY_COLORS, STATUS_CONFIG, SEVERITY_CONFIG } from './DqConstants'

interface Props {
  /** Rule set the history modal is scoped to. */
  ruleSetId?: string
  dataSourceId: string
  schemaMapping?: SchemaMapping
  customChecks?: DqCustomCheck[]
  /** Called after a successful scan with the full report. */
  onScanComplete?: (report: DqReport) => void
  /** Mount function to call before scanning (e.g. mountProjectSources). */
  onBeforeScan?: () => Promise<void>
}

interface Row {
  check: DqCheck
  result: DqCheckResult
}

export function DqResultsView({ ruleSetId, dataSourceId, schemaMapping, customChecks, onScanComplete, onBeforeScan }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const disabledCheckIds = useDqStore(
    (s) => s.dqRuleSets.find((rs) => rs.id === ruleSetId)?.disabledCheckIds,
  )

  const [report, setReport] = useState<DqReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null)
  const [detailVisible, setDetailVisible] = useState(true)
  const [chartsVisible, setChartsVisible] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Set when the displayed report comes from a past run (not a fresh scan) —
  // drives the "viewing a historical run" banner. Cleared on a new scan.
  const [viewedRunAt, setViewedRunAt] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  const handleRunScan = useCallback(async () => {
    if (loading) return
    cancelledRef.current = false
    setLoading(true)
    setReport(null)
    setSelectedCheckId(null)
    setViewedRunAt(null)
    setProgress({ done: 0, total: 0 })

    try {
      if (onBeforeScan) await onBeforeScan()

      const generated = await generateChecks(
        dataSourceId,
        schemaMapping,
        customChecks && customChecks.length > 0 ? customChecks : undefined,
      )
      // Disabled checks (custom or built-in) are excluded from the run and score.
      const disabled = new Set(disabledCheckIds ?? [])
      const checks = disabled.size > 0 ? generated.filter((c) => !disabled.has(c.id)) : generated
      setProgress({ done: 0, total: checks.length })

      const result = await runAllChecks(dataSourceId, checks, (done, total) => {
        if (!cancelledRef.current) setProgress({ done, total })
      })

      if (!cancelledRef.current) {
        setReport(result)
        onScanComplete?.(result)
      }
    } catch (err) {
      console.error('[DQ] Scan failed:', err)
    } finally {
      setLoading(false)
    }
  }, [dataSourceId, schemaMapping, customChecks, disabledCheckIds, loading, onBeforeScan, onScanComplete])

  const handleRestore = useCallback((entry: { report?: unknown; startedAt: string }) => {
    if (!entry.report) return
    setReport(entry.report as DqReport)
    setSelectedCheckId(null)
    setViewedRunAt(entry.startedAt)
  }, [])

  const rows = useMemo<Row[]>(() => {
    if (!report) return []
    const checkMap = new Map(report.checks.map((c) => [c.id, c]))
    const out: Row[] = []
    for (const r of report.results) {
      const check = checkMap.get(r.checkId)
      if (check) out.push({ check, result: r })
    }
    return out
  }, [report])

  const columns = useMemo<ConceptColumn<Row>[]>(() => [
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
        // Icon alone conveys the status; the translated label is kept as a title for a11y.
        return (
          <span className="inline-flex items-center justify-center" title={t(`data_quality.${cfg.label}`)}>
            <Icon size={14} className={cfg.color} />
          </span>
        )
      },
    },
    {
      id: 'check',
      header: t('data_quality.col_check'),
      accessor: (r) => r.check.description,
      filter: 'text',
      size: 260, minSize: 120,
      cell: (r) => <span className="font-medium">{r.check.description}</span>,
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
      id: 'table',
      header: t('data_quality.col_table'),
      accessor: (r) => r.check.tableName ?? '',
      filter: 'select',
      size: 130, minSize: 70,
      cell: (r) => <span className="font-mono text-muted-foreground">{r.check.tableName ?? '—'}</span>,
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
        return <Icon size={14} className={cfg.color} />
      },
    },
  ], [t])

  const selectedItem = selectedCheckId
    ? rows.find((f) => f.check.id === selectedCheckId) ?? null
    : null

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <Button
            size="sm"
            variant="default"
            onClick={handleRunScan}
            disabled={loading || !canWrite}
            className="h-6 gap-1 px-2 text-xs"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {loading ? t('data_quality.scanning') : t('data_quality.run_scan')}
          </Button>

          {ruleSetId && (
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

          {loading && progress.total > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('data_quality.progress', { done: progress.done, total: progress.total })}
            </span>
          )}

          {report && !loading && <DqScoreBadge report={report} />}

          {report && !loading && (
            <span className="text-xs text-muted-foreground">
              {t('data_quality.checks_passed', { passed: report.summary.passed, total: report.summary.total - report.summary.notApplicable })}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {report && !loading && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={chartsVisible ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    onClick={() => setChartsVisible(!chartsVisible)}
                  >
                    <BarChart3 size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('data_quality.chart_toggle')}</TooltipContent>
              </Tooltip>
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

        {/* Historical-run banner — shown when the table displays a past run. */}
        {viewedRunAt && !loading && (
          <div className="flex items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <History size={13} className="shrink-0" />
            <span>{t('data_quality.viewing_historical_run', { date: new Date(viewedRunAt).toLocaleString() })}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto h-5 w-5 text-amber-700 hover:text-amber-900 dark:text-amber-300"
              onClick={() => { setReport(null); setViewedRunAt(null); setSelectedCheckId(null) }}
              title={t('common.close')}
            >
              <X size={13} />
            </Button>
          </div>
        )}

        {/* Category charts (collapsible) */}
        {report && !loading && chartsVisible && (
          <div className="border-b">
            <DqCategoryCharts checks={report.checks} results={report.results} />
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
                <ConceptDataTable
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
              </Allotment.Pane>

              <Allotment.Pane preferredSize={300} minSize={220} maxSize={500} visible={detailVisible}>
                <DqCheckDetailPanel item={selectedItem} />
              </Allotment.Pane>
            </Allotment>
          )}
        </div>
      </div>

      {ruleSetId && (
        <DqHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          ruleSetId={ruleSetId}
          onRestore={handleRestore}
        />
      )}
    </TooltipProvider>
  )
}
