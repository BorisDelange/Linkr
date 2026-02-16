import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type VisibilityState,
  type Header,
} from '@tanstack/react-table'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import type { ConceptRow, ConceptCounts } from './use-concepts'
import type { ConceptFilters, ConceptSorting, ColumnDescriptor } from './concept-queries'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConceptTableProps {
  concepts: ConceptRow[]
  conceptCounts: Map<number, ConceptCounts>
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
  isLoading: boolean
  selectedConceptId: number | null
  availableColumns: ColumnDescriptor[]
  filters: ConceptFilters
  filterOptions: Record<string, string[]>
  sorting: ConceptSorting | null
  onFilterChange: (key: string, value: string | null) => void
  onSortingChange: (columnId: string) => void
  onSelect: (conceptId: number) => void
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capitalize a snake_case key into a display label. */
function columnLabel(id: string): string {
  return id
    .replace(/^_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ColumnFilterSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string | null
  options: string[]
  placeholder: string
  onChange: (v: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? null : v)}
    >
      <SelectTrigger className="h-6 w-full border-dashed text-[10px] font-normal">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SortIndicator({ columnId, sorting }: { columnId: string; sorting: ConceptSorting | null }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  if (sorting.desc) {
    return <ArrowDown size={10} className="shrink-0 text-primary" />
  }
  return <ArrowUp size={10} className="shrink-0 text-primary" />
}

function SortableColumnHeader({
  header,
  sorting,
  onSort,
  isDropTarget,
}: {
  header: Header<ConceptRow, unknown>
  sorting: ConceptSorting | null
  onSort: (columnId: string) => void
  isDropTarget: boolean
}) {
  const columnId = header.column.id

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: columnId })

  return (
    <TableHead
      ref={setNodeRef}
      className={`relative select-none text-xs ${isDropTarget ? 'bg-primary/10' : ''}`}
      style={{ width: header.getSize(), opacity: isDragging ? 0.4 : 1 }}
    >
      {isDropTarget && (
        <div className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={10} />
        </button>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 hover:text-foreground"
          onClick={() => onSort(columnId)}
        >
          <span className="truncate">
            {flexRender(header.column.columnDef.header, header.getContext())}
          </span>
          <SortIndicator columnId={columnId} sorting={sorting} />
        </button>
      </div>
      {/* Resize handle */}
      <div
        onMouseDown={header.getResizeHandler()}
        onTouchStart={header.getResizeHandler()}
        onDoubleClick={() => header.column.resetSize()}
        className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
      >
        <div
          className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
            header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
          }`}
        />
      </div>
    </TableHead>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConceptTable({
  concepts,
  conceptCounts,
  totalCount,
  page,
  pageSize,
  totalPages,
  isLoading,
  selectedConceptId,
  availableColumns,
  filters,
  filterOptions,
  sorting,
  onFilterChange,
  onSortingChange,
  onSelect,
  onPageChange,
  onPageSizeChange,
}: ConceptTableProps) {
  const { t } = useTranslation()
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([])
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const [overColumnId, setOverColumnId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  // Build TanStack columns dynamically from availableColumns
  const columns = useMemo<ColumnDef<ConceptRow>[]>(() => {
    return availableColumns.map((col) => {
      const base: Partial<ColumnDef<ConceptRow>> = {
        id: col.id,
        header: () => columnLabel(col.id),
        enableHiding: col.id !== 'concept_id' && col.id !== 'concept_name',
      }

      switch (col.id) {
        case 'concept_id':
          return {
            ...base,
            accessorFn: (row) => row.concept_id,
            cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
            size: 80,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'concept_name':
          return {
            ...base,
            accessorFn: (row) => row.concept_name,
            cell: ({ row }) => row.original.concept_name,
            size: 250,
            minSize: 120,
          } as ColumnDef<ConceptRow>

        case 'concept_code':
          return {
            ...base,
            accessorFn: (row) => row.concept_code,
            cell: ({ row }) => <span className="font-mono">{String(row.original.concept_code ?? '')}</span>,
            size: 100,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'record_count':
          return {
            ...base,
            header: () => t('concepts.column_records'),
            cell: ({ row }) => {
              const counts = conceptCounts.get(row.original.concept_id)
              if (!counts) return <Skeleton className="ml-auto h-3.5 w-10" />
              return <span className="tabular-nums">{counts.records.toLocaleString()}</span>
            },
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'patient_count':
          return {
            ...base,
            header: () => t('concepts.column_patients'),
            cell: ({ row }) => {
              const counts = conceptCounts.get(row.original.concept_id)
              if (!counts) return <Skeleton className="ml-auto h-3.5 w-10" />
              return <span className="tabular-nums">{counts.patients.toLocaleString()}</span>
            },
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        default:
          // Extra columns, vocabulary_id, _dict_key
          return {
            ...base,
            accessorFn: (row) => row[col.id],
            cell: ({ row }) => String(row.original[col.id] ?? ''),
            size: 120,
            minSize: 60,
          } as ColumnDef<ConceptRow>
      }
    })
  }, [availableColumns, t, conceptCounts])

  const table = useReactTable({
    data: concepts,
    columns,
    state: {
      columnVisibility,
      columnOrder,
      columnSizing,
    },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: totalPages,
  })

  const headerIds = table.getHeaderGroups()[0]?.headers.map((h) => h.column.id) ?? []

  const handleDragOver = (event: DragOverEvent) => {
    const { over, active } = event
    if (over && over.id !== active.id) {
      setOverColumnId(String(over.id))
    } else {
      setOverColumnId(null)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setOverColumnId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    const currentOrder = columnOrder.length > 0
      ? columnOrder
      : table.getAllLeafColumns().map((c) => c.id)

    const oldIndex = currentOrder.indexOf(String(active.id))
    const newIndex = currentOrder.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return

    setColumnOrder(arrayMove(currentOrder, oldIndex, newIndex))
  }

  /** Render the inline filter for a column. */
  const renderColumnFilter = (columnId: string) => {
    // Text search inputs for core searchable columns
    if (columnId === 'concept_id') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] font-mono outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="ID..."
          value={filters._searchId ?? ''}
          onChange={(e) => onFilterChange('_searchId', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_name') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder={t('concepts.search_placeholder')}
          value={filters._searchText ?? ''}
          onChange={(e) => onFilterChange('_searchText', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_code') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] font-mono outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="Code..."
          value={filters._searchCode ?? ''}
          onChange={(e) => onFilterChange('_searchCode', e.target.value || null)}
        />
      )
    }

    // Dropdown filters for filterable columns
    const col = availableColumns.find((c) => c.id === columnId)
    if (col?.filterable && filterOptions[columnId]?.length) {
      return (
        <ColumnFilterSelect
          value={filters[columnId] as string | null}
          options={filterOptions[columnId]}
          placeholder={columnLabel(columnId)}
          onChange={(v) => onFilterChange(columnId, v)}
        />
      )
    }

    return null
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Column visibility toggle */}
      <div className="flex items-center justify-end border-b px-2 py-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
              <Settings2 size={12} />
              {t('concepts.column_visibility', 'Columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[180px]">
            <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table.getAllColumns()
              .filter((col) => col.getCanHide())
              .map((col) => (
                <DropdownMenuCheckboxItem
                  key={col.id}
                  checked={col.getIsVisible()}
                  onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {columnLabel(col.id)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setOverColumnId(null)}
        >
          <Table className="w-full" style={{ tableLayout: 'fixed' }}>
            <TableHeader>
              {/* Column titles */}
              <TableRow>
                <SortableContext items={headerIds} strategy={horizontalListSortingStrategy}>
                  {table.getHeaderGroups().map((headerGroup) =>
                    headerGroup.headers.map((header) => (
                      <SortableColumnHeader
                        key={header.id}
                        header={header}
                        sorting={sorting}
                        onSort={onSortingChange}
                        isDropTarget={overColumnId === header.column.id}
                      />
                    ))
                  )}
                </SortableContext>
              </TableRow>
              {/* Inline filters row */}
              <TableRow className="hover:bg-transparent">
                {table.getHeaderGroups().map((headerGroup) =>
                  headerGroup.headers.map((header) => (
                    <TableHead
                      key={`filter-${header.id}`}
                      className="px-1 py-1"
                      style={{ width: header.getSize() }}
                    >
                      {renderColumnFilter(header.column.id)}
                    </TableHead>
                  ))
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {table.getVisibleLeafColumns().map((col) => (
                      <TableCell key={col.id}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-sm text-muted-foreground">
                    {t('concepts.stats_no_records')}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.original.concept_id}
                    className="cursor-pointer"
                    data-state={selectedConceptId === row.original.concept_id ? 'selected' : undefined}
                    onClick={() => onSelect(row.original.concept_id)}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                      const raw = cell.getValue()
                      const title = raw != null ? String(raw) : undefined
                      return (
                        <TableCell
                          key={cell.id}
                          className="overflow-hidden truncate text-xs"
                          style={{ maxWidth: cell.column.getSize() }}
                          title={title}
                        >
                          {rendered}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </DndContext>
      </div>

      {/* Pagination bar */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {t('concepts.pagination_total', { count: totalCount })}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('concepts.pagination_per_page')}
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-7 w-[70px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="25">25</SelectItem>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {t('concepts.pagination_page', { page: page + 1, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
