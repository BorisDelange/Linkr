import { describe, expect, it } from 'vitest'
import { ROW_ORD, type DatasetCellValue } from '@linkr/format'
import { cellInputValue, cellKey, parseCellInput, parseCellKey, prune } from './use-cell-editing'

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

describe('cellKey / parseCellKey', () => {
  it('round-trips a negative ordinal', () => {
    // Added rows take negative ordinals, so the sign must survive the key.
    expect(parseCellKey(cellKey(-3, 'col_a'))).toEqual({ row: -3, column: 'col_a' })
  })

  it('round-trips a column id containing the separator', () => {
    expect(parseCellKey(cellKey(7, 'col_a:b:c'))).toEqual({ row: 7, column: 'col_a:b:c' })
  })
})

describe('prune', () => {
  const key = cellKey(1, 'col_a')

  it('drops an overlay the rows have caught up with', () => {
    const overlays = new Map([[key, 'new']])
    const rows = [{ [ROW_ORD]: 1, col_a: 'new' }]
    expect(prune(overlays, rows).size).toBe(0)
  })

  it('keeps an overlay while the rows still show the old value', () => {
    const overlays = new Map([[key, 'new']])
    const rows = [{ [ROW_ORD]: 1, col_a: 'old' }]
    expect(prune(overlays, rows).get(key)).toBe('new')
  })

  it('keeps an overlay whose row is not on this page', () => {
    // Nothing here can confirm the write, so dropping it would flash the old
    // value the moment the user paged back.
    const overlays = new Map([[key, 'new']])
    expect(prune(overlays, [{ [ROW_ORD]: 99, col_a: 'x' }]).get(key)).toBe('new')
  })

  it('settles a number written as text, as the CSV round-trip returns it', () => {
    const overlays = new Map<string, DatasetCellValue>([[key, 70]])
    expect(prune(overlays, [{ [ROW_ORD]: 1, col_a: '70' }]).size).toBe(0)
  })

  it('settles a cleared cell', () => {
    const overlays = new Map<string, DatasetCellValue>([[key, null]])
    expect(prune(overlays, [{ [ROW_ORD]: 1, col_a: null }]).size).toBe(0)
  })

  it('returns the same map when nothing settles, so React skips the render', () => {
    const overlays = new Map([[key, 'new']])
    expect(prune(overlays, [{ [ROW_ORD]: 1, col_a: 'old' }])).toBe(overlays)
  })
})
