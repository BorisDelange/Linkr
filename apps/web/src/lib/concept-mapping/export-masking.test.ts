import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXPORT_MIN_COUNT,
  maskFrequency,
  maskSourceConceptsCsv,
  setExportMinCount,
  SourceConceptsUnreadableError,
} from './export-masking'

// Shared with apps/api/tests/test_export_masking.py: the two sides must emit the
// same bytes, or front-only and server clients would fight over the file in git.
const dir = join(__dirname, '__fixtures__', 'export-masking')
const read = (name: string) => readFileSync(join(dir, name), 'utf-8')

describe('maskSourceConceptsCsv', () => {
  it('masks small counts, withholds small profiles, drops extremes, event dates and small bins', () => {
    expect(maskSourceConceptsCsv(read('input.csv'), null, 11)).toBe(read('expected.csv'))
  })

  it('lets out only the fields the rule judged, and believes no stamp a pass could not have left', () => {
    const masked = maskSourceConceptsCsv(read('input-allowlist.csv'), null, 11)
    expect(masked).toBe(read('expected-allowlist.csv'))
    expect(masked).not.toContain('DUMMY')
    expect(maskSourceConceptsCsv(masked, null, 11)).toBe(masked)
  })

  it('changes nothing in a file it masked already, unless the threshold rose', () => {
    // A pulled file is masked already; pushing it back must not erode it further.
    const once = maskSourceConceptsCsv(read('input.csv'), null, 11)
    expect(maskSourceConceptsCsv(once, null, 11)).toBe(once)
    expect(maskSourceConceptsCsv(once, null, 20)).not.toBe(once)
  })

  it('follows the project column mapping and the file delimiter', () => {
    expect(maskSourceConceptsCsv(read('input-semicolon.csv'), { recordCountColumn: 'n_records', terminologyColumn: 'vocab' }, 11))
      .toBe(read('expected-semicolon.csv'))
  })

  it('reads the file with its parse options: lines skipped, delimiter, no header', () => {
    const skipPipe = { skipRows: 2, delimiter: '|' }
    const mapping = { patientCountColumn: 'n_pat', recordCountColumn: 'n_rec' }
    expect(maskSourceConceptsCsv(read('input-skip-pipe.csv'), mapping, 11, skipPipe)).toBe(read('expected-skip-pipe.csv'))
    expect(maskSourceConceptsCsv(read('input-no-header.csv'), { conceptCodeColumn: 'column0', conceptNameColumn: 'column1', patientCountColumn: 'column2' }, 11, { hasHeader: false }))
      .toBe(read('expected-no-header.csv'))
  })

  it('refuses a file that lacks a count column the mapping names', () => {
    const mapping = { patientCountColumn: 'n_pat', recordCountColumn: 'n_rec' }
    expect(() => maskSourceConceptsCsv(read('input-skip-pipe.csv'), mapping, 11)).toThrow(SourceConceptsUnreadableError)
  })

  it('drops a byte order mark, as the server does', () => {
    expect(maskSourceConceptsCsv(`\uFEFF${read('input.csv')}`, null, 11)).toBe(read('expected.csv'))
    expect(maskSourceConceptsCsv('\uFEFFcode,name\n1,2\n', null, 11)).toBe('code,name\n1,2\n')
  })

  it('masks a profile cell over 128 KiB, and withholds one nested past the depth cap, as the server does', () => {
    // Twin of _large_cells() in test_export_masking.py.
    const big = `"{""rows_count"":500,""patients_count"":50,""range"":[${'0,'.repeat(100_000)}0]}"`
    const deep = `"{""rows_count"":500,""patients_count"":50,""x"":${'['.repeat(5_000)}${']'.repeat(5_000)}}"`
    const text = `concept_code,record_count,patient_count,info_json\nBIG,500,50,${big}\nDEEP,500,50,${deep}\n`
    expect(text.length).toBeGreaterThan(200 * 1024)
    expect(maskSourceConceptsCsv(text, null, 11)).toBe(read('expected-large-cell.csv'))
  })

  it('judges every column, as the server does', () => {
    const mapping = { conceptCodeColumn: 'concept_code', conceptNameColumn: 'concept_name', extraColumns: ['specimen'] }
    expect(maskSourceConceptsCsv(read('input-columns.csv'), mapping, 11)).toBe(read('expected-columns.csv'))
  })

  it.each([
    'concept_code;name;record_count;patient_count\nA1;"unbalanced name;30;20\nA2;x;2;2\nA3;y;3;3\n',
    'concept_code,record_count\n"A"B,3\n',
    'concept_code,record_count\n"A" ,3\n',
    'concept_code,record_count\nA,3,extra\n',
    'concept_code,name,record_count\nA,3\n',
  ])('refuses a file it cannot read row for row, as the server does: %j', (text) => {
    expect(() => maskSourceConceptsCsv(text, null, 11)).toThrow(SourceConceptsUnreadableError)
  })

  it('reads every line ending alike, and refuses lines to skip the file does not have', () => {
    expect(maskSourceConceptsCsv('Generated\rconcept_code,record_count\rX,3\rY,300\r', null, 11, { skipRows: 1 }))
      .toBe('Generated\nconcept_code,record_count\nX,<11\nY,300\n')
    expect(() => maskSourceConceptsCsv('concept_code,record_count', null, 11, { skipRows: 5 })).toThrow(SourceConceptsUnreadableError)
  })

  it.each(['5,0', '+5', '1e0', '5 patients', '5\u00a0', '~5', '-1', '0x5', '1_0'])('masks a count cell that is no plain number: %j', (value) => {
    expect(maskSourceConceptsCsv(`concept_code,record_count\nA,"${value}"\n`, null, 11)).toBe('concept_code,record_count\nA,<11\n')
  })

  it('leaves only a real LFS pointer as it is', () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12\n`
    expect(maskSourceConceptsCsv(pointer, null, 11)).toBe(pointer)
    expect(maskSourceConceptsCsv('version https://git-lfs,record_count\nA,3\n', null, 11)).toContain('<11')
  })

  it('leaves a file with nothing to mask byte for byte', () => {
    const text = 'terminology,concept_code,record_count\r\nX,1,500\r\n'
    expect(maskSourceConceptsCsv(text, null, 11)).toBe(text)
    expect(maskSourceConceptsCsv(read('input.csv'), null, 1)).toBe(read('input.csv'))
  })
})

describe('maskFrequency', () => {
  it('turns a small frequency into unknown', () => {
    expect([maskFrequency(3), maskFrequency(0), maskFrequency(11), maskFrequency(null)]).toEqual([null, 0, 11, null])
  })
})

describe('setExportMinCount', () => {
  it('makes the instance threshold the default of every mask, and ignores a non-integer', () => {
    try {
      setExportMinCount(20)
      setExportMinCount(2.5)
      setExportMinCount(Number.NaN)
      expect(maskFrequency(15)).toBeNull()
      expect(maskSourceConceptsCsv('concept,patient_count\na,15\n')).toBe('concept,patient_count\na,<20\n')
    } finally {
      setExportMinCount(EXPORT_MIN_COUNT)
    }
  })

  it('follows a server that turns masking off with 0, as the server does', () => {
    try {
      setExportMinCount(0)
      expect(maskFrequency(5)).toBe(5)
      expect(maskSourceConceptsCsv('concept,patient_count\na,5\n')).toBe('concept,patient_count\na,5\n')
    } finally {
      setExportMinCount(EXPORT_MIN_COUNT)
    }
  })
})
