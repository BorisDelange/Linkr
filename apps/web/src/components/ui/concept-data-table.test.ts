import { describe, expect, it } from 'vitest'
import { clampPage, pageCountOf } from './concept-data-table'

describe('pageCountOf', () => {
  it('is 1 when pagination is off, whatever the size', () => {
    // Callers that omit pageSize render everything; the count must stay uniform.
    expect(pageCountOf(1394, undefined)).toBe(1)
  })

  it('rounds a partial last page up', () => {
    expect(pageCountOf(1394, 100)).toBe(14)
  })

  it('is exact when the total divides evenly', () => {
    expect(pageCountOf(200, 100)).toBe(2)
  })

  it('is 1 for an empty set, never 0', () => {
    // A count of 0 would make the only valid page index -1.
    expect(pageCountOf(0, 100)).toBe(1)
  })
})

describe('clampPage', () => {
  it('leaves a valid page alone', () => {
    expect(clampPage(3, 14)).toBe(3)
  })

  it('pulls a page past the end back to the last one', () => {
    // Filtering 1394 rows down to 50 leaves 1 page while page is still 13.
    expect(clampPage(13, 1)).toBe(0)
  })

  it('never returns a negative index', () => {
    expect(clampPage(-1, 5)).toBe(0)
    expect(clampPage(0, 0)).toBe(0)
  })

  it('keeps the last page reachable', () => {
    expect(clampPage(13, 14)).toBe(13)
  })
})
