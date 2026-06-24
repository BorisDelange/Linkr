/** Dashboard grid layout constants — shared by the grid renderer and the widget editor preview. */
export const DASHBOARD_GRID = {
  cols: 48,
  rowHeight: 20,
  margin: [12, 12] as [number, number],
  containerPadding: [12, 12] as [number, number],
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
