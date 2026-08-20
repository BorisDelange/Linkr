import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type Header,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ColumnVisibilityMenu } from '@/components/ui/column-visibility-menu'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { TruncatedText } from '@/components/ui/truncated-text'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

export type RowKey = string | number

/**
 * File-explorer selection maths: plain click replaces, Ctrl/Cmd toggles one,
 * Shift extends from the anchor (and keeps the existing set when combined with
 * Ctrl/Cmd). `order` is the filtered, sorted key list — ranges must follow what
 * the user sees, not the underlying data order.
 */
export function nextSelection(
  current: Set<RowKey>,
  key: RowKey,
  order: RowKey[],
  mods: { toggle: boolean; range: boolean },
  anchor: RowKey | null,
): { selection: Set<RowKey>; anchor: RowKey | null } {
  if (mods.range && anchor != null) {
    const from = order.indexOf(anchor)
    const to = order.indexOf(key)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      const next = mods.toggle ? new Set(current) : new Set<RowKey>()
      for (const k of order.slice(lo, hi + 1)) next.add(k)
      return { selection: next, anchor }
    }
  }
  if (mods.toggle) {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return { selection: next, anchor: key }
  }
  return { selection: new Set([key]), anchor: key }
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
type Sorting = { columnId: string; desc: boolean } | null

/** Kind of inline column filter to render under a column header. */
export type ConceptColumnFilter = 'text' | 'number' | 'select' | 'none'

export interface ConceptColumn<T> {
  id: string
  header: string
  /**
   * Custom header rendering, for a column whose header is a control rather than
   * a label (a select-all checkbox). `header` stays the plain-text name used by
   * the visibility menu and the truncation tooltip.
   *
   * Such a column is not sortable unless `sortable: true` is passed explicitly:
   * clicking the control must not also reorder the table under the cursor.
   */
  headerCell?: () => ReactNode
  /** Value used for sorting, filtering and default cell rendering. */
  accessor: (row: T) => string | number | null | undefined
  /**
   * Text to SHOW when the accessor's own value is not what the reader wants —
   * a date sorts correctly as an ISO string but must be read in the app's
   * language. Applies to the cell, its tooltip and the filter, while sorting
   * stays on `accessor`. Unlike `cell`, it survives the `tooltip` renderer.
   */
  display?: (row: T) => string
  /** Optional custom cell renderer (defaults to a truncated text of the accessor value). */
  cell?: (row: T) => ReactNode
  filter?: ConceptColumnFilter
  /**
   * Custom filter control, for a predicate the built-in filters cannot express —
   * a column whose cell shows several values and whose filter matches a row when
   * ANY of them is picked. The caller owns both the control and the filtering
   * (pass rows already narrowed); this slot only places it under the header so it
   * lines up with the other filters instead of floating above the table.
   *
   * Takes precedence over `filter`.
   */
  filterCell?: () => ReactNode
  /**
   * Disable sorting on this column (e.g. an actions/links column). Default true,
   * except for a `headerCell` column, whose header is a control and not a label.
   */
  sortable?: boolean
  /** For a 'select' filter: map a raw option value to a display label (e.g. translate/capitalize). */
  selectOptionLabel?: (value: string) => string
  size?: number
  minSize?: number
  /**
   * Whether the user can drag this column's edge. Defaults to true, except for
   * a `headerCell` column: a fixed-width checkbox or actions column has nothing
   * to widen, and the grip sits on top of the control.
   */
  resizable?: boolean
  /** Hidden by default (still toggleable via the column menu). */
  hidden?: boolean
  /** Center the cell content (used for boolean/flag columns). */
  center?: boolean
  /**
   * Only needed alongside a custom `cell`: columns without one already show the
   * full value in a tooltip when truncated. Setting this replaces that renderer
   * with the raw accessor value, so use it when the renderer was merely styling
   * text (and pass a class string rather than `true` to keep that styling) —
   * never when it produces a badge, button or link.
   */
  tooltip?: boolean | string
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
   * Extra classes for one row, to mark a state the table cannot know about —
   * dimming rows that are already dealt with elsewhere. Applied on top of the
   * selection and hover styling, so it should carry state, not replace them.
   */
  rowClassName?: (row: T) => string | undefined
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
  /**
   * Let the user drag column headers into a different order. Off by default:
   * it adds a grip to every header, which is noise on a table of three columns.
   */
  reorderable?: boolean
  /**
   * File-explorer multi-selection: plain click replaces the selection,
   * Ctrl/Cmd toggles one row, Shift extends from the last plain click.
   * Pass both to enable it; `onRowClick` still fires for the row that was hit,
   * so a table can drive a detail panel and a selection at the same time.
   */
  selectedRowKeys?: Set<string | number>
  onSelectedRowKeysChange?: (keys: Set<string | number>) => void
  /**
   * The rows currently passing the filters, in sort order. Needed by callers
   * whose own toolbar acts on the visible set — a Copy button that reaches for
   * the raw `data` prop instead would silently act on rows the user filtered out.
   */
  onVisibleRowsChange?: (rows: T[]) => void
  /**
   * Remember sort, filters, column sizes, order and visibility under this key,
   * so a table that lives in a dialog comes back the way the user left it
   * instead of resetting every time it is reopened. Module-level and
   * deliberately not persisted: it should survive a remount, not a reload.
   */
  viewKey?: string
}

