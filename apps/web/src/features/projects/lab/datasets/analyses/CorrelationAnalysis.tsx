import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetAnalysis, DatasetColumn } from '@/types'

interface CorrelationAnalysisProps {
  analysis: DatasetAnalysis
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length
  if (n < 2) return 0
  const meanX = x.reduce((a, b) => a + b, 0) / n
  const meanY = y.reduce((a, b) => a + b, 0) / n
  let numSum = 0
  let denX = 0
  let denY = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    numSum += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  const den = Math.sqrt(denX * denY)
  return den === 0 ? 0 : numSum / den
}

function getCorrelationColor(r: number): string {
  const abs = Math.abs(r)
  if (abs < 0.2) return 'var(--color-muted-foreground)'
  if (r > 0) return `rgba(59, 130, 246, ${abs})` // blue for positive
  return `rgba(239, 68, 68, ${abs})` // red for negative
}

export function CorrelationAnalysis({ analysis }: CorrelationAnalysisProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = _dirtyVersion >= 0 ? getFileRows(analysis.datasetFileId) : []

  // Only numeric columns
  const numericColumns = useMemo(
    () => columns.filter((c) => c.type === 'number'),
    [columns]
  )

  // Build correlation matrix
  const matrix = useMemo(() => {
    if (numericColumns.length < 2 || rows.length < 2) return null

    // Extract numeric arrays
    const arrays = new Map<string, number[]>()
    for (const col of numericColumns) {
      arrays.set(col.id, [])
    }

    for (const row of rows) {
      let allValid = true
      for (const col of numericColumns) {
        const v = Number(row[col.id])
        if (isNaN(v)) { allValid = false; break }
      }
      if (allValid) {
        for (const col of numericColumns) {
          arrays.get(col.id)!.push(Number(row[col.id]))
        }
      }
    }

    // Compute pairwise correlations
    const corr: number[][] = []
    for (let i = 0; i < numericColumns.length; i++) {
      const rowCorr: number[] = []
      const xi = arrays.get(numericColumns[i].id)!
      for (let j = 0; j < numericColumns.length; j++) {
        if (i === j) {
          rowCorr.push(1)
        } else {
          const yj = arrays.get(numericColumns[j].id)!
          rowCorr.push(pearsonCorrelation(xi, yj))
        }
      }
      corr.push(rowCorr)
    }

    return { columns: numericColumns, corr, validRows: arrays.get(numericColumns[0].id)!.length }
  }, [numericColumns, rows, _dirtyVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  if (numericColumns.length < 2) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.correlation_need_two_numeric')}
      </div>
    )
  }

  if (!matrix) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.no_rows')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-3">
      <div className="text-[10px] text-muted-foreground">
        {t('datasets.correlation_description', { n: matrix.validRows })}
      </div>

      <div className="overflow-auto rounded-lg border">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-muted border-b border-r px-2 py-1.5 font-medium text-left" />
              {matrix.columns.map((col) => (
                <th
                  key={col.id}
                  className="bg-muted border-b px-2 py-1.5 font-medium text-center whitespace-nowrap"
                >
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.columns.map((rowCol, i) => (
              <tr key={rowCol.id}>
                <td className="sticky left-0 z-10 bg-muted border-b border-r px-2 py-1.5 font-medium whitespace-nowrap">
                  {rowCol.name}
                </td>
                {matrix.corr[i].map((r, j) => (
                  <td
                    key={matrix.columns[j].id}
                    className="border-b px-2 py-1.5 text-center tabular-nums font-mono text-[11px]"
                    style={{
                      backgroundColor: i === j ? 'var(--color-muted)' : undefined,
                      color: i === j ? 'var(--color-muted-foreground)' : getCorrelationColor(r),
                      fontWeight: Math.abs(r) > 0.5 && i !== j ? 600 : 400,
                    }}
                  >
                    {r.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
