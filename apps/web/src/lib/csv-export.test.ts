import { describe, expect, it } from 'vitest'
import { csvField, csvRow, toCsv } from './csv-export'
import { parseCsvPreview } from './csv-preview'

describe('csvField', () => {
  it('leaves a plain value bare', () => {
    expect(csvField('abc')).toBe('abc')
    expect(csvField(42)).toBe('42')
  })

  it('quotes a value containing the delimiter', () => {
    // The real case: one unquoted comma shifts every column after it.
    expect(csvField('Sodium [Moles/volume] in Serum, Plasma'))
      .toBe('"Sodium [Moles/volume] in Serum, Plasma"')
  })

  it('doubles an embedded quote', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes newlines and CRs, so a field cannot break the record', () => {
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField('a\rb')).toBe('"a\rb"')
  })

  it('quotes padded values, which would otherwise lose their spaces', () => {
    expect(csvField(' lead')).toBe('" lead"')
    expect(csvField('trail ')).toBe('"trail "')
  })

  it('writes null and undefined as empty, not as the words', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })

  it('honours a tab delimiter', () => {
    expect(csvField('a\tb', '\t')).toBe('"a\tb"')
    // A comma is not special in a TSV.
    expect(csvField('a,b', '\t')).toBe('a,b')
  })
})

describe('csvRow', () => {
  it('joins fields and keeps empties in place', () => {
    expect(csvRow(['a', '', 'c'])).toBe('a,,c')
  })
})

describe('toCsv', () => {
  const ROWS = [
    { code: '50983', name: 'Sodium, Plasma', rows: 1200 },
    { code: '220045', name: 'O\'Brien "HR"', rows: 7 },
  ]
  const COLS = [
    { header: 'source_code', value: (r: typeof ROWS[0]) => r.code },
    { header: 'description', value: (r: typeof ROWS[0]) => r.name },
    { header: 'rows', value: (r: typeof ROWS[0]) => r.rows },
  ]

  it('writes a header then one line per row, CRLF-terminated', () => {
    const out = toCsv(ROWS, COLS)
    const lines = out.trimEnd().split('\r\n')
    expect(lines[0]).toBe('source_code,description,rows')
    expect(lines).toHaveLength(3)
    expect(out.endsWith('\r\n')).toBe(true)
  })

  it('round-trips through the app\'s own parser unchanged', () => {
    // The contract that matters: what we export, we can re-import.
    const parsed = parseCsvPreview(toCsv(ROWS, COLS), ',')
    expect(parsed?.headers).toEqual(['source_code', 'description', 'rows'])
    expect(parsed?.rows[0]).toEqual(['50983', 'Sodium, Plasma', '1200'])
    expect(parsed?.rows[1]).toEqual(['220045', 'O\'Brien "HR"', '7'])
  })

  it('emits a header-only document for no rows', () => {
    expect(toCsv([], COLS)).toBe('source_code,description,rows\r\n')
  })
})

describe('csvField refuses spreadsheet formula triggers', () => {
  // These rows carry names that came from the source data, and Excel/LibreOffice
  // execute a field starting with = + - @. Quoting is lossless on the DuckDB
  // read-back, so it costs nothing. The mapping export already did this; the
  // shared module (used by the ETL quality export) did not.
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tlead', '\rlead'])('quotes %j', (value) => {
    expect(csvField(value)).toBe(`"${value}"`)
  })

  it('quotes a formula trigger hidden behind the classic SUM payload', () => {
    expect(csvField('=cmd|\' /c calc\'!A1')).toBe('"=cmd|\' /c calc\'!A1"')
  })

  it('still leaves an ordinary value bare', () => {
    expect(csvField('Heart rate')).toBe('Heart rate')
    expect(csvField('a-b')).toBe('a-b')
  })
})