interface ViewState {
  sorting: Sorting
  filters: Record<string, string | string[] | undefined>
  columnSizing: Record<string, number>
  columnOrder: ColumnOrderState
  columnVisibility: VisibilityState
}

const viewCache = new Map<string, ViewState>()

/** Sets don't survive the cache, so filters are stored as arrays. */
export function toStoredFilters(f: Record<string, string | Set<string> | undefined>) {
  return Object.fromEntries(
    Object.entries(f).map(([k, v]) => [k, v instanceof Set ? [...v] : v]),
  )
}

export function fromStoredFilters(f: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? new Set(v) : v]),
  )
}

/** Header cell for a reorderable table: adds the drag grip and drop indicator. */
function SortableHead<T>({
  header,
  children,
  isDropTarget,
}: {
  header: Header<T, unknown>
  children: ReactNode
  isDropTarget: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: header.column.id })
  return (
    <TableHead
      ref={setNodeRef}
      className={cn('relative select-none overflow-hidden text-xs', isDropTarget && 'bg-primary/10')}
      style={{ width: header.getSize(), maxWidth: header.getSize(), opacity: isDragging ? 0.4 : 1 }}
    >
      {isDropTarget && <div className="absolute left-0 top-0 h-full w-0.5 bg-primary" />}
      <div className="flex items-center gap-1 overflow-hidden">
        <button
          type="button"
          className="shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={10} />
        </button>
        {children}
      </div>
    </TableHead>
  )
}

/**
 * Shared OMOP-style concept datatable: per-column sort, resize, reorder, inline
 * filters (text / number / multi-select), column-visibility menu and a results
 * count. Generalized from RelationsTable so concept lists read the same everywhere.
 */
