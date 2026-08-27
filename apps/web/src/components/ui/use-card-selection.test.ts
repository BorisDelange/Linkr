import { describe, it, expect } from 'vitest'
import { isSelectionClick, retainPresent } from './use-card-selection'
import type { RowKey } from './concept-data-table'

const mods = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...over,
})

describe('isSelectionClick', () => {
  it('leaves a plain click to navigation', () => {
    expect(isSelectionClick(mods(), null)).toBe(false)
    expect(isSelectionClick(mods(), 'a')).toBe(false)
  })

  it('treats Cmd and Ctrl alike, with or without an anchor', () => {
    expect(isSelectionClick(mods({ metaKey: true }), null)).toBe(true)
    expect(isSelectionClick(mods({ ctrlKey: true }), null)).toBe(true)
    expect(isSelectionClick(mods({ metaKey: true }), 'a')).toBe(true)
  })

  it('ignores Shift until an anchor exists', () => {
    expect(isSelectionClick(mods({ shiftKey: true }), null)).toBe(false)
    expect(isSelectionClick(mods({ shiftKey: true }), 'a')).toBe(true)
  })

  it('still selects on Cmd+Shift with no anchor', () => {
    expect(isSelectionClick(mods({ metaKey: true, shiftKey: true }), null)).toBe(true)
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
