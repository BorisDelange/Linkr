import { useTranslation } from 'react-i18next'
import { useDatasetStore } from '@/stores/dataset-store'
import { BarChart3 } from 'lucide-react'

interface ColumnStatsPanelProps {
  fileId: string | null
  columnId: string | null
}

export function ColumnStatsPanel({ fileId, columnId }: ColumnStatsPanelProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  if (!fileId || !columnId) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <BarChart3 size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('datasets.select_column_stats')}</p>
      </div>
    )
  }

  const file = files.find((f) => f.id === fileId)
  const column = file?.columns?.find((c) => c.id === columnId)
  const rows = _dirtyVersion >= 0 ? getFileRows(fileId) : []

  if (!column) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <p className="text-xs text-muted-foreground">{t('datasets.column_not_found')}</p>
      </div>
    )
  }

  // Compute basic statistics
  const values = rows.map((r) => r[columnId]).filter((v) => v != null)
  const total = rows.length
  const nonNull = values.length
  const nullCount = total - nonNull

  const numericValues = values.map(Number).filter((n) => !isNaN(n))
  const isNumeric = column.type === 'number' || (numericValues.length > 0 && numericValues.length === values.length)

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2">
        <h3 className="text-xs font-medium">{t('datasets.column_stats')}</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground truncate">{column.name}</p>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('datasets.stats_type')}</span>
            <span>{column.type}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('datasets.stats_total')}</span>
            <span>{total}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('datasets.stats_non_null')}</span>
            <span>{nonNull}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('datasets.stats_null')}</span>
            <span>{nullCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('datasets.stats_unique')}</span>
            <span>{new Set(values.map(String)).size}</span>
          </div>
        </div>

        {isNumeric && numericValues.length > 0 && (
          <div className="space-y-1.5 text-xs border-t pt-3">
            <h4 className="font-medium text-muted-foreground">{t('datasets.stats_numeric')}</h4>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('datasets.stats_min')}</span>
              <span>{Math.min(...numericValues).toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('datasets.stats_max')}</span>
              <span>{Math.max(...numericValues).toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('datasets.stats_mean')}</span>
              <span>{(numericValues.reduce((a, b) => a + b, 0) / numericValues.length).toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
