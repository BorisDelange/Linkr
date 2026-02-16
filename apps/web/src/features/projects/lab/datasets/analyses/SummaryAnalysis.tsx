import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDatasetStore } from '@/stores/dataset-store'
import { TypeBadge } from '../TypeBadge'
import type { DatasetAnalysis } from '@/types'

interface SummaryAnalysisProps {
  analysis: DatasetAnalysis
}

export function SummaryAnalysis({ analysis }: SummaryAnalysisProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = _dirtyVersion >= 0 ? getFileRows(analysis.datasetFileId) : []

  const summary = useMemo(() => {
    if (columns.length === 0) return null

    const totalRows = rows.length
    const totalColumns = columns.length
    const byType: Record<string, number> = {}

    let totalNulls = 0
    let totalCells = totalRows * totalColumns

    const columnSummaries = columns.map((col) => {
      byType[col.type] = (byType[col.type] ?? 0) + 1
      const values = rows.map((r) => r[col.id])
      const nullCount = values.filter((v) => v == null || v === '').length
      totalNulls += nullCount
      const uniqueSet = new Set(values.filter((v) => v != null && v !== '').map(String))
      return {
        column: col,
        nullCount,
        nullPct: totalRows > 0 ? (nullCount / totalRows) * 100 : 0,
        uniqueCount: uniqueSet.size,
        completeness: totalRows > 0 ? ((totalRows - nullCount) / totalRows) * 100 : 0,
      }
    })

    return {
      totalRows,
      totalColumns,
      byType,
      totalNulls,
      totalCells,
      overallCompleteness: totalCells > 0 ? ((totalCells - totalNulls) / totalCells) * 100 : 100,
      columnSummaries,
    }
  }, [columns, rows, _dirtyVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!summary || columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Overview cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border p-3">
          <p className="text-[10px] text-muted-foreground">{t('datasets.summary_rows')}</p>
          <p className="text-lg font-semibold tabular-nums">{summary.totalRows.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-[10px] text-muted-foreground">{t('datasets.summary_columns')}</p>
          <p className="text-lg font-semibold tabular-nums">{summary.totalColumns}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-[10px] text-muted-foreground">{t('datasets.summary_completeness')}</p>
          <p className="text-lg font-semibold tabular-nums">{summary.overallCompleteness.toFixed(1)}%</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-[10px] text-muted-foreground">{t('datasets.summary_missing_cells')}</p>
          <p className="text-lg font-semibold tabular-nums">{summary.totalNulls.toLocaleString()}</p>
        </div>
      </div>

      {/* Column types breakdown */}
      <div className="rounded-lg border p-3">
        <h4 className="text-xs font-medium mb-2">{t('datasets.summary_column_types')}</h4>
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary.byType).map(([type, count]) => (
            <div key={type} className="flex items-center gap-1.5 text-xs">
              <TypeBadge type={type as 'string' | 'number' | 'boolean' | 'date' | 'unknown'} size="sm" />
              <span className="tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Per-column table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-muted">
            <tr>
              <th className="border-b px-3 py-2 text-left font-medium">{t('datasets.summary_column')}</th>
              <th className="border-b px-3 py-2 text-left font-medium w-16">{t('datasets.stats_type')}</th>
              <th className="border-b px-3 py-2 text-right font-medium">{t('datasets.stats_unique')}</th>
              <th className="border-b px-3 py-2 text-right font-medium">{t('datasets.stats_null')}</th>
              <th className="border-b px-3 py-2 text-right font-medium">{t('datasets.stats_completeness')}</th>
              <th className="border-b px-3 py-2 font-medium w-32">{t('datasets.stats_completeness')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.columnSummaries.map((cs) => (
              <tr key={cs.column.id} className="hover:bg-accent/30">
                <td className="border-b px-3 py-1.5 font-medium">{cs.column.name}</td>
                <td className="border-b px-3 py-1.5">
                  <TypeBadge type={cs.column.type} size="sm" />
                </td>
                <td className="border-b px-3 py-1.5 text-right tabular-nums">{cs.uniqueCount}</td>
                <td className="border-b px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {cs.nullCount > 0 ? `${cs.nullCount} (${cs.nullPct.toFixed(1)}%)` : '—'}
                </td>
                <td className="border-b px-3 py-1.5 text-right tabular-nums">{cs.completeness.toFixed(1)}%</td>
                <td className="border-b px-3 py-1.5">
                  <div className="h-1.5 w-full rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{ width: `${cs.completeness}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
