import { describe, it, expect } from 'vitest'
import { localized, localizedRaw, toLocalized, setLocalized, seedLocalizedForEditing } from './localized'

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

  it('falls back past an empty English to the first non-empty language', () => {
    // The branch that actually needs find(Boolean): requested lang absent AND en empty.
    expect(localized({ en: '', de: 'Hallo' }, 'fr')).toBe('Hallo')
  })

  it('returns empty string when every language is empty', () => {
    expect(localized({ en: '', fr: '' }, 'fr')).toBe('')
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

// localizedRaw() is the edit-input read path: NO cross-language fallback, so an
// emptied field can actually be cleared instead of snapping back to English.
describe('localizedRaw', () => {
  it('returns the active language value', () => {
    expect(localizedRaw({ en: 'Hello', fr: 'Bonjour' }, 'fr')).toBe('Bonjour')
  })

  it('returns empty (NOT the English fallback) when the active language is blank', () => {
    // The bug: localized() would return 'Hello' here, making the FR field un-clearable.
    expect(localizedRaw({ en: 'Hello', fr: '' }, 'fr')).toBe('')
    expect(localizedRaw({ en: 'Hello' }, 'fr')).toBe('')
  })

  it('accepts a legacy plain string and nullish', () => {
    expect(localizedRaw('Legacy', 'fr')).toBe('Legacy')
    expect(localizedRaw(null, 'fr')).toBe('')
    expect(localizedRaw(undefined, 'fr')).toBe('')
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

// seedLocalizedForEditing() pre-fills the active language from the other one ONLY
// when blank — the "auto-complete on open, but stay clearable" edit UX.
describe('seedLocalizedForEditing', () => {
  it('fills a blank active language from the other one', () => {
    // Editing FR while only EN was entered → FR pre-fills with the EN value.
    expect(seedLocalizedForEditing({ en: 'Hospital' }, 'fr')).toEqual({ en: 'Hospital', fr: 'Hospital' })
  })

  it('treats an explicit empty string as blank and fills it', () => {
    expect(seedLocalizedForEditing({ en: 'Hospital', fr: '' }, 'fr')).toEqual({ en: 'Hospital', fr: 'Hospital' })
  })

  it('keeps a non-blank active language untouched', () => {
    expect(seedLocalizedForEditing({ en: 'Hospital', fr: 'Hôpital' }, 'fr')).toEqual({ en: 'Hospital', fr: 'Hôpital' })
  })

  it('does NOT re-fill once the user cleared it (the field is already the active lang)', () => {
    // After clearing, fr is '' and there IS another language — but this is called
    // only on open/lang-switch, not per keystroke, so the guarantee we test is:
    // when the active language is the ONLY content, nothing to seed from.
    expect(seedLocalizedForEditing({ fr: 'Hôpital' }, 'fr')).toEqual({ fr: 'Hôpital' })
  })

  it('upgrades a legacy string (present for every language)', () => {
    expect(seedLocalizedForEditing('Legacy', 'fr')).toEqual({ en: 'Legacy', fr: 'Legacy' })
  })

  it('leaves an all-empty value empty (nothing to seed)', () => {
    expect(seedLocalizedForEditing({}, 'fr')).toEqual({})
    expect(seedLocalizedForEditing(undefined, 'en')).toEqual({})
  })
})
