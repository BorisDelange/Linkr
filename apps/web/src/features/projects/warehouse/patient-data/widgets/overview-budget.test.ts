import { describe, expect, it } from 'vitest'
import { overviewBudget } from './overview-budget'

describe('overviewBudget', () => {
  it('gives a device that says nothing the full budget', () => {
    expect(overviewBudget()).toEqual({ eventLimit: 4000, concurrency: 4, maxTiles: 4000 })
  })

  it('holds and asks less on a small machine', () => {
    expect(overviewBudget({ deviceMemory: 4, hardwareConcurrency: 8 }).eventLimit).toBe(2000)
    expect(overviewBudget({ deviceMemory: 8, hardwareConcurrency: 2 })).toEqual({ eventLimit: 1000, concurrency: 1, maxTiles: 1000 })
  })
})
