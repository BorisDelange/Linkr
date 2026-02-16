import { useTranslation } from 'react-i18next'
import { useDatasetStore } from '@/stores/dataset-store'
import { cn } from '@/lib/utils'
import { TypeBadge } from './TypeBadge'

interface DatasetTableProps {
  fileId: string
  selectedColumnId: string | null
  onSelectColumn: (columnId: string | null) => void
}

export function DatasetTable({ fileId, selectedColumnId, onSelectColumn }: DatasetTableProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  const file = files.find((f) => f.id === fileId)
  const columns = file?.columns ?? []
  // Subscribe to _dirtyVersion to re-render when data changes
  const rows = _dirtyVersion >= 0 ? getFileRows(fileId) : []

  if (columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <p className="text-sm text-muted-foreground">{t('datasets.empty_dataset')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('datasets.add_columns_hint')}</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-auto">
      <table className="text-xs border-collapse">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="sticky left-0 z-20 bg-muted w-10 min-w-[40px] border-b border-r px-2 py-1.5 text-center text-muted-foreground font-normal">
              #
            </th>
            {columns.map((col) => (
              <th
                key={col.id}
                onClick={() => onSelectColumn(col.id === selectedColumnId ? null : col.id)}
                className={cn(
                  'border-b border-r px-3 py-1.5 text-left font-medium cursor-pointer hover:bg-accent/50 whitespace-nowrap',
                  selectedColumnId === col.id && 'bg-accent text-accent-foreground'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <TypeBadge type={col.type} size="sm" />
                  <span className="truncate">{col.name}</span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx} className="hover:bg-accent/30">
              <td className="sticky left-0 z-[5] bg-background border-b border-r px-2 py-1 text-center text-muted-foreground tabular-nums">
                {rowIdx + 1}
              </td>
              {columns.map((col) => (
                <td
                  key={col.id}
                  className={cn(
                    'border-b border-r px-3 py-1 whitespace-nowrap max-w-[300px] truncate',
                    selectedColumnId === col.id && 'bg-accent/20'
                  )}
                >
                  {row[col.id] != null ? String(row[col.id]) : <span className="italic text-muted-foreground/50">null</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="py-8 text-center text-xs text-muted-foreground">
          {t('datasets.no_rows')}
        </div>
      )}
    </div>
  )
}
