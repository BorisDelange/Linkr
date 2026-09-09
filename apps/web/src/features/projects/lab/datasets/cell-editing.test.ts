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
  const OP = 'op-1'
  /** A landed overlay: the write returned, so the log is the authority. */
  const landed = (value: DatasetCellValue) => new Map([[key, { value, opId: OP, inFlight: false }]])
  const inLog = new Set([OP])

  it('drops an overlay the rows have caught up with', () => {
    const rows = [{ [ROW_ORD]: 1, col_a: 'new' }]
    expect(prune(landed('new'), rows, inLog).size).toBe(0)
  })

  it('keeps an overlay while the rows still show the old value', () => {
    const rows = [{ [ROW_ORD]: 1, col_a: 'old' }]
    expect(prune(landed('new'), rows, inLog).get(key)?.value).toBe('new')
  })

  it('keeps an overlay whose row is not on this page', () => {
    // Nothing here can confirm the write, so dropping it would flash the old
    // value the moment the user paged back.
    const rows = [{ [ROW_ORD]: 99, col_a: 'x' }]
    expect(prune(landed('new'), rows, inLog).get(key)?.value).toBe('new')
  })

  it('drops an overlay whose op has left the log', () => {
    // What an undo does. The rows revert to the OLD value, which can never agree
    // with the overlay — so without this the undone value stayed on screen.
    const rows = [{ [ROW_ORD]: 1, col_a: 'old' }]
    expect(prune(landed('new'), rows, new Set<string>()).size).toBe(0)
  })

  it('keeps an in-flight overlay the log has not seen yet', () => {
    // The op is still on its way to the server; its absence proves nothing.
    const overlays = new Map([[key, { value: 'new', opId: OP, inFlight: true }]])
    const rows = [{ [ROW_ORD]: 1, col_a: 'old' }]
    expect(prune(overlays, rows, new Set<string>()).get(key)?.value).toBe('new')
  })

  it('settles a number written as text, as the CSV round-trip returns it', () => {
    expect(prune(landed(70), [{ [ROW_ORD]: 1, col_a: '70' }], inLog).size).toBe(0)
  })

  it('settles a cleared cell', () => {
    expect(prune(landed(null), [{ [ROW_ORD]: 1, col_a: null }], inLog).size).toBe(0)
  })

  it('returns the same map when nothing settles, so React skips the render', () => {
    const overlays = landed('new')
    expect(prune(overlays, [{ [ROW_ORD]: 1, col_a: 'old' }], inLog)).toBe(overlays)
  })
})