export function ConceptDataTable<T>({ data, columns: cols, rowKey, emptyMessage, onRowClick, selectedRowKey, rowClassName, pageSize, initialSorting, reorderable, selectedRowKeys, onSelectedRowKeysChange, onVisibleRowsChange, viewKey }: ConceptDataTableProps<T>) {
  const { t } = useTranslation()
  /** Where a Shift-range starts: the last row clicked without Shift. */
  const selectionAnchor = useRef<string | number | null>(null)
  const restored = viewKey ? viewCache.get(viewKey) : undefined
  const [sorting, setSorting] = useState<Sorting>(restored?.sorting ?? initialSorting ?? null)
  const [filters, setFilters] = useState<Record<string, string | Set<string> | undefined>>(
    () => (restored ? fromStoredFilters(restored.filters) : {}),
  )
  const [page, setPage] = useState(0)
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>(restored?.columnSizing ?? {})
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(restored?.columnOrder ?? [])
  const [overColumnId, setOverColumnId] = useState<string | null>(null)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => restored?.columnVisibility
      ?? Object.fromEntries(cols.filter((c) => c.hidden).map((c) => [c.id, false])),
  )

  useEffect(() => {
    if (!viewKey) return
    viewCache.set(viewKey, {
      sorting,
      filters: toStoredFilters(filters),
      columnSizing,
      columnOrder,
      columnVisibility,
    })
  }, [viewKey, sorting, filters, columnSizing, columnOrder, columnVisibility])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
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
      const shownOf = (r: T) => (c.display ? c.display(r) : String(c.accessor(r) ?? ''))
      out[c.id] = [...new Set(data.map(shownOf).filter(Boolean))].sort()
    }
    return out
  }, [cols, data])

  const filtered = useMemo(() => {
    let rows = data
    for (const c of cols) {
      const f = filters[c.id]
      if (f == null) continue
      if (f instanceof Set) {
        if (f.size) rows = rows.filter((r) => f.has(c.display ? c.display(r) : String(c.accessor(r) ?? '')))
      } else if (f) {
        const q = f.toLowerCase()
        rows = rows.filter((r) =>
          (c.display ? c.display(r) : String(c.accessor(r) ?? '')).toLowerCase().includes(q),
        )
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
  // In an effect, not during render: callers store this in their own state.
  const notifyVisible = useRef(onVisibleRowsChange)
  notifyVisible.current = onVisibleRowsChange
  useEffect(() => { notifyVisible.current?.(filtered) }, [filtered])

  /**
   * Ranges run over the filtered, sorted rows rather than the raw data, so
   * Shift-click selects what the user actually sees between the two clicks.
   */
  const handleSelectClick = (row: T, e: React.MouseEvent) => {
    if (!selectedRowKeys || !onSelectedRowKeysChange) return
    const { selection, anchor } = nextSelection(
      selectedRowKeys,
      rowKey(row),
      filtered.map(rowKey),
      { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey },
      selectionAnchor.current,
    )
    selectionAnchor.current = anchor
    onSelectedRowKeysChange(selection)
  }

  const paged = useMemo(
    () => (pageSize ? filtered.slice(safePage * pageSize, (safePage + 1) * pageSize) : filtered),
    [filtered, pageSize, safePage],
  )

  const renderFilter = (columnId: string) => {
    const col = colById.get(columnId)
    if (!col) return null
    if (col.filterCell) return col.filterCell()
    if (!col.filter || col.filter === 'none') return null
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
        : <TruncatedText text={c.display ? c.display(row.original) : String(c.accessor(row.original) ?? '')} className="text-xs" />,
    size: c.size ?? 120,
    minSize: c.minSize ?? 50,
    enableResizing: c.resizable ?? c.headerCell === undefined,
  })), [cols])

  const table = useReactTable({
    data: paged,
    columns,
    state: { columnVisibility, columnSizing, columnOrder },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    manualSorting: true,
    manualFiltering: true,
  })

  const handleDragOver = (e: DragOverEvent) => {
    const { over, active } = e
    setOverColumnId(over && over.id !== active.id ? String(over.id) : null)
  }

  const handleDragEnd = (e: DragEndEvent) => {
    setOverColumnId(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const current = columnOrder.length ? columnOrder : table.getAllLeafColumns().map((c) => c.id)
    const from = current.indexOf(String(active.id))
    const to = current.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    setColumnOrder(arrayMove(current, from, to))
  }

  const headerIds = table.getVisibleLeafColumns().map((c) => c.id)

  const body = (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            <TableRow>
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((header) => {
                  const colId = header.column.id
                  const def = colById.get(colId)
                  const canSort = def?.sortable ?? !def?.headerCell
                  const label = (
                    <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TruncatedHeader>
                  )
                  const content = def?.headerCell ? (
                    <div className="flex w-full min-w-0 items-center overflow-hidden pr-2">{def.headerCell()}</div>
                  ) : canSort ? (
                    <button type="button" className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-2 hover:text-foreground" onClick={() => handleSort(colId)}>
                      {label}
                      {!sorting || sorting.columnId !== colId
                        ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                        : sorting.desc
                          ? <ArrowDown size={10} className="shrink-0 text-primary" />
                          : <ArrowUp size={10} className="shrink-0 text-primary" />}
                    </button>
                  ) : (
                    <div className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-2">{label}</div>
                  )
                  const resizeHandle = header.column.getCanResize() && (
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                      className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                    >
                      <div className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'}`} />
                    </div>
                  )
                  return reorderable ? (
                    <SortableHead key={header.id} header={header} isDropTarget={overColumnId === colId}>
                      {content}
                      {resizeHandle}
                    </SortableHead>
                  ) : (
                    <TableHead
                      key={header.id}
                      className="relative select-none overflow-hidden text-xs"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {content}
                      {resizeHandle}
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
                  onClick={onRowClick || selectedRowKeys ? (e) => {
                    handleSelectClick(row.original, e)
                    onRowClick?.(row.original)
                  } : undefined}
                  className={cn(
                    (onRowClick || selectedRowKeys) && 'cursor-pointer',
                    // Shift-click would otherwise paint a browser text selection
                    // across the range the user is trying to select.
                    selectedRowKeys && 'select-none',
                    (selectedRowKey != null && key === selectedRowKey) || selectedRowKeys?.has(key)
                      ? 'bg-accent'
                      : (onRowClick || selectedRowKeys) && 'hover:bg-accent/50',
                    rowClassName?.(row.original),
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const col = colById.get(cell.column.id)
                    const raw = cell.getValue()
                    const useTooltip = col?.tooltip && raw != null && String(raw) !== ''
                    // `display` wins over the raw value everywhere it is shown.
                    const shown = col?.display ? col.display(row.original) : String(raw)
                    return (
                      <TableCell
                        key={cell.id}
                        className={`overflow-hidden truncate px-2 py-1 text-xs${col?.center ? ' text-center' : ''}`}
                        style={{ maxWidth: cell.column.getSize() }}
                      >
                        {useTooltip
                          ? <TruncatedText text={shown} className={typeof col?.tooltip === 'string' ? col.tooltip : undefined} />
                          : flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
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
          <ColumnVisibilityMenu
            items={table.getAllColumns().map((col) => ({
              id: col.id,
              label: colById.get(col.id)?.header ?? col.id,
              visible: col.getIsVisible(),
            }))}
            onToggle={(id, visible) => table.getColumn(id)?.toggleVisibility(visible)}
            onSetMany={(ids, visible) =>
              setColumnVisibility((v) => ({
                ...v,
                ...Object.fromEntries(ids.map((id) => [id, visible])),
              }))
            }
          />
        </div>
      </div>
    </div>
  )

  if (!reorderable) return body

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={headerIds} strategy={horizontalListSortingStrategy}>
        {body}
      </SortableContext>
    </DndContext>
  )
}
