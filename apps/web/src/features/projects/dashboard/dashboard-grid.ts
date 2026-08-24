import type { CSSProperties } from 'react'

/** Dashboard grid layout constants — shared by the grid renderer and the widget editor preview.
 *
 *  Spacing model: the grid uses jointive cells (react-grid-layout margin 0) flush to the container
 *  edge (containerPadding 0), so the full first/last cells are visible right at the border. Each
 *  widget then carries a `gap/2` visual inset, so two touching widgets are separated by a full
 *  `gap` (gap/2 + gap/2, demarcation centered) while edge widgets sit `gap/2` from the border.
 *  A cell is `colWidth × rowHeight` with NO inter-cell margin; the gutter lives inside the cell. */
export const DASHBOARD_GRID = {
  cols: 48,
  rowHeight: 20,
  margin: [12, 12] as [number, number],
  containerPadding: [12, 12] as [number, number],
}

/**
 * How far the bottom-right resize grip sits OUTSIDE the card it resizes.
 *
 * On the dashboard this is not set anywhere: the handle is positioned on the
 * grid CELL while the card is inset by half the inter-widget gap, so the glyph
 * naturally lands in the gutter. Standalone previews (the widget editor, the
 * analysis result) have no cell to hang it on, so they apply this offset —
 * half the default gap — to reproduce the same look.
 */
export const RESIZE_HANDLE_OFFSET = DASHBOARD_GRID.margin[0] / 2

/** Fixed number of rows in fit-to-height mode. The row COUNT is constant so widget heights (in
 *  rows) keep the same proportion of the viewport whatever its size: resizing the window only
 *  changes rowHeight in px (the rows always span the full height), never the layout. A variable row
 *  count — e.g. derived from the column width to keep cells square — would silently rescale every
 *  widget when the width changed (a full-height widget becoming half-height on a narrower window). */
export const FIT_ROWS = 40

/** Jointive column width: cells touch (margin 0) and the grid is flush to the edge (padding 0). */
export function colWidthFor(containerWidth: number): number {
  return containerWidth / DASHBOARD_GRID.cols
}

/** "Fit to height" geometry: the fixed row count and the row height that makes those rows span the
 *  visible area exactly. Shared by the grid renderer and the settings dialog (which uses the row
 *  count to rescale layouts when the option is turned on). */
export function computeFitRows(_containerWidth: number, availableHeight: number): { rows: number; rowHeight: number } | null {
  if (availableHeight <= 0) return null
  // Rows are jointive and flush to the edge, so rowHeight × FIT_ROWS = availableHeight exactly. A
  // fractional rowHeight is fine (sub-pixel rendered) and avoids a leftover band / clipped bottom.
  const rowHeight = Math.max(4, availableHeight / FIT_ROWS)
  return { rows: FIT_ROWS, rowHeight }
}

export interface GridLayoutBox { x: number; y: number; w: number; h: number }
const MIN_WIDGET_ROWS = 2

/** Trim only the columns whose stack overflows `maxRows`, leaving every other column exactly as-is.
 *  For each overflowing column its widgets are shrunk from the bottom up (down to the 2-row min) and
 *  then re-stacked gap-free from their column's top; columns that already fit keep their original
 *  positions and heights. Widgets spanning several columns are trimmed if ANY of their columns
 *  overflows, and re-flow uses the running bottom across all columns the widget touches so multi-
 *  column rows never overlap. */
function shrinkOverflowingColumns(
  widgets: { id: string; layout: GridLayoutBox }[],
  maxRows: number,
): Map<string, GridLayoutBox> {
  const result = new Map<string, GridLayoutBox>(widgets.map((wd) => [wd.id, { ...wd.layout }]))

  // Current gap-free bottom of each column, and which widgets live in each column (top-to-bottom).
  const colBottom = new Map<number, number>()
  const colStack = new Map<number, string[]>()
  for (const wd of widgets) {
    const { x, w, h } = wd.layout
    let y = 0
    for (let c = x; c < x + w; c++) y = Math.max(y, colBottom.get(c) ?? 0)
    for (let c = x; c < x + w; c++) {
      colBottom.set(c, y + h)
      const arr = colStack.get(c) ?? []
      arr.push(wd.id)
      colStack.set(c, arr)
    }
  }

  // Widgets that need trimming: any in a column whose bottom exceeds maxRows. Shrink each such
  // column from the bottom up by its own overflow, recomputed from current heights as we go.
  const overflowing = [...colStack].filter(([col]) => (colBottom.get(col) ?? 0) > maxRows)
  for (const [, ids] of overflowing) {
    let overshoot = ids.reduce((sum, id) => sum + result.get(id)!.h, 0) - maxRows
    for (let i = ids.length - 1; i >= 0 && overshoot > 0; i--) {
      const lay = result.get(ids[i])!
      const cut = Math.min(lay.h - MIN_WIDGET_ROWS, overshoot)
      if (cut <= 0) continue
      lay.h -= cut
      overshoot -= cut
    }
  }

  // Re-flow ONLY the columns we touched, gap-free from the top, in the original top-to-bottom order.
  // Untouched columns keep their exact y positions. A multi-column widget's new y is the max running
  // bottom of the touched columns it spans (so it can't overlap a sibling in any of them).
  const touched = new Set(overflowing.map(([col]) => col))
  const reflow = new Map<number, number>()
  for (const wd of widgets) {
    const lay = result.get(wd.id)!
    const cols = Array.from({ length: lay.w }, (_, i) => lay.x + i)
    if (!cols.some((c) => touched.has(c))) continue
    let y = 0
    for (const c of cols) y = Math.max(y, reflow.get(c) ?? lay.y)
    lay.y = y
    for (const c of cols) reflow.set(c, y + lay.h)
  }

  return result
}

