import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import {
  hitRange,
  windowFromRangeGrab,
  windowFromRangeJump,
  type RangeGeom,
  type RangeHit,
  type TimeWindow,
} from './timeline-view'

const HEIGHT = 34

const CURSORS: Record<Exclude<RangeHit, null>, string> = { lo: 'ew-resize', hi: 'ew-resize', move: 'grab', jump: 'pointer' }

/**
 * The record's density under a data table, with the window its columns cover:
 * drawn like the timeline's and the data overview's strips, and moved the same
 * way — drag the window, pull an edge, click beside it to recentre.
 */
export function DataTableRangeStrip({
  bounds,
  view,
  counts,
  onViewChange,
}: {
  bounds: TimeWindow
  view: TimeWindow
  /** Events per equal slice of `bounds`. */
  counts: readonly number[]
  onViewChange: (next: TimeWindow) => void
}) {
  const { t } = useTranslation()
  const dark = useAppStore((s) => s.darkMode)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rangeRef = useRef<RangeGeom | null>(null)
  const dragRef = useRef<{ mode: Exclude<RangeHit, null | 'jump'>; grab: number } | null>(null)
  const [width, setWidth] = useState(0)
  const [cursor, setCursor] = useState<RangeHit>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width)
      if (w > 0) setWidth((prev) => (prev === w ? prev : w))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = HEIGHT * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${HEIGHT}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, HEIGHT)

    const x0 = 0
    const w = width
    const ry = 4
    const rh = HEIGHT - 8
    const full = bounds.hi - bounds.lo || 1
    ctx.fillStyle = 'rgba(148,163,184,0.10)'
    ctx.fillRect(x0, ry, w, rh)
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.15)' : '#e2e8f0'
    ctx.lineWidth = 1
    ctx.strokeRect(x0 + 0.5, ry + 0.5, w - 1, rh - 1)

    const maxCount = counts.reduce((m, n) => (n > m ? n : m), 0)
    if (maxCount > 0) {
      const bw = w / counts.length
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.25)' : '#cbd5e1'
      counts.forEach((n, b) => {
        if (!n) return
        // Square root, as the timeline's strip: one busy hour would otherwise
        // flatten the rest of the record to nothing.
        const bh = Math.max(1, (rh - 4) * Math.sqrt(n / maxCount))
        ctx.fillRect(x0 + b * bw, ry + rh - 2 - bh, Math.max(1, bw), bh)
      })
    }

    const wx0 = x0 + Math.max(0, Math.min(1, (view.lo - bounds.lo) / full)) * w
    const wx1 = x0 + Math.max(0, Math.min(1, (view.hi - bounds.lo) / full)) * w
    ctx.fillStyle = 'rgba(15,23,42,.10)'
    ctx.fillRect(x0, ry, Math.max(0, wx0 - x0), rh)
    ctx.fillRect(wx1, ry, Math.max(0, x0 + w - wx1), rh)
    ctx.fillStyle = 'rgba(37,99,235,.08)'
    ctx.fillRect(wx0, ry, Math.max(1, wx1 - wx0), rh)
    ctx.strokeStyle = '#2563eb'
    ctx.strokeRect(wx0 + 0.5, ry + 0.5, Math.max(1, wx1 - wx0) - 1, rh - 1)
    ctx.fillStyle = '#2563eb'
    for (const hx of [wx0, wx1]) ctx.fillRect(hx - 1.5, ry + rh / 2 - 7, 3, 14)

    rangeRef.current = { x0, x1: x0 + w, y0: ry, y1: ry + rh, win: { x0: wx0, x1: wx1 } }
  }, [width, bounds, view, counts, dark])

  const local = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e)
    const r = rangeRef.current
    const hit = hitRange(r, x, y)
    if (!hit || !r) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (hit === 'jump') {
      onViewChange(windowFromRangeJump(r, x, view, bounds))
      dragRef.current = { mode: 'move', grab: (r.win.x1 - r.win.x0) / 2 }
    } else {
      dragRef.current = { mode: hit, grab: x - r.win.x0 }
    }
  }, [view, bounds, onViewChange])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e)
    const drag = dragRef.current
    if (drag && rangeRef.current) {
      onViewChange(windowFromRangeGrab(drag.mode, rangeRef.current, x, drag.grab, view, bounds))
      return
    }
    setCursor(hitRange(rangeRef.current, x, y))
  }, [view, bounds, onViewChange])

  return (
    <div ref={boxRef} className="shrink-0 border-t">
      <canvas
        ref={canvasRef}
        role="slider"
        aria-label={t('patient_data.datatable_range')}
        aria-valuemin={bounds.lo}
        aria-valuemax={bounds.hi}
        aria-valuenow={view.lo}
        className="block touch-none"
        style={{ cursor: cursor ? CURSORS[cursor] : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragRef.current = null }}
        onPointerLeave={() => { if (!dragRef.current) setCursor(null) }}
      />
    </div>
  )
}
