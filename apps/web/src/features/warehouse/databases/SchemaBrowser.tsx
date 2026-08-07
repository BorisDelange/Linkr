import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  BarChart3,
  PanelRight,
  PanelLeft,
  Loader2,
  Search,
  RefreshCw,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer,
} from 'recharts'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { CopySelectButton } from '@/components/ui/copy-select-button'
import { TypeBadge, TYPE_CONFIG, mapColumnType } from '@/components/ui/type-badge'
import { cn } from '@/lib/utils'
import { useDataSourceStore } from '@/stores/data-source-store'
import * as duckdbEngine from '@/lib/duckdb/engine'

// --- Types ---

interface ColumnInfo {
  column_name: string
  data_type: string
  ordinal_position: number
}

interface ColumnStats {
  total: number
  nonNull: number
  nullCount: number
  distinctCount: number
  minValue: string | null
  maxValue: string | null
  meanValue: number | null
  histogram: { label: string; count: number }[]
  topValues: { value: string; count: number; pct: number }[]
}

// --- Shared table-inspection cache ---
//
// Module-level (survives component unmount) so the three views — SQL scripts,
// ETL and profiling — share one cache per (dataSource, table): opening a table
// already inspected elsewhere is instant, no re-count. Keyed by dataSourceId +
// table name. The Refresh button invalidates one entry and recomputes it.

type NullCounts = Map<string, { nullCount: number; total: number; distinct: number }>

interface TableCacheEntry {
  columns: ColumnInfo[]
  hasStats: boolean
  rowCount: number | null
  nullCounts: NullCounts
  loadedAt: number
}

const tableCache = new Map<string, TableCacheEntry>()
const tableCacheKey = (dataSourceId: string, table: string) => `${dataSourceId}::${table}`

// Detailed per-column stats (distribution/top-values) are cached too, keyed by
// dataSource + table + column, so re-clicking a column doesn't re-scan.
const columnStatsCache = new Map<string, ColumnStats>()
const columnStatsKey = (dataSourceId: string, table: string, col: string) =>
  `${dataSourceId}::${table}::${col}`

// --- Shared schema browser ---
//
// One component for the three schema views: the SQL-scripts / IDE "browse
// schema" modal, the ETL scripts editor modal, and the ETL Profiling tab. It
// owns all data fetching; the caller only supplies a data source id.

interface Props {
  dataSourceId: string
  /** Qualifier prepended to the table in "Copy SELECT" (e.g. `source.`). ETL
   *  pipelines pass a role prefix so the copied SQL is portable; other callers
   *  omit it and get a bare table name. */
  tableQualifier?: string
}

