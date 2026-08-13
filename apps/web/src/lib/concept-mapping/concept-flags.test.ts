import { describe, it, expect } from 'vitest'
import { normalizeConceptFlag } from './concept-flags'

describe('normalizeConceptFlag', () => {
  it('passes through the stored codes', () => {
    expect(normalizeConceptFlag('S')).toBe('S')
    expect(normalizeConceptFlag('C')).toBe('C')
    expect(normalizeConceptFlag('D')).toBe('D')
    expect(normalizeConceptFlag('U')).toBe('U')
  })

  // The regression: CHAR(1) columns arrive padded, and comparing them raw
  // against 'S' made every concept read as non-standard.
  it('trims a padded CHAR(1) value', () => {
    expect(normalizeConceptFlag('S ')).toBe('S')
    expect(normalizeConceptFlag(' C')).toBe('C')
  })

  it('uppercases a lowercased value', () => {
    expect(normalizeConceptFlag('s')).toBe('S')
  })

  // A padded-empty invalid_reason must read as "valid", not as an unknown
  // invalid code.
  it('reads an absent flag as null', () => {
    expect(normalizeConceptFlag(null)).toBeNull()
    expect(normalizeConceptFlag(undefined)).toBeNull()
    expect(normalizeConceptFlag('')).toBeNull()
    expect(normalizeConceptFlag('   ')).toBeNull()
  })

  it('stringifies a non-string value rather than dropping it', () => {
    expect(normalizeConceptFlag({ toString: () => 'S' })).toBe('S')
  })
})
