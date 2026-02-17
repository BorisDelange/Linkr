import type { DashboardWidget } from '@/types'
import { useDashboardData } from '../DashboardDataProvider'

// Legacy builtin widgets (hardcoded mock data)
import { AdmissionCountWidget } from '../widgets/AdmissionCountWidget'
import { PatientCountWidget } from '../widgets/PatientCountWidget'
import { AdmissionTimelineWidget } from '../widgets/AdmissionTimelineWidget'
import { HeartRateWidget } from '../widgets/HeartRateWidget'
import { VitalsTableWidget } from '../widgets/VitalsTableWidget'

interface BuiltinWidgetRendererProps {
  widget: DashboardWidget
}

export function BuiltinWidgetRenderer({ widget }: BuiltinWidgetRendererProps) {
  if (widget.source.type !== 'builtin') return null
  const { builtinType, config } = widget.source

  // Legacy builtin types (hardcoded demo widgets)
  switch (builtinType) {
    case 'admission_count':
      return <AdmissionCountWidget />
    case 'patient_count':
      return <PatientCountWidget />
    case 'admission_timeline':
      return <AdmissionTimelineWidget />
    case 'heart_rate':
      return <HeartRateWidget />
    case 'vitals_table':
      return <VitalsTableWidget />
    // Data-aware builtins
    case 'kpi':
      return <KpiWidget config={config} />
    case 'table':
      return <BasicTableWidget config={config} />
    case 'chart':
      return <BasicChartWidget config={config} />
    default:
      return <div className="text-xs text-muted-foreground">Unknown builtin: {builtinType}</div>
  }
}

// --- KPI Widget ---

function KpiWidget({ config }: { config: Record<string, unknown> }) {
  const { filteredRows } = useDashboardData()
  const columnId = config.columnId as string | undefined
  const aggregation = (config.aggregation as string) ?? 'count'

  let value: number | string = '—'

  if (!columnId) {
    value = filteredRows.length
  } else {
    const nums = filteredRows
      .map((r) => Number(r[columnId]))
      .filter((n) => !isNaN(n))

    switch (aggregation) {
      case 'count':
        value = filteredRows.length
        break
      case 'sum':
        value = nums.reduce((a, b) => a + b, 0)
        break
      case 'average':
        value = nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0
        break
      case 'min':
        value = nums.length > 0 ? Math.min(...nums) : 0
        break
      case 'max':
        value = nums.length > 0 ? Math.max(...nums) : 0
        break
      default:
        value = filteredRows.length
    }
  }

  const formattedValue = typeof value === 'number' ? value.toLocaleString() : value

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="text-3xl font-bold text-foreground">{formattedValue}</div>
        <div className="mt-1 text-xs text-muted-foreground capitalize">{aggregation}</div>
      </div>
    </div>
  )
}

// --- Basic Table Widget ---

function BasicTableWidget({ config }: { config: Record<string, unknown> }) {
  const { filteredRows, columns } = useDashboardData()
  const selectedColumnIds = config.columnIds as string[] | undefined
  const maxRows = (config.maxRows as number) ?? 50

  const displayColumns = selectedColumnIds
    ? columns.filter((c) => selectedColumnIds.includes(c.id))
    : columns.slice(0, 8) // default: first 8 columns

  const displayRows = filteredRows.slice(0, maxRows)

  if (displayColumns.length === 0) {
    return <div className="text-xs text-muted-foreground p-2">No columns to display</div>
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            {displayColumns.map((col) => (
              <th key={col.id} className="px-2 py-1 text-left font-medium text-muted-foreground whitespace-nowrap">
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-accent/30">
              {displayColumns.map((col) => (
                <td key={col.id} className="px-2 py-1 whitespace-nowrap">
                  {String(row[col.id] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filteredRows.length > maxRows && (
        <div className="p-2 text-xs text-muted-foreground text-center">
          Showing {maxRows} of {filteredRows.length} rows
        </div>
      )}
    </div>
  )
}

// --- Basic Chart Widget ---

function BasicChartWidget({ config }: { config: Record<string, unknown> }) {
  const { filteredRows, columns } = useDashboardData()
  const columnId = config.columnId as string | undefined
  if (!columnId) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Select a column to chart</div>
  }

  const col = columns.find((c) => c.id === columnId)
  if (!col) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Column not found</div>
  }

  // Simple frequency distribution
  const freq = new Map<string, number>()
  for (const row of filteredRows) {
    const val = String(row[columnId] ?? 'N/A')
    freq.set(val, (freq.get(val) ?? 0) + 1)
  }

  const entries = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)

  const maxCount = Math.max(...entries.map((e) => e[1]), 1)

  return (
    <div className="h-full overflow-auto p-2">
      <div className="space-y-1">
        {entries.map(([label, count]) => (
          <div key={label} className="flex items-center gap-2 text-xs">
            <span className="w-24 truncate text-right text-muted-foreground" title={label}>
              {label}
            </span>
            <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary/60 rounded"
                style={{ width: `${(count / maxCount) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right text-muted-foreground">{count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
