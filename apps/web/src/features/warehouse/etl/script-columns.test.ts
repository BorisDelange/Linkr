import { describe, expect, it } from 'vitest'
import { columnCountFor, splitIntoColumns } from './script-columns'

/**
 * A pipeline is a sequence, and the column layout only helps if the sequence
 * still reads in order: column 1 must be the FIRST run of steps, not every
 * third one.
 */

describe('columnCountFor', () => {
  it('stays single-column while there is no room for two', () => {
    expect(columnCountFor(500, 50)).toBe(1)
  })

  it('adds columns as the pane widens', () => {
    expect(columnCountFor(700, 50)).toBe(2)
    expect(columnCountFor(1000, 50)).toBe(3)
  })

  it('does not spread a short pipeline over many columns', () => {
    // Three scripts in three columns is one card per column: the chain would
    // stop looking like a chain.
    expect(columnCountFor(1600, 3)).toBe(1)
    expect(columnCountFor(1600, 8)).toBe(2)
  })

  it('survives a width of zero, before the pane is measured', () => {
    expect(columnCountFor(0, 50)).toBe(1)
    expect(columnCountFor(-40, 50)).toBe(1)
  })
})

describe('splitIntoColumns', () => {
  it('fills column by column, so each one is consecutive', () => {
    const columns = splitIntoColumns([1, 2, 3, 4, 5, 6], 2)
    expect(columns).toEqual([[1, 2, 3], [4, 5, 6]])
  })

  it('never interleaves — that would scramble the execution order', () => {
    const columns = splitIntoColumns([1, 2, 3, 4, 5, 6], 3)
    expect(columns).toEqual([[1, 2], [3, 4], [5, 6]])
  })

  it('balances the remainder onto the leftmost columns', () => {
    // Not [1,2,3,4],[5,6,7] — the taller columns come first, so the layout
    // does not end on a lone card beside a full column.
    expect(splitIntoColumns([1, 2, 3, 4, 5, 6, 7], 2)).toEqual([[1, 2, 3, 4], [5, 6, 7]])
  })

  it('keeps every item exactly once, in order', () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    expect(splitIntoColumns(items, 4).flat()).toEqual(items)
  })

  it('returns one column when asked for one, or for none', () => {
    expect(splitIntoColumns([1, 2, 3], 1)).toEqual([[1, 2, 3]])
    expect(splitIntoColumns([], 3)).toEqual([[]])
  })

  it('drops empty columns rather than rendering blank ones', () => {
    expect(splitIntoColumns([1, 2], 5)).toEqual([[1], [2]])
  })
})
