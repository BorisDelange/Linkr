import { describe, it, expect } from 'vitest'
import { localized, toLocalized, setLocalized } from './localized'

// localized() is the single read path for every multilingual name/description/
// readme in the app. A wrong fallback shows an empty or wrong-language label.
describe('localized', () => {
  it('prefers the active language', () => {
    expect(localized({ en: 'Hello', fr: 'Bonjour' }, 'fr')).toBe('Bonjour')
  })

  it('falls back to English when the active language is missing', () => {
    expect(localized({ en: 'Hello' }, 'fr')).toBe('Hello')
  })

  it('falls back to the first available value when English is missing', () => {
    expect(localized({ de: 'Hallo' }, 'fr')).toBe('Hallo')
  })

  it('treats a defined-but-empty language as absent (falls back to English)', () => {
    expect(localized({ en: 'Hello', fr: '' }, 'fr')).toBe('Hello')
  })

  it('accepts a legacy plain string', () => {
    expect(localized('Legacy', 'fr')).toBe('Legacy')
  })

  it('returns empty string for nullish or empty', () => {
    expect(localized(null, 'en')).toBe('')
    expect(localized(undefined, 'en')).toBe('')
    expect(localized({}, 'en')).toBe('')
  })
})

// toLocalized() is the migration/backfill path: a legacy string must land in
// every language so it displays regardless of the active language.
describe('toLocalized', () => {
  it('copies a legacy string into every language', () => {
    expect(toLocalized('X')).toEqual({ en: 'X', fr: 'X' })
  })

  it('passes an already-localized object through unchanged', () => {
    const v = { en: 'A', fr: 'B' }
    expect(toLocalized(v)).toBe(v)
  })

  it('maps nullish to an empty object', () => {
    expect(toLocalized(undefined)).toEqual({})
    expect(toLocalized(null)).toEqual({})
  })

  it('honours a custom language list', () => {
    expect(toLocalized('X', ['en', 'fr', 'de'])).toEqual({ en: 'X', fr: 'X', de: 'X' })
  })
})

// setLocalized() writes only the active language, leaving others intact — the
// core of the "single field edits the active language" UX.
describe('setLocalized', () => {
  it('sets the active language without touching others', () => {
    expect(setLocalized({ en: 'Hello', fr: 'Bonjour' }, 'fr', 'Salut')).toEqual({
      en: 'Hello',
      fr: 'Salut',
    })
  })

  it('upgrades a legacy string then sets the active language', () => {
    expect(setLocalized('Legacy', 'fr', 'Nouveau')).toEqual({
      en: 'Legacy',
      fr: 'Nouveau',
    })
  })

  it('creates the object when starting from nullish', () => {
    expect(setLocalized(undefined, 'en', 'First')).toEqual({ en: 'First' })
  })
})
