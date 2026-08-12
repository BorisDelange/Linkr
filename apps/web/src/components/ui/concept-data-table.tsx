import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { cn } from '@/lib/utils'

/** Pages needed for `total` rows; 1 when unpaginated, so callers can be uniform. */
export function pageCountOf(total: number, pageSize?: number): number {
  if (!pageSize) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/** A page index that exists: filtering can shrink the set under the current page. */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pageCount - 1))
}

const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

function DebouncedInput({ value: ext, onChange, className, placeholder }: {
  value: string; onChange: (v: string) => void; className?: string; placeholder?: string
}) {
  const [local, setLocal] = useState(ext)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setLocal(ext) }, [ext])
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocal(e.target.value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange(e.target.value), 300)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return <input className={className} placeholder={placeholder} value={local} onChange={handle} />
}

/** Cell text with an instant tooltip shown only when the content is truncated. */
export function TruncatedText({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  const check = () => {
    const el = ref.current
    setTruncated(!!el && el.scrollWidth > el.clientWidth)
  }
  const span = (
    <span ref={ref} className={`block truncate ${className ?? ''}`} onPointerEnter={check}>
      {children}
    </span>
  )
  if (!truncated) return span
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent side="top" className="pointer-events-none max-w-xs">{children}</TooltipContent>
    </Tooltip>
  )
}

type Sorting = { columnId: string; desc: boolean } | null

/** Kind of inline column filter to render under a column header. */
export type ConceptColumnFilter = 'text' | 'number' | 'select' | 'none'

export interface ConceptColumn<T> {
  id: string
  header: string
  /** Value used for sorting, filtering and default cell rendering. */
  accessor: (row: T) => string | number | null | undefined
  /** Optional custom cell renderer (defaults to a truncated text of the accessor value). */
  cell?: (row: T) => ReactNode
  filter?: ConceptColumnFilter
  /** Disable sorting on this column (e.g. an actions/links column). Default true. */
  sortable?: boolean
  /** For a 'select' filter: map a raw option value to a display label (e.g. translate/capitalize). */
  selectOptionLabel?: (value: string) => string
  size?: number
  minSize?: number
  /** Hidden by default (still toggleable via the column menu). */
  hidden?: boolean
  /** Center the cell content (used for boolean/flag columns). */
  center?: boolean
}

interface ConceptDataTableProps<T> {
  data: T[]
  columns: ConceptColumn<T>[]
  /** Stable row key. */
  rowKey: (row: T) => string | number
  /** Empty-state message. */
  emptyMessage?: string
  /** Make rows clickable (e.g. to drive a detail panel). */
  onRowClick?: (row: T) => void
  /** Key of the currently selected row — highlighted when set. */
  selectedRowKey?: string | number | null
  /**
   * Rows per page. Omit to render every row, which is right for the short lists
   * most callers pass; set it when the data can run to thousands, where a row per
   * DOM node makes sorting and resizing visibly slow.
   */
  pageSize?: number
  /**
   * Column to sort by on first render, and its direction. The user can still
   * change it; this only decides what they see before touching anything, which
   * matters when the interesting rows are the big ones.
   */
  initialSorting?: { columnId: string; desc: boolean }
}

/**
 * Shared OMOP-style concept datatable: per-column sort, resize, inline filters
 * (text / number / multi-select), column-visibility menu and a results count.
 * Generalized from RelationsTable so concept lists read the same everywhere.
 */
