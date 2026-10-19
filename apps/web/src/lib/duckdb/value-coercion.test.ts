import { describe, it, expect } from 'vitest'
import { util } from 'apache-arrow'
import { toMs, toDate, fromArrowBigNum } from './value-coercion'

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

describe('fromArrowBigNum', () => {
  /** A 128-bit value as Arrow returns it: four little-endian 32-bit words. */
  const int128 = (words: number[]) => util.BN.new(new Uint32Array(words), true)

  it('reads a HUGEINT as its number', () => {
    expect(fromArrowBigNum(int128([15, 0, 0, 0]))).toBe(15)
  })

  it('keeps the sign of a negative value', () => {
    expect(fromArrowBigNum(int128([0xfffffff1, 0xffffffff, 0xffffffff, 0xffffffff]))).toBe(-15)
  })

  it('places the decimal point of a DECIMAL by its scale', () => {
    expect(fromArrowBigNum(int128([12345, 0, 0, 0]), 2)).toBe(123.45)
  })

  /** A signed 128-bit integer as its four words, two's complement. */
  const wordsOf = (n: bigint) => {
    const raw = BigInt.asUintN(128, n)
    return [0, 1, 2, 3].map((i) => Number((raw >> BigInt(32 * i)) & 0xffffffffn))
  }

  it('reads a DECIMAL(38,25) exactly, past the scale Arrow divides by a float power of ten', () => {
    expect(fromArrowBigNum(int128(wordsOf(12345678901234567890123456n)), 25)).toBe(Number('1.2345678901234567890123456'))
  })

  it('keeps the sign of a negative DECIMAL(38,25)', () => {
    expect(fromArrowBigNum(int128(wordsOf(-15n * 10n ** 24n)), 25)).toBe(-1.5)
  })

  it('leaves every other value alone', () => {
    for (const v of [null, undefined, 3, 'x', 10n, new Date(0), { a: 1 }, [1, 2]]) {
      expect(fromArrowBigNum(v)).toBe(v)
    }
  })
})
