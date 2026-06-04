/** Dashboard grid layout constants — shared by the grid renderer and the widget editor preview. */
export const DASHBOARD_GRID = {
  cols: 24,
  rowHeight: 40,
  margin: [12, 12] as [number, number],
  containerPadding: [16, 16] as [number, number],
}

/** Pixel size of a widget occupying w×h grid cells, given the grid container's pixel width. */
export function widgetPixelSize(w: number, h: number, containerWidth: number): { width: number; height: number } {
  const { cols, rowHeight, margin, containerPadding } = DASHBOARD_GRID
  const [marginX, marginY] = margin
  const [padX] = containerPadding
  const colWidth = (containerWidth - padX * 2 - marginX * (cols - 1)) / cols
  const width = Math.max(1, w * colWidth + (w - 1) * marginX)
  const height = Math.max(1, h * rowHeight + (h - 1) * marginY)
  return { width: Math.round(width), height: Math.round(height) }
}
