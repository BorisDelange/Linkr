import { describe, it, expect } from 'vitest'
import { WORD_SET_COLORS, SEARCH_COLOR_INDEX, wordSetColorIndex } from './word-set-colors'

describe('WORD_SET_COLORS', () => {
  it('gives every slot a distinct name, so a colour can address exactly one', () => {
    const names = WORD_SET_COLORS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('wordSetColorIndex', () => {
  it('honours the chosen colour whatever the set position', () => {
    const pink = WORD_SET_COLORS.findIndex((c) => c.name === 'pink')
    expect(wordSetColorIndex(0, 'pink')).toBe(pink)
    expect(wordSetColorIndex(4, 'pink')).toBe(pink)
  })

  it('falls back to the position when no colour was picked', () => {
    // The behaviour every set had before colours could be chosen.
    expect(wordSetColorIndex(0, undefined)).toBe(1)
    expect(wordSetColorIndex(1, undefined)).toBe(2)
  })

  it('never lands on the text-search colour by position', () => {
    // Search highlights are yellow; a set falling on it would be unreadable.
    for (let i = 0; i < 20; i++) {
      expect(wordSetColorIndex(i, undefined)).not.toBe(SEARCH_COLOR_INDEX)
    }
  })

  it('can still be chosen deliberately, unlike the positional fallback', () => {
    expect(wordSetColorIndex(3, 'yellow')).toBe(SEARCH_COLOR_INDEX)
  })

  it('falls back for a colour this palette does not have', () => {
    // A set imported from an instance with a different palette must still draw.
    expect(wordSetColorIndex(0, 'chartreuse')).toBe(1)
  })

  it('stays inside the palette however long the list', () => {
    for (let i = 0; i < 50; i++) {
      const idx = wordSetColorIndex(i, undefined)
      expect(WORD_SET_COLORS[idx]).toBeDefined()
    }
  })
})
