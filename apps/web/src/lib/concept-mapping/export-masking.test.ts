import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { maskFrequency, maskSourceConceptsCsv } from './export-masking'

// Shared with apps/api/tests/test_export_masking.py: the two sides must emit the
// same bytes, or front-only and server clients would fight over the file in git.
const dir = join(__dirname, '__fixtures__', 'export-masking')
const read = (name: string) => readFileSync(join(dir, name), 'utf-8')

describe('maskSourceConceptsCsv', () => {
  it('masks small counts, withholds small profiles, drops extremes and small bins', () => {
    expect(maskSourceConceptsCsv(read('input.csv'), null, 11)).toBe(read('expected.csv'))
  })

  it('follows the project column mapping and the file delimiter', () => {
    expect(maskSourceConceptsCsv(read('input-semicolon.csv'), { recordCountColumn: 'n_records' }, 11))
      .toBe(read('expected-semicolon.csv'))
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
