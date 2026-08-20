import type { ReactNode } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import type { ColumnDef, Header } from '@tanstack/react-table'

/**
 * The dashed inline filter field every table puts under its column headers.
 * Kept here rather than copied per file: it had drifted to six near-identical
 * literals, and a dense variant that differed only in being 4px shorter.
 */
export const FILTER_INPUT_CLASS =
  'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

/** Same field in a tighter row (a panel table sharing vertical space with a form). */
export const FILTER_INPUT_CLASS_DENSE =
  'h-5 w-full rounded border border-dashed bg-transparent px-1 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

export type TableSorting = { columnId: string; desc: boolean } | null

/**
 * Sort arrow for a column header: neutral when the table is sorted on something
 * else, and pointing the active way when it is not.
 */
export function SortIndicator({ columnId, sorting }: { columnId: string; sorting: TableSorting }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  return sorting.desc
    ? <ArrowDown size={10} className="shrink-0 text-primary" />
    : <ArrowUp size={10} className="shrink-0 text-primary" />
}

/**
 * Next sort state for a click on `columnId`: a fresh column starts descending
 * (the big rows are the interesting ones), then ascends, then clears.
 */
export function nextSorting(current: TableSorting, columnId: string): TableSorting {
  if (current?.columnId !== columnId) return { columnId, desc: true }
  return current.desc ? { columnId, desc: false } : null
}

/**
 * Human-readable name for a column, for the visibility menu. TanStack keeps the
 * header as a renderer, so a function header is called to recover its text; a
 * column that renders something other than a string falls back to its id,
 * de-slugified.
 */
export function columnLabel<T>(colDefs: ColumnDef<T>[], id: string): string {
  const def = colDefs.find((c) => 'id' in c && c.id === id)
  if (def) {
    if (typeof def.header === 'string') return def.header
    if (typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
  }
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * The drag strip on a column's trailing edge. It sits slightly outside the cell
 * so the cursor finds it before the neighbouring header, and shows itself only
 * on hover — a visible divider per column reads as chrome.
 *
 * Headless: the tables that resize through TanStack and the two that track
 * widths themselves render the same strip, so it takes handlers rather than a
 * `Header`. Use `ColumnResizeHandle` for the TanStack case.
 */
export function ResizeGrip({
  onStart,
  onReset,
  active,
}: {
  onStart: (e: React.MouseEvent | React.TouchEvent) => void
  onReset: () => void
  active: boolean
}): ReactNode {
  return (
    <div
      onMouseDown={onStart}
      onTouchStart={onStart}
      onDoubleClick={onReset}
      className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
    >
      <div
        className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
          active ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
        }`}
      />
    </div>
  )
}

/** `ResizeGrip` wired to a TanStack header. Renders nothing if the column is fixed. */
export function ColumnResizeHandle<T>({ header }: { header: Header<T, unknown> }): ReactNode {
  if (!header.column.getCanResize()) return null
  return (
    <ResizeGrip
      onStart={header.getResizeHandler()}
      onReset={() => header.column.resetSize()}
      active={header.column.getIsResizing()}
    />
  )
}
