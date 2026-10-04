import { describe, it, expect } from 'vitest'
import {
  bucketMsFor,
  eventWindowFor,
  OverviewDataCache,
  runLimited,
  tileBounds,
  tilesCovering,
  TILE_BUCKETS,
} from './overview-tiles'

const DAY = 86_400_000

describe('bucketMsFor', () => {
  it('is a power of two at or above one pixel', () => {
    const bw = bucketMsFor(10 * DAY, 1000)
    expect(Math.log2(bw) % 1).toBe(0)
    expect(bw).toBeGreaterThanOrEqual((10 * DAY) / 1000)
    expect(bw).toBeLessThan((2 * 10 * DAY) / 1000)
  })

  it('stays the same over a small zoom, so tiles are reused', () => {
    expect(bucketMsFor(10 * DAY, 1000)).toBe(bucketMsFor(9.5 * DAY, 1000))
  })

  it('never goes below about a second', () => {
    expect(bucketMsFor(1000, 1000)).toBe(1024)
  })
})

describe('tiles', () => {
  it('cover the view, and a pan only adds the tiles that came in', () => {
    const bw = 1024
    const t = bw * TILE_BUCKETS
    expect(tilesCovering(0.5 * t, 2.5 * t, bw)).toEqual([0, 1, 2])
    expect(tilesCovering(1.5 * t, 3.5 * t, bw)).toEqual([1, 2, 3])
    expect(tileBounds(2, bw)).toEqual([2 * t, 3 * t])
  })
})

describe('eventWindowFor', () => {
  it('covers the view with a margin, and nearby views share it', () => {
    const a = eventWindowFor(10 * DAY, 11 * DAY)
    expect(a.lo).toBeLessThan(10 * DAY)
    expect(a.hi).toBeGreaterThan(11 * DAY)
    expect(eventWindowFor(10 * DAY + 1000, 11 * DAY + 1000)).toEqual(a)
  })
})

describe('OverviewDataCache', () => {
  const ev = (start: number) => ({ start, end: null, value: null, text: null, conceptId: null, route: null, rate: null, rateUnit: null })

  it('serves a zoom into a window from that window, the narrowest first', () => {
    const c = new OverviewDataCache()
    c.putEvents('r', { lo: 0, hi: 100, events: [ev(5)], truncated: false })
    c.putEvents('r', { lo: 10, hi: 50, events: [ev(20)], truncated: false })
    expect(c.eventsFor('r', 20, 40)?.lo).toBe(10)
    expect(c.eventsFor('r', 5, 90)?.lo).toBe(0)
    expect(c.eventsFor('r', 5, 150)).toBeNull()
    expect(c.needsEvents('r', 20, 40)).toBe(false)
  })

  it('reads again when only a much wider, truncated window covers the view', () => {
    const c = new OverviewDataCache()
    c.putEvents('r', { lo: 0, hi: 1_000_000, events: [], truncated: true })
    expect(c.needsEvents('r', 500_000, 500_100)).toBe(true)
    expect(c.needsEvents('r', 0, 600_000)).toBe(false)
  })

  it('sums tile buckets into pixels, exactly at the fetched level', () => {
    const c = new OverviewDataCache()
    const bw = 1024
    const counts = new Float64Array(TILE_BUCKETS)
    counts[0] = 3
    counts[255] = 5
    c.putTile('r', bw, 0, counts)
    const px = c.pixelCounts('r', 0, bw * TILE_BUCKETS, 256, bw)!
    expect(px[0]).toBe(3)
    expect(px[255]).toBe(5)
    expect(px.reduce((a, b) => a + b, 0)).toBe(8)
  })

  it('stands in a coarser level while the exact one loads, spreading its buckets', () => {
    const c = new OverviewDataCache()
    const counts = new Float64Array(TILE_BUCKETS)
    counts[0] = 4
    c.putTile('r', 2048, 0, counts)
    const px = c.pixelCounts('r', 0, 1024 * 8, 8, 1024)!
    expect([...px.slice(0, 2)]).toEqual([2, 2])
    expect(px.reduce((a, b) => a + b, 0)).toBe(4)
  })

  it('counts only the share of a stand-in bucket that is in view', () => {
    const c = new OverviewDataCache()
    const counts = new Float64Array(TILE_BUCKETS)
    counts[0] = 8
    c.putTile('r', 4096, 0, counts)
    // Half of the bucket [0, 4096) lies left of the view.
    const px = c.pixelCounts('r', 2048, 2048 + 1024 * 8, 8, 1024)!
    expect([...px.slice(0, 2)]).toEqual([2, 2])
    expect(px.reduce((a, b) => a + b, 0)).toBe(4)
  })

  it('has nothing to show before any tile covers the view', () => {
    expect(new OverviewDataCache().pixelCounts('r', 0, 1000, 10, 1024)).toBeNull()
  })
})

describe('runLimited', () => {
  it('runs every task, never more than the limit at once', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 1))
      running--
      done.push(i)
    })
    await runLimited(tasks, 3, new AbortController().signal)
    expect(done).toHaveLength(10)
    expect(peak).toBe(3)
  })

  it('runs the other tasks when one throws', async () => {
    const done: number[] = []
    const tasks = Array.from({ length: 4 }, (_, i) => async () => {
      if (i === 0) throw new Error('boom')
      done.push(i)
    })
    await expect(runLimited(tasks, 1, new AbortController().signal)).resolves.toBeUndefined()
    expect(done).toEqual([1, 2, 3])
  })

  it('stops starting tasks once aborted', async () => {
    const controller = new AbortController()
    let ran = 0
    const tasks = Array.from({ length: 5 }, () => async () => { ran++; controller.abort() })
    await runLimited(tasks, 1, controller.signal)
    expect(ran).toBe(1)
  })
})
