/**
 * Reads each point's signals as NHS "Making Data Count" variation: common cause,
 * or special cause that is an improvement, a concern, or — when the indicator has
 * no good direction — neither.
 *
 * Presentation only: the signals themselves come from spc-rules.ts (and its
 * server port), so this needs no Python twin.
 */

import type { ChartPoint } from './spc-types'

/** Which way the indicator gets better. `none` for one with no good direction. */
export type ImprovementDirection = 'none' | 'up' | 'down'

export type Variation = 'common' | 'improvement' | 'concern' | 'special'

/**
 * Direction of the special cause behind a point: +1 high, -1 low, 0 none.
 *
 * `few-crossings` is ignored on purpose: it is a property of the whole series,
 * flagged on every point, so colouring by it would paint the entire chart.
 */
function signalSide(points: ChartPoint[], i: number): number {
  const p = points[i]
  if (p.signals.includes('beyond-limits')) return p.ucl !== null && p.value > p.ucl ? 1 : -1
  if (p.signals.includes('shift')) return Math.sign(p.value - p.centre)
  if (p.signals.includes('trend')) {
    const next = points[i + 1]
    if (next?.signals.includes('trend')) return Math.sign(next.value - p.value)
    const prev = points[i - 1]
    return prev ? Math.sign(p.value - prev.value) : 0
  }
  return 0
}

export function classifyVariation(points: ChartPoint[], direction: ImprovementDirection): Variation[] {
  return points.map((_, i) => {
    const side = signalSide(points, i)
    if (side === 0) return 'common'
    if (direction === 'none') return 'special'
    return (side > 0) === (direction === 'up') ? 'improvement' : 'concern'
  })
}

/** True when the series as a whole crosses its centre line too rarely. */
export function hasFewCrossings(points: ChartPoint[]): boolean {
  return points.some(p => p.signals.includes('few-crossings'))
}
