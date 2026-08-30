import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { drawEventRow, type OverviewEvent, type Mark } from './event-marks'
import { fmtEventValue, fmtEventWhen } from './event-format'
import { looksLikeDrugName, shortenDrugName } from './overview-layout'
import {
  axisTicks,
  isFullWindow,
  panWindow,
  windowFromRangeDrag,
  zoomWindow,
  type TimeWindow,
} from './timeline-view'

/** One concept's events, in the order the query returned them. */
export interface TimelineSeries {
  conceptId: number
  name: string
  colour: string
  /**
   * Unit of measure, when the concept was charted in exactly one. Null when the
   * schema maps none OR when the concept mixes units — a drug recorded in both
   * mg and mL — where showing either would be confidently wrong.
   */
  unit: string | null
  events: OverviewEvent[]
}

interface TimelineCanvasProps {
  series: TimelineSeries[]
  /** Full extent of the record; the view can never leave it. */
  bounds: TimeWindow
  view: TimeWindow
  onViewChange: (next: TimeWindow) => void
  /** Locale for the axis labels. */
  locale: string
}

const GUTTER = 128
const AXIS_H = 18
const RANGE_H = 34
const ROW_MIN = 22
const PAD_R = 10

/** Format an axis tick: a clock time when the window is short, a date otherwise. */
function formatTick(ms: number, withClock: boolean, locale: string): string {
  const d = new Date(ms)
  return withClock
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
}

/**
 * The mixed-shape timeline: one row per concept, drawn with the overview's own
 * marks — a line for a measurement, dots for a categorical series, blocks for
 * anything that lasts.
 *
 * Used instead of Dygraph whenever the selection holds something Dygraph cannot
 * draw. It has to bring its own zoom, pan and range selector, since those are
 * the things Dygraph was giving for free.
 */
