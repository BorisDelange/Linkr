import { describe, expect, it } from 'vitest'
import { csvDelimiterFor, parseCsvPreview, splitCsvLine } from './csv-preview'

describe('csvDelimiterFor', () => {
  it('recognises csv and tsv, case-insensitively', () => {
    expect(csvDelimiterFor('a.csv')).toBe(',')
    expect(csvDelimiterFor('a.CSV')).toBe(',')
    expect(csvDelimiterFor('a.tsv')).toBe('\t')
  })

  it('returns undefined for anything else', () => {
    expect(csvDelimiterFor('a.sql')).toBeUndefined()
    expect(csvDelimiterFor('noext')).toBeUndefined()
  })
})

describe('splitCsvLine', () => {
  it('splits a plain line', () => {
    expect(splitCsvLine('a,b,c', ',')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a quoted comma in one cell', () => {
    // The real case: a concept name like "Sodium [Moles/volume] in Serum, Plasma"
    // was torn in two, shifting every column after it.
    expect(splitCsvLine('50983,"Sodium, Plasma",LOINC', ','))
      .toEqual(['50983', 'Sodium, Plasma', 'LOINC'])
  })

  it('unescapes a doubled quote', () => {
    expect(splitCsvLine('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b'])
  })

  it('keeps empty fields, so columns stay aligned', () => {
    expect(splitCsvLine('a,,c', ',')).toEqual(['a', '', 'c'])
    expect(splitCsvLine('a,b,', ',')).toEqual(['a', 'b', ''])
  })

  it('handles tabs', () => {
    expect(splitCsvLine('a\tb', '\t')).toEqual(['a', 'b'])
  })
})

describe('parseCsvPreview', () => {
  it('takes the first line as headers', () => {
    const out = parseCsvPreview('h1,h2\n1,2\n', ',')
    expect(out?.headers).toEqual(['h1', 'h2'])
    expect(out?.rows).toEqual([['1', '2']])
    expect(out?.truncated).toBe(false)
  })

  it('returns null for empty or blank text', () => {
    expect(parseCsvPreview('', ',')).toBeNull()
    expect(parseCsvPreview('   \n  ', ',')).toBeNull()
  })

  it('reports truncation past the row cap', () => {
    const text = 'h\n' + Array.from({ length: 5 }, (_, i) => `r${i}`).join('\n')
    const out = parseCsvPreview(text, ',', 3)
    expect(out?.rows).toHaveLength(3)
    expect(out?.truncated).toBe(true)
  })

  it('treats a newline inside quotes as part of the field', () => {
    // Otherwise the record breaks in two and the table gains a bogus row.
    const out = parseCsvPreview('h1,h2\n"line1\nline2",b\n', ',')
    expect(out?.rows).toEqual([['line1\nline2', 'b']])
  })

  it('handles CRLF line endings', () => {
    const out = parseCsvPreview('h1,h2\r\n1,2\r\n', ',')
    expect(out?.rows).toEqual([['1', '2']])
  })

  it('skips blank lines rather than emitting empty rows', () => {
    const out = parseCsvPreview('h\n1\n\n2\n', ',')
    expect(out?.rows).toEqual([['1'], ['2']])
  })

  it('parses a header-only file as a table with no rows', () => {
    const out = parseCsvPreview('h1,h2\n', ',')
    expect(out?.headers).toEqual(['h1', 'h2'])
    expect(out?.rows).toEqual([])
  })

  it('parses the STCM export shape end to end', () => {
    const csv = 'source_code,source_concept_id,source_code_description,invalid_reason\n'
      + '50983,2000000001,"Sodium [Moles/volume] in Serum, Plasma",\n'
      + '220045,2000000002,"O\'Brien ""HR""",\n'
    const out = parseCsvPreview(csv, ',')
    expect(out?.rows[0]).toEqual(['50983', '2000000001', 'Sodium [Moles/volume] in Serum, Plasma', ''])
    expect(out?.rows[1][2]).toBe('O\'Brien "HR"')
  })
})
