import { describe, it, expect } from 'vitest'
import { estimateRemainingMs, type SeedProgress } from './seed-progress'

const progress = (p: Partial<SeedProgress>): SeedProgress => ({
  phase: 'data', label: '', done: 0, total: 0, elapsedMs: 0, ...p,
})

describe('estimateRemainingMs', () => {
  it('extrapolates the remaining time from the units already done', () => {
    // 4 of 10 in 8s → 2s per unit, 6 left.
    expect(estimateRemainingMs(progress({ done: 4, total: 10, elapsedMs: 8000 }))).toBe(12000)
  })

  // The first unit is routinely the slowest (a cold DuckDB, the largest parquet),
  // so predicting from it alone would show a wildly wrong number precisely when
  // the user is most likely to be reading it.
  it('gives no estimate before two units are done', () => {
    expect(estimateRemainingMs(progress({ done: 0, total: 10, elapsedMs: 3000 }))).toBeNull()
    expect(estimateRemainingMs(progress({ done: 1, total: 10, elapsedMs: 3000 }))).toBeNull()
  })

  it('gives no estimate when the total is unknown or already reached', () => {
    expect(estimateRemainingMs(progress({ done: 3, total: 0, elapsedMs: 3000 }))).toBeNull()
    expect(estimateRemainingMs(progress({ done: 10, total: 10, elapsedMs: 9000 }))).toBeNull()
  })
})