export function SchemaBrowser({ dataSourceId, tableQualifier }: Props) {
  const { t, i18n } = useTranslation()

  const [tables, setTables] = useState<string[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [columnStats, setColumnStats] = useState<ColumnStats | null>(null)
  const [tablesVisible, setTablesVisible] = useState(true)
  const [statsVisible, setStatsVisible] = useState(true)
  const [loading, setLoading] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [columnNullCounts, setColumnNullCounts] = useState<Map<string, { nullCount: number; total: number; distinct: number }>>(new Map())
  const [tableSearch, setTableSearch] = useState('')
  // Stats are opt-in and computed lazily: on a source with billions of rows the
  // COUNT/DISTINCT scans are expensive, so nothing runs until the user asks.
  const [statsEnabled, setStatsEnabled] = useState(true)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)

  // Ensure source is mounted
  useEffect(() => {
    const { testConnection } = useDataSourceStore.getState()
    testConnection(dataSourceId)
  }, [dataSourceId])

  // Load the table list (names only — no per-table COUNT, which would scan every
  // table up front). No auto-selection: the user picks a table to trigger work.
  useEffect(() => {
    let cancelled = false
    async function loadTables() {
      setLoading(true)
      try {
        const result = await duckdbEngine.discoverTables(dataSourceId)
        if (cancelled) return
        setTables(result)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadTables()
    return () => { cancelled = true }
  }, [dataSourceId])

  const applyEntry = useCallback((entry: TableCacheEntry) => {
    setColumns(entry.columns)
    setRowCount(entry.rowCount)
    setColumnNullCounts(entry.nullCounts)
    setLoadedAt(entry.loadedAt)
  }, [])

  // Load a table's columns (+ per-column null/distinct only when stats are on).
  // Served from the shared cache unless `force` (the Refresh button) or the
  // cached entry lacks the stats the caller now wants.
  const loadTable = useCallback(async (table: string, withStats: boolean, force = false) => {
    const key = tableCacheKey(dataSourceId, table)
    const cached = tableCache.get(key)
    if (!force && cached && (cached.hasStats || !withStats)) {
      applyEntry(cached)
      setSelectedColumn(null)
      setColumnStats(null)
      return
    }

    setLoading(true)
    setSelectedColumn(null)
    setColumnStats(null)
    try {
      const colRows = await duckdbEngine.queryDataSource(
        dataSourceId,
        `SELECT column_name, data_type, ordinal_position FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`,
      )
      const cols: ColumnInfo[] = colRows.map((r) => ({
        column_name: String(r.column_name),
        data_type: String(r.data_type),
        ordinal_position: Number(r.ordinal_position),
      }))

      let total: number | null = null
      const map: NullCounts = new Map()
      if (withStats) {
        const countRows = await duckdbEngine.queryDataSource(dataSourceId, `SELECT COUNT(*) as cnt FROM "${table}"`)
        total = Number(countRows[0]?.cnt ?? 0)

        // Null + distinct counts per column, in one batched round-trip.
        if (cols.length > 0 && total > 0) {
          const parts = cols.map((c) =>
            `SELECT '${c.column_name}' as col, COUNT(*) - COUNT("${c.column_name}") as null_count, COUNT(DISTINCT "${c.column_name}") as distinct_count FROM "${table}"`
          )
          const batchRows = await duckdbEngine.queryDataSource(dataSourceId, parts.join(' UNION ALL '))
          for (const row of batchRows) {
            map.set(String(row.col), {
              nullCount: Number(row.null_count),
              total: total!,
              distinct: Number(row.distinct_count),
            })
          }
        }
      }

      // A forced refresh drops any stale per-column stats for this table.
      if (force) {
        for (const c of cols) columnStatsCache.delete(columnStatsKey(dataSourceId, table, c.column_name))
      }

      const entry: TableCacheEntry = {
        columns: cols,
        hasStats: withStats,
        rowCount: total,
        nullCounts: map,
        loadedAt: Date.now(),
      }
      tableCache.set(key, entry)
      applyEntry(entry)
    } finally {
      setLoading(false)
    }
  }, [dataSourceId, applyEntry])

  // (Re)load whenever the selected table or the stats toggle changes.
  useEffect(() => {
    if (!selectedTable) {
      setColumns([])
      setRowCount(null)
      setColumnNullCounts(new Map())
      setLoadedAt(null)
      return
    }
    loadTable(selectedTable, statsEnabled)
  }, [selectedTable, statsEnabled, loadTable])

  // Load detailed stats for the selected column (only when stats are enabled).
  useEffect(() => {
    if (!selectedTable || !selectedColumn || !statsEnabled) {
      setColumnStats(null)
      return
    }
    let cancelled = false
    const col = columns.find((c) => c.column_name === selectedColumn)
    if (!col) return

    // Serve detailed column stats from the shared cache when available.
    const statsKey = columnStatsKey(dataSourceId, selectedTable, selectedColumn)
    const cachedStats = columnStatsCache.get(statsKey)
    if (cachedStats) {
      setColumnStats(cachedStats)
      setStatsLoading(false)
      return
    }

    async function loadStats() {
      setStatsLoading(true)
      try {
        const total = rowCount ?? 0
        const mappedType = mapColumnType(col!.data_type)

        const basicRows = await duckdbEngine.queryDataSource(
          dataSourceId,
          `SELECT COUNT(*) - COUNT("${selectedColumn}") as null_count, COUNT(DISTINCT "${selectedColumn}") as distinct_count FROM "${selectedTable}"`,
        )
        if (cancelled) return
        const nullCount = Number(basicRows[0]?.null_count ?? 0)
        const distinctCount = Number(basicRows[0]?.distinct_count ?? 0)

        let minValue: string | null = null
        let maxValue: string | null = null
        let meanValue: number | null = null
        let histogram: { label: string; count: number }[] = []
        let topValues: { value: string; count: number; pct: number }[] = []

        if (mappedType === 'number') {
          const numRows = await duckdbEngine.queryDataSource(
            dataSourceId,
            `SELECT MIN("${selectedColumn}") as min_val, MAX("${selectedColumn}") as max_val, AVG("${selectedColumn}")::DOUBLE as mean_val FROM "${selectedTable}" WHERE "${selectedColumn}" IS NOT NULL`,
          )
          if (cancelled) return
          minValue = String(numRows[0]?.min_val ?? '')
          maxValue = String(numRows[0]?.max_val ?? '')
          meanValue = numRows[0]?.mean_val != null ? Number(numRows[0].mean_val) : null

          try {
            const histRows = await duckdbEngine.queryDataSource(
              dataSourceId,
              `WITH bounds AS (SELECT MIN("${selectedColumn}")::DOUBLE as lo, MAX("${selectedColumn}")::DOUBLE as hi FROM "${selectedTable}" WHERE "${selectedColumn}" IS NOT NULL),
               bins AS (SELECT width_bucket("${selectedColumn}"::DOUBLE, lo, hi + 0.0001, 15) as bin, COUNT(*) as cnt FROM "${selectedTable}", bounds WHERE "${selectedColumn}" IS NOT NULL GROUP BY bin ORDER BY bin)
               SELECT bin, cnt FROM bins`,
            )
            if (!cancelled) {
              const lo = Number(minValue)
              const hi = Number(maxValue)
              const step = (hi - lo) / 15
              histogram = histRows.map((r) => {
                const binIdx = Number(r.bin) - 1
                return { label: (lo + binIdx * step).toFixed(1), count: Number(r.cnt) }
              })
            }
          } catch { /* histogram is optional */ }
        } else if (mappedType === 'date') {
          const dateRows = await duckdbEngine.queryDataSource(
            dataSourceId,
            `SELECT MIN("${selectedColumn}") as min_val, MAX("${selectedColumn}") as max_val FROM "${selectedTable}" WHERE "${selectedColumn}" IS NOT NULL`,
          )
          if (cancelled) return
          minValue = String(dateRows[0]?.min_val ?? '')
          maxValue = String(dateRows[0]?.max_val ?? '')
        }

        try {
          const topRows = await duckdbEngine.queryDataSource(
            dataSourceId,
            `SELECT "${selectedColumn}"::VARCHAR as val, COUNT(*) as cnt FROM "${selectedTable}" WHERE "${selectedColumn}" IS NOT NULL GROUP BY "${selectedColumn}" ORDER BY cnt DESC LIMIT 20`,
          )
          if (!cancelled) {
            const nonNull = total - nullCount
            topValues = topRows.map((r) => ({
              value: String(r.val),
              count: Number(r.cnt),
              pct: nonNull > 0 ? (Number(r.cnt) / nonNull) * 100 : 0,
            }))
          }
        } catch { /* top values optional */ }

        if (!cancelled) {
          const result: ColumnStats = {
            total,
            nonNull: total - nullCount,
            nullCount,
            distinctCount,
            minValue,
            maxValue,
            meanValue,
            histogram,
            topValues,
          }
          columnStatsCache.set(statsKey, result)
          setColumnStats(result)
        }
      } finally {
        if (!cancelled) setStatsLoading(false)
      }
    }

    loadStats()
    return () => { cancelled = true }
  }, [dataSourceId, selectedTable, selectedColumn, columns, rowCount, statsEnabled])

  const handleSelectColumn = useCallback((colName: string) => {
    setSelectedColumn(colName)
    setStatsVisible(true)
  }, [])

  const buildSelectSql = useCallback(() => {
    if (!selectedTable || columns.length === 0) return null
    const cols = columns.map((c) => `  ${c.column_name}`).join(',\n')
    return `SELECT\n${cols}\nFROM ${tableQualifier ?? ''}${selectedTable}\nLIMIT 100;`
  }, [selectedTable, columns, tableQualifier])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={tablesVisible ? 'secondary' : 'ghost'}
                size="icon-xs"
                onClick={() => setTablesVisible(!tablesVisible)}
              >
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('etl.profiling_toggle_tables')}</TooltipContent>
          </Tooltip>

          {selectedTable && (
            <span className="text-xs font-medium">{selectedTable}</span>
          )}

          {statsEnabled && rowCount != null && (
            <span className="text-xs text-muted-foreground">
              {rowCount.toLocaleString()} {t('etl.profiling_rows')} · {columns.length} {t('etl.profiling_columns')}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {selectedTable && loadedAt != null && (
              <span className="text-[11px] text-muted-foreground">
                {t('etl.profiling_last_loaded', {
                  date: new Date(loadedAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
                })}
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => { if (selectedTable) loadTable(selectedTable, statsEnabled, true) }}
                  disabled={!selectedTable || loading}
                >
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.profiling_refresh')}</TooltipContent>
            </Tooltip>

            <div className="mx-0.5 h-4 w-px bg-border" />

            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={statsEnabled}
                onCheckedChange={(v) => setStatsEnabled(v === true)}
                className="size-3.5"
              />
              {t('etl.profiling_compute_stats')}
            </label>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={statsVisible ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setStatsVisible(!statsVisible)}
                >
                  <PanelRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.profiling_toggle_stats')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content: table sidebar + columns table + stats sidebar */}
        <div className="min-h-0 flex-1">
          <Allotment proportionalLayout={false}>
            {/* Table list sidebar */}
            <Allotment.Pane preferredSize={220} minSize={140} maxSize={360} visible={tablesVisible}>
              <div className="flex h-full flex-col border-r">
                <div className="flex items-center border-b px-3 py-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.profiling_tables')} ({tables.length})
                  </span>
                </div>
                <div className="border-b px-2 py-1.5">
                  <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      placeholder={t('etl.profiling_filter_tables')}
                      className="h-7 w-full rounded-md border bg-transparent pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </div>
                <ScrollArea className="h-full flex-1">
                  <div className="py-1">
                    {(() => {
                      const filtered = tables.filter((tbl) =>
                        !tableSearch || tbl.toLowerCase().includes(tableSearch.toLowerCase())
                      )
                      const sorted = [...filtered].sort((a, b) => a.localeCompare(b))
                      if (sorted.length === 0 && !loading) {
                        return (
                          <p className="px-3 py-4 text-center text-[10px] text-muted-foreground">
                            {tableSearch ? t('etl.profiling_no_match') : t('etl.no_tables')}
                          </p>
                        )
                      }
                      return sorted.map((table) => {
                        const isActive = table === selectedTable
                        return (
                          <button
                            key={table}
                            onClick={() => setSelectedTable(table)}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                              isActive ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50',
                            )}
                          >
                            <span className="truncate font-mono">{table}</span>
                          </button>
                        )
                      })
                    })()}
                    {loading && tables.length === 0 && (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 size={14} className="animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </Allotment.Pane>

            {/* Column overview table */}
            <Allotment.Pane minSize={300}>
              <div className="flex h-full flex-col">
                {selectedTable && columns.length > 0 && (
                  <div className="flex items-center justify-between border-b px-3 py-1.5">
                    <span className="text-xs font-medium">{selectedTable}</span>
                    <CopySelectButton getSql={buildSelectSql} />
                  </div>
                )}
                <ScrollArea className="h-full flex-1">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10 bg-muted shadow-[0_1px_0_0_var(--color-border)]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">{t('etl.column_name')}</th>
                        <th className="px-3 py-2 text-left font-medium">{t('etl.data_type')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('etl.profiling_completeness')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('etl.profiling_distinct')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((col) => {
                        const stats = columnNullCounts.get(col.column_name)
                        const completeness = stats ? ((stats.total - stats.nullCount) / stats.total) * 100 : null
                        const isActive = col.column_name === selectedColumn
                        return (
                          <tr
                            key={col.column_name}
                            onClick={() => handleSelectColumn(col.column_name)}
                            className={cn(
                              'cursor-pointer border-b transition-colors last:border-0',
                              isActive ? 'bg-accent' : 'hover:bg-accent/50',
                            )}
                          >
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <TypeBadge type={col.data_type} />
                                <span className="font-mono">{col.column_name}</span>
                              </div>
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">{col.data_type}</td>
                            <td className="px-3 py-1.5 text-right">
                              {completeness != null ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <div className="h-1.5 w-12 overflow-hidden rounded-full bg-destructive/15">
                                    <div
                                      className="h-full rounded-full bg-emerald-500/70"
                                      style={{ width: `${completeness}%` }}
                                    />
                                  </div>
                                  <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{completeness.toFixed(0)}%</span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                              {!statsEnabled
                                ? '—'
                                : stats?.distinct?.toLocaleString() ?? (loading ? '—' : '0')}
                            </td>
                          </tr>
                        )
                      })}
                      {columns.length === 0 && !loading && (
                        <tr>
                          <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                            {tables.length === 0 ? t('etl.no_tables') : t('etl.select_table')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </ScrollArea>
              </div>
            </Allotment.Pane>

            {/* Stats sidebar */}
            <Allotment.Pane preferredSize={300} minSize={220} maxSize={440} visible={statsVisible}>
              <div className="flex h-full min-h-0 flex-col border-l">
                <ColumnStatsDetail
                  column={columns.find((c) => c.column_name === selectedColumn) ?? null}
                  stats={columnStats}
                  loading={statsLoading}
                />
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
    </TooltipProvider>
  )
}

// --- Column stats detail sidebar ---

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right tabular-nums truncate">
        {typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}
      </span>
    </div>
  )
}

function ColumnStatsDetail({
  column,
  stats,
  loading,
}: {
  column: ColumnInfo | null
  stats: ColumnStats | null
  loading: boolean
}) {
  const { t } = useTranslation()

  if (!column) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <BarChart3 size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('etl.profiling_select_column')}</p>
      </div>
    )
  }

  const mappedType = mapColumnType(column.data_type)
  const typeConfig = TYPE_CONFIG[mappedType] ?? TYPE_CONFIG.unknown

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className={cn('inline-flex items-center gap-0.5 rounded font-mono font-semibold leading-none shrink-0 px-1.5 py-0.5 text-[10px]', typeConfig.color)}>
            {typeConfig.icon}
          </span>
          <h3 className="truncate text-xs font-medium">{column.column_name}</h3>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{column.data_type}</p>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3 text-xs">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && stats && (
            <>
              {/* Completeness */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{t('etl.profiling_completeness')}</span>
                  <span className="tabular-nums">{stats.total > 0 ? ((stats.nonNull / stats.total) * 100).toFixed(1) : 0}%</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-sm bg-destructive/15">
                  <div
                    className="h-full rounded-sm bg-emerald-500/70 transition-all"
                    style={{ width: `${stats.total > 0 ? (stats.nonNull / stats.total) * 100 : 0}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{stats.nonNull.toLocaleString()} {t('etl.profiling_non_null')}</span>
                  <span className="text-muted-foreground">{stats.nullCount.toLocaleString()} {t('etl.profiling_missing')}</span>
                </div>
              </div>

              {/* Summary */}
              <div className="space-y-1 border-t pt-3">
                <StatRow label={t('etl.profiling_total_rows')} value={stats.total} />
                <StatRow label={t('etl.profiling_unique_values')} value={stats.distinctCount} />
              </div>

              {/* Numeric stats */}
              {mappedType === 'number' && stats.minValue != null && (
                <div className="space-y-1 border-t pt-3">
                  <StatRow label={t('etl.profiling_min')} value={stats.minValue} />
                  <StatRow label={t('etl.profiling_max')} value={stats.maxValue ?? ''} />
                  {stats.meanValue != null && <StatRow label={t('etl.profiling_mean')} value={stats.meanValue} />}
                </div>
              )}

              {/* Date stats */}
              {mappedType === 'date' && stats.minValue && (
                <div className="space-y-1 border-t pt-3">
                  <StatRow label={t('etl.profiling_earliest')} value={stats.minValue} />
                  <StatRow label={t('etl.profiling_latest')} value={stats.maxValue ?? ''} />
                </div>
              )}

              {/* Histogram */}
              {stats.histogram.length > 0 && (
                <div className="border-t pt-3">
                  <p className="mb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {t('etl.profiling_distribution')}
                  </p>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={stats.histogram} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
                      <XAxis dataKey="label" interval="preserveStartEnd" tick={{ fontSize: 9 }} />
                      <YAxis width={30} tick={{ fontSize: 9 }} />
                      <RechartsTooltip
                        contentStyle={{
                          background: 'var(--color-popover)',
                          border: '1px solid var(--color-border)',
                          color: 'var(--color-popover-foreground)',
                          borderRadius: 6,
                          fontSize: 11,
                        }}
                      />
                      <Bar dataKey="count" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Top values */}
              {stats.topValues.length > 0 && (
                <div className="border-t pt-3">
                  <p className="mb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {t('etl.profiling_top_values')}
                  </p>
                  <div className="space-y-1.5">
                    {stats.topValues.map((item) => (
                      <div key={item.value} className="group">
                        <div className="mb-0.5 flex items-center justify-between gap-2">
                          <span className="flex-1 truncate text-[10px] text-muted-foreground">{item.value}</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {item.count.toLocaleString()} ({item.pct.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-sm bg-muted">
                          <div
                            className="h-full rounded-sm bg-primary/60"
                            style={{ width: `${(item.count / (stats!.topValues[0]?.count ?? 1)) * 100}%` }}
                          />
                        </div>
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
