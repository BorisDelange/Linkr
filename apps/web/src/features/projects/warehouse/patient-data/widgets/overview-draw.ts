import { medianGapPx, MIN_GAP_PX, FEW_EVENTS, type OverviewRow } from './overview-layout'
import { shade, type OverviewEvent, type Mark as EventMark } from './event-marks'
import { type UnitStay, type OverviewDensity, UNIT_PALETTE, RANGE_H, clamp, stableColour } from './overview-helpers'

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** A drawn event's hit box, plus the unit lane's own — which only this widget has. */
export type Mark = EventMark & { unit?: UnitStay }

export interface LayoutRow {
  y: number
  rowH: number
  row: OverviewRow
  marks: Mark[] | null
  counts: Float64Array | null
  level: 'density' | 'events'
  nb: number
  bw: number
  plotL: number
  clipped: boolean
}

export interface BarHit {
  key: string
  trackY: number
  trackH: number
  thumbY: number
  thumbH: number
  x0: number
  x1: number
  max: number
}

export interface RangeGeom {
  x0: number
  x1: number
  y0: number
  y1: number
  win: { x0: number; x1: number }
}

export type DragState =
  | { kind: 'zoom'; x0: number; x1: number; moved: boolean }
  | { kind: 'bar'; bar: BarHit; grab: number }
  | { kind: 'range'; mode: 'lo' | 'hi' | 'move'; grab: number }

/** Would these events be legible drawn individually, or do the marks collide? */
export function fitsIndividually(events: OverviewEvent[], plotW: number, span: number): boolean {
  if (events.length === 0) return true
  if (events.length <= FEW_EVENTS) return true
  return medianGapPx(events.map((e) => e.start), plotW, span) >= MIN_GAP_PX
}

/** Events per pixel column; a span counts in every column it covers. */
export function binEvents(events: OverviewEvent[], nb: number, lo: number, span: number): Float64Array {
  const counts = new Float64Array(nb)
  for (const e of events) {
    const b0 = clamp(Math.floor(((e.start - lo) / span) * nb), 0, nb - 1)
    const b1 = clamp(Math.floor((((e.end ?? e.start) - lo) / span) * nb), 0, nb - 1)
    for (let k = b0; k <= b1; k++) counts[k]++
  }
  return counts
}

export function drawDensity(
  ctx: CanvasRenderingContext2D,
  counts: Float64Array,
  y: number,
  rowH: number,
  plotL: number,
  bw: number,
  colour: string,
): void {
  let maxC = 0
  for (const c of counts) if (c > maxC) maxC = c
  if (maxC === 0) return
  const barH = Math.max(3, Math.min(rowH - 8, 10))
  const barY = y + (rowH - barH) / 2
  for (let b = 0; b < counts.length; b++) {
    if (!counts[b]) continue
    ctx.fillStyle = shade(colour, 0.2 + 0.8 * Math.sqrt(counts[b] / maxC))
    ctx.fillRect(plotL + b * bw, barY, Math.max(1.2, bw), barH)
  }
}

export function drawUnits(
  ctx: CanvasRenderingContext2D,
  units: UnitStay[],
  y: number,
  rowH: number,
  plotL: number,
  plotW: number,
  x: (ms: number) => number,
  muted: boolean,
): Mark[] {
  const marks: Mark[] = []
  if (muted) return marks
  const barH = Math.max(6, Math.min(rowH - 6, 16))
  const barY = y + (rowH - barH) / 2
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `${Math.min(10, barH - 4)}px Inter, system-ui`

  for (const u of units) {
    const a = x(u.start)
    const b = x(u.end ?? u.start)
    const w = Math.max(2, b - a)
    if (b < plotL || a > plotL + plotW) continue
    // Colour by the standard category, label by the ward: two ICU wards read as
    // the same kind of place while keeping their own names.
    ctx.fillStyle = stableColour(u.category || u.name, UNIT_PALETTE)
    ctx.fillRect(a, barY, w, barH)
    const room = w - 6
    if (room > 24) {
      let s = u.name
      if (ctx.measureText(s).width > room) {
        while (s.length > 1 && ctx.measureText(`${s}…`).width > room) s = s.slice(0, -1)
        s += '…'
      }
      ctx.fillStyle = '#fff'
      ctx.fillText(s, a + 3, barY + barH / 2)
    }
    marks.push({
      x0: Math.max(plotL, a),
      x1: Math.min(plotL + plotW, a + w),
      y0: barY,
      y1: barY + barH,
      unit: u,
    })
  }
  return marks
}

export function drawRangeSelector(
  ctx: CanvasRenderingContext2D,
  top: number,
  plotL: number,
  plotW: number,
  bounds: { lo: number; hi: number },
  view: { lo: number; hi: number },
  death: number | null,
  showDeath: boolean,
  overview: OverviewDensity | null,
): RangeGeom {
  const full = bounds.hi - bounds.lo || 1
  const y = top + 6
  const h = RANGE_H - 14

  ctx.fillStyle = 'rgba(148,163,184,0.10)'
  ctx.fillRect(plotL, y, plotW, h)
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.strokeRect(plotL + 0.5, y + 0.5, plotW - 1, h - 1)

  // The whole record's density, so the strip shows WHERE the data is: the
  // admissions stand out as blocks, which is what you aim the window at. An
  // empty frame gives nothing to navigate by.
  if (overview && overview.max > 0) {
    const bw = plotW / overview.counts.length
    ctx.fillStyle = '#cbd5e1'
    for (let b = 0; b < overview.counts.length; b++) {
      const n = overview.counts[b]
      if (!n) continue
      const bh = Math.max(1, (h - 4) * Math.sqrt(n / overview.max))
      ctx.fillRect(plotL + b * bw, y + h - 2 - bh, Math.max(1, bw), bh)
    }
  }

  if (showDeath && death != null) {
    const dx = plotL + ((death - bounds.lo) / full) * plotW
    ctx.strokeStyle = '#dc2626'
    ctx.beginPath()
    ctx.moveTo(dx, y)
    ctx.lineTo(dx, y + h)
    ctx.stroke()
  }

  const wx0 = plotL + ((view.lo - bounds.lo) / full) * plotW
  const wx1 = plotL + ((view.hi - bounds.lo) / full) * plotW
  ctx.fillStyle = 'rgba(15,23,42,.10)'
  ctx.fillRect(plotL, y, Math.max(0, wx0 - plotL), h)
  ctx.fillRect(Math.min(wx1, plotL + plotW), y, Math.max(0, plotL + plotW - wx1), h)

  ctx.fillStyle = 'rgba(37,99,235,.08)'
  ctx.fillRect(wx0, y, Math.max(1, wx1 - wx0), h)
  ctx.strokeStyle = '#2563eb'
  ctx.strokeRect(wx0 + 0.5, y + 0.5, Math.max(1, wx1 - wx0) - 1, h - 1)
  ctx.fillStyle = '#2563eb'
  for (const hx of [wx0, wx1]) ctx.fillRect(hx - 1.5, y + h / 2 - 7, 3, 14)

  return { x0: plotL, x1: plotL + plotW, y0: y, y1: y + h, win: { x0: wx0, x1: wx1 } }
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
