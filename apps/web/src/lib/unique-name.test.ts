import { describe, expect, it } from 'vitest'
import { isNameTaken, uniqueName } from './unique-name'

describe('isNameTaken', () => {
  it('reports a collision only when the name is already used', () => {
    expect(isNameTaken('Adults', ['Children'])).toBe(false)
    expect(isNameTaken('Adults', ['Children', 'Adults'])).toBe(true)
    expect(isNameTaken('Adults', [])).toBe(false)
  })

  it('compares case-insensitively and ignores surrounding blanks', () => {
    expect(isNameTaken('adults', ['Adults'])).toBe(true)
    expect(isNameTaken('  Adults  ', ['Adults'])).toBe(true)
    expect(isNameTaken('Adults', ['  ADULTS  '])).toBe(true)
  })

  // A blank required field reports "name is missing", not "name is taken".
  it('never flags a blank candidate', () => {
    expect(isNameTaken('', ['Adults'])).toBe(false)
    expect(isNameTaken('   ', ['Adults', ''])).toBe(false)
  })

  // The two halves must agree, or a form rejects a name uniqueName just handed it.
  it('accepts exactly the name uniqueName produces', () => {
    const taken = ['Adults', 'Adults (2)']
    expect(isNameTaken(uniqueName('Adults', taken), taken)).toBe(false)
  })
})

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