/**
 * Recompute a tab's widget layouts so the gap-free stack fits `maxRows`. Two modes:
 *
 * - `'shrink-only'` (default): leave the layout untouched UNLESS a column overflows maxRows, in
 *   which case only that overflow is trimmed (no compacting, no growing to fill). This is what every
 *   caller uses: heights are never auto-stretched — widening/moving a widget, reloading, going
 *   fullscreen, turning the mode on, or adding a widget only ever trims a real vertical overflow, so
 *   the user's chosen heights (e.g. half-height widgets) survive every one of those events.
 * - `'fill'`: remove vertical gaps, scale heights down if the stack is too tall, then make each
 *   column land precisely on maxRows — growing the bottom widget into rounding slack, or shrinking
 *   from the bottom up if min-height clamping overshot. Kept for completeness; not currently used.
 *
 * Never produces an overlap. Returns new boxes keyed by input order (widgets sorted top-to-bottom).
 */
export function fitTabLayouts(
  widgets: { id: string; layout: GridLayoutBox }[],
  maxRows: number,
  mode: 'fill' | 'shrink-only' = 'shrink-only',
): Map<string, GridLayoutBox> {
  const result = new Map<string, GridLayoutBox>()
  if (widgets.length === 0 || maxRows < MIN_WIDGET_ROWS) return result

  // Height of the gap-free stack with the current heights (drives the scale factor).
  let compactedRows = 0
  {
    const bottomByCol = new Map<number, number>()
    for (const wd of widgets) {
      const { x, w, h } = wd.layout
      let y = 0
      for (let c = x; c < x + w; c++) y = Math.max(y, bottomByCol.get(c) ?? 0)
      for (let c = x; c < x + w; c++) bottomByCol.set(c, y + h)
      compactedRows = Math.max(compactedRows, y + h)
    }
  }

  // Shrink-only keeps every column independent: a column that fits is left exactly as the user set
  // it (positions AND heights), and only a column that actually overflows is trimmed back to maxRows
  // from the bottom up. No global scaling, no compacting, no growing — so adding/resizing a widget
  // in one column never touches a widget that was happily at 50% height in another column.
  if (mode === 'shrink-only') {
    if (compactedRows <= maxRows) {
      for (const wd of widgets) result.set(wd.id, { ...wd.layout })
      return result
    }
    return shrinkOverflowingColumns(widgets, maxRows)
  }

  const factor = compactedRows > maxRows ? maxRows / compactedRows : 1
  const bottomByCol = new Map<number, number>()
  const colStack = new Map<number, string[]>()
  for (const wd of widgets) {
    const { x, w } = wd.layout
    let y = 0
    for (let c = x; c < x + w; c++) y = Math.max(y, bottomByCol.get(c) ?? 0)
    const h = Math.max(MIN_WIDGET_ROWS, factor < 1 ? Math.floor(wd.layout.h * factor) : wd.layout.h)
    for (let c = x; c < x + w; c++) {
      bottomByCol.set(c, y + h)
      const arr = colStack.get(c) ?? []
      arr.push(wd.id)
      colStack.set(c, arr)
    }
    result.set(wd.id, { x, y, w, h })
  }

  // Shrink from the bottom up wherever a column overflows maxRows.
  for (const [col, ids] of colStack) {
    let overshoot = (bottomByCol.get(col) ?? 0) - maxRows
    for (let i = ids.length - 1; i >= 0 && overshoot > 0; i--) {
      const lay = result.get(ids[i])!
      const cut = Math.min(lay.h - MIN_WIDGET_ROWS, overshoot)
      if (cut <= 0) continue
      lay.h -= cut
      overshoot -= cut
    }
  }

  // Re-flow top-to-bottom from the adjusted heights (no gaps, no overlaps).
  const reflow = new Map<number, number>()
  for (const wd of widgets) {
    const lay = result.get(wd.id)!
    let y = 0
    for (let c = lay.x; c < lay.x + lay.w; c++) y = Math.max(y, reflow.get(c) ?? 0)
    lay.y = y
    for (let c = lay.x; c < lay.x + lay.w; c++) reflow.set(c, y + lay.h)
  }

  // Grow each column's bottom widget to fill remaining slack up to maxRows. We only reach this point
  // when the stack overflowed (shrink-only returns early above when it already fits), so closing the
  // rounding slack is wanted in BOTH modes — otherwise the floor() in the scale step leaves the
  // stack one row short of the bottom (a visible empty cell after an over-tall resize).
  for (const [col, bottom] of reflow) {
    const slack = maxRows - bottom
    if (slack <= 0) continue
    const ids = colStack.get(col)
    const lastId = ids?.[ids.length - 1]
    const lay = lastId ? result.get(lastId) : undefined
    if (lay && Array.from({ length: lay.w }, (_, i) => lay.x + i).every((c) => colStack.get(c)?.slice(-1)[0] === lastId)) {
      lay.h += slack
      for (let c = lay.x; c < lay.x + lay.w; c++) reflow.set(c, lay.y + lay.h)
    }
  }

  return result
}

