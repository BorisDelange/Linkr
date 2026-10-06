import { describe, it, expect } from 'vitest'
import { classifyVariation, hasFewCrossings } from './spc-variation'
import type { ChartPoint, SignalKind } from './spc-types'

function point(value: number, signals: SignalKind[] = [], limits: { ucl?: number | null; lcl?: number | null } = {}): ChartPoint {
  return {
    date: '2024-01-01',
    value,
    numerator: value,
    denominator: 1,
    centre: 10,
    ucl: limits.ucl === undefined ? 20 : limits.ucl,
    lcl: limits.lcl === undefined ? 0 : limits.lcl,
    signals,
    baseline: true,
  }
}

describe('classifyVariation', () => {
  it('leaves unflagged points as common cause', () => {
    expect(classifyVariation([point(12), point(8)], 'down')).toEqual(['common', 'common'])
  })

  it('reads a point above the upper limit as a concern when lower is better', () => {
    const points = [point(25, ['beyond-limits']), point(-1, ['beyond-limits'])]
    expect(classifyVariation(points, 'down')).toEqual(['concern', 'improvement'])
    expect(classifyVariation(points, 'up')).toEqual(['improvement', 'concern'])
  })

  it('reports special cause without a verdict when the indicator has no direction', () => {
    expect(classifyVariation([point(25, ['beyond-limits'])], 'none')).toEqual(['special'])
  })

  it('takes a shift point by its side of the centre line', () => {
    const points = [point(14, ['shift']), point(6, ['shift'])]
    expect(classifyVariation(points, 'down')).toEqual(['concern', 'improvement'])
  })

  it('takes a trend point by the direction of the trend, not its side of the centre', () => {
    // A rising trend that is still below the centre line is rising all the same.
    const points = [point(2, ['trend']), point(4, ['trend']), point(6, ['trend']), point(12)]
    expect(classifyVariation(points, 'down')).toEqual(['concern', 'concern', 'concern', 'common'])
  })

  it('does not colour points flagged only by the whole-series crossings rule', () => {
    const points = [point(14, ['few-crossings']), point(6, ['few-crossings'])]
    expect(classifyVariation(points, 'down')).toEqual(['common', 'common'])
    expect(hasFewCrossings(points)).toBe(true)
  })

  it('lets beyond-limits decide when a point carries several signals', () => {
    // Below the centre (a shift downwards) yet above the UCL is impossible, so use
    // a low UCL: the limit breach is the stronger evidence and sets the side.
    expect(classifyVariation([point(9, ['beyond-limits', 'shift'], { ucl: 8 })], 'down')).toEqual(['concern'])
  })
})
