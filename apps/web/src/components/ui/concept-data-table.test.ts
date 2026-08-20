import { describe, expect, it } from 'vitest'
import { clampPage, nextSelection, pageCountOf, type RowKey } from './concept-data-table'

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

describe('nextSelection', () => {
  const order = ['a', 'b', 'c', 'd', 'e']
  const none = new Set<RowKey>()
  const plain = { toggle: false, range: false }
  const toggle = { toggle: true, range: false }
  const range = { toggle: false, range: true }

  it('replaces the whole selection on a plain click', () => {
    const r = nextSelection(new Set(['a', 'b']), 'd', order, plain, 'a')
    expect([...r.selection]).toEqual(['d'])
  })

  it('moves the anchor to the row a plain click hit', () => {
    expect(nextSelection(none, 'c', order, plain, 'a').anchor).toBe('c')
  })

  it('adds one row on ctrl-click without dropping the rest', () => {
    const r = nextSelection(new Set(['a']), 'c', order, toggle, 'a')
    expect([...r.selection].sort()).toEqual(['a', 'c'])
  })

  it('removes an already-selected row on ctrl-click', () => {
    const r = nextSelection(new Set(['a', 'c']), 'c', order, toggle, 'a')
    expect([...r.selection]).toEqual(['a'])
  })

  it('selects the inclusive range on shift-click', () => {
    const r = nextSelection(none, 'd', order, range, 'b')
    expect([...r.selection]).toEqual(['b', 'c', 'd'])
  })

  it('selects the same range when dragged backwards', () => {
    const r = nextSelection(none, 'b', order, range, 'd')
    expect([...r.selection]).toEqual(['b', 'c', 'd'])
  })

  it('drops the previous selection on a plain shift-click', () => {
    const r = nextSelection(new Set(['z']), 'c', order, range, 'b')
    expect([...r.selection]).toEqual(['b', 'c'])
  })

  it('keeps the previous selection when shift is combined with ctrl', () => {
    const r = nextSelection(new Set(['z']), 'c', order, { toggle: true, range: true }, 'b')
    expect([...r.selection].sort()).toEqual(['b', 'c', 'z'])
  })

  it('leaves the anchor where it was after a range, so the range can be redrawn', () => {
    expect(nextSelection(none, 'd', order, range, 'b').anchor).toBe('b')
  })

  it('falls back to a plain click when there is no anchor yet', () => {
    const r = nextSelection(new Set(['a']), 'c', order, range, null)
    expect([...r.selection]).toEqual(['c'])
  })

  it('falls back when the anchor has been filtered out of the visible rows', () => {
    // The anchor row can vanish when a filter narrows the set under it.
    const r = nextSelection(new Set(['a']), 'c', order, range, 'gone')
    expect([...r.selection]).toEqual(['c'])
  })
})
