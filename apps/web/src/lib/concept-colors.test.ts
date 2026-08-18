import { describe, it, expect } from 'vitest'
import {
  CONCEPT_COLOR_ORDER,
  defaultConceptColorName,
  paletteHex,
  conceptColorHex,
} from './concept-colors'
import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'

// Concepts with no explicit colour used to fall back to a grey that read as
// "no colour set" rather than as a series colour. Each position must now get a
// distinct, non-grey hue, and the picker swatch must show the same colour the
// chart draws.

describe('defaultConceptColorName', () => {
  it('gives the first three concepts red, blue then green', () => {
    expect(defaultConceptColorName(0)).toBe('red')
    expect(defaultConceptColorName(1)).toBe('blue')
    expect(defaultConceptColorName(2)).toBe('green')
  })

  it('never assigns a grey, which is what made series look unstyled', () => {
    for (const name of CONCEPT_COLOR_ORDER) {
      expect(name, name).not.toBe('slate')
      expect(name, name).not.toBe('none')
    }
  })

  it('keeps the first several distinct so a chart is readable at a glance', () => {
    const first = CONCEPT_COLOR_ORDER.slice(0, 8)
    expect(new Set(first).size).toBe(first.length)
  })

  it('wraps around instead of running off the end', () => {
    const n = CONCEPT_COLOR_ORDER.length
    expect(defaultConceptColorName(n)).toBe(defaultConceptColorName(0))
    expect(defaultConceptColorName(n + 2)).toBe(defaultConceptColorName(2))
  })

  it('only names colours the shared palette actually defines', () => {
    // A name absent from COLOR_PALETTE resolves to null and the swatch would
    // render empty — the exact bug being fixed.
    const known = new Set(COLOR_PALETTE.map((c) => c.name))
    for (const name of CONCEPT_COLOR_ORDER) {
      expect(known.has(name), name).toBe(true)
    }
  })
})

describe('paletteHex', () => {
  it('passes a raw hex through untouched', () => {
    expect(paletteHex('#ff0000')).toBe('#ff0000')
  })

  it('resolves a palette name to its hex', () => {
    expect(paletteHex('red')).toBe('#ef4444')
  })

  it('returns null for nothing or an unknown name', () => {
    expect(paletteHex(undefined)).toBeNull()
    expect(paletteHex('chartreuse')).toBeNull()
  })
})

describe('conceptColorHex', () => {
  it('prefers the explicit colour over the positional default', () => {
    expect(conceptColorHex('green', 0)).toBe('#22c55e')
  })

  it('falls back to the positional colour when none is set', () => {
    expect(conceptColorHex(undefined, 0)).toBe(paletteHex('red'))
    expect(conceptColorHex(undefined, 1)).toBe(paletteHex('blue'))
  })

  it('always returns a usable colour, never an empty string', () => {
    for (let i = 0; i < 25; i++) {
      expect(conceptColorHex(undefined, i)).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('honours a custom hex the user picked', () => {
    expect(conceptColorHex('#123456', 3)).toBe('#123456')
  })
})
