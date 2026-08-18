import { useState, useMemo, useRef, type ReactNode } from 'react'
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
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
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
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import {
  ConceptSetCell,
  CountCell,
  conceptCellContent,
} from './concept-cells'
import { columnLabel } from '@/lib/format-helpers'
import type { ConceptRow } from './use-concepts'
import type {
  ConceptFilters,
  ConceptFilterValue,
  ConceptSorting,
  ColumnDescriptor,
} from './concept-queries'

/** Dashed inline-filter look shared with the concept-mapping tables. */
const FILTER_INPUT_CLASS =
  'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

/** Picker affordances, not data: no sort, no filter, no drag, no hiding. */
const AFFORDANCE_COLUMNS = new Set(['_select', '_action'])

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConceptTableProps {
  concepts: ConceptRow[]
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
  columnVisibility: VisibilityState
  onColumnVisibilityChange: (v: VisibilityState) => void
  onFilterChange: (key: string, value: ConceptFilterValue) => void
  onSortingChange: (columnId: string) => void
  onSelect: (conceptId: number) => void
  /** Multi-selection (Shift / Cmd-Ctrl). Empty = the single `selectedConceptId`
   *  drives the detail panel. */
  selectedConceptIds: Set<number>
  onSelectedConceptIdsChange: (next: Set<number>) => void
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  /** Open a concept set's detail panel by name (data-dictionary column). */
  onOpenConceptSet?: (setName: string) => void
  /**
   * Picker mode: a leading checkbox column, and a plain click toggles a row's
   * membership instead of driving a detail panel. `selectedConceptIds` then
   * carries the picked set rather than a transient multi-selection.
   */
  pickMode?: boolean
  /** Picker mode: called for every toggle, so the caller can cache the name. */
  onToggleConcept?: (row: ConceptRow) => void
  /** Extra trailing column pinned after the data columns (e.g. a stats popover). */
  rowAction?: { render: (row: ConceptRow) => ReactNode; size?: number }
  /** Empty-state message. Defaults to the Concepts page's own wording. */
  emptyMessage?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Human label for a standard_concept option: OMOP stores S / C / NULL, which the
 *  table renders as the S / C / NS badges. */
function standardConceptLabel(value: string, t: (key: string) => string): string {
  if (value === 'S') return t('concepts.standard_s')
  if (value === 'C') return t('concepts.standard_c')
  return t('concepts.standard_non')
}

/** Multi-select column filter — same control and sizing as the mapping editor's
 *  source-concepts table, so both tables read identically. */
function ColumnFilterMulti({
  values,
  options,
  placeholder,
  onChange,
  optionLabel,
}: {
  values: string[]
  options: string[]
  placeholder: string
  onChange: (next: string[]) => void
  optionLabel?: (value: string) => string
}) {
  const opts = optionLabel
    ? options.map((v) => ({ value: v, label: optionLabel(v) }))
    : options
  return (
    <MultiSelectFilter
      value={values}
      options={opts}
      placeholder={placeholder}
      onChange={onChange}
      triggerClass={FILTER_INPUT_CLASS}
      popoverWidthClass="w-[300px]"
    />
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
      className={`relative select-none overflow-hidden text-xs ${isDropTarget ? 'bg-primary/10' : ''}`}
      style={{ width: header.getSize(), maxWidth: header.getSize(), opacity: isDragging ? 0.4 : 1 }}
    >
      {isDropTarget && (
        <div className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
      )}
      <div className="flex items-center gap-1 overflow-hidden">
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
          className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground"
          onClick={() => onSort(columnId)}
        >
          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
            {flexRender(header.column.columnDef.header, header.getContext())}
          </TruncatedHeader>
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
  columnVisibility,
  onColumnVisibilityChange,
  onFilterChange,
  onSortingChange,
  onSelect,
  selectedConceptIds,
  onSelectedConceptIdsChange,
  onPageChange,
  onPageSizeChange,
  onOpenConceptSet,
  pickMode = false,
  onToggleConcept,
  rowAction,
  emptyMessage,
}: ConceptTableProps) {
  const { t } = useTranslation()
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([])

  // Sorting is done by SQL, so the data-dictionary columns (joined in the
  // browser) cannot be ordered on — the ORDER BY would name a column the query
  // has never heard of.
  const sortableIds = useMemo(
    () => new Set(availableColumns.filter((c) => c.source !== 'conceptSet').map((c) => c.id)),
    [availableColumns],
  )
  const handleSort = (columnId: string) => {
    if (!sortableIds.has(columnId)) return
    onSortingChange(columnId)
  }

  // Anchor for shift-range selection — the last row clicked without Shift.
  const selectionAnchorRef = useRef<number | null>(null)

  /** File-explorer-style selection: plain / Ctrl-Cmd (toggle) / Shift (range).
   *  In pick mode a plain click toggles too, since the set IS the result. */
  const handleRowClick = (row: ConceptRow, e: React.MouseEvent) => {
    const conceptId = row.concept_id
    const isToggle = e.metaKey || e.ctrlKey || pickMode
    const isRange = e.shiftKey

    if (isRange && selectionAnchorRef.current != null) {
      const order = concepts.map((r) => r.concept_id)
      const from = order.indexOf(selectionAnchorRef.current)
      const to = order.indexOf(conceptId)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const next = isToggle ? new Set(selectedConceptIds) : new Set<number>()
        for (const r of concepts.slice(lo, hi + 1)) {
          next.add(r.concept_id)
          onToggleConcept?.(r)
        }
        onSelectedConceptIdsChange(next)
        return
      }
    }

    if (isToggle) {
      const next = new Set(selectedConceptIds)
      if (next.has(conceptId)) next.delete(conceptId)
      else next.add(conceptId)
      selectionAnchorRef.current = conceptId
      onToggleConcept?.(row)
      onSelectedConceptIdsChange(next)
      return
    }

    // Plain click → single selection, which drives the detail panel. Only mint a
    // new Set when there is something to clear: an empty one still counts as a
    // new identity, and would re-render every row on each click.
    selectionAnchorRef.current = conceptId
    if (selectedConceptIds.size > 0) onSelectedConceptIdsChange(new Set())
    onSelect(conceptId)
  }
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  const [overColumnId, setOverColumnId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const allVisibleSelected =
    concepts.length > 0 && concepts.every((c) => selectedConceptIds.has(c.concept_id))

  /** Header checkbox: add every row on this page, or drop them all. */
  const toggleSelectAllVisible = () => {
    const next = new Set(selectedConceptIds)
    if (allVisibleSelected) {
      for (const c of concepts) next.delete(c.concept_id)
    } else {
      for (const c of concepts) {
        next.add(c.concept_id)
        onToggleConcept?.(c)
      }
    }
    onSelectedConceptIdsChange(next)
  }

  // Build TanStack columns dynamically from availableColumns
  const columns = useMemo<ColumnDef<ConceptRow>[]>(() => {
    const dataColumns = availableColumns.map((col) => {
      const base: Partial<ColumnDef<ConceptRow>> = {
        id: col.id,
        header: () => columnLabel(col.id),
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
            accessorFn: (row) => row.record_count,
            cell: ({ row }) => (
              <CountCell value={row.original.record_count as number | undefined} />
            ),
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'patient_count':
          return {
            ...base,
            header: () => t('concepts.column_patients'),
            accessorFn: (row) => row.patient_count,
            cell: ({ row }) => (
              <CountCell value={row.original.patient_count as number | undefined} />
            ),
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'concept_set_name':
          // Joined from the imported dictionary; a concept can be in several
          // sets, so each name is its own button — clicking one opens that set
          // rather than whichever happened to be listed first.
          return {
            ...base,
            header: () => t('concepts.column_concept_set'),
            accessorFn: (row) => row.concept_set_name,
            cell: ({ row }) => (
              <ConceptSetCell
                value={String(row.original.concept_set_name ?? '')}
                onOpen={onOpenConceptSet}
                openLabel={t('concept_mapping.cs_open_detail')}
              />
            ),
            size: 180,
            minSize: 80,
          } as ColumnDef<ConceptRow>

        case 'standard_concept':
          // S / C / NS badge, same as the concept-mapping tables.
          return {
            ...base,
            header: () => t('concepts.column_standard'),
            accessorFn: (row) => row.standard_concept,
            cell: ({ row }) => (
              <StandardConceptBadge value={row.original.standard_concept as string | null} />
            ),
            size: 70,
            minSize: 50,
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

    // Picker affordances sit outside the data columns: neither is reorderable or
    // hideable, so they are appended after the dnd-sortable set rather than in it.
    const leading: ColumnDef<ConceptRow>[] = pickMode
      ? [{
          id: '_select',
          header: () => null,
          enableHiding: false,
          enableResizing: false,
          cell: ({ row }) => (
            <div
              className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                selectedConceptIds.has(row.original.concept_id)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-foreground/30'
              }`}
            >
              {selectedConceptIds.has(row.original.concept_id) && <Check size={10} />}
            </div>
          ),
          size: 36,
          minSize: 36,
        }]
      : []

    const trailing: ColumnDef<ConceptRow>[] = rowAction
      ? [{
          id: '_action',
          header: () => null,
          enableHiding: false,
          enableResizing: false,
          cell: ({ row }) => (
            <div className="flex justify-center">{rowAction.render(row.original)}</div>
          ),
          size: rowAction.size ?? 36,
          minSize: rowAction.size ?? 36,
        }]
      : []

    return [...leading, ...dataColumns, ...trailing]
  }, [availableColumns, t, onOpenConceptSet, pickMode, selectedConceptIds, rowAction])

  const table = useReactTable({
    data: concepts,
    columns,
    state: {
      columnVisibility,
      columnOrder,
      columnSizing,
    },
    onColumnVisibilityChange: (updater) =>
      onColumnVisibilityChange(
        typeof updater === 'function' ? updater(columnVisibility) : updater,
      ),
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: totalPages,
  })

  const headerIds =
    table.getHeaderGroups()[0]?.headers
      .map((h) => h.column.id)
      .filter((id) => !AFFORDANCE_COLUMNS.has(id)) ?? []

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
    if (AFFORDANCE_COLUMNS.has(columnId)) return null
    // Text search inputs for core searchable columns
    if (columnId === 'concept_id') {
      return (
        <input
          className={`${FILTER_INPUT_CLASS} font-mono`}
          placeholder={t('concepts.search_id_placeholder')}
          value={typeof filters._searchId === 'string' ? filters._searchId : ''}
          onChange={(e) => onFilterChange('_searchId', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_name') {
      return (
        <input
          className={FILTER_INPUT_CLASS}
          placeholder={t('concepts.search_placeholder')}
          value={typeof filters._searchText === 'string' ? filters._searchText : ''}
          onChange={(e) => onFilterChange('_searchText', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_code') {
      return (
        <input
          className={`${FILTER_INPUT_CLASS} font-mono`}
          placeholder={t('concepts.search_code_placeholder')}
          value={typeof filters._searchCode === 'string' ? filters._searchCode : ''}
          onChange={(e) => onFilterChange('_searchCode', e.target.value || null)}
        />
      )
    }

    // Dropdown filters for filterable columns
    const col = availableColumns.find((c) => c.id === columnId)
    if (col?.filterable && filterOptions[columnId]?.length) {
      const raw = filters[columnId]
      const values = Array.isArray(raw) ? raw : raw ? [raw] : []
      return (
        <ColumnFilterMulti
          values={values}
          options={filterOptions[columnId]}
          placeholder={columnLabel(columnId)}
          onChange={(next) => onFilterChange(columnId, next.length ? next : null)}
          optionLabel={
            columnId === 'standard_concept'
              ? (v) => standardConceptLabel(v, t)
              : undefined
          }
        />
      )
    }

    return null
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
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
                    headerGroup.headers.map((header) =>
                      AFFORDANCE_COLUMNS.has(header.column.id) ? (
                        <TableHead
                          key={header.id}
                          className="select-none overflow-hidden text-xs"
                          style={{ width: header.getSize(), maxWidth: header.getSize() }}
                        >
                          {header.column.id === '_select' && (
                            <button
                              type="button"
                              className="flex size-4 items-center justify-center rounded border border-muted-foreground/30 hover:border-primary"
                              onClick={toggleSelectAllVisible}
                              title={t('common.select_all')}
                            >
                              {allVisibleSelected && <Check size={10} className="text-primary" />}
                            </button>
                          )}
                        </TableHead>
                      ) : (
                        <SortableColumnHeader
                          key={header.id}
                          header={header}
                          sorting={sorting}
                          onSort={handleSort}
                          isDropTarget={overColumnId === header.column.id}
                        />
                      )
                    )
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
                    {emptyMessage ?? t('concepts.no_concepts')}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={`${row.original._dict_key ?? ''}:${row.original.concept_id}`}
                    className="cursor-pointer select-none"
                    data-state={
                      (pickMode || selectedConceptIds.size > 0
                        ? selectedConceptIds.has(row.original.concept_id)
                        : selectedConceptId === row.original.concept_id)
                        ? 'selected'
                        : undefined
                    }
                    onClick={(e) => handleRowClick(row.original, e)}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const raw = cell.getValue()
                      const rendered = conceptCellContent(
                        cell.column.id,
                        raw,
                        flexRender(cell.column.columnDef.cell, cell.getContext()),
                      )
                      return (
                        <TableCell
                          key={cell.id}
                          className="overflow-hidden truncate px-2 py-1 text-xs"
                          style={{ maxWidth: cell.column.getSize() }}
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

      {/* Pagination bar + column visibility */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('concepts.pagination_total', { count: totalCount })}
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <Settings2 size={12} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-[180px]">
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
