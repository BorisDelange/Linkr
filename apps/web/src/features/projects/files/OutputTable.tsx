import { useState, useMemo, useCallback } from 'react'
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import {
  ColumnFilterInput,
  applyColumnFilter,
  type ColumnFilterValue,
} from '@/features/projects/lab/datasets/ColumnFilterInput'
import { cn } from '@/lib/utils'
import { DATE_DATETIME_RE } from '@/lib/dataset-utils'

interface OutputTableProps {
  headers: string[]
  rows: string[][]
  /** Compact mode for dashboard widgets — hides toolbar, filter row, and page-size selector. */
  compact?: boolean
}

type InferredType = 'number' | 'boolean' | 'date' | 'string' | 'unknown'

function inferColumnType(rows: string[][], colIdx: number): InferredType {
  let hasValue = false
  let allNumber = true
  let allBool = true
  let allDate = true

  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const val = rows[i][colIdx]
    if (val == null || val === '' || val.toLowerCase() === 'null' || val.toLowerCase() === 'na' || val.toLowerCase() === 'none') continue
    hasValue = true
    if (allNumber && isNaN(Number(val))) allNumber = false
    if (allBool && val !== 'true' && val !== 'false' && val !== 'TRUE' && val !== 'FALSE' && val !== '0' && val !== '1') allBool = false
    if (allDate && !DATE_DATETIME_RE.test(val)) allDate = false
    if (!allNumber && !allBool && !allDate) return 'string'
  }

  if (!hasValue) return 'unknown'
  if (allBool) return 'boolean'
  if (allNumber) return 'number'
  if (allDate) return 'date'
  return 'string'
}

/** Detect whether date-typed column values contain time components. */
function colHasTimeComponent(rows: string[][], colIdx: number): boolean {
  const timeRe = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/
  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const val = rows[i][colIdx]
    if (val != null && val !== '' && timeRe.test(val)) return true
  }
  return false
}

function isNullish(val: string | undefined): boolean {
  if (val == null || val === '') return true
  const lower = val.toLowerCase()
  return lower === 'null' || lower === 'na' || lower === 'none' || lower === 'nan'
}

// Subtle column background colors for visual separation (alternating)
const COLUMN_COLORS = [
  'bg-blue-500/[0.04]',
  '',  // transparent
  'bg-violet-500/[0.04]',
  '',
  'bg-emerald-500/[0.04]',
  '',
  'bg-amber-500/[0.04]',
  '',
  'bg-rose-500/[0.04]',
  '',
  'bg-cyan-500/[0.04]',
  '',
]

