/**
 * Canvas drawing shared by the patient overview and the timeline.
 *
 * The overview already drew the three shapes a clinical record needs — a block
 * for something that lasts, a line for a measurement, a dot for everything else
 * — so the timeline's mixed mode reuses this rather than growing a second,
 * slightly different renderer. Shape follows the DATA, never the table it came
 * from: see `eventShape`.
 */

/** One event on a row. */
export interface OverviewEvent {
  start: number
  end: number | null
  value: number | null
  text: string | null
  /** Only meaningful on a class/domain row, where several concepts share a row. */
  conceptId: string | null
  /** Administration route, when mapped — decides whether a rate is meaningful. */
  route: string | null
}

/** A hit-testable box on the canvas, so the pointer can name what it is over. */
export interface Mark {
  x0: number
  x1: number
  y0: number
  y1: number
  event?: OverviewEvent
  /** Events drawn at the same spot, when the mark stands for more than one. */
  merged?: OverviewEvent[]
}

export type EventShape = 'blocks' | 'line' | 'dots'

/**
 * The shape a set of events takes.
 *
 * A duration is a block, a numeric series with enough points to connect is a
 * line, anything else is a dot. `mixed` forces dots: a row holding several
 * concepts has no single y scale to plot against.
 */
export function eventShape(events: OverviewEvent[], mixed: boolean): EventShape {
  if (events.some((e) => e.end != null)) return 'blocks'
  const numeric = events.filter((e) => e.value != null).length
  return !mixed && numeric >= 2 ? 'line' : 'dots'
}

/** Mix a hex colour towards white: `t` of 1 keeps it, 0 makes it white. */
export function shade(hex: string, t: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const k = Math.min(1, Math.max(0, t))
  return `rgb(${Math.round(255 - (255 - r) * k)},${Math.round(255 - (255 - g) * k)},${Math.round(255 - (255 - b) * k)})`
}

export interface DrawEventsOptions {
  ctx: CanvasRenderingContext2D
  events: OverviewEvent[]
  /** True when the row holds more than one concept, so no value line is drawn. */
  mixed: boolean
  y: number
  rowH: number
  plotL: number
  plotW: number
  /** Maps a timestamp to a canvas x. */
  x: (ms: number) => number
  colour: string
}

/**
 * Draw one row of events and return their hit boxes.
 *
 * Extracted verbatim from the overview widget so both callers stay pixel-identical;
 * the comments explain the parts that look arbitrary but are not.
 */
export function drawEventRow({
  ctx,
  events,
  mixed,
  y,
  rowH,
  plotL,
  plotW,
  x,
  colour,
}: DrawEventsOptions): Mark[] {
  const marks: Mark[] = []
  const mid = y + rowH / 2
  const plotR = plotL + plotW
  const shape = eventShape(events, mixed)
  const nums = events.filter((e) => e.value != null)

  if (shape === 'blocks') {
    const barH = Math.max(5, Math.min(rowH - 7, 14))
    const barY = y + (rowH - barH) / 2
    ctx.fillStyle = shade(colour, 0.75)
    for (const e of events) {
      const a = x(e.start)
      const b = e.end != null ? x(e.end) : a
      const w = Math.max(3, b - a)
      ctx.fillRect(a, barY, w, barH)
      marks.push({ x0: Math.max(plotL, a), x1: Math.min(plotR, a + w), y0: barY, y1: barY + barH, event: e })
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    for (const m of marks) {
      if (m.x1 - m.x0 > 4) ctx.strokeRect(m.x0 + 0.5, m.y0 + 0.5, m.x1 - m.x0 - 1, m.y1 - m.y0 - 1)
    }
    return marks
  }

  if (shape === 'line') {
    let vLo = Infinity
    let vHi = -Infinity
    for (const e of nums) {
      const v = e.value as number
      if (v < vLo) vLo = v
      if (v > vHi) vHi = v
    }
    const flat = !(vHi > vLo)
    const pad = 4
    const yFor = (v: number) =>
      flat ? mid : y + rowH - pad - ((v - vLo) / (vHi - vLo)) * (rowH - 2 * pad)

    ctx.strokeStyle = shade(colour, 0.55)
    ctx.lineWidth = 1.25
    ctx.beginPath()
    nums.forEach((e, i) => {
      const px = x(e.start)
      const py = yFor(e.value as number)
      if (i) ctx.lineTo(px, py)
      else ctx.moveTo(px, py)
    })
    ctx.stroke()

    // Points only where they can be told apart. The gate is the distance to the
    // previous drawn point, not the row's average spacing: events cluster, so an
    // average taken over a long quiet stretch hides every point in the busy one.
    const r = rowH >= 26 ? 2.5 : 2
    ctx.fillStyle = shade(colour, 1)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    let lastPx = -Infinity
    for (const e of nums) {
      const px = x(e.start)
      if (px - lastPx < 2 * r + 1) continue
      lastPx = px
      ctx.beginPath()
      ctx.arc(px, yFor(e.value as number), r, 0, Math.PI * 2)
      ctx.fill()
      // A white rim, or a point sitting on its own line is invisible.
      ctx.stroke()
    }
    // Hit boxes exist whether or not the point was drawn: the value is still
    // there to be read, and the line is what the pointer is aiming at.
    for (const e of nums) {
      const px = x(e.start)
      const py = yFor(e.value as number)
      marks.push({ x0: px - 4, x1: px + 4, y0: py - 5, y1: py + 5, event: e })
    }
    return marks
  }

  const r = Math.max(2.5, Math.min(4, (rowH - 8) / 3))
  ctx.fillStyle = shade(colour, 0.85)
  // Dots closer together than their own diameter paint on top of each other, so
  // they become one mark carrying every event under it — otherwise the tooltip
  // reports whichever one happened to be last in the array.
  // Capped: each merge pushes x1 further right, so on a dense row one mark would
  // keep swallowing its neighbours and end up spanning the plot — the whole row
  // becoming a single hit-target reporting hundreds of events.
  const MAX_MARK_W = 6 * r
  let last: Mark | null = null
  for (const e of events) {
    const px = x(e.start)
    if (last && px - last.x1 <= 0 && px + r + 2 - last.x0 <= MAX_MARK_W) {
      last.x1 = px + r + 2
      last.merged?.push(e)
      continue
    }
    ctx.beginPath()
    ctx.arc(px, mid, r, 0, Math.PI * 2)
    ctx.fill()
    last = { x0: px - r - 2, x1: px + r + 2, y0: mid - r - 2, y1: mid + r + 2, event: e, merged: [e] }
    marks.push(last)
  }
  return marks
}
