import { describe, it, expect } from 'vitest'
import { copyName, copyNameString } from './copy-name'

describe('copyName', () => {
  it('appends " (copy)" when nothing collides', () => {
    expect(copyName({ en: 'Sepsis', fr: 'Sepsis' }, [])).toEqual({
      en: 'Sepsis (copy)',
      fr: 'Sepsis (copy)',
    })
  })

  it('numbers the copy once " (copy)" is taken', () => {
    const siblings = [{ en: 'Sepsis' }, { en: 'Sepsis (copy)' }]
    expect(copyName({ en: 'Sepsis' }, siblings)).toEqual({ en: 'Sepsis (copy) 2' })
  })

  it('keeps counting past the numbered copies', () => {
    const siblings = [{ en: 'Sepsis (copy)' }, { en: 'Sepsis (copy) 2' }, { en: 'Sepsis (copy) 3' }]
    expect(copyName({ en: 'Sepsis' }, siblings)).toEqual({ en: 'Sepsis (copy) 4' })
  })

  it('matches collisions case-insensitively', () => {
    expect(copyName({ en: 'Sepsis' }, [{ en: 'SEPSIS (COPY)' }])).toEqual({ en: 'Sepsis (copy) 2' })
  })

  it('suffixes every language with the same number', () => {
    // Only the English name collides, but both languages must stay in step —
    // a copy whose FR name says "(copy)" and EN says "(copy) 2" is incoherent.
    const siblings = [{ en: 'Cohort (copy)', fr: 'Cohorte (copy)' }]
    expect(copyName({ en: 'Cohort', fr: 'Cohorte' }, siblings)).toEqual({
      en: 'Cohort (copy) 2',
      fr: 'Cohorte (copy) 2',
    })
  })

  it('expands a legacy plain-string name into every language', () => {
    expect(copyName('Sepsis', [])).toEqual({ en: 'Sepsis (copy)', fr: 'Sepsis (copy)' })
  })

  it('ignores siblings that are unrelated names', () => {
    expect(copyName({ en: 'Sepsis' }, [{ en: 'Shock (copy)' }])).toEqual({ en: 'Sepsis (copy)' })
  })
})

describe('copyNameString', () => {
  it('returns a plain string, not a localized map', () => {
    expect(copyNameString('Sepsis', [])).toBe('Sepsis (copy)')
  })

  it('numbers around existing copies', () => {
    expect(copyNameString('Sepsis', ['Sepsis', 'Sepsis (copy)'])).toBe('Sepsis (copy) 2')
  })
})
