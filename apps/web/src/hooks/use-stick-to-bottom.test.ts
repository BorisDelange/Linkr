import { describe, it, expect } from 'vitest'
import { isAtBottom } from './use-stick-to-bottom'

describe('isAtBottom', () => {
  it('is true when scrolled fully to the bottom', () => {
    // content 1000, viewport 300 → bottom is scrollTop 700
    expect(isAtBottom(700, 1000, 300)).toBe(true)
  })

  it('is true within the tolerance, so sub-pixel layout never drops the pin', () => {
    // Fractional device pixels and zoom mean scrollTop + clientHeight rarely
    // equals scrollHeight exactly; an equality test would unpin content that is
    // visually at the bottom.
    expect(isAtBottom(699.5, 1000, 300)).toBe(true)
    expect(isAtBottom(680, 1000, 300)).toBe(true)
  })

  it('is FALSE once the reader has scrolled up past the tolerance', () => {
    // This is the whole point: reading something above must stop the auto-scroll.
    expect(isAtBottom(400, 1000, 300)).toBe(false)
    expect(isAtBottom(0, 1000, 300)).toBe(false)
  })

  it('is true when the content is shorter than the viewport', () => {
    // Nothing to scroll — the reader is trivially at the bottom, and new output
    // must keep following.
    expect(isAtBottom(0, 200, 300)).toBe(true)
  })

  it('re-pins exactly at the boundary of the tolerance', () => {
    // 24px is the default tolerance: 24 away still counts, 25 does not.
    expect(isAtBottom(676, 1000, 300)).toBe(true)
    expect(isAtBottom(675, 1000, 300)).toBe(false)
  })

  it('honours a custom tolerance', () => {
    expect(isAtBottom(690, 1000, 300, 5)).toBe(false)
    expect(isAtBottom(690, 1000, 300, 50)).toBe(true)
  })
})
