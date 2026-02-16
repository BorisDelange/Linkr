import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface OutputTableProps {
  headers: string[]
  rows: string[][]
}

export function OutputTable({ headers, rows }: OutputTableProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})

  // Filter rows client-side based on column search inputs
  const filteredRows = useMemo(() => {
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v.length > 0)
    if (activeFilters.length === 0) return rows
    return rows.filter((row) =>
      activeFilters.every(([colId, term]) => {
        const idx = parseInt(colId.replace('col_', ''), 10)
        const val = row[idx] ?? ''
        return val.toLowerCase().includes(term.toLowerCase())
      }),
    )
  }, [rows, columnFilters])

  const totalCount = filteredRows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const pageRows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize],
  )

  const columns = useMemo<ColumnDef<string[]>[]>(
    () =>
      headers.map((h, idx) => ({
        id: `col_${idx}`,
        header: () => h,
        accessorFn: (row: string[]) => row[idx],
        size: 150,
        minSize: 60,
      })),
    [headers],
  )

  const table = useReactTable({
    data: pageRows,
    columns,
    state: { columnSizing, columnVisibility },
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  const handleFilterChange = useCallback(
    (colId: string, value: string) => {
      setColumnFilters((prev) => ({ ...prev, [colId]: value }))
      setPage(0)
    },
    [],
  )

  const hasActiveFilters = Object.values(columnFilters).some((v) => v.length > 0)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar: column visibility */}
      <div className="flex items-center justify-between border-b px-2 py-1">
        <span className="text-xs text-muted-foreground">
          {hasActiveFilters
            ? t('files.table_total', { count: totalCount }) +
              ` / ${rows.length}`
            : ''}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
              <Settings2 size={12} />
              {t('files.columns', 'Columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[300px] w-[180px] overflow-y-auto">
            <DropdownMenuLabel className="text-xs">
              {t('files.columns', 'Columns')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table.getAllColumns().map((col) => (
              <DropdownMenuCheckboxItem
                key={col.id}
                checked={col.getIsVisible()}
                onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                {headers[parseInt(col.id.replace('col_', ''), 10)]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto pb-3">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            {/* Column headers */}
            <TableRow>
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="relative select-none text-xs"
                    style={{ width: header.getSize() }}
                  >
                    <span className="truncate">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                    </span>
                    {/* Resize handle */}
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                      className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                    >
                      <div
                        className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                          header.column.getIsResizing()
                            ? 'bg-primary'
                            : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                        }`}
                      />
                    </div>
                  </TableHead>
                )),
              )}
            </TableRow>
            {/* Column filter row */}
            <TableRow className="hover:bg-transparent">
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={`filter-${header.id}`}
                    className="px-1 py-1"
                    style={{ width: header.getSize() }}
                  >
                    <input
                      className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary"
                      placeholder={`${headers[parseInt(header.id.replace('col_', ''), 10)]}...`}
                      value={columnFilters[header.id] ?? ''}
                      onChange={(e) => handleFilterChange(header.id, e.target.value)}
                    />
                  </TableHead>
                )),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={headers.length}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  {t('files.no_output')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.index}>
                  {row.getVisibleCells().map((cell) => {
                    const raw = cell.getValue()
                    const title = raw != null ? String(raw) : undefined
                    return (
                      <TableCell
                        key={cell.id}
                        className="overflow-hidden truncate text-xs"
                        style={{ maxWidth: cell.column.getSize() }}
                        title={title}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination bar */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t('files.table_total', { count: totalCount })}
        </span>
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
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="25">25</SelectItem>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {t('files.table_page', { page: page + 1, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
