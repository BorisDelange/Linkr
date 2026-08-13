import { describe, expect, it } from 'vitest'
import { clampNextId } from './source-id-range'

/**
 * The cursor and the bounds are stored side by side and can disagree: editing a
 * range moves the bounds and leaves the cursor where the previous range put it.
 * What makes that specifically dangerous is that the assignment loop guards
 * only the upper end, so a cursor below the start is not caught by anything.
 */

describe('clampNextId', () => {
  it('leaves a cursor inside the range alone', () => {
    expect(clampNextId(2_100_500_000, 2_100_000_001, 2_101_000_000)).toBe(2_100_500_000)
  })

  it('accepts a cursor sitting exactly on either bound', () => {
    expect(clampNextId(2_100_000_001, 2_100_000_001, 2_101_000_000)).toBe(2_100_000_001)
    expect(clampNextId(2_101_000_000, 2_100_000_001, 2_101_000_000)).toBe(2_101_000_000)
  })

  it('snaps a cursor below the start up to the start', () => {
    // The reported bug: a badge created before an earlier range kept its
    // cursor, the range was then edited to a higher band, and assignment ran
    // from the old cursor - filling the new range's quota with ids from the
    // old band while reporting success.
    expect(clampNextId(2_002_000_001, 2_100_000_001, 2_101_000_000)).toBe(2_100_000_001)
  })

  it('keeps an exhausted cursor past the end rather than re-issuing ids', () => {
    // end + 1 is the "full" marker; clamping it back inside would hand out ids
    // that were already allocated.
    expect(clampNextId(2_101_000_001, 2_100_000_001, 2_101_000_000)).toBe(2_101_000_001)
  })

  it('caps a cursor far past the end at one-past-the-end', () => {
    expect(clampNextId(2_147_483_647, 2_100_000_001, 2_101_000_000)).toBe(2_101_000_001)
  })

  it('falls back to the start when the cursor is missing or not a number', () => {
    expect(clampNextId(NaN, 2_100_000_001, 2_101_000_000)).toBe(2_100_000_001)
    expect(clampNextId(undefined as unknown as number, 2_100_000_001, 2_101_000_000)).toBe(2_100_000_001)
  })

  it('never returns a value that would allocate outside the range', () => {
    const start = 2_100_000_001
    const end = 2_100_000_010
    for (const cursor of [0, 1, start - 1, start, end, end + 1, end + 999, NaN]) {
      const clamped = clampNextId(cursor, start, end)
      // Either a usable id inside the range, or the exhausted marker.
      expect(clamped >= start).toBe(true)
      expect(clamped <= end + 1).toBe(true)
    }
  })
})
