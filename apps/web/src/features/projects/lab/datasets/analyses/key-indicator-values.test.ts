import { describe, it, expect } from 'vitest'
import { anyRowProportion, computeKpiValue, kpiTrendDelta } from './key-indicator-values'

const opts = { columnId: 'kind', uniqueAggregation: 'any', aggregate: 'proportion', targetValue: 'BSI', excludeNA: false }

describe('anyRowProportion', () => {
  const rows = [
    { pid: 1, kind: 'BSI' },
    { pid: 1, kind: 'UTI' },
    { pid: 2, kind: 'UTI' },
    { pid: 3, kind: null },
    { pid: null, kind: 'BSI' },
  ]

  it('counts an entity once when any of its rows holds the target', () => {
    expect(anyRowProportion(rows, { ...opts, uniquePerId: 'pid' })).toEqual({
      result: (1 / 3) * 100, n: 3, matchCount: 1, resolvedTarget: 'BSI',
    })
  })

  it('keeps entities with no value in the denominator', () => {
    expect(anyRowProportion([{ pid: 1, kind: '' }, { pid: 2, kind: 'BSI' }], { ...opts, uniquePerId: 'pid' })?.n).toBe(2)
  })

  it('treats any non-empty value as a match without a target', () => {
    const res = anyRowProportion(rows, { ...opts, targetValue: '', uniquePerId: 'pid' })
    expect(res).toMatchObject({ matchCount: 2, n: 3, resolvedTarget: '' })
  })

  it('is null when no row has an entity id', () => {
    expect(anyRowProportion([{ pid: null, kind: 'BSI' }], { ...opts, uniquePerId: 'pid' })).toBeNull()
  })

  it('is what computeKpiValue uses for "any" with a unique-per column', () => {
    expect(computeKpiValue(rows, { ...opts, uniquePerId: 'pid' })).toBeCloseTo(100 / 3)
  })
})

describe('kpiTrendDelta', () => {
  it('reports a proportion in percentage points', () => {
    expect(kpiTrendDelta(25, 20, true)).toBe(5)
  })

  it('reports other values as a relative change', () => {
    expect(kpiTrendDelta(25, 20, false)).toBe(25)
    expect(kpiTrendDelta(-15, -10, false)).toBe(-50)
  })

  it('is null when the previous value is 0, unless a proportion', () => {
    expect(kpiTrendDelta(5, 0, false)).toBeNull()
    expect(kpiTrendDelta(5, 0, true)).toBe(5)
  })

  it('is null when either side is missing', () => {
    expect(kpiTrendDelta(null, 3, false)).toBeNull()
    expect(kpiTrendDelta(3, null, true)).toBeNull()
  })
})
