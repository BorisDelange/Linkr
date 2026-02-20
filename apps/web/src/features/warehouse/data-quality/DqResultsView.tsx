import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { ShieldCheck, Play, Loader2, PanelLeft, PanelRight, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { generateChecks, runAllChecks } from '@/lib/duckdb/data-quality'
import type { DqCheck, DqCheckResult, DqReport } from '@/lib/duckdb/data-quality'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DqCustomCheck } from '@/types'
import { DqScoreBadge } from './DqScoreBadge'
import { DqFiltersPanel } from './DqFiltersPanel'
import { DqResultsTable } from './DqResultsTable'
import { DqCheckDetailPanel } from './DqCheckDetailPanel'
import { DqCategoryCharts } from './DqCategoryCharts'
import { defaultFilters, type DqFilters } from './DqConstants'

interface Props {
  dataSourceId: string
  schemaMapping?: SchemaMapping
  customChecks?: DqCustomCheck[]
  /** Called after a successful scan with the full report. */
  onScanComplete?: (report: DqReport) => void
  /** Mount function to call before scanning (e.g. mountProjectSources). */
  onBeforeScan?: () => Promise<void>
}

export function DqResultsView({ dataSourceId, schemaMapping, customChecks, onScanComplete, onBeforeScan }: Props) {
  const { t } = useTranslation()

  const [report, setReport] = useState<DqReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null)
  const [filters, setFilters] = useState<DqFilters>(defaultFilters)
  const [filtersVisible, setFiltersVisible] = useState(true)
  const [detailVisible, setDetailVisible] = useState(true)
  const [chartsVisible, setChartsVisible] = useState(true)
  const cancelledRef = useRef(false)

  const handleRunScan = useCallback(async () => {
    if (loading) return
    cancelledRef.current = false
    setLoading(true)
    setReport(null)
    setSelectedCheckId(null)
    setProgress({ done: 0, total: 0 })

    try {
      if (onBeforeScan) await onBeforeScan()

      const checks = await generateChecks(
        dataSourceId,
        schemaMapping,
        customChecks && customChecks.length > 0 ? customChecks : undefined,
      )
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
  }, [dataSourceId, schemaMapping, customChecks, loading, onBeforeScan, onScanComplete])

  // Filter results
  const filteredResults: { check: DqCheck; result: DqCheckResult }[] = []
  if (report) {
    const checkMap = new Map(report.checks.map((c) => [c.id, c]))
    const searchLower = filters.searchText.toLowerCase()
    for (const r of report.results) {
      const check = checkMap.get(r.checkId)
      if (!check) continue
      if (!filters.statuses.has(r.status)) continue
      if (
        searchLower &&
        !check.description.toLowerCase().includes(searchLower) &&
        !check.name.toLowerCase().includes(searchLower) &&
        !(check.tableName ?? '').toLowerCase().includes(searchLower)
      ) continue
      if (!filters.categories.has(check.category)) continue
      if (filters.tables.size > 0 && (!check.tableName || !filters.tables.has(check.tableName))) continue
      if (!filters.severities.has(check.severity)) continue
      filteredResults.push({ check, result: r })
    }
  }

  const selectedItem = selectedCheckId
    ? filteredResults.find((f) => f.check.id === selectedCheckId) ?? null
    : null

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={filtersVisible ? 'secondary' : 'ghost'}
                size="icon-xs"
                onClick={() => setFiltersVisible(!filtersVisible)}
              >
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('data_quality.filters')}</TooltipContent>
          </Tooltip>

          <Button
            size="sm"
            variant="default"
            onClick={handleRunScan}
            disabled={loading}
            className="h-6 gap-1 px-2 text-xs"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {loading ? t('data_quality.scanning') : t('data_quality.run_scan')}
          </Button>

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

        {/* Category charts (collapsible) */}
        {report && !loading && chartsVisible && (
          <div className="border-b">
            <DqCategoryCharts checks={report.checks} results={report.results} />
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1">
          {!report && !loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <ShieldCheck size={32} className="mx-auto text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium text-foreground">{t('data_quality.no_results')}</p>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t('data_quality.no_results_description')}</p>
              </div>
            </div>
          ) : (
            <Allotment proportionalLayout={false}>
              <Allotment.Pane preferredSize={200} minSize={160} maxSize={280} visible={filtersVisible}>
                <DqFiltersPanel
                  filters={filters}
                  onFiltersChange={setFilters}
                  report={report}
                />
              </Allotment.Pane>

              <Allotment.Pane minSize={400}>
                <DqResultsTable
                  items={filteredResults}
                  selectedId={selectedCheckId}
                  onSelect={(id) => {
                    setSelectedCheckId(id)
                    setDetailVisible(true)
                  }}
                  loading={loading}
                />
              </Allotment.Pane>

              <Allotment.Pane preferredSize={300} minSize={220} maxSize={500} visible={detailVisible}>
                <DqCheckDetailPanel item={selectedItem} />
              </Allotment.Pane>
            </Allotment>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
