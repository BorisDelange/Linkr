import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDatasetStore } from '@/stores/dataset-store'
import { TypeBadge } from '../TypeBadge'
import type { DatasetAnalysis, DatasetColumn } from '@/types'

interface Table1AnalysisProps {
  analysis: DatasetAnalysis
}

interface VariableRow {
  column: DatasetColumn
  total: number
  nonNull: number
  nullCount: number
  // Numeric
  mean?: number
  std?: number
  median?: number
  min?: number
  max?: number
  q1?: number
  q3?: number
  // Categorical
  categories?: { value: string; count: number; pct: number }[]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function Table1Analysis({ analysis }: Table1AnalysisProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = _dirtyVersion >= 0 ? getFileRows(analysis.datasetFileId) : []

  const table = useMemo((): VariableRow[] => {
    if (columns.length === 0 || rows.length === 0) return []

    return columns.map((col) => {
      const values = rows.map((r) => r[col.id])
      const nonNullValues = values.filter((v) => v != null && v !== '')
      const total = values.length
      const nonNull = nonNullValues.length
      const nullCount = total - nonNull

      const numericValues = nonNullValues.map(Number).filter((n) => !isNaN(n))
      const isNumeric = col.type === 'number' || (numericValues.length > 0 && numericValues.length === nonNullValues.length)

      if (isNumeric && numericValues.length > 0) {
        const sorted = [...numericValues].sort((a, b) => a - b)
        const sum = sorted.reduce((a, b) => a + b, 0)
        const mean = sum / sorted.length
        const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length
        const std = Math.sqrt(variance)
        return {
          column: col,
          total,
          nonNull,
          nullCount,
          mean,
          std,
          median: percentile(sorted, 50),
          min: sorted[0],
          max: sorted[sorted.length - 1],
          q1: percentile(sorted, 25),
          q3: percentile(sorted, 75),
        }
      }

      // Categorical
      const counts = new Map<string, number>()
      for (const v of nonNullValues) {
        const key = String(v)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const categories = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count, pct: (count / total) * 100 }))

      return { column: col, total, nonNull, nullCount, categories }
    })
  }, [columns, rows, _dirtyVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="border-b px-3 py-2 text-left font-medium">Variable</th>
            <th className="border-b px-3 py-2 text-left font-medium w-12">Type</th>
            <th className="border-b px-3 py-2 text-right font-medium">n</th>
            <th className="border-b px-3 py-2 text-right font-medium">{t('datasets.stats_missing')}</th>
            <th className="border-b px-3 py-2 text-right font-medium">Mean ± SD</th>
            <th className="border-b px-3 py-2 text-right font-medium">{t('datasets.stats_median')} [IQR]</th>
            <th className="border-b px-3 py-2 text-left font-medium">n (%) / Range</th>
          </tr>
        </thead>
        <tbody>
          {table.map((row) => (
            <tr key={row.column.id} className="hover:bg-accent/30">
              <td className="border-b px-3 py-1.5 font-medium">{row.column.name}</td>
              <td className="border-b px-3 py-1.5"><TypeBadge type={row.column.type} size="sm" /></td>
              <td className="border-b px-3 py-1.5 text-right tabular-nums">{row.nonNull}</td>
              <td className="border-b px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {row.nullCount > 0 ? `${row.nullCount} (${((row.nullCount / row.total) * 100).toFixed(1)}%)` : '—'}
              </td>
              <td className="border-b px-3 py-1.5 text-right tabular-nums">
                {row.mean != null ? `${fmt(row.mean)} ± ${fmt(row.std!)}` : '—'}
              </td>
              <td className="border-b px-3 py-1.5 text-right tabular-nums">
                {row.median != null ? `${fmt(row.median)} [${fmt(row.q1!)}–${fmt(row.q3!)}]` : '—'}
              </td>
              <td className="border-b px-3 py-1.5">
                {row.categories ? (
                  <div className="space-y-0.5">
                    {row.categories.map((cat) => (
                      <div key={cat.value} className="flex items-center gap-1">
                        <span className="truncate max-w-[100px]" title={cat.value}>{cat.value}</span>
                        <span className="text-muted-foreground tabular-nums">{cat.count} ({cat.pct.toFixed(1)}%)</span>
                      </div>
                    ))}
                  </div>
                ) : row.min != null ? (
                  <span className="tabular-nums">{fmt(row.min!)} – {fmt(row.max!)}</span>
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
