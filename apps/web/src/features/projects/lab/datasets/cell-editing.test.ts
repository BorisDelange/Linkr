import { describe, expect, it } from 'vitest'
import { cellInputValue, parseCellInput } from './use-cell-editing'

describe('parseCellInput', () => {
  it('reads an empty input as null, not as an empty string', () => {
    // A cleared cell is missing data — storing "" would make it a value, which
    // then survives NA filters and stats as if it were one.
    expect(parseCellInput('', 'string')).toBeNull()
    expect(parseCellInput('   ', 'number')).toBeNull()
  })

  it('parses numbers', () => {
    expect(parseCellInput('70', 'number')).toBe(70)
    expect(parseCellInput('-3.5', 'number')).toBe(-3.5)
  })

  it('keeps an unparseable number as text rather than silently dropping it', () => {
    expect(parseCellInput('about 70', 'number')).toBe('about 70')
  })

  it('parses the boolean spellings a clinician actually types', () => {
    for (const yes of ['true', 'TRUE', '1', 'yes', 'Y']) {
      expect(parseCellInput(yes, 'boolean')).toBe(true)
    }
    for (const no of ['false', '0', 'no', 'N']) {
      expect(parseCellInput(no, 'boolean')).toBe(false)
    }
  })

  it('keeps an unrecognised boolean as text', () => {
    expect(parseCellInput('maybe', 'boolean')).toBe('maybe')
  })

  it('trims but otherwise preserves strings and dates', () => {
    expect(parseCellInput('  ventilated  ', 'string')).toBe('ventilated')
    expect(parseCellInput('2026-01-04', 'date')).toBe('2026-01-04')
  })
})

describe('cellInputValue', () => {
  it('shows an empty box for a null cell', () => {
    expect(cellInputValue(null)).toBe('')
    expect(cellInputValue(undefined)).toBe('')
  })

  it('round-trips through parseCellInput', () => {
    for (const [value, type] of [[70, 'number'], ['x', 'string'], [true, 'boolean']] as const) {
      expect(parseCellInput(cellInputValue(value), type)).toBe(value)
    }
  })

  it('renders a Date as an editable ISO day', () => {
    expect(cellInputValue(new Date('2026-01-04T12:00:00Z'))).toBe('2026-01-04')
  })
})
