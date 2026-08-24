/**
 * A table typeset the way a journal typesets one.
 *
 * Deliberately NOT `ConceptDataTable`. That component exists to explore data —
 * inline filter fields under every header, a column-visibility menu, paging
 * controls, a row counter. Every one of those is chrome that must not appear in
 * a manuscript, so reusing it would mean fighting it to hide most of what it
 * does. `ui-patterns.md` §6 says extend the shared component when it *almost*
 * fits; here it does not, because the goal is a typeset table rather than a
 * datatable. See docs/planning/descriptive-table-plan.md §3.
 *
 * The style is `booktabs` — what LaTeX's package of that name, gtsummary and the
 * NEJM/Lancet all produce:
 *   - horizontal rules ONLY: top, under the header, bottom;
 *   - no vertical rules, no cell borders, no zebra striping;
 *   - one line per row, so a column of figures can be scanned vertically.
 *
 * What it keeps from a datatable is column resizing, because a variable-name
 * column routinely needs widening — through the shared headless `ResizeGrip`,
 * which exists for exactly the tables that track their own widths.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ResizeGrip } from '@/components/ui/table-primitives'
import { TruncatedText } from '@/components/ui/truncated-text'
import { cn } from '@/lib/utils'

export interface PublicationColumn<T> {
  id: string
  header: string
  /**
   * A header spanning several columns, drawn as a second row above them with a
   * rule underneath — how a journal presents a group ("Control (n=137)") over
   * the statistics that belong to it.
   */
  group?: string
  cell: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  /** Initial width in px; the user can drag from there. */
  width?: number
  minWidth?: number
}

export interface PublicationRow {
  id: string
  /**
   * A level of a categorical variable rather than a variable itself. Indented
   * and unemphasised, the way gtsummary lays out a Table 1 — the variable names
   * a question, its levels are the answers.
   */
  indent?: boolean
}

