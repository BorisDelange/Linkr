import { describe, expect, it } from 'vitest'
import {
  columnCountFor,
  columnDropIndex,
  columnNeighbourIndex,
  columnStartIndex,
  splitIntoColumns,
} from './script-columns'

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

/**
 * Moving a card sideways is the only way to reach the far end of a neighbouring
 * column, so the landing index has to be right even when the columns differ in
 * length — which they usually do, since the remainder is spread leftwards.
 */
describe('columnNeighbourIndex', () => {
  it('steps a full column along when the columns are even', () => {
    // [0 1 2] [3 4 5]: row 1 of column 1 is index 4.
    expect(columnNeighbourIndex([3, 3], 1, 1)).toBe(4)
    expect(columnNeighbourIndex([3, 3], 4, -1)).toBe(1)
  })

  it('accounts for the left column being the taller one', () => {
    // [0 1 2 3] [4 5 6]: stepping right from index 1 (row 1) lands on 5, NOT on
    // 1 + 3 = 4, which is row 0 of the next column.
    expect(columnNeighbourIndex([4, 3], 1, 1)).toBe(5)
    expect(columnNeighbourIndex([4, 3], 5, -1)).toBe(1)
  })

  it('lands on the last card when the neighbouring column is shorter', () => {
    // [0 1 2 3] [4 5 6]: row 3 has no counterpart on the right, so clamp to 6.
    expect(columnNeighbourIndex([4, 3], 3, 1)).toBe(6)
  })

  it('refuses to move past the outermost columns', () => {
    expect(columnNeighbourIndex([3, 3], 0, -1)).toBe(0)
    expect(columnNeighbourIndex([3, 3], 5, 1)).toBe(5)
  })

  it('is a no-op with a single column, whichever way', () => {
    expect(columnNeighbourIndex([4], 2, 1)).toBe(2)
    expect(columnNeighbourIndex([4], 2, -1)).toBe(2)
  })

  it('round-trips across three uneven columns', () => {
    // [0 1 2 3] [4 5 6] [7 8 9]
    const lengths = [4, 3, 3]
    expect(columnNeighbourIndex(lengths, 5, 1)).toBe(8)
    expect(columnNeighbourIndex(lengths, 8, -1)).toBe(5)
  })

  it('returns the index unchanged when it is out of range', () => {
    expect(columnNeighbourIndex([2, 2], 9, 1)).toBe(9)
  })
})

/**
 * Dropping on a column's empty space is how a card reaches the foot of a column
 * (or a column it is not already in). The landing index is easy to get wrong by
 * one, because the lengths describe the layout BEFORE the card is removed — so
 * this is checked exhaustively against the real splitter rather than by example.
 */
describe('columnDropIndex', () => {
  function arrayMove<T>(items: T[], from: number, to: number): T[] {
    const copy = [...items]
    copy.splice(to, 0, copy.splice(from, 1)[0])
    return copy
  }

  it('lands the card last in the target column, for every card and column', () => {
    for (const count of [5, 6, 7, 8, 9, 12, 13]) {
      for (const columns of [2, 3, 4]) {
        const files = Array.from({ length: count }, (_, i) => `f${i}`)
        const lengths = splitIntoColumns(files, columns).map((c) => c.length)
        for (const id of files) {
          for (let col = 0; col < lengths.length; col++) {
            const from = files.indexOf(id)
            const moved = arrayMove(files, from, columnDropIndex(lengths, col))
            const target = splitIntoColumns(moved, columns)[col]
            expect(target[target.length - 1]).toBe(id)
          }
        }
      }
    }
  })

  it('drops into the first column at its last row', () => {
    // [0 1 2 3][4 5 6 7] — the foot of column 0 is index 3, not 4.
    expect(columnDropIndex([4, 4], 0)).toBe(3)
  })

  it('drops into the last column at the end of the sequence', () => {
    expect(columnDropIndex([4, 4], 1)).toBe(7)
  })

  it('never returns a negative index for an empty layout', () => {
    expect(columnDropIndex([], 0)).toBe(0)
  })
})

/** The mirror of columnDropIndex: the zone ABOVE a column, landing on row 0. */
describe('columnStartIndex', () => {
  function arrayMove<T>(items: T[], from: number, to: number): T[] {
    const copy = [...items]
    copy.splice(to, 0, copy.splice(from, 1)[0])
    return copy
  }

  it('lands the card first in the target column, for every card and column', () => {
    for (const count of [5, 6, 7, 8, 9, 12, 13]) {
      for (const columns of [2, 3, 4]) {
        const files = Array.from({ length: count }, (_, i) => `f${i}`)
        const lengths = splitIntoColumns(files, columns).map((c) => c.length)
        for (const id of files) {
          for (let col = 0; col < lengths.length; col++) {
            const from = files.indexOf(id)
            const moved = arrayMove(files, from, columnStartIndex(lengths, col))
            expect(splitIntoColumns(moved, columns)[col][0]).toBe(id)
          }
        }
      }
    }
  })

  it('is the head of the sequence for the first column', () => {
    expect(columnStartIndex([4, 4], 0)).toBe(0)
  })

  it('is the first index past the previous columns', () => {
    expect(columnStartIndex([4, 4], 1)).toBe(4)
    expect(columnStartIndex([4, 3, 3], 2)).toBe(7)
  })
})

