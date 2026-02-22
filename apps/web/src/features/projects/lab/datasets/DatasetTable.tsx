import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDatasetStore } from '@/stores/dataset-store'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TypeBadge } from './TypeBadge'
import { ColumnFilterInput, applyColumnFilter, type ColumnFilterValue } from './ColumnFilterInput'
import { hasTimeComponent } from '@/lib/dataset-utils'
import type { DatasetColumn } from '@/types'

interface DatasetTableProps {
  fileId: string
  selectedColumnId: string | null
  onSelectColumn: (columnId: string | null) => void
  hiddenColumns: Set<string>
  onHiddenColumnsChange?: (updater: (prev: Set<string>) => Set<string>) => void
}

const PAGE_SIZES = [25, 50, 100, 250, 500]

export function DatasetTable({ fileId, selectedColumnId, onSelectColumn, hiddenColumns, onHiddenColumnsChange }: DatasetTableProps) {
  const { t } = useTranslation()
  const { files, getFileRows, _dirtyVersion } = useDatasetStore()

  const file = files.find((f) => f.id === fileId)
  const columns = file?.columns ?? []
  // Subscribe to _dirtyVersion to re-render when data changes
  const rows = _dirtyVersion >= 0 ? getFileRows(fileId) : []

  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilterValue>>({})
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [resizing, setResizing] = useState<{ colId: string; startX: number; startW: number } | null>(null)

  // Reset state when switching files
  useEffect(() => {
    setPage(0)
    setColumnFilters({})
    setColumnWidths({})
  }, [fileId])

  // Visible columns
  const visibleColumns = useMemo(
    () => columns.filter((col) => !hiddenColumns.has(col.id)),
    [columns, hiddenColumns],
  )

  // Sample values per date column (for datetime detection)
  const samplesByCol = useMemo(() => {
    const map: Record<string, unknown[]> = {}
    for (const col of columns) {
      if (col.type === 'date') {
        map[col.id] = rows.slice(0, 100).map((r) => r[col.id])
      }
    }
    return map
  }, [columns, rows])

  // Filter rows client-side
  const filteredRows = useMemo(() => {
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v != null)
    if (activeFilters.length === 0) return rows

    // Build a colType lookup
    const colTypeMap: Record<string, DatasetColumn['type']> = {}
    for (const col of columns) colTypeMap[col.id] = col.type

    return rows.filter((row) =>
      activeFilters.every(([colId, filterValue]) =>
        applyColumnFilter(row[colId], colTypeMap[colId] ?? 'string', filterValue),
      ),
    )
  }, [rows, columnFilters, columns])

  // Pagination
  const totalCount = filteredRows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const clampedPage = Math.min(page, totalPages - 1)

  const pageRows = useMemo(
    () => filteredRows.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize),
    [filteredRows, clampedPage, pageSize],
  )

  // Row number offset for the current page
  const rowOffset = clampedPage * pageSize

  const hasActiveFilters = Object.values(columnFilters).some((v) => v != null)

  // Column filter change handler
  const handleFilterChange = useCallback((colId: string, value: ColumnFilterValue) => {
    setColumnFilters((prev) => {
      const next = { ...prev }
      if (value == null) delete next[colId]
      else next[colId] = value
      return next
    })
    setPage(0)
  }, [])

  // Column resize handler
  const getColWidth = useCallback(
    (colId: string, defaultWidth: number) => columnWidths[colId] ?? defaultWidth,
    [columnWidths],
  )

  const handleResizeStart = useCallback(
    (colId: string, e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const startW = columnWidths[colId] ?? 150

      setResizing({ colId, startX: clientX, startW })

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const currentX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
        const delta = currentX - clientX
        const newWidth = Math.max(60, startW + delta)
        setColumnWidths((prev) => ({ ...prev, [colId]: newWidth }))
      }

      const onEnd = () => {
        setResizing(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onEnd)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onEnd)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onEnd)
      document.addEventListener('touchmove', onMove)
      document.addEventListener('touchend', onEnd)
    },
    [columnWidths],
  )

  const resetColWidth = useCallback((colId: string) => {
    setColumnWidths((prev) => {
      const next = { ...prev }
      delete next[colId]
      return next
    })
  }, [])

  // Total table width
  const ROW_NUM_WIDTH = 50
  const DEFAULT_COL_WIDTH = 150
  const totalWidth =
    ROW_NUM_WIDTH +
    visibleColumns.reduce((sum, col) => sum + getColWidth(col.id, DEFAULT_COL_WIDTH), 0)

  if (columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <p className="text-sm text-muted-foreground">{t('datasets.empty_dataset')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('datasets.add_columns_hint')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Scrollable table area */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="text-xs"
          style={{ minWidth: totalWidth, width: '100%', tableLayout: 'fixed' }}
        >
          <thead className="sticky top-0 z-10 bg-muted">
            {/* Column headers */}
            <tr>
              <th
                style={{ width: ROW_NUM_WIDTH }}
                className="sticky left-0 z-20 bg-muted border-b border-r px-2 py-1.5 text-center text-muted-foreground font-normal"
              >
                #
              </th>
              {visibleColumns.map((col) => {
                const w = getColWidth(col.id, DEFAULT_COL_WIDTH)
                return (
                  <th
                    key={col.id}
                    style={{ width: w }}
                    className={cn(
                      'relative border-b border-r px-3 py-1.5 text-left font-medium whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer hover:bg-accent/50',
                      selectedColumnId === col.id && 'bg-accent text-accent-foreground',
                    )}
                    onClick={() =>
                      onSelectColumn(col.id === selectedColumnId ? null : col.id)
                    }
                  >
                    <div className="flex items-center gap-1.5">
                      <TypeBadge type={col.type} size="sm" />
                      <span className="truncate">{col.name}</span>
                    </div>
                    {/* Resize handle */}
                    <div
                      onMouseDown={(e) => handleResizeStart(col.id, e)}
                      onTouchStart={(e) => handleResizeStart(col.id, e)}
                      onDoubleClick={() => resetColWidth(col.id)}
                      className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                    >
                      <div
                        className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                          resizing?.colId === col.id
                            ? 'bg-primary'
                            : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                        }`}
                      />
                    </div>
                  </th>
                )
              })}
            </tr>
            {/* Column filter row */}
            <tr>
              <th
                style={{ width: ROW_NUM_WIDTH }}
                className="sticky left-0 z-20 bg-muted border-b border-r px-1 py-1"
              />
              {visibleColumns.map((col) => (
                <th
                  key={`filter-${col.id}`}
                  style={{ width: getColWidth(col.id, DEFAULT_COL_WIDTH) }}
                  className="border-b border-r px-1 py-1 bg-muted"
                >
                  <ColumnFilterInput
                    colId={col.id}
                    colType={col.type}
                    colName={col.name}
                    value={columnFilters[col.id]}
                    onChange={handleFilterChange}
                    isDatetime={samplesByCol[col.id] ? hasTimeComponent(samplesByCol[col.id]) : false}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleColumns.length + 1}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  {t('datasets.no_rows')}
                </td>
              </tr>
            ) : (
              pageRows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-accent/30">
                  <td
                    style={{ width: ROW_NUM_WIDTH }}
                    className="sticky left-0 z-[5] bg-background border-b border-r px-2 py-1 text-center text-muted-foreground tabular-nums"
                  >
                    {rowOffset + rowIdx + 1}
                  </td>
                  {visibleColumns.map((col) => (
                    <td
                      key={col.id}
                      style={{ maxWidth: getColWidth(col.id, DEFAULT_COL_WIDTH) }}
                      className={cn(
                        'border-b border-r px-3 py-1 whitespace-nowrap overflow-hidden text-ellipsis',
                        selectedColumnId === col.id && 'bg-accent/20',
                      )}
                    >
                      {row[col.id] != null
                        ? String(row[col.id])
                        : <span className="italic text-muted-foreground/50">null</span>}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination bar + column visibility */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('files.table_total', { count: totalCount })}
            {hasActiveFilters && ` / ${rows.length}`}
          </span>
          {onHiddenColumnsChange && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <Settings2 size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[300px] w-[200px] overflow-y-auto">
                <DropdownMenuLabel className="text-xs">
                  {t('files.columns', 'Columns')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {columns.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={!hiddenColumns.has(col.id)}
                    onCheckedChange={() => {
                      onHiddenColumnsChange((prev) => {
                        const next = new Set(prev)
                        if (next.has(col.id)) next.delete(col.id)
                        else next.add(col.id)
                        return next
                      })
                    }}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      <TypeBadge type={col.type} size="sm" />
                      <span className="truncate">{col.name}</span>
                    </div>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('files.table_per_page')}
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              setPageSize(Number(v))
              setPage(0)
            }}
          >
            <SelectTrigger className="h-7 w-[70px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {t('files.table_page', {
              page: clampedPage + 1,
              total: totalPages,
            })}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage(clampedPage + 1)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
