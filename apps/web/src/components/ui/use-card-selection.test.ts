import { describe, it, expect } from 'vitest'
import { isSelectionClick, rangeAnchor, retainPresent } from './use-card-selection'
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
