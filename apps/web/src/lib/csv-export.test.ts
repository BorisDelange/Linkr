import { describe, expect, it } from 'vitest'
import { csvField, csvHumanField, csvRow, spreadsheetText, toCsv } from './csv-export'
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

describe('csvField stays lossless', () => {
  // Machine consumers (DuckDB read-back, OMOP loaders) must get the value unchanged.
  // Quotes are CSV syntax a spreadsheet removes: they protect nothing, see csvHumanField.
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tlead', '\rlead'])('quotes %j and keeps its text', (value) => {
    expect(csvField(value)).toBe(`"${value}"`)
  })

  it('still leaves an ordinary value bare', () => {
    expect(csvField('Heart rate')).toBe('Heart rate')
    expect(csvField('a-b')).toBe('a-b')
  })
})

describe('a CSV for people holds text, never a formula', () => {
  it.each(['=1+1', '+A1', '-A1', '@SUM(A1)', '\tlead', '\rlead', '\nlead', '=HYPERLINK("http://x","y")', '-1+1'])(
    'prefixes %j with a quote', (value) => {
      expect(spreadsheetText(value)).toBe(`'${value}`)
    })

  it.each(['-1', '+1', '-1.5', '-1,5', '+33612345678', '-1e5', '1+1', 'a=b', '-', '=', ''])('leaves %j alone', (value) => {
    expect(spreadsheetText(value)).toBe(value)
  })

  it('reads the prefix back through the writer', () => {
    expect(csvHumanField('=A1,B1')).toBe(`"'=A1,B1"`)
    expect(csvHumanField(-3)).toBe('"-3"')
    expect(csvHumanField(null)).toBe('')
  })

  it('toCsv guards headers and cells', () => {
    const text = toCsv([{ a: '=A1', n: -2 }], [
      { header: '@h', value: (r) => r.a },
      { header: 'n', value: (r) => r.n },
    ])
    expect(text).toBe(`'@h,n\r\n'=A1,"-2"\r\n`)
  })
})
