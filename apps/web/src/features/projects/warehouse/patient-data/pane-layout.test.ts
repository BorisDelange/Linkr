import { describe, expect, it } from 'vitest'
import { paneSizes, paneSizesAfterReset, type PaneLayoutInput } from './pane-layout'

const DEFAULT = 320
const base: PaneLayoutInput = {
  total: 1400,
  sidebarVisible: true,
  collectionOpen: true,
  sidebarWidth: 500,
  collectionWidth: 450,
}

describe('paneSizes', () => {
  it('gives the dashboard whatever the panels leave', () => {
    expect(paneSizes(base)).toEqual([450, 500, 450])
  })

  it('counts a hidden panel as zero, without widening the other', () => {
    expect(paneSizes({ ...base, collectionOpen: false })).toEqual([900, 500, 0])
    expect(paneSizes({ ...base, sidebarVisible: false })).toEqual([950, 0, 450])
  })
})

describe('paneSizesAfterReset', () => {
  it('returns the collection panel to its default and leaves the sidebar alone', () => {
    // The regression: Allotment resets the pane LEFT of the sash first, so
    // double-clicking the collection border resized the patient sidebar instead.
    const [dashboard, sidebar, collection] = paneSizesAfterReset(base, 'collection', DEFAULT)
    expect(sidebar).toBe(500)
    expect(collection).toBe(DEFAULT)
    expect(dashboard).toBe(1400 - 500 - DEFAULT)
  })

  it('returns the sidebar to its default and leaves the collection panel alone', () => {
    const [, sidebar, collection] = paneSizesAfterReset(base, 'sidebar', DEFAULT)
    expect(sidebar).toBe(DEFAULT)
    expect(collection).toBe(450)
  })

  it('shrinks the pair rather than moving the untouched panel', () => {
    // Both oversized: resetting one gives the space to the dashboard, and the other
    // panel keeps its width exactly.
    const before = paneSizes(base)
    const after = paneSizesAfterReset(base, 'collection', DEFAULT)
    expect(after[1]).toBe(before[1])
    expect(after[0]).toBeGreaterThan(before[0])
  })

  it('resets a visible panel while the other is hidden', () => {
    const input = { ...base, sidebarVisible: false }
    expect(paneSizesAfterReset(input, 'collection', DEFAULT)).toEqual([1400 - DEFAULT, 0, DEFAULT])
  })
})
