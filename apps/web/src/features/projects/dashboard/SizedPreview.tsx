import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { widgetPixelSize, DASHBOARD_GRID, colWidthFor, RESIZE_HANDLE_OFFSET } from './dashboard-grid'

/** Reference width used when no dashboard is on screen to measure. */
const FALLBACK_GRID_WIDTH = 1400

interface SizedPreviewProps {
  /** Grid cells the preview starts at. */
  layout: { w: number; h: number }
  gridWidth?: number
  widgetSpacing?: number
  children: React.ReactNode
}

/**
 * A widget rendered at its on-dashboard pixel size, with a drag handle to try other
 * sizes locally — it never changes the dashboard layout.
 *
 * Shared by the widget editor (starts at the widget's real footprint) and the add
 * dialog (starts at a roomy default, since the widget has no footprint yet).
 */
export function SizedPreview({ layout, gridWidth, widgetSpacing, children }: SizedPreviewProps) {
  const { t } = useTranslation()
  const effGridWidth = gridWidth && gridWidth > 0 ? gridWidth : FALLBACK_GRID_WIDTH

  // Cell pitch matching the live dashboard grid (jointive cells), so the preview snaps to whole
  // cells. `gap` stays the per-widget gutter so the snap rounding mirrors widgetPixelSize.
  const { colPitch, rowPitch, gap } = useMemo(() => {
    const g = widgetSpacing ?? DASHBOARD_GRID.margin[0]
    return { colPitch: colWidthFor(effGridWidth), rowPitch: DASHBOARD_GRID.rowHeight, gap: g }
  }, [effGridWidth, widgetSpacing])

  const base = useMemo(
    () => widgetPixelSize(layout.w, layout.h, effGridWidth, widgetSpacing),
    [layout.w, layout.h, effGridWidth, widgetSpacing],
  )
  const [size, setSize] = useState(base)
  // Re-sync to the widget's size when the target widget changes.
  useEffect(() => { setSize(base) }, [base])

  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height }
    setResizing(true)
  }, [size])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const d = dragRef.current
    // Snap the dragged size to whole grid cells, mirroring the dashboard's resize behaviour.
    const rawW = d.startW + (e.clientX - d.startX)
    const rawH = d.startH + (e.clientY - d.startY)
    const cellsW = Math.max(2, Math.round((rawW + gap) / colPitch))
    const cellsH = Math.max(2, Math.round((rawH + gap) / rowPitch))
    setSize({
      width: Math.round(cellsW * colPitch - gap),
      height: Math.round(cellsH * rowPitch - gap),
    })
  }, [colPitch, rowPitch, gap])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    setResizing(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  const isCustomSize = size.width !== base.width || size.height !== base.height
  const cellsW = Math.max(1, Math.round((size.width + gap) / colPitch))
  const cellsH = Math.max(1, Math.round((size.height + gap) / rowPitch))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1 text-[11px] text-muted-foreground">
        <span>{t('dashboard.preview_size')}: {size.width} × {size.height} px</span>
        {isCustomSize && (
          <button onClick={() => setSize(base)} className="inline-flex items-center gap-1 hover:text-foreground">
            <RotateCcw size={11} />
            {t('dashboard.preview_reset_size')}
          </button>
        )}
        <span className="ml-auto">{cellsW} × {cellsH} {t('dashboard.preview_cells')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
        <div className="relative" style={{ width: size.width, height: size.height }}>
          {/* Red placeholder mirroring the dashboard's resize feedback — the cells the widget will
              occupy. Drawn under the widget so its content stays readable while dragging. */}
          {resizing && (
            <div className="pointer-events-none absolute inset-0 rounded-lg bg-destructive/20" />
          )}
          <div className="h-full w-full overflow-hidden rounded-lg border bg-card shadow-sm">
            {children}
          </div>
          {/* Resize grip (bottom-right) — the dashboard's own handle, offset so it
              sits just OUTSIDE the card corner. On the dashboard the handle is
              positioned on the grid CELL while the card is inset by half the
              gutter, which is what puts the glyph in the gap; here there is no
              cell, so the same offset is applied directly. */}
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="react-resizable-handle react-resizable-handle-se"
            title={t('dashboard.preview_resize_hint')}
            style={{ cursor: 'nwse-resize', bottom: -RESIZE_HANDLE_OFFSET, right: -RESIZE_HANDLE_OFFSET }}
          />
        </div>
      </div>
    </div>
  )
}
