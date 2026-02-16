import { useTranslation } from 'react-i18next'
import { useDatasetStore } from '@/stores/dataset-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

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
    <ScrollArea className="h-full">
      <div className="min-w-full">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <tr>
              <th className="w-10 border-b border-r px-2 py-1.5 text-center text-muted-foreground font-normal">
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
                  <div className="flex items-center gap-1">
                    <span className="truncate">{col.name}</span>
                    <span className="text-[10px] text-muted-foreground font-normal">{col.type}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-accent/30">
                <td className="border-b border-r px-2 py-1 text-center text-muted-foreground">
                  {rowIdx + 1}
                </td>
                {columns.map((col) => (
                  <td
                    key={col.id}
                    className={cn(
                      'border-b border-r px-3 py-1 whitespace-nowrap',
                      selectedColumnId === col.id && 'bg-accent/20'
                    )}
                  >
                    {row[col.id] != null ? String(row[col.id]) : ''}
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
    </ScrollArea>
  )
}