export function OutputTable({ headers, rows, compact }: OutputTableProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilterValue>>({})
  const [hiddenColumns, setHiddenColumns] = useState<Set<number>>(new Set())

  // Infer column types from data
  const columnTypes = useMemo<InferredType[]>(
    () => headers.map((_, idx) => inferColumnType(rows, idx)),
    [headers, rows],
  )

  // Detect datetime columns (for date filter input type)
  const columnDatetimeFlags = useMemo(
    () => headers.map((_, idx) => columnTypes[idx] === 'date' ? colHasTimeComponent(rows, idx) : false),
    [headers, rows, columnTypes],
  )

  // Visible column indices
  const visibleIndices = useMemo(
    () => headers.map((_, i) => i).filter((i) => !hiddenColumns.has(i)),
    [headers, hiddenColumns],
  )

  // Filter rows client-side using type-aware filtering
  const filteredRows = useMemo(() => {
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v != null)
    if (activeFilters.length === 0) return rows
    return rows.filter((row) =>
      activeFilters.every(([colKey, filterValue]) => {
        const idx = parseInt(colKey, 10)
        return applyColumnFilter(row[idx], columnTypes[idx], filterValue)
      }),
    )
  }, [rows, columnFilters, columnTypes])

  const totalCount = filteredRows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const pageRows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize],
  )

  const handleFilterChange = useCallback(
    (colId: string, value: ColumnFilterValue) => {
      setColumnFilters((prev) => {
        const next = { ...prev }
        if (value == null) delete next[colId]
        else next[colId] = value
        return next
      })
      setPage(0)
    },
    [],
  )

  const toggleColumn = useCallback((idx: number) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  const hasActiveFilters = Object.keys(columnFilters).length > 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted">
            {/* Column headers */}
            <tr>
              <th className={cn('sticky left-0 z-20 bg-muted w-10 min-w-[40px] border-b border-r text-center text-muted-foreground font-normal', compact ? 'px-1 py-0.5' : 'px-2 py-1.5')}>
                #
              </th>
              {visibleIndices.map((idx) => (
                <th
                  key={idx}
                  className={cn('border-b border-r text-left font-medium whitespace-nowrap', compact ? 'px-2 py-0.5' : 'px-3 py-1.5', COLUMN_COLORS[idx % COLUMN_COLORS.length])}
                >
                  <div className="flex items-center gap-1.5">
                    <TypeBadge type={columnTypes[idx]} size="sm" />
                    <span className="truncate">{headers[idx]}</span>
                  </div>
                </th>
              ))}
            </tr>
            {/* Column filter row (hidden in compact mode) */}
            {!compact && (
              <tr>
                <th className="sticky left-0 z-20 bg-muted border-b border-r px-1 py-1" />
                {visibleIndices.map((idx) => (
                  <th key={`filter-${idx}`} className="border-b border-r px-1 py-1 bg-muted">
                    <ColumnFilterInput
                      colId={String(idx)}
                      colType={columnTypes[idx]}
                      colName={headers[idx]}
                      value={columnFilters[idx]}
                      onChange={handleFilterChange}
                      isDatetime={columnDatetimeFlags[idx]}
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleIndices.length + 1}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  {t('files.no_output')}
                </td>
              </tr>
            ) : (
              pageRows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-accent/30">
                  <td className={cn('sticky left-0 z-[5] bg-background border-b border-r text-center text-muted-foreground tabular-nums', compact ? 'px-1 py-0' : 'px-2 py-1')}>
                    {page * pageSize + rowIdx + 1}
                  </td>
                  {visibleIndices.map((colIdx) => {
                    const val = row[colIdx]
                    const nullish = isNullish(val)
                    return (
                      <td
                        key={colIdx}
                        className={cn(
                          'border-b border-r whitespace-nowrap max-w-[300px] truncate',
                          compact ? 'px-2 py-0' : 'px-3 py-1',
                          columnTypes[colIdx] === 'number' && !nullish && 'tabular-nums',
                          COLUMN_COLORS[colIdx % COLUMN_COLORS.length],
                        )}
                        title={!nullish ? val : undefined}
                      >
                        {nullish
                          ? <span className="italic text-muted-foreground/50">null</span>
                          : val}
                      </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination bar */}
      <div className={cn('flex shrink-0 items-center justify-between border-t', compact ? 'px-2 py-0.5' : 'px-3 py-1.5')}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {hasActiveFilters
              ? `${totalCount} / ${rows.length}`
              : t('files.table_total', { count: totalCount })}
          </span>
          {!compact && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <Settings2 size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[300px] w-[180px] overflow-y-auto">
                <DropdownMenuLabel className="text-xs">
                  {t('files.columns', 'Columns')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {headers.map((h, idx) => (
                  <DropdownMenuCheckboxItem
                    key={idx}
                    checked={!hiddenColumns.has(idx)}
                    onCheckedChange={() => toggleColumn(idx)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      <TypeBadge type={columnTypes[idx]} size="sm" />
                      <span className="truncate">{h}</span>
                    </div>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!compact && (
            <>
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
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="500">500</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            {t('files.table_page', { page: page + 1, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="icon"
            className={compact ? 'h-5 w-5' : 'h-7 w-7'}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={compact ? 10 : 14} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className={compact ? 'h-5 w-5' : 'h-7 w-7'}
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={compact ? 10 : 14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