export function ConceptDataTable<T>({ data, columns: cols, rowKey, emptyMessage, onRowClick, selectedRowKey, pageSize, initialSorting }: ConceptDataTableProps<T>) {
  const { t } = useTranslation()
  const [sorting, setSorting] = useState<Sorting>(initialSorting ?? null)
  const [filters, setFilters] = useState<Record<string, string | Set<string> | undefined>>({})
  const [page, setPage] = useState(0)
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(cols.filter((c) => c.hidden).map((c) => [c.id, false])),
  )

  const handleSort = (columnId: string) => {
    setSorting((s) =>
      s?.columnId === columnId
        ? s.desc ? { columnId, desc: false } : null
        : { columnId, desc: true },
    )
  }

  const colById = useMemo(() => new Map(cols.map((c) => [c.id, c])), [cols])

  /** Distinct values per select-filter column. */
  const selectOptions = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const c of cols) {
      if (c.filter !== 'select') continue
      out[c.id] = [...new Set(data.map((r) => String(c.accessor(r) ?? '')).filter(Boolean))].sort()
    }
    return out
  }, [cols, data])

  const filtered = useMemo(() => {
    let rows = data
    for (const c of cols) {
      const f = filters[c.id]
      if (f == null) continue
      if (f instanceof Set) {
        if (f.size) rows = rows.filter((r) => f.has(String(c.accessor(r) ?? '')))
      } else if (f) {
        const q = f.toLowerCase()
        rows = rows.filter((r) => String(c.accessor(r) ?? '').toLowerCase().includes(q))
      }
    }
    if (sorting) {
      const col = colById.get(sorting.columnId)
      if (col) {
        const dir = sorting.desc ? -1 : 1
        rows = [...rows].sort((a, b) => {
          const av = col.accessor(a)
          const bv = col.accessor(b)
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
          return dir * String(av).localeCompare(String(bv))
        })
      }
    }
    return rows
  }, [data, cols, filters, sorting, colById])

  const pageCount = pageCountOf(filtered.length, pageSize)
  // Clamped, not reset to 0: narrowing a filter should not throw away the user's
  // position when the page they are on still exists.
  const safePage = clampPage(page, pageCount)
  const paged = useMemo(
    () => (pageSize ? filtered.slice(safePage * pageSize, (safePage + 1) * pageSize) : filtered),
    [filtered, pageSize, safePage],
  )

  const renderFilter = (columnId: string) => {
    const col = colById.get(columnId)
    if (!col || !col.filter || col.filter === 'none') return null
    if (col.filter === 'select') {
      const rawOpts = selectOptions[columnId] ?? []
      if (rawOpts.length < 2) return null
      const opts = col.selectOptionLabel
        ? rawOpts.map((v) => ({ value: v, label: col.selectOptionLabel!(v) }))
        : rawOpts
      const current = filters[columnId]
      const value = current instanceof Set ? [...current] : []
      return (
        <MultiSelectFilter
          value={value}
          options={opts}
          placeholder={col.header}
          onChange={(v) => setFilters((f) => ({ ...f, [columnId]: v.length ? new Set(v) : undefined }))}
        />
      )
    }
    const current = filters[columnId]
    const value = typeof current === 'string' ? current : ''
    const isNum = col.filter === 'number'
    return (
      <DebouncedInput
        className={`${FILTER_INPUT_CLASS}${isNum ? ' font-mono' : ''}`}
        placeholder={isNum ? 'ID...' : '...'}
        value={value}
        onChange={(v) => setFilters((f) => ({ ...f, [columnId]: v || undefined }))}
      />
    )
  }

  const columns = useMemo<ColumnDef<T>[]>(() => cols.map((c) => ({
    id: c.id,
    header: () => c.header,
    accessorFn: (r) => c.accessor(r),
    cell: ({ row }) =>
      c.cell
        ? c.cell(row.original)
        : <TruncatedText className="text-xs">{String(c.accessor(row.original) ?? '')}</TruncatedText>,
    size: c.size ?? 120,
    minSize: c.minSize ?? 50,
    enableResizing: true,
  })), [cols])

  const table = useReactTable({
    data: paged,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    manualSorting: true,
    manualFiltering: true,
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            <TableRow>
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((header) => {
                  const colId = header.column.id
                  const canSort = colById.get(colId)?.sortable !== false
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none overflow-hidden text-xs"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {canSort ? (
                        <button type="button" className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-2 hover:text-foreground" onClick={() => handleSort(colId)}>
                          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TruncatedHeader>
                          {!sorting || sorting.columnId !== colId
                            ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                            : sorting.desc
                              ? <ArrowDown size={10} className="shrink-0 text-primary" />
                              : <ArrowUp size={10} className="shrink-0 text-primary" />}
                        </button>
                      ) : (
                        <div className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-2">
                          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TruncatedHeader>
                        </div>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'}`} />
                        </div>
                      )}
                    </TableHead>
                  )
                }),
              )}
            </TableRow>
            <TableRow className="hover:bg-transparent">
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((header) => (
                  <TableHead key={`f-${header.id}`} className="px-1 py-1" style={{ width: header.getSize() }}>
                    {renderFilter(header.column.id)}
                  </TableHead>
                )),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-16 text-center text-xs text-muted-foreground">
                  {emptyMessage ?? t('common.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const key = rowKey(row.original)
                return (
                <TableRow
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(
                    onRowClick && 'cursor-pointer',
                    selectedRowKey != null && key === selectedRowKey ? 'bg-accent' : onRowClick && 'hover:bg-accent/50',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`overflow-hidden truncate px-2 py-1 text-xs${colById.get(cell.column.id)?.center ? ' text-center' : ''}`}
                      style={{ maxWidth: cell.column.getSize() }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex shrink-0 items-center border-t px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {filtered.length} / {data.length} {t('common.results').toLowerCase()}
          </span>
          {pageSize && pageCount > 1 && (
            <div className="ml-1 flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 0}
                aria-label={t('common.previous')}
              >
                <ChevronLeft size={12} />
              </Button>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= pageCount - 1}
                aria-label={t('common.next')}
              >
                <ChevronRight size={12} />
              </Button>
            </div>
          )}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                    <Settings2 size={12} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table.getAllColumns().map((col) => (
                <DropdownMenuCheckboxItem
                  key={col.id}
                  checked={col.getIsVisible()}
                  onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {colById.get(col.id)?.header ?? col.id}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
