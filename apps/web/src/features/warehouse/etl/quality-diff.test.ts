import { describe, expect, it } from 'vitest'
import {
  classifyDiff,
  countByDiff,
  expectedRowsByTarget,
  type ConceptCount,
} from './quality-diff'

describe('classifyDiff', () => {
  it('flags rows that arrived but never mapped', () => {
    // The defect this view exists to find: data is there, the mapping did nothing.
    expect(classifyDiff(500, 0, 500)).toBe('missing')
  })

  it('reports a shortfall', () => {
    expect(classifyDiff(500, 400, 500)).toBe('fewer')
  })

  it('reports a surplus', () => {
    expect(classifyDiff(500, 600, 500)).toBe('more')
  })

  it('reports an exact match', () => {
    expect(classifyDiff(500, 500, 500)).toBe('match')
  })

  it('treats a concept with no source data as a match, not a defect', () => {
    // Nothing arrived, so nothing is missing: flagging it would bury the real
    // problems under every unused mapping in the dictionary.
    expect(classifyDiff(0, 0, 0)).toBe('match')
  })

  it('does not flag a shortfall when nothing was expected', () => {
    expect(classifyDiff(0, 10, 0)).toBe('match')
  })
})

describe('expectedRowsByTarget', () => {
  const counts = new Map<number, ConceptCount>([
    [2_000_000_001, { patients: 3, rows: 100 }],
    [2_000_000_002, { patients: 4, rows: 250 }],
  ])

  it('sums the source rows feeding one target concept', () => {
    // N:1 — two source codes map to the same standard concept, so the target is
    // expected to hold both their rows.
    const totals = expectedRowsByTarget([
      { sourceConceptId: 2_000_000_001, targetConceptId: 3027018 },
      { sourceConceptId: 2_000_000_002, targetConceptId: 3027018 },
    ], counts)
    expect(totals.get(3027018)).toBe(350)
  })

  it('keeps separate targets separate', () => {
    const totals = expectedRowsByTarget([
      { sourceConceptId: 2_000_000_001, targetConceptId: 1 },
      { sourceConceptId: 2_000_000_002, targetConceptId: 2 },
    ], counts)
    expect(totals.get(1)).toBe(100)
    expect(totals.get(2)).toBe(250)
  })

  it('counts an unassigned source concept as zero, not as missing data', () => {
    const totals = expectedRowsByTarget([{ sourceConceptId: 0, targetConceptId: 5 }], counts)
    expect(totals.get(5)).toBe(0)
  })

  it('treats a source concept with no observed rows as zero', () => {
    const totals = expectedRowsByTarget([{ sourceConceptId: 999, targetConceptId: 5 }], counts)
    expect(totals.get(5)).toBe(0)
  })
})

describe('countByDiff', () => {
  it('counts every verdict, including the absent ones', () => {
    const counts = countByDiff([
      { diff: 'match' as const }, { diff: 'match' as const }, { diff: 'missing' as const },
    ])
    expect(counts).toEqual({ match: 2, missing: 1, fewer: 0, more: 0 })
  })

  it('returns all zeros for no rows', () => {
    expect(countByDiff([])).toEqual({ match: 0, missing: 0, fewer: 0, more: 0 })
  })
})
