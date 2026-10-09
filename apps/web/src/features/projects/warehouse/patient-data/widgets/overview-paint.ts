import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import { publishGutter } from '../timeline-sync'
import { rowCacheKey, wantsEvents } from './use-overview-data'
import { bucketMsFor, type OverviewDataCache } from './overview-tiles'
import type { BuildRowsResult, OverviewRow } from './overview-layout'
import { drawEventRow } from './event-marks'
import { rowLabel } from './overview-row-label'
import { GUTTER_MAX, RANGE_H, clamp, fmtAxis, fmtN, unitCount, type OverviewDensity, type UnitStay } from './overview-helpers'
import {
  binEvents,
  drawDensity,
  drawRangeSelector,
  drawUnits,
  fitsIndividually,
  roundRect,
  type BarHit,
  type DragState,
  type LayoutRow,
  type Mark,
  type RangeGeom,
} from './overview-draw'

/** What a paint of the overview reads from the widget: its state, and the refs
 *  it writes the hit-test geometry back into. */
export interface OverviewPaintEnv {
  size: { w: number; h: number }
  layout: BuildRowsResult
  rowH: number
  t: TFunction
  i18n: { language: string }
  units: UnitStay[]
  death: number | null
  overview: OverviewDensity | null
  tableColour: Map<string, string>
  syncTimeRange: boolean
  tabId: string
  showDeath: boolean
  drawRange: boolean
  setPaintedPlotW: Dispatch<SetStateAction<number>>
  hiddenRef: RefObject<Set<string>>
  collapsedRef: RefObject<Set<string>>
  dataRef: RefObject<OverviewDataCache>
  layoutRef: RefObject<LayoutRow[]>
  barsRef: RefObject<BarHit[]>
  dragRef: RefObject<DragState | null>
  rangeRef: RefObject<RangeGeom | null>
}

