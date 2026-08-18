import { describe, it, expect } from 'vitest'
import { mergeSelection, appendListConcepts } from './concept-selection'

describe('mergeSelection', () => {
  it('appends a newly picked id at the end', () => {
    expect(mergeSelection([10, 20], new Set([10, 20, 30]))).toEqual([10, 20, 30])
  })

  it('keeps surviving ids at their original position when one is removed', () => {
    // 10 must stay first: the chart colours by index, so promoting 30 would
    // recolour every remaining series.
    expect(mergeSelection([10, 20, 30], new Set([10, 30]))).toEqual([10, 30])
  })

  it('does not reorder when the incoming set iterates in another order', () => {
    expect(mergeSelection([10, 20, 30], new Set([30, 10, 20]))).toEqual([10, 20, 30])
  })

  it('returns the same reference when nothing changed', () => {
    const previous = [10, 20]
    expect(mergeSelection(previous, new Set([10, 20]))).toBe(previous)
  })

  it('clears to an empty array', () => {
    expect(mergeSelection([10, 20], new Set())).toEqual([])
  })

  it('handles an empty starting selection', () => {
    expect(mergeSelection([], new Set([5]))).toEqual([5])
  })
})

describe('appendListConcepts', () => {
  it('appends the list in its own order', () => {
    expect(appendListConcepts([1], [7, 8, 9])).toEqual([1, 7, 8, 9])
  })

  it('is additive: an existing selection is never wiped', () => {
    expect(appendListConcepts([1, 2], [3])).toEqual([1, 2, 3])
  })

  it('skips ids already selected, keeping their original position', () => {
    expect(appendListConcepts([5, 6], [6, 7])).toEqual([5, 6, 7])
  })

  it('de-duplicates ids repeated within the list itself', () => {
    expect(appendListConcepts([], [4, 4, 5])).toEqual([4, 5])
  })

  it('returns the same reference when the list adds nothing', () => {
    const previous = [1, 2]
    expect(appendListConcepts(previous, [1, 2])).toBe(previous)
    expect(appendListConcepts(previous, [])).toBe(previous)
  })
})