export function TimelineCanvas({ series, bounds, view, onViewChange, locale }: TimelineCanvasProps) {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const marksRef = useRef<{ row: number; marks: Mark[] }[]>([])
  const [hover, setHover] = useState<{
    x: number
    y: number
    title: string
    /** The figure, given its own line so it reads as the answer. */
    value: string | null
    lines: string[]
  } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      // A hidden tab measures 0; keeping the last real size avoids a repaint at
      // zero and another one on return.
      if (w === 0 || h === 0) return
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const plotL = GUTTER
  const plotW = Math.max(40, size.w - GUTTER - PAD_R)
  const chartH = Math.max(ROW_MIN, size.h - AXIS_H - RANGE_H)
  const rowH = series.length > 0 ? Math.max(ROW_MIN, chartH / series.length) : ROW_MIN

  const xFor = useCallback(
    (ms: number) => plotL + ((ms - view.lo) / (view.hi - view.lo || 1)) * plotW,
    [plotL, plotW, view],
  )

  // Paint. Everything is redrawn each time: the row count is small and the marks
  // have to be rebuilt anyway for hit-testing.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const dark = document.documentElement.classList.contains('dark')
    const gridColour = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'
    const textColour = dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)'

    // Axis ticks, drawn behind the rows.
    const spanHours = (view.hi - view.lo) / 3600_000
    const ticks = axisTicks(view, Math.max(2, Math.floor(plotW / 90)))
    ctx.font = '10px Inter, system-ui'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    for (const tick of ticks) {
      const x = xFor(tick)
      ctx.strokeStyle = gridColour
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, chartH)
      ctx.stroke()
      ctx.fillStyle = textColour
      ctx.fillText(formatTick(tick, spanHours <= 72, locale), x, chartH + AXIS_H / 2)
    }

    // Rows: label in the gutter, marks in the plot.
    const nextMarks: { row: number; marks: Mark[] }[] = []
    ctx.save()
    series.forEach((s, i) => {
      const y = i * rowH
      ctx.textAlign = 'left'
      ctx.fillStyle = textColour
      ctx.font = '11px Inter, system-ui'
      // An RxNorm-style name leads with the dose — "1000 ML sodium chloride 9
      // MG/ML Injection" — and the gutter truncates from the right, so the one
      // word that identifies the row is the first thing lost. Lead with the
      // substance instead, as the overview does.
      const full = looksLikeDrugName(s.name) ? shortenDrugName(s.name) : s.name
      let label = full
      while (label.length > 1 && ctx.measureText(`${label}…`).width > GUTTER - 14) {
        label = label.slice(0, -1)
      }
      if (label !== full) label += '…'
      ctx.fillText(label, 6, y + rowH / 2)

      // A swatch ties the row to its colour, as the legend used to.
      ctx.fillStyle = s.colour
      ctx.fillRect(GUTTER - 6, y + rowH / 2 - 4, 3, 8)

      ctx.save()
      ctx.beginPath()
      ctx.rect(plotL, y, plotW, rowH)
      ctx.clip()
      const inView = s.events.filter(
        (e) => (e.end ?? e.start) >= view.lo && e.start <= view.hi,
      )
      const marks = drawEventRow({
        ctx,
        events: inView,
        mixed: false,
        y,
        rowH,
        plotL,
        plotW,
        x: xFor,
        colour: s.colour,
      })
      ctx.restore()
      nextMarks.push({ row: i, marks })
    })
    ctx.restore()
    marksRef.current = nextMarks

    // Range selector, drawn like the overview's: a density histogram of the whole
    // record so the strip shows WHERE the data is — an empty frame gives nothing
    // to aim the window at — then the window itself, tinted with a handle at each
    // edge.
    const ry = size.h - RANGE_H + 6
    const rh = RANGE_H - 14
    const full = bounds.hi - bounds.lo || 1
    ctx.fillStyle = 'rgba(148,163,184,0.10)'
    ctx.fillRect(plotL, ry, plotW, rh)
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.15)' : '#e2e8f0'
    ctx.lineWidth = 1
    ctx.strokeRect(plotL + 0.5, ry + 0.5, plotW - 1, rh - 1)

    const buckets = Math.max(1, Math.floor(plotW / 3))
    const counts = new Array<number>(buckets).fill(0)
    for (const s of series) {
      for (const e of s.events) {
        const b = Math.min(buckets - 1, Math.max(0, Math.floor(((e.start - bounds.lo) / full) * buckets)))
        counts[b]++
      }
    }
    const maxCount = counts.reduce((m, n) => (n > m ? n : m), 0)
    if (maxCount > 0) {
      const bw = plotW / buckets
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.25)' : '#cbd5e1'
      for (let b = 0; b < buckets; b++) {
        const n = counts[b]
        if (!n) continue
        // Square root, not linear: one busy hour would otherwise flatten the
        // whole rest of the record to nothing.
        const bh = Math.max(1, (rh - 4) * Math.sqrt(n / maxCount))
        ctx.fillRect(plotL + b * bw, ry + rh - 2 - bh, Math.max(1, bw), bh)
      }
    }

    const wx0 = plotL + ((view.lo - bounds.lo) / full) * plotW
    const wx1 = plotL + ((view.hi - bounds.lo) / full) * plotW
    ctx.fillStyle = 'rgba(15,23,42,.10)'
    ctx.fillRect(plotL, ry, Math.max(0, wx0 - plotL), rh)
    ctx.fillRect(Math.min(wx1, plotL + plotW), ry, Math.max(0, plotL + plotW - wx1), rh)
    ctx.fillStyle = 'rgba(37,99,235,.08)'
    ctx.fillRect(wx0, ry, Math.max(1, wx1 - wx0), rh)
    ctx.strokeStyle = '#2563eb'
    ctx.strokeRect(wx0 + 0.5, ry + 0.5, Math.max(1, wx1 - wx0) - 1, rh - 1)
    ctx.fillStyle = '#2563eb'
    for (const hx of [wx0, wx1]) ctx.fillRect(hx - 1.5, ry + rh / 2 - 7, 3, 14)
  }, [series, size, view, bounds, rowH, chartH, plotL, plotW, xFor, locale])

  // --- Gestures -----------------------------------------------------------

  const dragRef = useRef<
    | { kind: 'pan'; x: number; view: TimeWindow }
    | { kind: 'range'; x0: number; x1: number }
    | null
  >(null)
  const [rangeDrag, setRangeDrag] = useState<{ x0: number; x1: number } | null>(null)
  // Mirrors dragRef for the cursor: a ref cannot be read while rendering.
  const [panning, setPanning] = useState(false)

  const localPoint = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (bounds.hi <= bounds.lo) return
      const { x } = localPoint(e)
      const at = (x - plotL) / plotW
      // Trackpads emit many small deltas; a fixed step per event would make the
      // zoom race away. Scale by the delta but cap it.
      const factor = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.002)))
      onViewChange(zoomWindow(view, bounds, factor, at))
    },
    [view, bounds, plotL, plotW, onViewChange],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const { x, y } = localPoint(e)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      if (y >= size.h - RANGE_H) {
        dragRef.current = { kind: 'range', x0: x, x1: x }
        setRangeDrag({ x0: x, x1: x })
      } else {
        dragRef.current = { kind: 'pan', x, view }
        setPanning(true)
      }
    },
    [size.h, view],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const { x, y } = localPoint(e)
      const drag = dragRef.current

      if (drag?.kind === 'pan') {
        onViewChange(panWindow(drag.view, bounds, x - drag.x, plotW))
        return
      }
      if (drag?.kind === 'range') {
        drag.x1 = x
        setRangeDrag({ x0: drag.x0, x1: x })
        return
      }

      // Hover: name the mark under the pointer.
      const row = Math.floor(y / rowH)
      const entry = marksRef.current.find((m) => m.row === row)
      const s = series[row]
      if (!entry || !s || y > chartH) {
        setHover(null)
        return
      }
      let best: Mark | null = null
      let bestD = Infinity
      for (const m of entry.marks) {
        const d = x < m.x0 ? m.x0 - x : x > m.x1 ? x - m.x1 : 0
        if (d < bestD) {
          bestD = d
          best = m
        }
      }
      if (!best || bestD > 6) {
        setHover(null)
        return
      }
      const ev = best.event
      if (!ev) {
        setHover(null)
        return
      }
      // Same shape as the overview's tooltip: the figure with its unit (and the
      // average rate when something was infused), then when it happened, then
      // the route — which is what tells a drip from a single shot.
      const value = fmtEventValue(ev.value, ev.text, s.unit, ev.start, ev.end)
      const lines = [fmtEventWhen(ev.start, ev.end)]
      if (ev.route) lines.push(ev.route)
      // The labels are bare nouns, so the count is composed here — as the
      // overview does it.
      const count = best.merged?.length ?? 1
      if (count > 1) {
        lines.push(
          `${count} ${t(count === 1 ? 'patient_data.overview_events_one' : 'patient_data.overview_events')}`,
        )
      }
      setHover({ x, y, title: s.name, value, lines })
    },
    [bounds, plotW, onViewChange, rowH, chartH, series, locale, t],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      dragRef.current = null
      setPanning(false)
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      if (drag?.kind === 'range') {
        const next = windowFromRangeDrag(drag.x0, drag.x1, plotL, plotW, bounds)
        // A click on the strip (too short to be a drag) resets to the full record
        // rather than zooming to nothing.
        onViewChange(next ?? bounds)
        setRangeDrag(null)
      }
    },
    [plotL, plotW, bounds, onViewChange],
  )

  const zoomed = !isFullWindow(view, bounds)

  const rangeOverlay = useMemo(() => {
    if (!rangeDrag) return null
    const left = Math.min(rangeDrag.x0, rangeDrag.x1)
    const width = Math.abs(rangeDrag.x1 - rangeDrag.x0)
    return { left, width }
  }, [rangeDrag])

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor: panning ? 'grabbing' : 'crosshair' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        // react-grid-layout would otherwise capture the drag and move the widget.
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      />
      {rangeOverlay && (
        <div
          className="pointer-events-none absolute bg-primary/20"
          style={{
            left: rangeOverlay.left,
            width: rangeOverlay.width,
            bottom: 8,
            height: RANGE_H - 14,
          }}
        />
      )}
      {zoomed && (
        <button
          onClick={() => onViewChange(bounds)}
          className="absolute right-2 top-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {t('patient_data.timeline_reset_zoom')}
        </button>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded border bg-popover px-2 py-1 text-[10px] shadow-md"
          style={{
            left: Math.min(hover.x + 12, Math.max(0, size.w - 180)),
            top: Math.max(0, hover.y - 8),
          }}
        >
          <p className="font-medium">{hover.title}</p>
          {hover.value && <p className="tabular-nums">{hover.value}</p>}
          {hover.lines.map((line, i) => (
            <p key={i} className="text-muted-foreground">{line}</p>
          ))}
        </div>
      )}
    </div>
  )
}
