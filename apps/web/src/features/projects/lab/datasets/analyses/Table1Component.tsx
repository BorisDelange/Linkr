import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TableIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantile(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

function fmt(val: number, decimals = 2): string {
  if (Number.isInteger(val) && Math.abs(val) < 1e6) return val.toLocaleString()
  if (Math.abs(val) >= 1e6) return val.toExponential(2)
  return val.toFixed(decimals)
}

// ---------------------------------------------------------------------------
// Metric labels
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<string, { en: string; fr: string }> = {
  n: { en: 'n', fr: 'n' },
  missing: { en: 'Missing', fr: 'Manquants' },
  mean_sd: { en: 'Mean \u00b1 SD', fr: 'Moyenne \u00b1 ET' },
  median_iqr: { en: 'Median [IQR]', fr: 'M\u00e9diane [IQR]' },
  min_max: { en: 'Min / Max', fr: 'Min / Max' },
  range: { en: 'Range', fr: '\u00c9tendue' },
  categories: { en: 'Categories', fr: 'Cat\u00e9gories' },
}

const DASH = '\u2014'

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

interface ColumnStats {
  variable: string
  values: Record<string, string>
}

function isNumericColumn(col: { type: string }): boolean {
  return col.type === 'number'
}

function computeMetrics(
  values: unknown[],
  totalN: number,
  isNumeric: boolean,
  metrics: string[],
): Record<string, string> {
  const result: Record<string, string> = {}
  const nonNull = values.filter((v) => v != null && v !== '' && String(v).toLowerCase() !== 'null')
  const missingCount = totalN - nonNull.length

  if (metrics.includes('n')) {
    result.n = String(nonNull.length)
  }

  if (metrics.includes('missing')) {
    if (missingCount > 0) {
      const pct = ((missingCount / totalN) * 100).toFixed(1)
      result.missing = `${missingCount} (${pct}%)`
    } else {
      result.missing = DASH
    }
  }

  if (isNumeric) {
    const nums: number[] = []
    for (const v of nonNull) {
      const n = typeof v === 'number' ? v : Number(v)
      if (!isNaN(n)) nums.push(n)
    }

    if (metrics.includes('mean_sd')) {
      if (nums.length > 0) {
        result.mean_sd = `${fmt(nums.reduce((s, v) => s + v, 0) / nums.length)} \u00b1 ${fmt(stddev(nums))}`
      } else {
        result.mean_sd = DASH
      }
    }
    if (metrics.includes('median_iqr')) {
      if (nums.length > 0) {
        const med = median(nums)
        const q1 = quantile(nums, 0.25)
        const q3 = quantile(nums, 0.75)
        result.median_iqr = `${fmt(med)} [${fmt(q1)}\u2013${fmt(q3)}]`
      } else {
        result.median_iqr = DASH
      }
    }
    if (metrics.includes('min_max')) {
      if (nums.length > 0) {
        result.min_max = `${fmt(Math.min(...nums))} / ${fmt(Math.max(...nums))}`
      } else {
        result.min_max = DASH
      }
    }
    if (metrics.includes('range')) {
      if (nums.length > 0) {
        result.range = fmt(Math.max(...nums) - Math.min(...nums))
      } else {
        result.range = DASH
      }
    }
    if (metrics.includes('categories')) {
      result.categories = DASH
    }
  } else {
    // Categorical
    if (metrics.includes('mean_sd')) result.mean_sd = DASH
    if (metrics.includes('median_iqr')) result.median_iqr = DASH
    if (metrics.includes('min_max')) result.min_max = DASH
    if (metrics.includes('range')) result.range = DASH
    if (metrics.includes('categories')) {
      const counts = new Map<string, number>()
      for (const v of nonNull) {
        const key = String(v)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      if (sorted.length > 0) {
        result.categories = sorted
          .map(([cat, count]) => `${cat}: ${count} (${((count / totalN) * 100).toFixed(1)}%)`)
          .join('; ')
      } else {
        result.categories = DASH
      }
    }
  }

  return result
}

interface Table1Data {
  headers: string[]
  metricKeys: string[]
  rows: ColumnStats[]
  groupNames: string[] | null
}

function computeTable1(
  rows: Record<string, unknown>[],
  columns: { id: string; name: string; type: string }[],
  selectedColumnIds: string[],
  groupByColumnId: string | null,
  metrics: string[],
): Table1Data {
  const colMap = new Map(columns.map((c) => [c.id, c]))
  const validColumns = selectedColumnIds
    .map((id) => colMap.get(id))
    .filter((c): c is { id: string; name: string; type: string } => c !== undefined)

  if (validColumns.length === 0) {
    return { headers: [], metricKeys: [], rows: [], groupNames: null }
  }

  const groupCol = groupByColumnId ? colMap.get(groupByColumnId) : null

  // No group-by
  if (!groupCol) {
    const totalN = rows.length
    const statsRows: ColumnStats[] = validColumns.map((col) => {
      const values = rows.map((r) => r[col.id])
      return {
        variable: col.name,
        values: computeMetrics(values, totalN, isNumericColumn(col), metrics),
      }
    })
    return { headers: ['Variable', ...metrics], metricKeys: metrics, rows: statsRows, groupNames: null }
  }

  // Group-by: split rows by group value
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const gv = row[groupCol.id]
    const key = gv == null ? '(Missing)' : String(gv)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(row)
  }
  const groupNames = [...grouped.keys()].sort()

  // Build headers: Variable, then for each group: group - metric1, group - metric2, ...
  const headers = ['Variable']
  const metricKeys: string[] = []
  for (const grp of groupNames) {
    for (const m of metrics) {
      headers.push(`${grp} - ${m}`)
      metricKeys.push(`${grp}::${m}`)
    }
  }

  const statsRows: ColumnStats[] = validColumns.map((col) => {
    const values: Record<string, string> = {}
    for (const grp of groupNames) {
      const grpRows = grouped.get(grp)!
      const grpValues = grpRows.map((r) => r[col.id])
      const grpMetrics = computeMetrics(grpValues, grpRows.length, isNumericColumn(col), metrics)
      for (const m of metrics) {
        values[`${grp}::${m}`] = grpMetrics[m] ?? DASH
      }
    }
    return { variable: col.name, values }
  })

  return { headers, metricKeys, rows: statsRows, groupNames }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Table1Component({ config, columns, rows, compact }: ComponentPluginProps) {
  const { t, i18n } = useTranslation()
  const lang = (i18n.language === 'fr' ? 'fr' : 'en') as 'en' | 'fr'

  const rawSelectedColumns = config.selectedColumns as string[] | undefined
  const groupByColumn = (config.groupByColumn as string) ?? null
  const rawMetrics = config.metrics as string[] | undefined

  // defaultAll: when undefined or empty, use all columns / all metrics
  const allMetricIds = ['n', 'missing', 'mean_sd', 'median_iqr', 'min_max', 'range', 'categories']
  const selectedColumns = rawSelectedColumns?.length ? rawSelectedColumns : columns.map((c) => c.id)
  const metrics = rawMetrics?.length ? rawMetrics : allMetricIds

  const table = useMemo(
    () => computeTable1(rows, columns, selectedColumns, groupByColumn, metrics),
    [rows, columns, selectedColumns, groupByColumn, metrics],
  )

  if (columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <TableIcon size={24} className="opacity-40" />
        <p className="text-xs">{t('datasets.table1_no_columns', 'Select at least one variable.')}</p>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <TableIcon size={24} className="opacity-40" />
        <p className="text-xs">{t('datasets.table1_no_data', 'No data available.')}</p>
      </div>
    )
  }

  const metricLabel = (metricId: string): string => {
    return METRIC_LABELS[metricId]?.[lang] ?? metricId
  }

  const cellKeys = table.metricKeys
  const isGrouped = !!table.groupNames

  return (
    <div className={cn('h-full overflow-auto', !compact && 'p-4')}>
      <table className={cn('w-full border-collapse', compact ? 'text-[10px]' : 'text-xs')}>
        <thead className="sticky top-0 z-10">
          {/* Group header row (only when group-by is active) */}
          {isGrouped && table.groupNames && (
            <tr className="bg-muted">
              <th
                rowSpan={2}
                className={cn(
                  'border-b border-r font-medium whitespace-nowrap text-left sticky left-0 z-20 bg-muted',
                  compact ? 'px-2 py-0.5' : 'px-3 py-1.5',
                )}
              >
                {t('datasets.table1_variable', 'Variable')}
              </th>
              {table.groupNames.map((grp) => (
                <th
                  key={grp}
                  colSpan={metrics.length}
                  className={cn(
                    'border-b border-r font-semibold whitespace-nowrap text-center',
                    compact ? 'px-2 py-0.5' : 'px-3 py-1',
                  )}
                >
                  {grp}
                </th>
              ))}
            </tr>
          )}
          {/* Metric header row */}
          <tr className="bg-muted">
            {!isGrouped && (
              <th
                className={cn(
                  'border-b border-r font-medium whitespace-nowrap text-left sticky left-0 z-20 bg-muted',
                  compact ? 'px-2 py-0.5' : 'px-3 py-1.5',
                )}
              >
                {t('datasets.table1_variable', 'Variable')}
              </th>
            )}
            {cellKeys.map((key, i) => {
              const metricId = key.includes('::') ? key.split('::')[1] : key
              return (
                <th
                  key={i}
                  className={cn(
                    'border-b border-r font-medium whitespace-nowrap text-left',
                    compact ? 'px-2 py-0.5' : 'px-3 py-1.5',
                  )}
                >
                  {metricLabel(metricId)}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className={cn(
                'transition-colors hover:bg-accent/30',
                rowIdx % 2 === 1 && 'bg-muted/30',
              )}
            >
              <td
                className={cn(
                  'sticky left-0 z-[5] border-b border-r font-medium bg-background',
                  compact ? 'px-2 py-0.5' : 'px-3 py-1.5',
                  rowIdx % 2 === 1 && 'bg-muted/30',
                )}
              >
                {row.variable}
              </td>
              {cellKeys.map((key, colIdx) => {
                const val = row.values[key] ?? DASH
                const isDash = val === DASH
                return (
                  <td
                    key={colIdx}
                    className={cn(
                      'border-b border-r whitespace-nowrap',
                      compact ? 'px-2 py-0.5' : 'px-3 py-1.5',
                      isDash && 'text-muted-foreground/40',
                      // Categories column: allow wrapping
                      key.endsWith('categories') && 'whitespace-normal max-w-[300px]',
                    )}
                    title={!isDash ? val : undefined}
                  >
                    {val}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
