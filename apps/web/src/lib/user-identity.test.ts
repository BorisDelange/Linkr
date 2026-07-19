import { describe, it, expect } from 'vitest'
import { isValidOrcid, normalizeOrcid, userDisplayName, userToAuthorDetails } from './user-identity'

describe('userDisplayName', () => {
  it('joins first and last name', () => {
    expect(userDisplayName({ firstName: 'Alice', lastName: 'Martin', username: 'amartin' })).toBe('Alice Martin')
  })

  it('falls back to the username when no name is set', () => {
    expect(userDisplayName({ firstName: '', lastName: '', username: 'amartin' })).toBe('amartin')
    expect(userDisplayName({ username: 'amartin' })).toBe('amartin')
  })

  it('uses whichever name part is present', () => {
    expect(userDisplayName({ firstName: 'Alice', username: 'amartin' })).toBe('Alice')
    expect(userDisplayName({ lastName: 'Martin', username: 'amartin' })).toBe('Martin')
  })
})

describe('userToAuthorDetails', () => {
  it('projects only the non-empty identity fields', () => {
    expect(
      userToAuthorDetails({
        firstName: 'Alice',
        lastName: 'Martin',
        affiliation: 'CHU Rennes',
        profession: 'Data scientist',
        orcid: '0000-0002-1825-0097',
        username: 'amartin',
        role: 'user',
      }),
    ).toEqual({
      firstName: 'Alice',
      lastName: 'Martin',
      affiliation: 'CHU Rennes',
      profession: 'Data scientist',
      orcid: '0000-0002-1825-0097',
    })
  })

  it('drops blank / whitespace-only fields', () => {
    expect(userToAuthorDetails({ firstName: 'Alice', lastName: '   ', affiliation: '' })).toEqual({
      firstName: 'Alice',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(userToAuthorDetails({ firstName: '  Alice  ' })).toEqual({ firstName: 'Alice' })
  })

  it('carries email and keeps multilingual affiliation/profession verbatim', () => {
    expect(
      userToAuthorDetails({
        firstName: 'Alice',
        email: 'alice@chu-rennes.fr',
        affiliation: { en: 'Rennes University Hospital', fr: 'CHU de Rennes' },
        profession: { en: 'Intensivist', fr: 'Réanimateur' },
      }),
    ).toEqual({
      firstName: 'Alice',
      email: 'alice@chu-rennes.fr',
      affiliation: { en: 'Rennes University Hospital', fr: 'CHU de Rennes' },
      profession: { en: 'Intensivist', fr: 'Réanimateur' },
    })
  })

  it('drops an empty multilingual value (all languages blank)', () => {
    expect(
      userToAuthorDetails({ firstName: 'Alice', affiliation: { en: '', fr: '' } }),
    ).toEqual({ firstName: 'Alice' })
  })
})

describe('isValidOrcid', () => {
  it('accepts a canonical ORCID', () => {
    expect(isValidOrcid('0000-0002-1825-0097')).toBe(true)
  })

  it('accepts the X checksum digit in the last position', () => {
    expect(isValidOrcid('0000-0002-1694-233X')).toBe(true)
  })

  it('treats empty/absent as valid (the field is optional)', () => {
    expect(isValidOrcid('')).toBe(true)
    expect(isValidOrcid(undefined)).toBe(true)
    expect(isValidOrcid(null)).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isValidOrcid('0000-0002-1825')).toBe(false)          // too short
    expect(isValidOrcid('0000000218250097')).toBe(false)         // no hyphens
    expect(isValidOrcid('0000-0002-1825-009Z')).toBe(false)      // bad checksum char
    expect(isValidOrcid('https://orcid.org/0000-0002-1825-0097')).toBe(false)  // must be normalized first
  })
})

describe('normalizeOrcid', () => {
  it('hyphenates a 16-digit compact id', () => {
    expect(normalizeOrcid('0000000218250097')).toBe('0000-0002-1825-0097')
  })

  it('strips the orcid.org URL prefix', () => {
    expect(normalizeOrcid('https://orcid.org/0000-0002-1825-0097')).toBe('0000-0002-1825-0097')
  })

  it('preserves a trailing X checksum', () => {
    expect(normalizeOrcid('000000021694233X')).toBe('0000-0002-1694-233X')
  })

  it('leaves unrecognized input untouched (so the validator can reject it)', () => {
    expect(normalizeOrcid('not-an-orcid')).toBe('not-an-orcid')
  })

  it('round-trips a canonical id through normalize + validate', () => {
    const n = normalizeOrcid('0000-0002-1825-0097')
    expect(n).toBe('0000-0002-1825-0097')
    expect(isValidOrcid(n)).toBe(true)
  })
})
