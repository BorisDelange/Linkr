import { describe, it, expect } from 'vitest'
import { sampleEvenly, sampleRandom } from './plot-sampling'

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('sampleEvenly', () => {
  it('returns every item when under the cap', () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3])
  })

  it('caps the count and spreads picks over the whole range, in order', () => {
    expect(sampleEvenly(range(100), 4)).toEqual([0, 25, 50, 75])
  })

  it('handles a length that does not divide evenly', () => {
    // floor(k * 10 / 3) for k = 0..2 — the indices the server picks too.
    expect(sampleEvenly(range(10), 3)).toEqual([0, 3, 6])
  })
})

describe('sampleRandom', () => {
  it('returns every item when under the cap', () => {
    expect(sampleRandom([1, 2, 3], 5)).toEqual([1, 2, 3])
  })

  it('picks distinct items, in their original order, the same on every call', () => {
    const out = sampleRandom(range(1000), 50)
    expect(out).toHaveLength(50)
    expect(new Set(out).size).toBe(50)
    expect(out).toEqual([...out].sort((a, b) => a - b))
    expect(sampleRandom(range(1000), 50)).toEqual(out)
  })

  it('does not alias with a periodic order', () => {
    // Two interleaved groups: a stride of 2.4 would favour one 3:2.
    const odd = sampleRandom(range(12_000), 5000).filter(i => i % 2 === 1).length
    expect(Math.abs(odd - 2500)).toBeLessThan(150)
  })
})