/** Measure the live dashboard grid viewport and return the fit-to-height row count, or null if
 *  it can't be measured. Used by the settings dialog and the add-widget flow to rescale layouts. */
export function measureFitRows(): number | null {
  if (typeof document === 'undefined') return null
  const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
  if (!viewport) return null
  const gridEl = viewport.querySelector<HTMLElement>('.react-grid-layout')
  const width = gridEl?.clientWidth ?? viewport.clientWidth
  const height = viewport.clientHeight
  const fit = computeFitRows(width, height)
  return fit ? fit.rows : null
}

/** Geometry of a react-grid-layout container, in the library's own terms. `margin`/`containerPadding`
 *  are 0 on dashboards (jointive cells) but not on the patient-data boards, so the helper below
 *  covers both. */
export interface GridGeometry {
  cols: number
  containerWidth: number
  rowHeight: number
  margin: [number, number]
  containerPadding: [number, number]
}

/** Faint cell backdrop painted in edit mode so widget placement is easier to read.
 *
 *  Mirrors react-grid-layout's own placement maths: a cell's top-left corner is at
 *  `containerPadding + index × (cellSize + margin)`, with
 *  `colWidth = (containerWidth − margin.x·(cols−1) − padding.x·2) / cols`. So the two gradients use
 *  the cell PITCH (cell + margin) as their period and the container padding as their origin, and
 *  every line lands exactly on a cell edge — jointive (dashboards, margin/padding 0) or spaced
 *  (patient boards) alike. Returns undefined when the container hasn't been measured yet. */
export function gridBackgroundStyle(geometry: GridGeometry): CSSProperties | undefined {
  const { cols, containerWidth, rowHeight, margin, containerPadding } = geometry
  const colWidth = (containerWidth - margin[0] * (cols - 1) - containerPadding[0] * 2) / cols
  if (colWidth <= 0 || rowHeight <= 0) return undefined
  return {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'linear-gradient(to right, var(--color-border) 1px, transparent 1px),' +
      'linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)',
    backgroundSize: `${colWidth + margin[0]}px ${rowHeight + margin[1]}px`,
    backgroundPosition: `${containerPadding[0]}px ${containerPadding[1]}px`,
    opacity: 0.4,
  }
}

/** Pixel footprint of a w×h widget on ANY react-grid-layout container, in the library's own maths:
 *  a span of `n` cells covers `n` cells plus the `n−1` margins between them, with
 *  `colWidth = (containerWidth − margin.x·(cols−1) − padding.x·2) / cols`. Unlike `widgetPixelSize`
 *  (dashboards only: jointive cells, gutter inset inside the cell), this takes the geometry as an
 *  argument, so it is exact on the spaced patient-data grid too. Returns null before measurement. */
export function widgetFootprint(
  w: number,
  h: number,
  geometry: GridGeometry,
): { width: number; height: number } | null {
  const { cols, containerWidth, rowHeight, margin, containerPadding } = geometry
  const colWidth = (containerWidth - margin[0] * (cols - 1) - containerPadding[0] * 2) / cols
  if (colWidth <= 0 || rowHeight <= 0) return null
  return {
    width: Math.round(w * colWidth + (w - 1) * margin[0]),
    height: Math.round(h * rowHeight + (h - 1) * margin[1]),
  }
}

/** Visible pixel size of a widget occupying w×h grid cells, given the grid container's pixel width.
 *  The cell footprint is w·colWidth × h·rowHeight (jointive); the visible card is that minus the
 *  `gap/2` inset on each side, i.e. one full `gap` smaller in each axis. `gap` overrides the default
 *  spacing (per-dashboard widgetSpacing). */
export function widgetPixelSize(w: number, h: number, containerWidth: number, gap?: number): { width: number; height: number } {
  const { rowHeight, margin } = DASHBOARD_GRID
  const g = gap ?? margin[0]
  const colWidth = colWidthFor(containerWidth)
  const width = Math.max(1, w * colWidth - g)
  const height = Math.max(1, h * rowHeight - g)
  return { width: Math.round(width), height: Math.round(height) }
}
