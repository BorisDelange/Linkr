import { describe, it, expect } from 'vitest'
import { formatClipboardList, type ClipboardListItem } from './clipboard-list-format'

const items: ClipboardListItem[] = [
  { concept_code: '718-7', concept_name: 'Hemoglobin', terminology_name: 'LOINC' },
  { concept_code: '4548-4', concept_name: 'HbA1c', vocabulary_id: 'LOINC' },
]

describe('formatClipboardList', () => {
  it('formats SQL leading-comma aligned (first item shifted, comments column-aligned)', () => {
    expect(formatClipboardList(items, 'sql')).toBe(
      'IN (\n      718-7  -- LOINC - Hemoglobin\n    , 4548-4 -- LOINC - HbA1c\n)',
    )
  })

  it('formats R with c() leading-comma and # comments', () => {
    expect(formatClipboardList(items, 'r')).toBe(
      'c(\n      718-7  # LOINC - Hemoglobin\n    , 4548-4 # LOINC - HbA1c\n)',
    )
  })

  it('formats Python trailing-comma with # comments', () => {
    expect(formatClipboardList(items, 'python')).toBe(
      '[\n    718-7,  # LOINC - Hemoglobin\n    4548-4, # LOINC - HbA1c\n]',
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
    expect(out).toBe('IN (\n      A        -- V - Short\n    , LONGCODE -- V - Long\n)')
  })

  it('emits an empty container for an empty list', () => {
    expect(formatClipboardList([], 'sql')).toBe('IN ()')
    expect(formatClipboardList([], 'r')).toBe('c()')
    expect(formatClipboardList([], 'python')).toBe('[]')
  })
})
