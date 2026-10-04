import { describe, it, expect } from 'vitest'
import { blocksShiftTextSelection, clearsSelection, isSelectionClick, rangeAnchor, retainPresent } from './use-card-selection'
import type { RowKey } from './data-table'

const mods = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...over,
})

describe('isSelectionClick', () => {
  it('leaves a plain click to navigation', () => {
    expect(isSelectionClick(mods())).toBe(false)
  })

  it('treats Cmd, Ctrl and Shift as selection gestures', () => {
    expect(isSelectionClick(mods({ metaKey: true }))).toBe(true)
    expect(isSelectionClick(mods({ ctrlKey: true }))).toBe(true)
    expect(isSelectionClick(mods({ shiftKey: true }))).toBe(true)
  })
})

describe('rangeAnchor', () => {
  const keys: RowKey[] = ['a', 'b', 'c']

  it('extends from the last card picked', () => {
    expect(rangeAnchor('b', keys)).toBe('b')
  })

  it('starts from the first card when none was picked', () => {
    expect(rangeAnchor(null, keys)).toBe('a')
  })

  it('starts from the first card when the last one picked is no longer shown', () => {
    expect(rangeAnchor('z', keys)).toBe('a')
  })

  it('has no anchor on an empty grid', () => {
    expect(rangeAnchor(null, [])).toBeNull()
  })
})

describe('retainPresent', () => {
  const keys: RowKey[] = ['a', 'b', 'c']

  it('drops keys the grid no longer shows', () => {
    expect([...retainPresent(new Set(['a', 'z']), keys)]).toEqual(['a'])
  })

  it('keeps the same Set when everything is still visible', () => {
    const selected = new Set<RowKey>(['a', 'b'])
    expect(retainPresent(selected, keys)).toBe(selected)
  })

  it('keeps the empty Set untouched', () => {
    const empty = new Set<RowKey>()
    expect(retainPresent(empty, [])).toBe(empty)
  })

  it('empties the selection when the grid shows nothing', () => {
    expect(retainPresent(new Set(['a']), []).size).toBe(0)
  })
})

describe('clearsSelection', () => {
  // A stand-in for an element: `closest` matches when its ancestors include one
  // of the given selectors.
  const inside = (...ancestors: string[]) => ({
    closest: (selector: string) => (ancestors.some((a) => selector.split(', ').includes(a)) ? {} : null),
  }) as unknown as EventTarget

  it('drops the selection on a plain click on the page', () => {
    expect(clearsSelection(mods(), inside('div'))).toBe(true)
    expect(clearsSelection(mods(), null)).toBe(true)
  })

  it('keeps it on a modified click', () => {
    expect(clearsSelection(mods({ shiftKey: true }), null)).toBe(false)
    expect(clearsSelection(mods({ metaKey: true }), null)).toBe(false)
    expect(clearsSelection(mods({ ctrlKey: true }), null)).toBe(false)
  })

  it('keeps it on a control, a field, or inside a dialog', () => {
    expect(clearsSelection(mods(), inside('button'))).toBe(false)
    expect(clearsSelection(mods(), inside('input'))).toBe(false)
    expect(clearsSelection(mods(), inside('[role="alertdialog"]'))).toBe(false)
  })
})

describe('clearsSelection on a dialog overlay', () => {
  const inside = (...ancestors: string[]) => ({
    closest: (selector: string) => (ancestors.some((a) => selector.split(', ').includes(a)) ? {} : null),
  }) as unknown as EventTarget

  it('keeps it when the click dismisses a confirm by its overlay', () => {
    expect(clearsSelection(mods(), inside('[data-slot="dialog-overlay"]'))).toBe(false)
    expect(clearsSelection(mods(), inside('[data-slot="alert-dialog-overlay"]'))).toBe(false)
  })
})

describe('blocksShiftTextSelection', () => {
  const at = (...ancestors: string[]) => ({
    closest: (selector: string) => (ancestors.some((a) => selector.split(', ').includes(a)) ? {} : null),
  }) as unknown as EventTarget

  it('blocks the press on a card grid', () => {
    expect(blocksShiftTextSelection(at('[data-card-grid]'))).toBe(true)
  })

  it('leaves Shift-click text selection alone elsewhere on the page', () => {
    expect(blocksShiftTextSelection(at('div'))).toBe(false)
    expect(blocksShiftTextSelection(null)).toBe(false)
  })

  it('leaves a field inside the grid alone', () => {
    expect(blocksShiftTextSelection(at('[data-card-grid]', 'input'))).toBe(false)
  })
})