export function PublicationTable<T extends PublicationRow>({
  rows,
  columns,
  wrap = false,
  emptyMessage,
  className,
  center = false,
  tableRef,
}: {
  rows: T[]
  columns: PublicationColumn<T>[]
  /**
   * Let a long cell wrap onto several lines. Off by default: irregular row
   * heights break the vertical scan that is the point of a column of figures.
   */
  wrap?: boolean
  emptyMessage?: string
  className?: string
  /** Centre the table in its container. Off by default (flush left). */
  center?: boolean
  /** The table element, for export (PNG / clipboard / LaTeX). */
  tableRef?: React.Ref<HTMLTableElement>
}) {
  const [widths, setWidths] = useState<Record<string, number>>({})
  // Mirror of `widths` for the drag handler to read, so the handler itself has
  // no dependency on the state and never needs re-creating.
  const widthsRef = useRef(widths)
  useEffect(() => {
    widthsRef.current = widths
  }, [widths])
  const drag = useRef<
    { id: string; startX: number; startWidth: number; startScrollLeft: number } | null
  >(null)
  const [resizing, setResizing] = useState<string | null>(null)
  /** The scroll container, so a drag can tell cursor movement from scrolling. */
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const widthOf = (col: PublicationColumn<T>) => widths[col.id] ?? col.width ?? 140

  const onResizeStart = useCallback(
    (col: PublicationColumn<T>) => (e: React.MouseEvent | React.TouchEvent) => {
      const point = 'touches' in e ? e.touches[0] : e
      // Start width from the ref, not from a captured `widths`: this handler
      // then has no dependencies, so a caller that rebuilds its column array on
      // every render cannot hand the grip a stale closure mid-drag — which is
      // exactly what made a column stop tracking the cursor.
      drag.current = {
        id: col.id,
        startX: point.clientX,
        startWidth: widthsRef.current[col.id] ?? col.width ?? 140,
        startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
      }
      setResizing(col.id)

      const move = (ev: MouseEvent | TouchEvent) => {
        const d = drag.current
        if (!d) return
        const p = 'touches' in ev ? ev.touches[0] : ev
        // Widening a column widens the table, so a container scrolled away from
        // the left edge re-anchors and slides the whole table under the cursor.
        // clientX alone then measures cursor movement PLUS that slide, and the
        // grip drifts away from the pointer. Adding back the scroll delta makes
        // the measurement relative to the table rather than to the viewport.
        const scrolled = (scrollRef.current?.scrollLeft ?? 0) - d.startScrollLeft
        const next = Math.max(col.minWidth ?? 60, d.startWidth + (p.clientX - d.startX) + scrolled)
        setWidths((w) => (w[d.id] === next ? w : { ...w, [d.id]: next }))
      }
      const up = () => {
        drag.current = null
        setResizing(null)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        window.removeEventListener('touchmove', move)
        window.removeEventListener('touchend', up)
      }
      // On window, not the grip: the pointer routinely leaves the 3px strip
      // mid-drag, and the resize must follow it rather than stop dead.
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      window.addEventListener('touchmove', move)
      window.addEventListener('touchend', up)
    },
    [],
  )

  // Group headers, as runs of adjacent columns sharing a `group`. Built from the
  // column order so a group is always contiguous by construction.
  const groups: { label: string | undefined; span: number }[] = []
  for (const col of columns) {
    const last = groups[groups.length - 1]
    if (last && last.label === col.group) last.span++
    else groups.push({ label: col.group, span: 1 })
  }
  const hasGroups = groups.some((g) => g.label)

  if (rows.length === 0 && emptyMessage) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  const alignOf = (a: PublicationColumn<T>['align']) =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left'

  return (
    <div ref={scrollRef} className={cn('overflow-auto', className)}>
      <table
        ref={tableRef}
        className="border-collapse bg-background text-xs"
        style={{
          tableLayout: 'fixed',
          width: columns.reduce((s, c) => s + widthOf(c), 0),
          // The table has an explicit pixel width, so in a wider pane it sits
          // flush left unless centred. Opt-in: most callers want it aligned
          // with the text above it.
          ...(center ? { marginLeft: 'auto', marginRight: 'auto' } : null),
        }}
      >
        {/* Widths live here, not on the header cells.
            Under table-layout: fixed the browser takes column widths from the
            FIRST row — which, whenever there are group headers, is a row of
            colSpan cells that carry no width of their own. It then spread the
            columns evenly and ignored every width below, so dragging a grip
            changed nothing visible. A colgroup states the widths once, for the
            whole table, independent of what the first row happens to be. */}
        <colgroup>
          {columns.map((col) => (
            <col key={col.id} style={{ width: widthOf(col) }} />
          ))}
        </colgroup>
        <thead>
          {/* The three booktabs rules: toprule here, midrule under the header
              row, bottomrule on the last body row. Nothing vertical anywhere. */}
          {hasGroups && (
            <tr className="border-t-2 border-foreground/70">
              {groups.map((g, i) => (
                <th
                  key={i}
                  colSpan={g.span}
                  className={cn(
                    'px-3 pb-1 pt-2 text-center font-semibold',
                    // The rule runs under the group label only, not across the
                    // whole row: it marks what the label covers.
                    g.label && 'border-b border-foreground/40',
                  )}
                >
                  {g.label ?? ''}
                </th>
              ))}
            </tr>
          )}
          <tr className={cn(!hasGroups && 'border-t-2 border-foreground/70')}>
            {columns.map((col) => (
              <th
                key={col.id}
                className={cn(
                  'relative select-none border-b border-foreground/70 px-3 pb-1.5 font-semibold',
                  hasGroups ? 'pt-1.5' : 'pt-2',
                  alignOf(col.align),
                )}
              >
                <TruncatedText text={col.header} readOnly />
                <ResizeGrip
                  onStart={onResizeStart(col)}
                  onReset={() => setWidths((w) => { const n = { ...w }; delete n[col.id]; return n })}
                  active={resizing === col.id}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id}
              className={cn(i === rows.length - 1 && 'border-b-2 border-foreground/70')}
            >
              {columns.map((col, ci) => (
                <td
                  key={col.id}
                  className={cn(
                    'px-3 py-1 align-top',
                    alignOf(col.align),
                    !wrap && 'truncate whitespace-nowrap',
                    // Only the first column carries the indent: it holds the
                    // variable name, and the level belongs under it.
                    row.indent && ci === 0 && 'pl-7 text-muted-foreground',
                    col.align === 'right' && 'tabular-nums',
                  )}
                  style={{ maxWidth: widthOf(col) }}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
