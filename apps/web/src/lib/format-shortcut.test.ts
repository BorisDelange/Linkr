import { describe, it, expect } from 'vitest'
import { comboToDisplay, comboToString } from './format-shortcut'
import type { KeyCombo } from '@/types/shortcuts'

const combo = (over: Partial<KeyCombo>): KeyCombo => ({
  key: 'j',
  ctrlOrMeta: false,
  shift: false,
  alt: false,
  ...over,
})

// The Ctrl/Cmd symbol depends on the platform (jsdom may report Mac), so assert on
// structure/order rather than the exact modifier glyph.
const CMD = /^(⌘|Ctrl)$/

describe('comboToDisplay', () => {
  it('orders modifiers (ctrl/cmd, shift) then the uppercased key', () => {
    const parts = comboToDisplay(combo({ ctrlOrMeta: true, shift: true, key: 'j' }))
    expect(parts[0]).toMatch(CMD)
    expect(parts[1]).toBe('Shift')
    expect(parts[2]).toBe('J')
  })

  it('renders Enter as ↵', () => {
    const parts = comboToDisplay(combo({ ctrlOrMeta: true, key: 'Enter' }))
    expect(parts[parts.length - 1]).toBe('↵')
  })

  it('keeps multi-char keys verbatim', () => {
    expect(comboToDisplay(combo({ key: 'F9' }))).toEqual(['F9'])
  })

  it('uppercases a single-char key', () => {
    expect(comboToDisplay(combo({ key: 'b' }))).toEqual(['B'])
  })
})

describe('comboToString', () => {
  it('includes every modifier and the key', () => {
    const s = comboToString(combo({ ctrlOrMeta: true, shift: true, key: 'j' }))
    expect(s).toMatch(/(⌘|Ctrl)/)
    expect(s).toContain('Shift')
    expect(s).toContain('J')
  })

  it('returns empty for an unbound combo', () => {
    expect(comboToString(combo({ key: '' }))).toBe('')
  })
})
