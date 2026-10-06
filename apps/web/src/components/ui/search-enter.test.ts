import { describe, it, expect } from 'vitest'
import type { KeyboardEvent } from 'react'
import { firstMatchOnEnter, isSearchEnter, selectMatchesOnEnter } from './search-enter'

const key = (k: string, isComposing = false) =>
  ({ key: k, nativeEvent: { isComposing } }) as unknown as KeyboardEvent

describe('isSearchEnter', () => {
  it('accepts a plain Enter', () => {
    expect(isSearchEnter(key('Enter'))).toBe(true)
  })
  it('ignores Enter that confirms an IME composition', () => {
    expect(isSearchEnter(key('Enter', true))).toBe(false)
  })
  it('ignores other keys', () => {
    expect(isSearchEnter(key('a'))).toBe(false)
  })
})

describe('firstMatchOnEnter', () => {
  it('picks the first match', () => {
    expect(firstMatchOnEnter('ag', ['age', 'stage'])).toBe('age')
  })
  it('picks nothing without a search', () => {
    expect(firstMatchOnEnter('  ', ['age', 'stage'])).toBeUndefined()
  })
  it('picks nothing when nothing matches', () => {
    expect(firstMatchOnEnter('zz', [])).toBeUndefined()
  })
})

describe('selectMatchesOnEnter', () => {
  it('adds every match after the current selection', () => {
    expect(selectMatchesOnEnter('a', ['x'], ['a1', 'a2'])).toEqual(['x', 'a1', 'a2'])
  })
  it('keeps already selected matches once, in their place', () => {
    expect(selectMatchesOnEnter('a', ['a2', 'x'], ['a1', 'a2'])).toEqual(['a2', 'x', 'a1'])
  })
  it('returns the same selection when every match is already in it', () => {
    const selected = ['a1', 'a2']
    expect(selectMatchesOnEnter('a', selected, ['a1'])).toBe(selected)
  })
  it('does nothing without a search, rather than selecting everything', () => {
    expect(selectMatchesOnEnter('', ['x'], ['a1', 'a2'])).toBeNull()
  })
})
