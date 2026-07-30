import { describe, it, expect } from 'vitest'
import { formatClipboardList, type ClipboardListItem } from './clipboard-list-format'

// Plain-integer concept_ids: the bare (unquoted) OMOP-concept_id path. Non-numeric
// codes (e.g. LOINC "718-7") are covered by the quoting tests below.
const items: ClipboardListItem[] = [
  { concept_code: '3000963', concept_name: 'Hemoglobin', terminology_name: 'LOINC' },
  { concept_code: '3004410', concept_name: 'HbA1c', vocabulary_id: 'LOINC' },
]

describe('formatClipboardList', () => {
  it('formats SQL leading-comma aligned (first item shifted, comments column-aligned)', () => {
    expect(formatClipboardList(items, 'sql')).toBe(
      'IN (\n      3000963 -- LOINC - Hemoglobin\n    , 3004410 -- LOINC - HbA1c\n)',
    )
  })

  it('formats R with c() leading-comma and # comments', () => {
    expect(formatClipboardList(items, 'r')).toBe(
      'c(\n      3000963 # LOINC - Hemoglobin\n    , 3004410 # LOINC - HbA1c\n)',
    )
  })

  it('formats Python trailing-comma with # comments', () => {
    expect(formatClipboardList(items, 'python')).toBe(
      '[\n    3000963, # LOINC - Hemoglobin\n    3004410, # LOINC - HbA1c\n]',
    )
  })

  it('prefers terminology_name over vocabulary_id in the comment', () => {
    const out = formatClipboardList(
      [{ concept_code: 'X', concept_name: 'N', terminology_name: 'Term', vocabulary_id: 'Vocab' }],
      'sql',
    )
    expect(out).toContain('-- Term - N')
  })

  it('omits the comment when there is no vocab and no name', () => {
    expect(formatClipboardList([{ concept_code: '42' }], 'sql')).toBe('IN (\n      42\n)')
  })

  it('pads codes so comments align in a column (SQL)', () => {
    const out = formatClipboardList(
      [
        { concept_code: 'A', concept_name: 'Short', terminology_name: 'V' },
        { concept_code: 'LONGCODE', concept_name: 'Long', terminology_name: 'V' },
      ],
      'sql',
    )
    // Non-numeric codes are quoted; padding aligns on the rendered (quoted) width.
    expect(out).toBe("IN (\n      'A'        -- V - Short\n    , 'LONGCODE' -- V - Long\n)")
  })

  it('emits an empty container for an empty list', () => {
    expect(formatClipboardList([], 'sql')).toBe('IN ()')
    expect(formatClipboardList([], 'r')).toBe('c()')
    expect(formatClipboardList([], 'python')).toBe('[]')
  })

  it('quotes non-numeric codes so the generated SQL is valid', () => {
    const out = formatClipboardList([{ concept_code: 'E11.9' }, { concept_code: '718-7' }], 'sql')
    expect(out).toBe("IN (\n      'E11.9'\n    , '718-7'\n)")
  })

  it('escapes single quotes in SQL string codes', () => {
    const out = formatClipboardList([{ concept_code: "a'b" }, { concept_code: 'X' }], 'sql')
    expect(out).toContain("'a''b'")
  })

  it('quotes and escapes non-numeric codes in R and Python', () => {
    expect(formatClipboardList([{ concept_code: 'A"B' }], 'r')).toBe('c(\n      "A\\"B"\n)')
    expect(formatClipboardList([{ concept_code: 'C\\D' }], 'python')).toBe('[\n    "C\\\\D",\n]')
  })

  it('keeps a pure-integer list bare (unquoted)', () => {
    expect(formatClipboardList([{ concept_code: '42' }, { concept_code: '-7' }], 'sql')).toBe(
      'IN (\n      42\n    , -7\n)',
    )
  })

  it('collapses a newline in the concept name so it cannot break the snippet', () => {
    const out = formatClipboardList(
      [{ concept_code: '1', concept_name: 'line1\nline2', terminology_name: 'V' }],
      'sql',
    )
    expect(out).toBe('IN (\n      1 -- V - line1 line2\n)')
    expect(out.split('\n')).toHaveLength(3)
  })

  it('formats a single-item list', () => {
    expect(formatClipboardList([{ concept_code: '99' }], 'python')).toBe('[\n    99,\n]')
  })
})