export function paintOverview(
  ctx: CanvasRenderingContext2D,
  cv: HTMLCanvasElement,
  view: { lo: number; hi: number },
  bounds: { lo: number; hi: number },
  env: OverviewPaintEnv,
) {
  const { size, layout, rowH, t, i18n, units, death, overview, tableColour, syncTimeRange, tabId, showDeath, drawRange, setPaintedPlotW, hiddenRef, collapsedRef, dataRef, layoutRef, barsRef, dragRef, rangeRef } = env
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const w = size.w
  const rows = layout.rows
  // Exactly the wrapper's box. The canvas is stretched to it by CSS
  // (absolute inset-0), so drawing at any other size would scale every pixel
  // and put the marks somewhere other than where the mouse reports them.
  const h = size.h
  if (w < 80 || h < 40) return

  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  // Pin the CSS size too: without it the intrinsic size and the stretched box
  // can disagree, which is exactly what offsets the hit-testing.
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const labelFont = `${Math.min(12, rowH - 6)}px Inter, system-ui`
  const headerFont = `600 ${Math.min(11, rowH - 7)}px Inter, system-ui`
  const metaFont = `${Math.min(10, rowH - 8)}px Inter, system-ui`

  const label = (row: OverviewRow) => rowLabel(row, t)
  const rightText = (row: OverviewRow) =>
    row.kind === 'table' || row.kind === 'units' || row.kind === 'class'
      ? `${fmtN(row.kind === 'units' ? unitCount(units) : row.conceptCount)} ${
          row.kind === 'units' ? t('patient_data.overview_units') : t('patient_data.overview_concepts')
        } · ${fmtN(row.eventCount)}`
      : fmtN(row.eventCount)

  ctx.font = labelFont
  let labelW = 0
  for (const r of rows) labelW = Math.max(labelW, ctx.measureText(label(r)).width)
  ctx.font = metaFont
  let countW = 0
  for (const r of rows) countW = Math.max(countW, ctx.measureText(rightText(r)).width)

  const GAP = 10
  const gutter = Math.min(GUTTER_MAX, 26 + labelW + GAP + countW + GAP)
  const truncateTo = Math.max(40, gutter - 8 - GAP - countW - GAP)
  const plotL = gutter
  const plotW = Math.max(40, w - plotL - 10)
  // Published so synced timelines on this tab can widen to the same origin.
  // Only while synced: a lone overview has no reason to reshape anything, and
  // this gutter follows its own labels, which change as rows fold and unfold.
  if (syncTimeRange) publishGutter(tabId, plotL)
  const lo = view.lo
  const span = view.hi - view.lo || 1
  const x = (ms: number) => plotL + ((ms - lo) / span) * plotW
  const nb = Math.max(40, Math.floor(plotW))
  setPaintedPlotW((prev) => (prev === plotW ? prev : plotW))
  const bucketMs = bucketMsFor(span, plotW)

  const nested = rows.some((r) => r.kind === 'class')
  const newLayout: LayoutRow[] = []

  rows.forEach((row, i) => {
    const y = i * rowH
    if (i % 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.07)'
      ctx.fillRect(plotL, y, plotW, rowH)
    }

    const isUnits = row.kind === 'units'
    const isHeader = row.kind === 'table' || isUnits
    const isClass = row.kind === 'class'
    const muted = hiddenRef.current.has(row.table) || hiddenRef.current.has(row.key)
    const colour = tableColour.get(row.table) ?? '#64748b'

    // A class row carries its own chevron at x=24, so its text must clear it;
    // concepts under a class indent one step further again.
    const indent = isHeader ? 22 : isClass ? 34 : nested ? 40 : 24

    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.font = isHeader || isClass ? headerFont : labelFont

    let text = isHeader && !isUnits ? label(row).toUpperCase() : label(row)
    if (isUnits) text = text.toUpperCase()
    const room = truncateTo - (indent - 8)
    let clipped = false
    if (ctx.measureText(text).width > room) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > room) text = text.slice(0, -1)
      text += '…'
      clipped = true
    }

    if (isUnits) {
      ctx.fillStyle = muted ? '#cbd5e1' : '#0f172a'
    } else if (isHeader || isClass) {
      const cx = isClass ? 24 : 12
      const cy = y + rowH / 2
      const r = isClass ? 3 : 3.5
      const shut = collapsedRef.current.has(isClass ? row.key : row.table)
      ctx.fillStyle = muted ? '#e2e8f0' : isClass ? '#94a3b8' : '#64748b'
      ctx.beginPath()
      if (shut) {
        ctx.moveTo(cx - r, cy - r - 1)
        ctx.lineTo(cx + r, cy)
        ctx.lineTo(cx - r, cy + r + 1)
      } else {
        ctx.moveTo(cx - r - 1, cy - r)
        ctx.lineTo(cx + r + 1, cy - r)
        ctx.lineTo(cx, cy + r)
      }
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = muted ? '#cbd5e1' : isClass ? '#475569' : colour
    } else {
      const stemX = nested ? 32 : 16
      ctx.strokeStyle = '#cbd5e1'
      ctx.beginPath()
      ctx.moveTo(stemX, y)
      ctx.lineTo(stemX, y + rowH / 2)
      ctx.lineTo(stemX + 5, y + rowH / 2)
      ctx.stroke()
      ctx.fillStyle = muted ? '#cbd5e1' : row.kind === 'other' ? '#94a3b8' : '#334155'
    }
    ctx.fillText(text, indent, y + rowH / 2)

    ctx.font = metaFont
    ctx.textAlign = 'right'
    ctx.fillStyle = muted ? '#e2e8f0' : isHeader ? '#64748b' : '#94a3b8'
    ctx.fillText(rightText(row), gutter - GAP, y + rowH / 2)

    ctx.save()
    ctx.beginPath()
    ctx.rect(plotL, y, plotW, rowH)
    ctx.clip()

    let marks: Mark[] | null = null
    let counts: Float64Array | null = null
    let level: 'density' | 'events' = 'density'

    if (isUnits) {
      marks = drawUnits(ctx, units, y, rowH, plotL, plotW, x, muted)
      level = 'events'
    } else if (!muted) {
      const key = rowCacheKey(row)
      const win = row.conceptIds.length > 0 && wantsEvents(row, view, bounds, plotW)
        ? dataRef.current.eventsFor(key, lo, view.hi)
        : null
      const evts = win && !win.truncated ? win.events : null
      const inView = evts?.filter((e) => (e.end ?? e.start) >= lo && e.start <= view.hi) ?? null

      if (inView && fitsIndividually(inView, plotW, span)) {
        marks = drawEventRow({
          ctx,
          events: inView,
          mixed: row.mixed,
          y,
          rowH,
          plotL,
          plotW,
          x,
          colour,
        })
        level = 'events'
      } else {
        // Every event in view is at hand: bin them here. Otherwise the tiles
        // the fetch read for this zoom level, or a coarser one meanwhile.
        counts = inView
          ? binEvents(inView, nb, lo, span)
          : dataRef.current.pixelCounts(key, lo, view.hi, nb, bucketMs) ?? new Float64Array(nb)
        drawDensity(ctx, counts, y, rowH, plotL, plotW / nb, colour)
      }
    }
    ctx.restore()

    newLayout.push({ y, rowH, row, marks, counts, level, nb, bw: plotW / nb, plotL, clipped })
  })

  layoutRef.current = newLayout

  // Per-group scrollbars, in the gutter's left margin.
  const bands = new Map<string, { top: number; bottom: number; table: string }>()
  for (const l of newLayout) {
    if (l.row.kind !== 'concept' && l.row.kind !== 'other') continue
    const b = bands.get(l.row.key) ?? { top: l.y, bottom: l.y + l.rowH, table: l.row.table }
    b.top = Math.min(b.top, l.y)
    b.bottom = Math.max(b.bottom, l.y + l.rowH)
    bands.set(l.row.key, b)
  }
  const bars: BarHit[] = []
  for (const [key, b] of bands) {
    const win = layout.windows.get(key)
    if (!win || win.total <= win.shown) continue
    const off = layout.offsets.get(key) ?? 0
    const trackX = nested ? 15 : 3
    const trackW = 3
    const trackY = b.top + 1
    const trackH = Math.max(8, b.bottom - b.top - 2)
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(trackX, trackY, trackW, trackH)
    const thumbH = Math.max(10, trackH * (win.shown / win.total))
    const thumbY = trackY + (trackH - thumbH) * (off / Math.max(1, win.total - win.shown))
    ctx.fillStyle = tableColour.get(b.table) ?? '#94a3b8'
    ctx.fillRect(trackX, thumbY, trackW, thumbH)
    bars.push({
      key,
      trackY,
      trackH,
      thumbY,
      thumbH,
      x0: trackX - 4,
      x1: trackX + trackW + 5,
      max: win.total - win.shown,
    })
  }
  barsRef.current = bars

  const bodyH = rows.length * rowH

  // Death: a badge rather than bare text, so it can't be read as part of
  // whatever row it crosses.
  if (showDeath && death != null && death >= lo && death <= view.hi) {
    const dx = x(death)
    ctx.save()
    ctx.strokeStyle = '#dc2626'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(dx, 0)
    ctx.lineTo(dx, bodyH)
    ctx.stroke()
    ctx.restore()

    const badge = t('patient_data.overview_death')
    ctx.font = '600 10px Inter, system-ui'
    const tw = ctx.measureText(badge).width
    const bw = tw + 10
    const bh = 15
    const right = dx + 4 + bw > w - 10
    const bx = right ? dx - 4 - bw : dx + 4
    ctx.fillStyle = '#dc2626'
    roundRect(ctx, bx, 2, bw, bh, 4)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(badge, bx + 5, 2 + bh / 2 + 0.5)
  }

  // Time axis
  const axisY = bodyH
  ctx.strokeStyle = '#e2e8f0'
  ctx.beginPath()
  ctx.moveTo(plotL, axisY + 0.5)
  ctx.lineTo(w - 10, axisY + 0.5)
  ctx.stroke()
  ctx.fillStyle = '#64748b'
  ctx.font = '10px Inter, system-ui'
  ctx.textBaseline = 'top'
  const ticks = Math.max(2, Math.min(7, Math.floor(plotW / 110)))
  const withClock = span < 3 * 86_400_000
  // The reader's own language, NOT a hardcoded region: en-GB is a 24-hour
  // locale, so it showed 22:34 where the timelines beside it showed 10:34 PM.
  const locale = i18n.language
  for (let k = 0; k <= ticks; k++) {
    const ms = lo + (span * k) / ticks
    ctx.textAlign = k === 0 ? 'left' : k === ticks ? 'right' : 'center'
    ctx.fillText(fmtAxis(ms, withClock, locale), clamp(x(ms), plotL, w - 10), axisY + 8)
  }

  // Drag-to-zoom overlay
  const d = dragRef.current
  if (d?.kind === 'zoom' && d.moved) {
    ctx.fillStyle = 'rgba(37,99,235,.15)'
    ctx.strokeStyle = 'rgba(37,99,235,.6)'
    const a = Math.min(d.x0, d.x1)
    const b = Math.max(d.x0, d.x1)
    ctx.fillRect(a, 0, b - a, bodyH)
    ctx.strokeRect(a + 0.5, 0.5, b - a - 1, bodyH - 1)
  }

  if (drawRange) {
    // Pinned to the bottom of the widget, not to where the rows happen to
    // end: a short record would otherwise leave it floating mid-card.
    rangeRef.current = drawRangeSelector(
      ctx, h - RANGE_H, plotL, plotW, bounds, view, death, showDeath, overview,
    )
  } else {
    rangeRef.current = null
  }
}
