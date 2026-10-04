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
    expect(toMs('2138-11-21 22:32:00')).toBe(expected)
  })

  it('reads a naive timestamp as UTC whatever the browser\'s zone', () => {
    // The server sends a TIMESTAMP as a naive `.isoformat()`; read as local time
    // it would shift by the offset, unlike the same value from DuckDB-WASM.
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(toMs('2138-11-21T22:32:00')).toBe(expected)
      expect(toMs('2138-11-21T22:32:00.000000')).toBe(expected)
      expect(toMs('2138-11-21T22:32:00+01:00')).toBe(expected - 3_600_000)
    } finally {
      process.env.TZ = tz
    }
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
