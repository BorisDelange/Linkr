import { describe, expect, it } from 'vitest'
import { clampNextId, formatRangeBound, parseRangeBound, rangeCapacity } from './source-id-range'

/**
 * The cursor and the bounds are stored side by side and can disagree: editing a
 * range moves the bounds and leaves the cursor where the previous range put it.
 * A cursor outside the bounds is therefore stale, not informative - which way it
 * is wrong decides the damage:
 *
 *   below the start -> ids leak into another badge's band, silently
 *   above the end   -> the range reads as exhausted and refuses to assign
 *
 * Only the entries actually allocated can settle it, so they are the authority.
 */

const START = 2_002_000_001
const END = 2_004_000_000

describe('clampNextId', () => {
  describe('with nothing assigned yet', () => {
    it('restarts an empty range whose cursor sits past the end', () => {
      // The reported bug: four badges created 1M-wide, then widened to 2M. The
      // edit left each cursor above its new end, so a range that had never
      // assigned anything reported "Range exhausted: only 0 new IDs assigned".
      expect(clampNextId(END + 1, START, END, null)).toBe(START)
    })

    it('restarts an empty range whose cursor sits below the start', () => {
      expect(clampNextId(2_000_000_001, START, END, null)).toBe(START)
    })

    it('keeps a valid cursor on an empty range', () => {
      expect(clampNextId(START, START, END, null)).toBe(START)
    })
  })

  describe('with ids already assigned', () => {
    it('resumes just past the highest id handed out', () => {
      expect(clampNextId(START, START, END, 2_002_006_782)).toBe(2_002_006_783)
    })

    it('repairs a cursor left below the start by an edit', () => {
      // Cursor from a previous, lower range; entries prove where we really got to.
      expect(clampNextId(2_000_500_000, START, END, 2_002_006_782)).toBe(2_002_006_783)
    })

    it('trusts a cursor ahead of the high-water mark', () => {
      // Ids can be assigned and later deleted, leaving the mark behind the
      // cursor; re-issuing those ids would collide with data already exported.
      expect(clampNextId(2_002_009_000, START, END, 2_002_006_782)).toBe(2_002_009_000)
    })

    it('reports exhausted only when the assigned ids really reach the end', () => {
      expect(clampNextId(END + 1, START, END, END)).toBe(END + 1)
    })

    it('ignores a high-water mark from outside the range', () => {
      // Entries inherited from another badge keep their original id and must not
      // drag this range's cursor with them.
      expect(clampNextId(START, START, END, 2_000_144_638)).toBe(START)
    })
  })

  it('falls back to the start when the cursor is missing or not a number', () => {
    expect(clampNextId(NaN, START, END, null)).toBe(START)
    expect(clampNextId(undefined as unknown as number, START, END, null)).toBe(START)
  })

  it('defaults to the pre-existing behaviour when no high-water mark is given', () => {
    expect(clampNextId(2_000_000_001, START, END)).toBe(START)
  })

  it('never allocates outside the range, whatever the inputs', () => {
    const s = 2_100_000_001
    const e = 2_100_000_010
    const cursors = [0, 1, s - 1, s, e, e + 1, e + 999, NaN]
    const marks = [null, s, e, s + 5, s - 1, e + 1]
    for (const cursor of cursors) {
      for (const mark of marks) {
        const got = clampNextId(cursor, s, e, mark)
        // Either a usable id inside the range, or the exhausted marker.
        expect(got).toBeGreaterThanOrEqual(s)
        expect(got).toBeLessThanOrEqual(e + 1)
        // An empty range must never come back exhausted.
        if (mark == null) expect(got).toBeLessThanOrEqual(e)
      }
    }
  })
})

describe('parseRangeBound', () => {
  it('accepts the grouped form the inputs display', () => {
    expect(parseRangeBound('2 002 000 001')).toBe(2002000001)
    expect(parseRangeBound('2002000001')).toBe(2002000001)
  })

  it('accepts the separators toLocaleString actually emits', () => {
    // Written as escapes on purpose: these are invisible in a source file, and a
    // value copied out of the read-only display carries them verbatim.
    expect(parseRangeBound('2\u00a0002\u00a0000\u00a0001')).toBe(2002000001)
    expect(parseRangeBound('2\u202f002\u202f000\u202f001')).toBe(2002000001)
    expect(parseRangeBound('2,002,000,001')).toBe(2002000001)
  })

  it('rejects anything that is not a plain number', () => {
    // parseInt would take the leading digits and call these valid.
    expect(parseRangeBound('2e9')).toBeNull()
    expect(parseRangeBound('12abc')).toBeNull()
    expect(parseRangeBound('-5')).toBeNull()
    expect(parseRangeBound('')).toBeNull()
    expect(parseRangeBound('   ')).toBeNull()
  })

  it('rejects values past the safe-integer boundary', () => {
    expect(parseRangeBound('99999999999999999999')).toBeNull()
  })
})

describe('formatRangeBound', () => {
  it('groups digits in threes so billions read apart from millions', () => {
    expect(formatRangeBound(2002000001)).toBe('2 002 000 001')
    expect(formatRangeBound('2000000')).toBe('2 000 000')
    expect(formatRangeBound(999)).toBe('999')
  })

  it('formats partial input as it is typed', () => {
    expect(formatRangeBound('2002')).toBe('2 002')
    expect(formatRangeBound('')).toBe('')
  })
})

describe('rangeCapacity', () => {
  it('counts both bounds', () => {
    expect(rangeCapacity(2000000001, 2002000000)).toBe(2000000)
    expect(rangeCapacity(10, 10)).toBe(1)
  })

  it('has nothing to report until the bounds make a range', () => {
    expect(rangeCapacity(null, 100)).toBeNull()
    expect(rangeCapacity(100, null)).toBeNull()
    expect(rangeCapacity(100, 99)).toBeNull()
  })
})
