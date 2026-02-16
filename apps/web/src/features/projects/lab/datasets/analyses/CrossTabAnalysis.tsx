import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetAnalysis, DatasetColumn } from '@/types'

interface CrossTabAnalysisProps {
  analysis: DatasetAnalysis
}

const MAX_CATEGORIES = 30

export function CrossTabAnalysis({ analysis }: CrossTabAnalysisProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion, updateAnalysis } = useDatasetStore()

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = _dirtyVersion >= 0 ? getFileRows(analysis.datasetFileId) : []

  // Config: rowCol and colCol
  const rowColId = (analysis.config.rowColumnId as string) ?? ''
  const colColId = (analysis.config.colColumnId as string) ?? ''

  const setRowCol = (id: string) => {
    updateAnalysis(analysis.id, { config: { ...analysis.config, rowColumnId: id } })
  }
  const setColCol = (id: string) => {
    updateAnalysis(analysis.id, { config: { ...analysis.config, colColumnId: id } })
  }

  // Categorical columns (or any column with few unique values)
  const categoricalColumns = useMemo(() => {
    return columns.filter((c) => c.type === 'string' || c.type === 'boolean')
  }, [columns])

  const rowColumn = columns.find((c) => c.id === rowColId)
  const colColumn = columns.find((c) => c.id === colColId)

  // Build cross-tabulation
  const crossTab = useMemo(() => {
    if (!rowColumn || !colColumn || rows.length === 0) return null

    const rowValues = new Set<string>()
    const colValues = new Set<string>()
    const counts = new Map<string, number>()

    for (const row of rows) {
      const rv = row[rowColumn.id]
      const cv = row[colColumn.id]
      if (rv == null || rv === '' || cv == null || cv === '') continue
      const rk = String(rv)
      const ck = String(cv)
      rowValues.add(rk)
      colValues.add(ck)
      const key = `${rk}|${ck}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const sortedRows = [...rowValues].sort().slice(0, MAX_CATEGORIES)
    const sortedCols = [...colValues].sort().slice(0, MAX_CATEGORIES)

    // Compute row totals and column totals
    const rowTotals = new Map<string, number>()
    const colTotals = new Map<string, number>()
    let grandTotal = 0

    for (const rv of sortedRows) {
      let total = 0
      for (const cv of sortedCols) {
        const c = counts.get(`${rv}|${cv}`) ?? 0
        total += c
        colTotals.set(cv, (colTotals.get(cv) ?? 0) + c)
      }
      rowTotals.set(rv, total)
      grandTotal += total
    }

    return {
      rowValues: sortedRows,
      colValues: sortedCols,
      counts,
      rowTotals,
      colTotals,
      grandTotal,
      truncatedRows: rowValues.size > MAX_CATEGORIES,
      truncatedCols: colValues.size > MAX_CATEGORIES,
    }
  }, [rowColumn, colColumn, rows, _dirtyVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Column selectors */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{t('datasets.crosstab_row_variable')}</Label>
          <Select value={rowColId} onValueChange={setRowCol}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t('datasets.crosstab_select_column')} />
            </SelectTrigger>
            <SelectContent>
              {categoricalColumns.map((col) => (
                <SelectItem key={col.id} value={col.id}>
                  {col.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('datasets.crosstab_col_variable')}</Label>
          <Select value={colColId} onValueChange={setColCol}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t('datasets.crosstab_select_column')} />
            </SelectTrigger>
            <SelectContent>
              {categoricalColumns.map((col) => (
                <SelectItem key={col.id} value={col.id}>
                  {col.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Cross-tabulation table */}
      {!rowColumn || !colColumn ? (
        <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
          {t('datasets.crosstab_select_both')}
        </div>
      ) : !crossTab ? (
        <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
          {t('datasets.no_rows')}
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 bg-muted border-b border-r px-2 py-1.5 font-medium text-left">
                  {rowColumn.name} \ {colColumn.name}
                </th>
                {crossTab.colValues.map((cv) => (
                  <th key={cv} className="bg-muted border-b px-2 py-1.5 font-medium text-center whitespace-nowrap">
                    {cv}
                  </th>
                ))}
                <th className="bg-muted border-b border-l px-2 py-1.5 font-medium text-center">{t('datasets.crosstab_total')}</th>
              </tr>
            </thead>
            <tbody>
              {crossTab.rowValues.map((rv) => (
                <tr key={rv} className="hover:bg-accent/30">
                  <td className="sticky left-0 z-10 bg-muted border-b border-r px-2 py-1.5 font-medium whitespace-nowrap">
                    {rv}
                  </td>
                  {crossTab.colValues.map((cv) => {
                    const count = crossTab.counts.get(`${rv}|${cv}`) ?? 0
                    const pct = crossTab.grandTotal > 0 ? (count / crossTab.grandTotal) * 100 : 0
                    return (
                      <td key={cv} className="border-b px-2 py-1.5 text-center tabular-nums">
                        {count > 0 ? (
                          <>
                            {count}
                            <span className="ml-1 text-[10px] text-muted-foreground">({pct.toFixed(1)}%)</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="border-b border-l px-2 py-1.5 text-center tabular-nums font-medium bg-muted/50">
                    {crossTab.rowTotals.get(rv) ?? 0}
                  </td>
                </tr>
              ))}
              {/* Totals row */}
              <tr className="bg-muted/50">
                <td className="sticky left-0 z-10 bg-muted border-r px-2 py-1.5 font-medium">
                  {t('datasets.crosstab_total')}
                </td>
                {crossTab.colValues.map((cv) => (
                  <td key={cv} className="px-2 py-1.5 text-center tabular-nums font-medium">
                    {crossTab.colTotals.get(cv) ?? 0}
                  </td>
                ))}
                <td className="border-l px-2 py-1.5 text-center tabular-nums font-semibold">
                  {crossTab.grandTotal}
                </td>
              </tr>
            </tbody>
          </table>
          {(crossTab.truncatedRows || crossTab.truncatedCols) && (
            <div className="border-t px-2 py-1 text-[10px] text-muted-foreground bg-muted/50 italic">
              {t('datasets.crosstab_truncated', { max: MAX_CATEGORIES })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
