import { describe, expect, it } from 'vitest'
import { uniqueName } from './unique-name'

describe('uniqueName', () => {
  it('keeps the base name when it is free', () => {
    expect(uniqueName('OMOP CDM 5.4', [])).toBe('OMOP CDM 5.4')
    expect(uniqueName('OMOP CDM 5.4', ['MIMIC-IV'])).toBe('OMOP CDM 5.4')
  })

  it('suffixes from (2) and skips the numbers already taken', () => {
    expect(uniqueName('OMOP CDM 5.4', ['OMOP CDM 5.4'])).toBe('OMOP CDM 5.4 (2)')
    expect(uniqueName('OMOP CDM 5.4', ['OMOP CDM 5.4', 'OMOP CDM 5.4 (2)']))
      .toBe('OMOP CDM 5.4 (3)')
    // A gap is reused rather than always appending at the end.
    expect(uniqueName('S', ['S', 'S (3)'])).toBe('S (2)')
  })

  it('compares case-insensitively and ignores surrounding blanks', () => {
    expect(uniqueName('Omop', ['OMOP'])).toBe('Omop (2)')
    expect(uniqueName('Omop', ['  omop  '])).toBe('Omop (2)')
  })
})
