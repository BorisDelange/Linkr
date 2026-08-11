import { describe, expect, it, vi } from 'vitest'
import {
  mergeTableCounts,
  notifyTableCounts,
  sortedCounts,
  subscribeTableCounts,
} from './table-counts'
import type { DatabaseStatsCache } from '@/types'

describe('sortedCounts', () => {
  it('puts the biggest tables first — how both views read them', () => {
    const counts = new Map([['person', 100], ['measurement', 9000], ['death', 3]])
    expect(sortedCounts(counts).map((t) => t.tableName)).toEqual([
      'measurement', 'person', 'death',
    ])
  })

  it('is empty for a database nobody has counted', () => {
    expect(sortedCounts(new Map())).toEqual([])
  })
})

describe('mergeTableCounts', () => {
  const existing: DatabaseStatsCache = {
    dataSourceId: 'ds1',
    summary: { patientCount: 42, visitCount: 7, visitDetailCount: 1, tableCount: 1 },
    genderDistribution: { male: 20, female: 22, other: 0 },
    agePyramid: [],
    admissionTimeline: [],
    descriptiveStats: { ageMean: 61 },
    tableCounts: [{ tableName: 'person', rowCount: 1 }],
    computedAt: '2026-01-01T00:00:00.000Z',
  }

  it('keeps the clinical figures, which are not ours to write', () => {
    const merged = mergeTableCounts('ds1', existing, new Map([['person', 500]]))
    expect(merged.summary.patientCount).toBe(42)
    expect(merged.descriptiveStats.ageMean).toBe(61)
    expect(merged.genderDistribution.female).toBe(22)
  })

  it('replaces the counts rather than adding to the stale ones', () => {
    const merged = mergeTableCounts('ds1', existing, new Map([['person', 500]]))
    expect(merged.tableCounts).toEqual([{ tableName: 'person', rowCount: 500 }])
  })

  it('claims no zeros when there was no entry at all', () => {
    // A fresh entry must not assert "0 patients": nobody counted them.
    const merged = mergeTableCounts('ds1', undefined, new Map([['person', 5]]))
    expect(merged.summary.patientCount).toBe(0)
    expect(merged.summary.tableCount).toBe(1)
    expect(merged.tableCounts).toEqual([{ tableName: 'person', rowCount: 5 }])
  })

  it('records when it was counted, so a stale figure is recognisable', () => {
    expect(mergeTableCounts('ds1', existing, new Map()).computedAt)
      .not.toBe(existing.computedAt)
  })
})

describe('sharing counts between views', () => {
  it('tells the other view when counts change', () => {
    const seen = vi.fn()
    const off = subscribeTableCounts('ds1', seen)
    notifyTableCounts('ds1')
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('only tells views watching THAT database', () => {
    const seen = vi.fn()
    const off = subscribeTableCounts('ds1', seen)
    notifyTableCounts('ds2')
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('stops calling back once unsubscribed', () => {
    const seen = vi.fn()
    subscribeTableCounts('ds1', seen)()
    notifyTableCounts('ds1')
    expect(seen).not.toHaveBeenCalled()
  })

  it('runs the caller-supplied cleanup alongside the unsubscribe', () => {
    const cleanup = vi.fn()
    subscribeTableCounts('ds1', vi.fn(), cleanup)()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('reaches every view watching the same database', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeTableCounts('ds1', a)
    const offB = subscribeTableCounts('ds1', b)
    notifyTableCounts('ds1')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA(); offB()
  })

  it('notifying with nobody listening is harmless', () => {
    expect(() => notifyTableCounts('nobody')).not.toThrow()
  })
})
