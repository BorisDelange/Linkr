import { describe, expect, it } from 'vitest'
import { cellText } from './cell-context-menu'

describe('cellText', () => {
  it('copies nothing for an empty cell', () => {
    expect(cellText(null)).toBe('')
    expect(cellText(undefined)).toBe('')
  })

  it('keeps scalars as written, with no thousands separators', () => {
    expect(cellText('LOINC')).toBe('LOINC')
    expect(cellText(3004249)).toBe('3004249')
    expect(cellText(false)).toBe('false')
  })

  it('joins lists and serializes objects', () => {
    expect(cellText(['A', 'B', 2])).toBe('A, B, 2')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
  })
})
