import { describe, it, expect } from 'vitest'
import { applyRules, maxAcceptableRun, minAcceptableCrossings } from './spc-rules'
import type { ChartPoint } from './spc-types'

/** Points around a centre of 0, with wide limits so only runs rules can fire. */
function series(values: number[], opts: { centre?: number; ucl?: number; lcl?: number } = {}): ChartPoint[] {
  const centre = opts.centre ?? 0
  return values.map((value, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    value,
    numerator: value,
    denominator: 1,
    centre,
    ucl: opts.ucl ?? 1000,
    lcl: opts.lcl ?? -1000,
    signals: [],
    baseline: true,
  }))
}

describe('Anhøj thresholds', () => {
  it('scales the acceptable run length with series length', () => {
    // round(log2(n)) + 3 — verified against the published table.
    expect(maxAcceptableRun(10)).toBe(6)
    expect(maxAcceptableRun(20)).toBe(7)
    expect(maxAcceptableRun(30)).toBe(8)
    expect(maxAcceptableRun(50)).toBe(9)
  })

  it('demands more crossings from a longer series', () => {
    expect(minAcceptableCrossings(20)).toBe(5)
    expect(minAcceptableCrossings(30)).toBe(10)
    expect(minAcceptableCrossings(50)).toBe(18)
  })

  it('asks nothing of a series too short to judge', () => {
    expect(minAcceptableCrossings(2)).toBe(0)
    expect(maxAcceptableRun(1)).toBe(Infinity)
  })
})

describe('out-of-limit detection', () => {
  it('flags a point beyond either limit whatever the rule set', () => {
    const pts = applyRules(series([0, 0, 5, 0, -5], { ucl: 3, lcl: -3 }), { ruleSet: 'none' })
    expect(pts[2].signals).toContain('beyond-limits')
    expect(pts[4].signals).toContain('beyond-limits')
    expect(pts[0].signals).toEqual([])
  })

  it('treats a point exactly on the limit as in control', () => {
    const pts = applyRules(series([3], { ucl: 3, lcl: -3 }), { ruleSet: 'none' })
    expect(pts[0].signals).toEqual([])
  })

  it('ignores a null limit instead of comparing against it', () => {
    const pts = series([100])
    pts[0].ucl = null
    applyRules(pts, { ruleSet: 'none' })
    expect(pts[0].signals).toEqual([])
  })
})

describe('run rule', () => {
  it('flags a run longer than the threshold', () => {
    // 12 points, threshold round(log2(12)) + 3 = 7: a run of 8 must signal.
    const pts = applyRules(series([1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1]), { ruleSet: 'anhoj' })
    expect(pts[0].signals).toContain('shift')
    expect(pts[7].signals).toContain('shift')
    expect(pts[8].signals).not.toContain('shift')
  })

  it('leaves a run at the threshold alone', () => {
    const pts = applyRules(series([1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]), { ruleSet: 'anhoj' })
    expect(pts[0].signals).not.toContain('shift')
  })

  it('does not let a point on the centre line break or extend a run', () => {
    // The zero carries no side, so the 1s around it form one run of 8, which is
    // over the threshold of 7 and signals — while the zero itself is not part of
    // it. (Every point also carries `few-crossings` here: one crossing in 12
    // points is its own signal, and a series-wide one.)
    const pts = applyRules(series([1, 1, 1, 1, 0, 1, 1, 1, 1, -1, -1, -1]), { ruleSet: 'anhoj' })
    expect(pts[0].signals).toContain('shift')
    expect(pts[4].signals).not.toContain('shift')
  })
})

describe('crossings rule', () => {
  it('flags a series that wanders on one side too long', () => {
    // 20 points, two long excursions: only one crossing where 5 are expected.
    const values = [...Array(10).fill(1), ...Array(10).fill(-1)]
    const pts = applyRules(series(values), { ruleSet: 'anhoj' })
    expect(pts[0].signals).toContain('few-crossings')
  })

  it('leaves a series that oscillates freely alone', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1))
    const pts = applyRules(series(values), { ruleSet: 'anhoj' })
    expect(pts.every(p => !p.signals.includes('few-crossings'))).toBe(true)
  })
})

describe('fixed rule set', () => {
  it('flags a monotone trend of the configured length', () => {
    const pts = applyRules(series([1, 2, 3, 4, 5, 6, 5, 4]), { ruleSet: 'fixed', runLength: 6 })
    expect(pts[0].signals).toContain('trend')
    expect(pts[5].signals).toContain('trend')
  })

  it('does not flag a trend broken by a repeat — monotone means strict', () => {
    const pts = applyRules(series([1, 2, 3, 3, 4, 5, 6, 7]), { ruleSet: 'fixed', runLength: 6 })
    expect(pts[0].signals).not.toContain('trend')
  })

  it('applies the configured run length rather than the Anhøj threshold', () => {
    // A run of 6 signals under `fixed` with runLength 6, but not under `anhoj`
    // for a 12-point series (threshold 7).
    const values = [1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1]
    expect(applyRules(series(values), { ruleSet: 'fixed', runLength: 6 })[0].signals).toContain('shift')
    expect(applyRules(series(values), { ruleSet: 'anhoj' })[0].signals).not.toContain('shift')
  })
})

describe('rule set selection', () => {
  it('none disables runs rules but keeps out-of-limit detection', () => {
    const values = [...Array(10).fill(1), ...Array(10).fill(-1)]
    const pts = applyRules(series(values, { ucl: 0.5, lcl: -0.5 }), { ruleSet: 'none' })
    expect(pts.every(p => !p.signals.includes('shift'))).toBe(true)
    expect(pts[0].signals).toContain('beyond-limits')
  })

  it('accumulates several reasons on one point', () => {
    const values = [...Array(10).fill(5), ...Array(10).fill(-1)]
    const pts = applyRules(series(values, { ucl: 3, lcl: -3 }), { ruleSet: 'anhoj' })
    expect(pts[0].signals).toContain('beyond-limits')
    expect(pts[0].signals).toContain('shift')
  })
})
