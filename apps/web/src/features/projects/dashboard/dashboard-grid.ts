/** Dashboard grid layout constants — shared by the grid renderer and the widget editor preview. */
export const DASHBOARD_GRID = {
  cols: 48,
  rowHeight: 20,
  margin: [12, 12] as [number, number],
  containerPadding: [12, 12] as [number, number],
}

/** "Fit to height" geometry: the number of rows that fills the visible area with ~square cells,
 *  and the exact row height for that many rows. Shared by the grid renderer and the settings
 *  dialog (which uses the row count to rescale layouts when the option is turned on). */
export function computeFitRows(containerWidth: number, availableHeight: number, gap: number): { rows: number; rowHeight: number } | null {
  const { cols } = DASHBOARD_GRID
  const colWidth = (containerWidth - gap * 2 - gap * (cols - 1)) / cols
  if (colWidth <= 0 || availableHeight <= 0) return null
  const innerH = availableHeight - gap * 2
  const rows = Math.max(1, Math.floor((innerH + gap) / (colWidth + gap)))
  const rowHeight = Math.max(4, Math.floor((innerH - gap * (rows - 1)) / rows))
  return { rows, rowHeight }
}

/** Measure the live dashboard grid viewport and return the fit-to-height row count, or null if
 *  it can't be measured. Used by the settings dialog and the add-widget flow to rescale layouts. */
export function measureFitRows(gap: number): number | null {
  if (typeof document === 'undefined') return null
  const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
  if (!viewport) return null
  const gridEl = viewport.querySelector<HTMLElement>('.react-grid-layout')
  const width = gridEl?.clientWidth ?? viewport.clientWidth
  const height = viewport.clientHeight
  const fit = computeFitRows(width, height, gap)
  return fit ? fit.rows : null
}

/** Pixel size of a widget occupying w×h grid cells, given the grid container's pixel width.
 *  `gap` overrides the default inter-widget margin (per-dashboard widgetSpacing). */
export function widgetPixelSize(w: number, h: number, containerWidth: number, gap?: number): { width: number; height: number } {
  const { cols, rowHeight, margin, containerPadding } = DASHBOARD_GRID
  const marginX = gap ?? margin[0]
  const marginY = gap ?? margin[1]
  const [padX] = containerPadding
  const colWidth = (containerWidth - padX * 2 - marginX * (cols - 1)) / cols
  const width = Math.max(1, w * colWidth + (w - 1) * marginX)
  const height = Math.max(1, h * rowHeight + (h - 1) * marginY)
  return { width: Math.round(width), height: Math.round(height) }
}