/**
 * The zone drop resolves to a ROW (a column's first or last card), not to the
 * boundary between two columns: the two zones either side of a gap denote the
 * same slot in the flat sequence, so a boundary index cannot say which column the
 * card ends up in — the splitter decides. Checked from EVERY source position,
 * because a mid-column card shifts the later boundaries when it is removed.
 */
describe('zone drops resolve from any source row', () => {
  function arrayMove<T>(items: T[], from: number, to: number): T[] {
    const copy = [...items]
    copy.splice(to, 0, copy.splice(from, 1)[0])
    return copy
  }

  it('lands the card on the targeted row whatever column it came from', () => {
    for (const count of [8, 9, 12, 13, 29]) {
      for (const columns of [2, 3]) {
        const files = Array.from({ length: count }, (_, i) => `f${i}`)
        const lengths = splitIntoColumns(files, columns).map((c) => c.length)
        for (let from = 0; from < files.length; from++) {
          for (let col = 0; col < lengths.length; col++) {
            const toStart = columnStartIndex(lengths, col)
            if (toStart !== from) {
              const laid = splitIntoColumns(arrayMove(files, from, toStart), columns)
              expect(laid[col][0]).toBe(files[from])
            }
            const toEnd = columnDropIndex(lengths, col)
            if (toEnd !== from) {
              const laid = splitIntoColumns(arrayMove(files, from, toEnd), columns)
              expect(laid[col][laid[col].length - 1]).toBe(files[from])
            }
          }
        }
      }
    }
  })
})

/**
 * The rule the drop zones implement: a zone marks the gap it sits in, and means
 * "cross into the NEIGHBOURING column" — the zone above a column is the foot of
 * the previous one, the zone below is the head of the next one. Reading it as
 * head/foot of its OWN column left a mid-column card at its own column's edge,
 * which is the one thing aiming at a gap should never do.
 */
describe('zone drop targets the neighbouring column', () => {
  function arrayMove<T>(items: T[], from: number, to: number): T[] {
    const copy = [...items]
    copy.splice(to, 0, copy.splice(from, 1)[0])
    return copy
  }

  /** Mirrors handleDragEnd: the outermost gaps render no zone, so `col` always
   *  has a neighbour in the direction the zone points. */
  function resolveZone(lengths: number[], col: number, atStart: boolean): number {
    const neighbour = atStart ? col - 1 : col + 1
    return atStart
      ? columnDropIndex(lengths, neighbour)
      : columnStartIndex(lengths, neighbour)
  }

  it('lands any card at the neighbouring column edge, from any row', () => {
    for (const count of [8, 9, 12, 13, 29]) {
      for (const columns of [2, 3, 4]) {
        const files = Array.from({ length: count }, (_, i) => `f${i}`)
        const lengths = splitIntoColumns(files, columns).map((c) => c.length)
        for (let from = 0; from < files.length; from++) {
          for (let col = 0; col < lengths.length; col++) {
            // `start` on the first column and `end` on the last render no zone.
            for (const atStart of [true, false]) {
              const neighbour = atStart ? col - 1 : col + 1
              if (neighbour < 0 || neighbour >= lengths.length) continue

              const laid = splitIntoColumns(
                arrayMove(files, from, resolveZone(lengths, col, atStart)),
                columns,
              )
              const landed = laid[neighbour]
              expect(atStart ? landed[landed.length - 1] : landed[0]).toBe(files[from])
            }
          }
        }
      }
    }
  })

  it('sends a mid-column card to the previous column, not its own edge', () => {
    // [15,14]: f18 sits mid-column-1. Its top zone means the foot of column 0.
    const files = Array.from({ length: 29 }, (_, i) => `f${i}`)
    const laid = splitIntoColumns(arrayMove(files, 18, resolveZone([15, 14], 1, true)), 2)
    expect(laid[0][laid[0].length - 1]).toBe('f18')
  })

  it('sends the last card of a column to the head of the next', () => {
    // [10,10,9]: f19 is the last of column 1; its bottom zone heads column 2.
    const files = Array.from({ length: 29 }, (_, i) => `f${i}`)
    const laid = splitIntoColumns(
      arrayMove(files, 19, resolveZone([10, 10, 9], 1, false)),
      3,
    )
    expect(laid[2][0]).toBe('f19')
  })
})
