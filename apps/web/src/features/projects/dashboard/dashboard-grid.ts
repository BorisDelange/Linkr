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

/** Jointive column width: cells touch (margin 0) and the grid is flush to the edge (padding 0). */
export function colWidthFor(containerWidth: number): number {
  return containerWidth / DASHBOARD_GRID.cols
}

/** "Fit to height" geometry: the number of rows that fills the visible area with ~square cells,
 *  and the exact row height for that many rows. Shared by the grid renderer and the settings
 *  dialog (which uses the row count to rescale layouts when the option is turned on). */
export function computeFitRows(containerWidth: number, availableHeight: number): { rows: number; rowHeight: number } | null {
  const colWidth = colWidthFor(containerWidth)
  if (colWidth <= 0 || availableHeight <= 0) return null
  // Cells are jointive and flush to the edge, so the row pitch is exactly rowHeight and the rows
  // span the full height. Pick a row count that makes cells ~square, then a fractional row height
  // that fills the height EXACTLY (rows × rowHeight = availableHeight). A fractional height is fine
  // — the browser sub-pixel renders it — and avoids the leftover band (floor) or clipped bottom
  // (ceil) an integer height leaves when it can't divide the viewport evenly.
  const rows = Math.max(1, Math.round(availableHeight / colWidth))
  const rowHeight = Math.max(4, availableHeight / rows)
  return { rows, rowHeight }
}

export interface GridLayoutBox { x: number; y: number; w: number; h: number }
const MIN_WIDGET_ROWS = 2

/**
 * Recompute a tab's widget layouts so the gap-free stack fills exactly `maxRows`: remove vertical
 * gaps, scale heights down if the stack is too tall, then make each column land precisely on
 * maxRows — growing the bottom widget into rounding slack, or shrinking widgets from the bottom up
 * (cascading past any already at the 2-row minimum) if min-height clamping overshot. Never produces
 * an overlap. Returns new boxes keyed by input order (widgets must be sorted top-to-bottom first).
 */
export function fitTabLayouts(widgets: { id: string; layout: GridLayoutBox }[], maxRows: number): Map<string, GridLayoutBox> {
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

  // Grow each column's bottom widget to fill remaining slack up to maxRows.
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
