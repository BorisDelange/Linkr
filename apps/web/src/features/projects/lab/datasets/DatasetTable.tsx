import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  ChevronRight,
  Settings2,
  MoreVertical,
  ArrowUp,
  ArrowDown,
  Filter,
  EyeOff,
  Columns2,
  Pin,
  PinOff,
  Tag,
  Trash2,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDatasetStore, emptyTableView, type DatasetTableView } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { useServerDatasetRows } from './use-server-dataset-rows'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ColumnVisibilityMenu } from '@/components/ui/column-visibility-menu'
import { Separator } from '@/components/ui/separator'
import { ResizeGrip } from '@/components/ui/table-primitives'
import { TypeBadge, renderTypeMenuItems } from './TypeBadge'
import { ColumnFilterInput, applyColumnFilter, type ColumnFilterValue } from './ColumnFilterInput'
import { useColumnDistinct } from './use-column-distinct'
import { ROW_ORD } from '@linkr/format'
import { useCellEditing } from './use-cell-editing'
import { useFlashTarget } from './use-flash-target'
import { EditColumnMetaDialog } from './EditColumnMetaDialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { hasTimeComponent, columnTint, displayColumnName, displayCellValue } from '@/lib/dataset-utils'
import { useBooleanLabels } from '@/hooks/use-boolean-labels'
import type { DatasetColumn, DatasetParseOptions } from '@/types'


interface DatasetTableProps {
  fileId: string
  selectedColumnId: string | null
  onSelectColumn: (columnId: string | null) => void
  hiddenColumns: Set<string>
  onHiddenColumnsChange?: (updater: (prev: Set<string>) => Set<string>) => void
  /** Allow in-place cell editing. Every commit records an op; the raw file is
   *  never touched. Off by default so a viewer's table behaves exactly as before. */
  editable?: boolean
  /** Edit controls, rendered in the footer bar. Called with the current selection
   *  so the toolbar's row actions can address it without duplicating table state. */
  editToolbar?: (ctx: EditToolbarContext) => React.ReactNode
}

export interface EditToolbarContext {
  /** Row ordinal of the selected cell, when one is selected. */
  selectedRow?: number
  /** The ordinal displayed just before the given one, for "insert above". */
  rowBefore: (ordinal: number) => number | null
}

const PAGE_SIZES = [25, 50, 100, 250, 500]

/** Shared default so a file with no stored view doesn't get a new object each render. */
const EMPTY_VIEW = emptyTableView()

/**
 * A `useState`-shaped setter over one field of the store-held table view, so the
 * table's existing handlers (including functional updates) work unchanged.
 */
function useViewSetter<K extends keyof DatasetTableView>(
  fileId: string,
  key: K,
  patchView: (fileId: string, changes: Partial<DatasetTableView>) => void,
) {
  return useCallback(
    (value: DatasetTableView[K] | ((prev: DatasetTableView[K]) => DatasetTableView[K])) => {
      const prev = useDatasetStore.getState().getTableView(fileId)[key]
      const next =
        typeof value === 'function'
          ? (value as (p: DatasetTableView[K]) => DatasetTableView[K])(prev)
          : value
      patchView(fileId, { [key]: next } as Partial<DatasetTableView>)
    },
    [fileId, key, patchView],
  )
}

