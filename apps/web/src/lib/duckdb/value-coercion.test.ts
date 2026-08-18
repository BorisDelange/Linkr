import { describe, it, expect } from 'vitest'
import { toMs, toDate } from './value-coercion'

/**
 * The same timestamp reaches a widget in four different shapes depending on
 * whether the query ran in DuckDB-WASM (Arrow) or on the server (JSON). Getting
 * one of them wrong shifts a whole timeline silently, so each shape is pinned.
 */
describe('toMs', () => {
  const expected = Date.UTC(2138, 10, 21, 22, 32, 0)

  it('accepts a Date', () => {
    expect(toMs(new Date(expected))).toBe(expected)
  })

  it('accepts Arrow BigInt microseconds', () => {
    expect(toMs(BigInt(expected) * 1000n)).toBe(expected)
  })

  it('accepts epoch milliseconds', () => {
    expect(toMs(expected)).toBe(expected)
  })

  it('accepts an ISO string', () => {
    expect(toMs('2138-11-21T22:32:00.000Z')).toBe(expected)
  })

  it('accepts DuckDB\'s space-separated form', () => {
    // Parsed as local time, like `new Date('2138-11-21T22:32:00')` — the point is
    // that it parses at all rather than returning NaN as it does in Safari.
    const ms = toMs('2138-11-21 22:32:00')
    expect(ms).not.toBeNull()
    const d = new Date(ms as number)
    expect(d.getFullYear()).toBe(2138)
    expect(d.getMonth()).toBe(10)
    expect(d.getDate()).toBe(21)
  })

  it('returns null rather than a bogus date for unusable values', () => {
    expect(toMs(null)).toBeNull()
    expect(toMs(undefined)).toBeNull()
    expect(toMs('')).toBeNull()
    expect(toMs('   ')).toBeNull()
    expect(toMs('not a date')).toBeNull()
    expect(toMs(new Date('nope'))).toBeNull()
    expect(toMs(Number.NaN)).toBeNull()
  })
})

describe('toDate', () => {
  it('falls back to the epoch, never to an Invalid Date', () => {
    expect(toDate('not a date').getTime()).toBe(0)
    expect(Number.isNaN(toDate(null).getTime())).toBe(false)
  })
})
