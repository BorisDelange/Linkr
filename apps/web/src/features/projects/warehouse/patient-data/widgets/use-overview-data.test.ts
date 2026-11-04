import { describe, expect, it } from 'vitest'
import { RANGE_BUCKETS } from './overview-helpers'
import { TILE_BUCKETS } from './overview-tiles'
import { stripOf, stripSliceOf, tileCountsOf } from './use-overview-data'

describe('overview density bucketing', () => {
  it('adds the pairs into the strip, dropping slices outside it', () => {
    const { counts, max } = stripOf([[0, 2], [0, 3], [RANGE_BUCKETS - 1, 1], [-1, 9], [RANGE_BUCKETS, 9], [Number.NaN, 9]])
    expect(counts[0]).toBe(5)
    expect(counts[RANGE_BUCKETS - 1]).toBe(1)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6)
    expect(max).toBe(5)
  })

  it('files a bucket under the strip slice its start falls in', () => {
    const strip = { lo: 1000, hi: 1000 + RANGE_BUCKETS * 10 }
    expect(stripSliceOf(100, 10, strip)).toBe(0)
    expect(stripSliceOf(101, 10, strip)).toBe(1)
    expect(stripSliceOf(100 + RANGE_BUCKETS - 1, 10, strip)).toBe(RANGE_BUCKETS - 1)
    expect(stripSliceOf(99, 10, strip)).toBe(-1)
  })

  it('cuts each row into its tiles, summing a bucket read twice and dropping the others', () => {
    const first = 3 * TILE_BUCKETS
    const raw = [
      { row_key: 'a', bucket: first, n: 2 },
      { row_key: 'a', bucket: first, n: 1 },
      { row_key: 'a', bucket: first + TILE_BUCKETS + 5, n: 4 },
      { row_key: 'a', bucket: first - 1, n: 9 },
      { row_key: 'a', bucket: first + 2 * TILE_BUCKETS, n: 9 },
      { row_key: 'unknown', bucket: first, n: 9 },
    ]
    const tiles = tileCountsOf(raw, ['a', 'b'], 3, 4)
    expect([...tiles.keys()]).toEqual(['a', 'b'])
    const [t3, t4] = tiles.get('a')!
    expect(t3.length).toBe(TILE_BUCKETS)
    expect(t3[0]).toBe(3)
    expect(t4[5]).toBe(4)
    expect(t3.reduce((x, y) => x + y, 0) + t4.reduce((x, y) => x + y, 0)).toBe(7)
    expect(tiles.get('b')!.every((t) => t.every((v) => v === 0))).toBe(true)
  })
})