export function DatasetTable({ fileId, selectedColumnId, onSelectColumn, hiddenColumns, onHiddenColumnsChange, editable = false, editToolbar }: DatasetTableProps) {
  const { t } = useTranslation()
  const booleanLabels = useBooleanLabels()
  const { files, getFileRows, setColumnType, setColumnFilterMode, _dirtyVersion } = useDatasetStore()

  const metaLoading = useDatasetStore((s) => s.metaLoadingIds.includes(fileId))

  const file = files.find((f) => f.id === fileId)
  const columns = file?.columns ?? []
  const parseOptions: DatasetParseOptions | undefined = file?.parseOptions
  const server = isServerMode()
  // Front-only mode holds all rows in memory (subscribe to _dirtyVersion to
  // re-render on change). Server mode fetches one page at a time (see below).
  const rows = !server && _dirtyVersion >= 0 ? getFileRows(fileId) : []

  // Filters/sort/paging live in the store, keyed by file id, so they survive
  // navigating away from the Datasets page and back. Keyed state also makes the
  // old "reset on file switch" effect unnecessary: each file has its own entry.
  const view = useDatasetStore((s) => s.tableViews[fileId]) ?? EMPTY_VIEW
  const patchView = useDatasetStore((s) => s.patchTableView)
  const { page, pageSize, columnFilters, naFilters, sort, columnWidths, pinnedColumns } = view

  const setPage = useViewSetter(fileId, 'page', patchView)
  const setPageSize = useViewSetter(fileId, 'pageSize', patchView)
  const setColumnFilters = useViewSetter(fileId, 'columnFilters', patchView)
  const setNaFilters = useViewSetter(fileId, 'naFilters', patchView)
  const setSort = useViewSetter(fileId, 'sort', patchView)
  const setColumnWidths = useViewSetter(fileId, 'columnWidths', patchView)
  const setPinnedColumns = useViewSetter(fileId, 'pinnedColumns', patchView)

  const [resizing, setResizing] = useState<{ colId: string; startX: number; startW: number } | null>(null)
  const [metaColumn, setMetaColumn] = useState<DatasetColumn | null>(null)

  // Visible columns — pinned ones first (in pin order), then the rest in natural order
  const visibleColumns = useMemo(() => {
    const visible = columns.filter((col) => !hiddenColumns.has(col.id))
    const pinned = pinnedColumns
      .map((id) => visible.find((c) => c.id === id))
      .filter((c): c is DatasetColumn => c != null)
    const rest = visible.filter((col) => !pinnedColumns.includes(col.id))
    return [...pinned, ...rest]
  }, [columns, hiddenColumns, pinnedColumns])

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

  // A column filters as a checkbox list when it's a string column not explicitly
  // set to 'text' (explicit 'list' or auto). Its distinct values are then fetched
  // (server) / scanned (local); columns above the cap fall back to text search.
  const listColumnIds = useMemo(
    () => columns
      .filter((c) => c.type === 'string' && parseOptions?.columnFilterMode?.[c.id] !== 'text')
      .map((c) => c.id),
    [columns, parseOptions],
  )
  const distinctByCol = useColumnDistinct({ fileId, columns, listColumnIds, rows, dataVersion: _dirtyVersion })
  const isListMode = useCallback(
    (col: DatasetColumn) => {
      if (col.type !== 'string') return false
      const explicit = parseOptions?.columnFilterMode?.[col.id]
      if (explicit === 'text') return false
      const opts = distinctByCol[col.id]
      // Auto mode: only when the (capped) distinct set actually fits a dropdown.
      if (explicit === 'list') return opts != null
      return opts != null && opts.length > 0 && opts.length < 100
    },
    [distinctByCol, parseOptions],
  )

  // --- Server mode: one page fetched on demand (never the whole dataset) ---
  const serverState = useServerDatasetRows({
    fileId,
    page,
    pageSize,
    sort,
    columnFilters,
    naFilters,
    columns,
  })

  // Filter rows client-side (value filters + NA filters) — front-only mode only
  const filteredRows = useMemo(() => {
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v != null)
    const activeNa = Object.entries(naFilters)
    if (activeFilters.length === 0 && activeNa.length === 0) return rows

    // Build a colType lookup
    const colTypeMap: Record<string, DatasetColumn['type']> = {}
    for (const col of columns) colTypeMap[col.id] = col.type

    const isNa = (v: unknown) => v == null || v === ''

    return rows.filter((row) => {
      for (const [colId, mode] of activeNa) {
        const na = isNa(row[colId])
        if (mode === 'exclude' && na) return false
        if (mode === 'only' && !na) return false
      }
      return activeFilters.every(([colId, filterValue]) =>
        applyColumnFilter(row[colId], colTypeMap[colId] ?? 'string', filterValue),
      )
    })
  }, [rows, columnFilters, naFilters, columns])

  // Sort rows (NA values always sink to the bottom)
  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows
    const col = columns.find((c) => c.id === sort.colId)
    if (!col) return filteredRows
    const dir = sort.dir === 'asc' ? 1 : -1
    const numeric = col.type === 'number'
    const copy = [...filteredRows]
    copy.sort((a, b) => {
      const va = a[sort.colId]
      const vb = b[sort.colId]
      const aNa = va == null || va === ''
      const bNa = vb == null || vb === ''
      if (aNa && bNa) return 0
      if (aNa) return 1
      if (bNa) return -1
      if (numeric) return (Number(va) - Number(vb)) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
    return copy
  }, [filteredRows, sort, columns])

  // Pagination — server mode uses the fetched page + server total; front-only
  // slices the in-memory filtered/sorted rows.
  const totalCount = server ? serverState.total : sortedRows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const clampedPage = Math.min(page, totalPages - 1)

  const localPageRows = useMemo(
    () => sortedRows.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize),
    [sortedRows, clampedPage, pageSize],
  )
  const pageRows = server ? serverState.rows : localPageRows

  // Row number offset for the current page
  const rowOffset = clampedPage * pageSize

  // In-place editing. Cells are addressed by row ordinal (carried in the rows
  // themselves), never by screen position — the table shows a sorted, filtered,
  // paginated slice and server mode holds only one page.
  const edit = useCellEditing({ fileId, rows: pageRows, columns: visibleColumns, enabled: editable })
  const applyOps = useDatasetStore((s) => s.applyOps)
  const flash = useFlashTarget(fileId)
  /** The ordinal shown just above `ordinal`, or null at the top of the page. */
  const rowBefore = useCallback((ordinal: number): number | null => {
    const at = pageRows.findIndex((r) => (r[ROW_ORD] as number) === ordinal)
    if (at <= 0) return null
    return (pageRows[at - 1][ROW_ORD] as number) ?? null
  }, [pageRows])

  const flashRowRef = useCallback((node: HTMLTableRowElement | null) => {
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  // A row appended to a long dataset lands on the LAST page, so highlighting it
  // without going there would flash a row the user cannot see.
  useEffect(() => {
    if (flash?.row === undefined || server) return
    const at = sortedRows.findIndex((r) => (r[ROW_ORD] as number) === flash.row)
    if (at >= 0) {
      const targetPage = Math.floor(at / pageSize)
      if (targetPage !== clampedPage) setPage(targetPage)
    }
  }, [flash?.row, server, sortedRows, pageSize, clampedPage, setPage])

  const hasActiveFilters =
    Object.values(columnFilters).some((v) => v != null) || Object.keys(naFilters).length > 0

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

  // Toggle sort: asc → desc → none
  const handleSort = useCallback((colId: string, dir: 'asc' | 'desc') => {
    setSort((prev) => (prev?.colId === colId && prev.dir === dir ? null : { colId, dir }))
  }, [])

  // Toggle NA filter: same mode again clears it
  const handleNaFilter = useCallback((colId: string, mode: 'exclude' | 'only') => {
    setNaFilters((prev) => {
      const next = { ...prev }
      if (next[colId] === mode) delete next[colId]
      else next[colId] = mode
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

  const togglePin = useCallback((colId: string) => {
    setPinnedColumns((prev) =>
      prev.includes(colId) ? prev.filter((id) => id !== colId) : [...prev, colId],
    )
  }, [])

  // Total table width
  const ROW_NUM_WIDTH = 50
  const DEFAULT_COL_WIDTH = 150
  const totalWidth =
    ROW_NUM_WIDTH +
    visibleColumns.reduce((sum, col) => sum + getColWidth(col.id, DEFAULT_COL_WIDTH), 0)

  // Cumulative left offset for each pinned column (after the row-number column)
  const pinnedLeft = useMemo(() => {
    const map: Record<string, number> = {}
    let acc = ROW_NUM_WIDTH
    for (const col of visibleColumns) {
      if (!pinnedColumns.includes(col.id)) continue
      map[col.id] = acc
      acc += getColWidth(col.id, DEFAULT_COL_WIDTH)
    }
    return map
  }, [visibleColumns, pinnedColumns, getColWidth])

  // Shared column-action items, rendered both in the "..." dropdown and the right-click context menu.
  /** Move a row one slot up or down, within the rows currently displayed. */
  const moveRow = useCallback((ordinal: number, delta: number) => {
    const order = pageRows.map((r) => edit.ordinalOf(r)).filter((o): o is number => o !== undefined)
    const at = order.indexOf(ordinal)
    const to = at + delta
    if (at < 0 || to < 0 || to >= order.length) return
    ;[order[at], order[to]] = [order[to], order[at]]
    void applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'reorderRows', order,
    }])
  }, [applyOps, edit, fileId, pageRows])

  const removeRow = useCallback((ordinal: number) => {
    void applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'removeRow', row: ordinal,
    }])
  }, [applyOps, fileId])

  /** Move a column one slot left or right. Reorder is an `order` change, never a
   *  rekey, so nothing downstream needs repairing. */
  const moveColumn = useCallback((colId: string, delta: number) => {
    const order = columns.map((c) => c.id)
    const at = order.indexOf(colId)
    const to = at + delta
    if (at < 0 || to < 0 || to >= order.length) return
    ;[order[at], order[to]] = [order[to], order[at]]
    void applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'reorderColumns', order,
    }])
  }, [applyOps, columns, fileId])

  const removeColumn = useCallback((colId: string) => {
    void applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'removeColumn', column: colId,
    }])
  }, [applyOps, fileId])

  const renderColumnMenuItems = (
    col: DatasetColumn,
    Item: typeof DropdownMenuItem | typeof ContextMenuItem,
    Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator,
  ) => {
    const isSorted = sort?.colId === col.id
    const isPinned = pinnedColumns.includes(col.id)
    return (
      <>
        {editable && (
          <>
            <Item onClick={() => moveColumn(col.id, -1)} className="text-xs">
              <ChevronLeft size={13} />
              {t('datasets.col_move_left')}
            </Item>
            <Item onClick={() => moveColumn(col.id, 1)} className="text-xs">
              <ChevronRight size={13} />
              {t('datasets.col_move_right')}
            </Item>
            <Item onClick={() => removeColumn(col.id)} className="text-xs" variant="destructive">
              <Trash2 size={13} />
              {t('datasets.col_delete')}
            </Item>
            <Separator />
          </>
        )}
        <Item onClick={() => handleSort(col.id, 'asc')} className="text-xs">
          <ArrowUp size={13} />
          {t('datasets.col_sort_asc')}
          {isSorted && sort!.dir === 'asc' && <span className="ml-auto text-primary">✓</span>}
        </Item>
        <Item onClick={() => handleSort(col.id, 'desc')} className="text-xs">
          <ArrowDown size={13} />
          {t('datasets.col_sort_desc')}
          {isSorted && sort!.dir === 'desc' && <span className="ml-auto text-primary">✓</span>}
        </Item>
        <Separator />
        <Item onClick={() => handleNaFilter(col.id, 'exclude')} className="text-xs">
          <Filter size={13} />
          {t('datasets.col_hide_na')}
          {naFilters[col.id] === 'exclude' && <span className="ml-auto text-primary">✓</span>}
        </Item>
        <Item onClick={() => handleNaFilter(col.id, 'only')} className="text-xs">
          <Filter size={13} />
          {t('datasets.col_only_na')}
          {naFilters[col.id] === 'only' && <span className="ml-auto text-primary">✓</span>}
        </Item>
        <Separator />
        <Item onClick={() => togglePin(col.id)} className="text-xs">
          {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
          {isPinned ? t('datasets.col_unpin') : t('datasets.col_pin')}
        </Item>
        <Item onClick={() => onSelectColumn(col.id)} className="text-xs">
          <Settings2 size={13} />
          {t('datasets.col_view_stats')}
        </Item>
        <Item onClick={() => setMetaColumn(col)} className="text-xs">
          <Tag size={13} />
          {t('datasets.col_edit_meta')}
        </Item>
        <Separator />
        {/* Force the column type (overrides inference; persisted in parseOptions). */}
        {renderTypeMenuItems({
          current: col.type,
          onSelect: (ty) => { void setColumnType(fileId, col.id, ty) },
          Item,
        })}
        {col.type === 'string' && (
          <>
            <Separator />
            <Item
              onClick={() => { void setColumnFilterMode(fileId, col.id, isListMode(col) ? 'text' : 'list') }}
              className="text-xs"
            >
              <Filter size={13} />
              {isListMode(col) ? t('datasets.col_filter_as_text') : t('datasets.col_filter_as_list')}
            </Item>
          </>
        )}
        <Separator />
        <Item onClick={() => resetColWidth(col.id)} className="text-xs">
          <Columns2 size={13} />
          {t('datasets.col_reset_width')}
        </Item>
        {onHiddenColumnsChange && (
          <Item
            onClick={() => onHiddenColumnsChange((prev) => new Set(prev).add(col.id))}
            className="text-xs"
          >
            <EyeOff size={13} />
            {t('datasets.col_hide')}
          </Item>
        )}
      </>
    )
  }

  if (columns.length === 0) {
    // Server mode fetches the columns lazily on open: an empty dataset and one
    // still loading look alike, so only call it empty once the fetch is done.
    if (metaLoading) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <Loader2 size={20} className="animate-spin text-primary" />
          <p className="text-xs text-muted-foreground">{t('datasets.loading_dataset')}</p>
        </div>
      )
    }
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
          style={{ minWidth: totalWidth, width: '100%', tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0 }}
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
              {visibleColumns.map((col, colIdx) => {
                const w = getColWidth(col.id, DEFAULT_COL_WIDTH)
                const isSorted = sort?.colId === col.id
                const hasNa = naFilters[col.id] != null
                const hasValueFilter = columnFilters[col.id] != null
                const isActive = isSorted || hasNa || hasValueFilter
                const isSelected = selectedColumnId === col.id
                const isPinned = pinnedColumns.includes(col.id)
                return (
                  <ContextMenu key={col.id}>
                  <ContextMenuTrigger asChild>
                  <th
                    style={{ width: w, ...(isPinned ? { left: pinnedLeft[col.id] } : {}) }}
                    className={cn(
                      'group/col border-b border-r px-3 py-1.5 text-left font-medium whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer',
                      isPinned ? 'sticky z-40 border-r-primary/40 hover:bg-accent' : 'relative hover:bg-accent/50',
                      !isSelected && !isPinned && columnTint(colIdx),
                      !isSelected && isPinned && 'bg-muted',
                      isSelected && 'bg-accent text-accent-foreground',
                    )}
                    onClick={() =>
                      onSelectColumn(col.id === selectedColumnId ? null : col.id)
                    }
                  >
                    <div className="flex items-center gap-1.5">
                      <TypeBadge type={col.type} size="sm" />
                      <TooltipProvider delayDuration={400}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="truncate">{displayColumnName(col)}</span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-80">
                            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                              <span className="text-muted-foreground">{t('datasets.col_meta_col_id')}</span>
                              <span className="font-mono break-all">{col.name}</span>
                              <span className="text-muted-foreground">{t('datasets.col_meta_label')}</span>
                              <span className="break-words">{col.label || '—'}</span>
                              <span className="text-muted-foreground">{t('datasets.col_meta_description')}</span>
                              <span className="break-words">{col.description || '—'}</span>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      {isSorted && (
                        sort!.dir === 'asc'
                          ? <ArrowUp size={11} className="shrink-0 text-primary" />
                          : <ArrowDown size={11} className="shrink-0 text-primary" />
                      )}
                      {(hasNa || hasValueFilter) && (
                        <Filter size={11} className="shrink-0 text-primary" />
                      )}
                      {isPinned && <Pin size={11} className="shrink-0 text-primary" />}
                      {/* Column actions menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              'ml-auto shrink-0 rounded p-0.5 hover:bg-accent-foreground/10',
                              isActive ? 'opacity-100' : 'opacity-0 group-hover/col:opacity-100',
                            )}
                          >
                            <MoreVertical size={12} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[200px]" onClick={(e) => e.stopPropagation()}>
                          {renderColumnMenuItems(col, DropdownMenuItem, DropdownMenuSeparator)}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <ResizeGrip
                      onStart={(e) => handleResizeStart(col.id, e)}
                      onReset={() => resetColWidth(col.id)}
                      active={resizing?.colId === col.id}
                    />
                  </th>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-[200px]">
                    {renderColumnMenuItems(col, ContextMenuItem, ContextMenuSeparator)}
                  </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </tr>
            {/* Column filter row */}
            <tr>
              <th
                style={{ width: ROW_NUM_WIDTH }}
                className="sticky left-0 z-20 bg-muted border-b border-r px-1 py-1"
              />
              {visibleColumns.map((col) => {
                const isPinned = pinnedColumns.includes(col.id)
                return (
                <th
                  key={`filter-${col.id}`}
                  style={{ width: getColWidth(col.id, DEFAULT_COL_WIDTH), ...(isPinned ? { left: pinnedLeft[col.id] } : {}) }}
                  className={cn('border-b border-r px-1 py-1 bg-muted', isPinned && 'sticky z-30 border-r-primary/40')}
                >
                  <ColumnFilterInput
                    colId={col.id}
                    colType={col.type}
                    colName={col.name}
                    value={columnFilters[col.id]}
                    onChange={handleFilterChange}
                    isDatetime={samplesByCol[col.id] ? hasTimeComponent(samplesByCol[col.id]) : false}
                    listMode={isListMode(col)}
                    listOptions={distinctByCol[col.id]}
                  />
                </th>
                )
              })}
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
              pageRows.map((row, rowIdx) => {
              // The edit log addresses rows by their raw ordinal. Front-only rows
              // carry it after a replay; server rows carry it once the dataset has
              // a log (the cache only materialises the key when there is one).
              const ordinal = edit.ordinalOf(row) ?? rowOffset + rowIdx
              return (
                <tr
                  key={rowIdx}
                  // A new row can land off-screen — or on another page entirely —
                  // so the flash alone would highlight something nobody sees.
                  ref={flash?.row === ordinal ? flashRowRef : undefined}
                  className={cn(
                    'hover:bg-accent/30',
                    flash?.row === ordinal && 'animate-in fade-in bg-primary/15',
                  )}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild disabled={!editable}>
                      <td
                        style={{ width: ROW_NUM_WIDTH }}
                        className="sticky left-0 z-[5] bg-background border-b border-r px-2 py-1 text-center text-muted-foreground tabular-nums"
                      >
                        {rowOffset + rowIdx + 1}
                      </td>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => moveRow(ordinal, -1)} className="text-xs">
                        <ArrowUp size={13} />
                        {t('datasets.row_move_up')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => moveRow(ordinal, 1)} className="text-xs">
                        <ArrowDown size={13} />
                        {t('datasets.row_move_down')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => removeRow(ordinal)} className="text-xs" variant="destructive">
                        <Trash2 size={13} />
                        {t('datasets.row_delete')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {visibleColumns.map((col, colIdx) => {
                    const isPinned = pinnedColumns.includes(col.id)
                    const raw = row[col.id]
                    const isSelectedCell = edit.selected?.row === ordinal && edit.selected?.column === col.id
                    const isEditingCell = edit.editing?.row === ordinal && edit.editing?.column === col.id
                    // Native title (cheap on thousands of cells): the mapped label with the
                    // raw code in parens when a value label applies, else the full value so a
                    // truncated cell is still readable on hover.
                    const cellTitle = raw == null
                      ? undefined
                      : col.valueLabels?.[String(raw)] != null
                        ? `${col.valueLabels[String(raw)]} (${String(raw)})`
                        : String(raw)
                    return (
                    <td
                      key={col.id}
                      title={isEditingCell ? undefined : cellTitle}
                      onClick={editable ? () => edit.setSelected({ row: ordinal as number, column: col.id }) : undefined}
                      onDoubleClick={editable ? () => edit.beginEdit({ row: ordinal as number, column: col.id }, raw) : undefined}
                      style={{ maxWidth: getColWidth(col.id, DEFAULT_COL_WIDTH), ...(isPinned ? { left: pinnedLeft[col.id], width: getColWidth(col.id, DEFAULT_COL_WIDTH) } : {}) }}
                      className={cn(
                        'relative border-b border-r px-3 py-1 whitespace-nowrap overflow-hidden text-ellipsis',
                        isPinned
                          ? 'sticky z-20 bg-background border-r-primary/40'
                          : selectedColumnId === col.id ? 'bg-accent/20' : columnTint(colIdx),
                        editable && 'cursor-cell',
                        flash?.column === col.id && 'bg-primary/15',
                        isSelectedCell && 'outline outline-2 -outline-offset-2 outline-primary',
                      )}
                    >
                      {isEditingCell ? (
                        // Absolutely positioned inside a relative cell: an inline
                        // input is a taller box than the text it replaces, and
                        // would push the row height as you moved through cells.
                        <input
                          autoFocus
                          value={edit.draft}
                          onChange={(e) => edit.setDraft(e.target.value)}
                          onBlur={() => void edit.commitEdit()}
                          className="absolute inset-0 w-full bg-background px-3 text-xs outline-none ring-2 ring-inset ring-primary"
                        />
                      ) : raw != null ? (
                        displayCellValue(col, raw, booleanLabels)
                      ) : (
                        <span className="italic text-muted-foreground/50">null</span>
                      )}
                    </td>
                    )
                  })}
                </tr>
              )})
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination bar + column visibility */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-2">
          {editToolbar?.({ selectedRow: edit.selected?.row, rowBefore })}
          {editToolbar && <Separator orientation="vertical" className="mx-1 h-4" />}
          <span className="text-xs text-muted-foreground">
            {t('files.table_total', { count: totalCount })}
            {!server && hasActiveFilters && ` / ${rows.length}`}
          </span>
          {onHiddenColumnsChange && (
            <ColumnVisibilityMenu
              items={columns.map((col) => ({
                id: col.id,
                label: displayColumnName(col),
                searchText: `${col.name} ${col.label ?? ''} ${col.description ?? ''}`,
                visible: !hiddenColumns.has(col.id),
                content: (
                  <div className="flex items-center gap-1.5">
                    <TypeBadge type={col.type} size="sm" />
                    <span className="truncate">{displayColumnName(col)}</span>
                  </div>
                ),
                tooltip: (
                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
                    <span className="text-muted-foreground">{t('datasets.col_meta_col_id')}</span>
                    <span className="font-mono break-all">{col.name}</span>
                    <span className="text-muted-foreground">{t('datasets.col_meta_label')}</span>
                    <span className="break-words">{col.label || '—'}</span>
                    <span className="text-muted-foreground">{t('datasets.col_meta_description')}</span>
                    <span className="break-words">{col.description || '—'}</span>
                  </div>
                ),
              }))}
              onToggle={(id, visible) => {
                onHiddenColumnsChange((prev) => {
                  const next = new Set(prev)
                  if (visible) next.delete(id)
                  else next.add(id)
                  return next
                })
              }}
              onSetMany={(ids, visible) => {
                onHiddenColumnsChange((prev) => {
                  const next = new Set(prev)
                  for (const id of ids) {
                    if (visible) next.delete(id)
                    else next.add(id)
                  }
                  return next
                })
              }}
            />
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

      {metaColumn && (
        <EditColumnMetaDialog
          key={metaColumn.id}
          fileId={fileId}
          column={metaColumn}
          rows={rows}
          open={metaColumn != null}
          onOpenChange={(open) => { if (!open) setMetaColumn(null) }}
        />
      )}
    </div>
  )
}
