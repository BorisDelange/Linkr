/**
 * Where a dated event lands on a control chart's time axis.
 *
 * The x axis is categorical: one slot per plotted point, evenly spaced, each
 * point standing for its whole period. There is no continuous time between two
 * points to place a date in, and drawing an event a third of the way from March
 * to April would claim a precision the chart does not have. So an event snaps to
 * the point whose PERIOD CONTAINS it — the first value that can reflect it.
 *
 * - **Periodic charts** (p, u, c, I-MR, EWMA…): each point is a calendar bucket
 *   starting at its date. The event goes to the bucket holding its day. A bucket
 *   with no point (an empty denominator drops it) passes the event on to the next
 *   plotted point: the first one whose data comes after the event.
 * - **g and t charts**: each point is the interval that ENDS at its date. The
 *   event goes to the first point on or after its day. Before the first point the
 *   interval's start is unknown, so the event is not drawn.
 *
 * An event before the first period or after the last one is not drawn: the axis
 * does not extend past the data, and pinning it to an edge would misdate it.
 */
import { nextPeriod, parseDate } from './spc-aggregate'
import type { ChartType, Period } from './spc-types'

/** The events snapped to one point, in their input order. */
export interface EventMarker<E> {
  /** The `date` of the point the marker is drawn at — the category on the x axis. */
  pointDate: string
  events: E[]
}

export function placeEvents<E extends { date: string }>(
  points: readonly { date: string }[],
  events: readonly E[],
  period: Period,
  chartType: ChartType,
): EventMarker<E>[] {
  if (points.length === 0 || events.length === 0) return []
  const intervals = chartType === 'g' || chartType === 't'
  const starts = points.map(p => parseDate(p.date))

  const byPoint = new Map<number, E[]>()
  for (const event of events) {
    const day = parseDate(event.date)
    if (day === null) continue
    const index = intervals ? intervalIndex(starts, day) : periodIndex(starts, day, period)
    if (index === null) continue
    const list = byPoint.get(index)
    if (list) list.push(event)
    else byPoint.set(index, [event])
  }

  return [...byPoint.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => ({ pointDate: points[index].date, events: list }))
}

function periodIndex(starts: (number | null)[], day: number, period: Period): number | null {
  const first = starts.find((s): s is number => s !== null)
  if (first === undefined || day < first) return null
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    if (start === null) continue
    if (nextPeriod(start, period) > day) return i
  }
  return null
}

function intervalIndex(ends: (number | null)[], day: number): number | null {
  const first = ends.find((s): s is number => s !== null)
  if (first === undefined || day < first) return null
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i]
    if (end !== null && end >= day) return i
  }
  return null
}
