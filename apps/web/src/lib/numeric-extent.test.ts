import { describe, it, expect } from 'vitest'
import { extent } from './numeric-extent'

describe('extent', () => {
  it('spans 200k values without overflowing the stack', () => {
    const values = Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 200_000 - 1000)
    expect(extent(values)).toEqual({ min: -1000, max: 198_999 })
  })

  it('spans several lists, skipping NaN', () => {
    expect(extent([3, NaN, 1], [], [7, -2])).toEqual({ min: -2, max: 7 })
  })

  it('is empty-safe', () => {
    expect(extent([])).toEqual({ min: Infinity, max: -Infinity })
  })
})
