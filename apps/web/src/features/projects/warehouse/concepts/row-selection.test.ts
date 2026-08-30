import { describe, it, expect } from 'vitest'
import { resolveRowSelection, type RowSelectionInput } from './row-selection'

// Selection is the one table behaviour with no visible markup to check it
// against: a Ctrl-click that silently clears the set, or a Shift-range that
// forgets its anchor, both look like "the table ignored my click".

const ORDER = [10, 20, 30, 40, 50]

const click = (over: Partial<RowSelectionInput>): RowSelectionInput => ({
  conceptId: 30,
  order: ORDER,
  selected: new Set<number>(),
  anchor: null,
  toggle: false,
  range: false,
  pickMode: false,
  ...over,
})

const ids = (s: Set<number> | null) => (s == null ? null : [...s].sort((a, b) => a - b))

describe('plain click', () => {
  it('selects a single row and drives the detail panel', () => {
    const r = resolveRowSelection(click({}))
    expect(r.single).toBe(true)
    expect(r.anchor).toBe(30)
  })

  it('clears an existing multi-selection', () => {
    const r = resolveRowSelection(click({ selected: new Set([10, 20]) }))
    expect(ids(r.selected)).toEqual([])
  })

  it('leaves the set untouched when it is already empty', () => {
    // A fresh empty Set is a new identity and would re-render every row.
    expect(resolveRowSelection(click({})).selected).toBeNull()
  })
})

describe('ctrl/cmd click', () => {
  it('adds a row without dropping the others', () => {
    const r = resolveRowSelection(click({ conceptId: 30, selected: new Set([10]), toggle: true }))
    expect(ids(r.selected)).toEqual([10, 30])
    expect(r.added).toEqual([30])
  })

  it('removes a row that was already picked', () => {
    const r = resolveRowSelection(click({ conceptId: 10, selected: new Set([10, 30]), toggle: true }))
    expect(ids(r.selected)).toEqual([30])
    expect(r.added).toEqual([])
  })

  it('moves the anchor, so a following shift-click extends from here', () => {
    expect(resolveRowSelection(click({ conceptId: 30, toggle: true })).anchor).toBe(30)
  })

  it('never reports a single selection', () => {
    expect(resolveRowSelection(click({ toggle: true })).single).toBe(false)
  })
})

describe('shift click', () => {
  it('selects the range between the anchor and the clicked row', () => {
    const r = resolveRowSelection(click({ conceptId: 40, anchor: 20, range: true }))
    expect(ids(r.selected)).toEqual([20, 30, 40])
  })

  it('works upward as well as downward', () => {
    const r = resolveRowSelection(click({ conceptId: 20, anchor: 40, range: true }))
    expect(ids(r.selected)).toEqual([20, 30, 40])
  })

  it('replaces the previous selection when ctrl is not held', () => {
    const r = resolveRowSelection(click({ conceptId: 30, anchor: 20, range: true, selected: new Set([50]) }))
    expect(ids(r.selected)).toEqual([20, 30])
  })

  it('adds to the selection when ctrl is held too', () => {
    // Ctrl+Shift is how a file explorer collects a second range.
    const r = resolveRowSelection(
      click({ conceptId: 30, anchor: 20, range: true, selected: new Set([50]), toggle: true }),
    )
    expect(ids(r.selected)).toEqual([20, 30, 50])
  })

  it('reports only the ids it actually added', () => {
    const r = resolveRowSelection(
      click({ conceptId: 30, anchor: 20, range: true, selected: new Set([20]), toggle: true }),
    )
    expect(r.added).toEqual([30])
  })

  it('falls back to a toggle when there is no anchor yet', () => {
    // Shift-clicking as the very first action must still do something sensible.
    const r = resolveRowSelection(click({ conceptId: 30, anchor: null, range: true, pickMode: true }))
    expect(ids(r.selected)).toEqual([30])
  })

  it('ignores an anchor that is no longer on the page', () => {
    // Paging away drops the anchor row; the range has no origin to measure from.
    const r = resolveRowSelection(click({ conceptId: 30, anchor: 999, range: true, pickMode: true }))
    expect(ids(r.selected)).toEqual([30])
  })
})

describe('pick mode', () => {
  it('toggles on a plain click, since the set is the result', () => {
    const r = resolveRowSelection(click({ conceptId: 30, pickMode: true }))
    expect(ids(r.selected)).toEqual([30])
    expect(r.single).toBe(false)
  })

  it('still removes a second time', () => {
    const r = resolveRowSelection(click({ conceptId: 30, selected: new Set([30]), pickMode: true }))
    expect(ids(r.selected)).toEqual([])
  })

  it('keeps ctrl and shift working the same way', () => {
    const r = resolveRowSelection(click({ conceptId: 40, anchor: 20, range: true, pickMode: true }))
    expect(ids(r.selected)).toEqual([20, 30, 40])
  })
})
