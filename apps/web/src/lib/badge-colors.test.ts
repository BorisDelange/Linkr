import { describe, expect, it } from 'vitest'
import { contrastOnWhite, darkenForWhiteBackground } from './badge-colors'

describe('contrastOnWhite', () => {
  it('is 1 for white and 21 for black', () => {
    expect(contrastOnWhite('#ffffff')).toBeCloseTo(1, 2)
    expect(contrastOnWhite('#000000')).toBeCloseTo(21, 1)
  })

  it('accepts 3-digit hex and a missing #', () => {
    expect(contrastOnWhite('#fff')).toBeCloseTo(contrastOnWhite('#ffffff'), 5)
    expect(contrastOnWhite('000')).toBeCloseTo(contrastOnWhite('#000000'), 5)
  })

  it('treats an unparseable colour as exactly passing, so it is left alone', () => {
    expect(contrastOnWhite('not-a-colour')).toBe(4.5)
    expect(darkenForWhiteBackground('not-a-colour')).toBe('not-a-colour')
  })
})

describe('darkenForWhiteBackground', () => {
  it('leaves an already-legible colour untouched', () => {
    for (const color of ['#1d4ed8', '#166534', '#7f1d1d', '#000000']) {
      expect(darkenForWhiteBackground(color)).toBe(color)
    }
  })

  it('darkens a pale colour until it clears AA on white', () => {
    // Pale yellow: 1.1:1 against white, unreadable as text.
    expect(contrastOnWhite('#fef08a')).toBeLessThan(1.5)
    const darkened = darkenForWhiteBackground('#fef08a')
    expect(darkened).not.toBe('#fef08a')
    expect(contrastOnWhite(darkened)).toBeGreaterThanOrEqual(4.5)
  })

  it('clears AA for every colour across the hue circle, however pale', () => {
    const pales = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ffd7d7', '#e0ffe0', '#fafafa', '#ffffff']
    for (const color of pales) {
      expect(contrastOnWhite(darkenForWhiteBackground(color))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('darkens no further than it must, so the colour stays recognisable', () => {
    // Landing far below the target would wash every pale pick out to near-black.
    for (const color of ['#ffff00', '#00ff00', '#fef08a', '#00ffff']) {
      expect(contrastOnWhite(darkenForWhiteBackground(color))).toBeLessThan(5.5)
    }
  })

  it('holds the hue: a darkened yellow is still yellow', () => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(darkenForWhiteBackground('#ffff00').slice(i, i + 2), 16))
    expect(r).toBe(g)
    expect(b).toBeLessThan(r)
  })

  it('is idempotent — darkening a darkened colour changes nothing', () => {
    const once = darkenForWhiteBackground('#fef08a')
    expect(darkenForWhiteBackground(once)).toBe(once)
  })
})
