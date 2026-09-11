import { describe, it, expect } from 'vitest'
import { EDITS_SUFFIX, editsFileName } from './layout.js'

/**
 * The edit journal's filename is a format contract, not an implementation detail:
 * the TS builder (entity-io.ts) and the Python one (project_export.py) both derive
 * it, and a disagreement would make the same project export differently from each
 * side — a false git diff on every sync.
 *
 * It also carries a privacy guarantee. The journal holds the values typed into a
 * dataset, so for a hand-filled collection it IS the health data. Naming it after
 * the data file is what lets one "mark for versioning" decide the fate of both, and
 * what makes that pairing visible in the Versioning tab.
 */
describe('editsFileName', () => {
  it('replaces the data file extension', () => {
    expect(editsFileName('my_data.csv')).toBe('my_data.edits.json')
    expect(editsFileName('cohort.xlsx')).toBe('cohort.edits.json')
    expect(editsFileName('stays.parquet')).toBe('stays.edits.json')
  })

  it('sits beside its data file, so one gitignore rule covers both', () => {
    // The whole point of the split: `my_data.csv` ignored ⇒ `my_data.edits.json`
    // ignored, by name rather than by a rule nobody can see.
    const data = 'labs.csv'
    expect(editsFileName(data).startsWith('labs')).toBe(true)
    expect(editsFileName(data).endsWith(EDITS_SUFFIX)).toBe(true)
  })

  it('handles a name with no extension at all', () => {
    expect(editsFileName('collection')).toBe('collection.edits.json')
  })

  it('keeps dots that belong to the name', () => {
    // Only the LAST segment is an extension; `v1.2` is part of what the file is
    // called and losing it would collide two datasets onto one journal.
    expect(editsFileName('cohort.v1.2.csv')).toBe('cohort.v1.2.edits.json')
  })

  it('does not mistake a directory dot for an extension', () => {
    expect(editsFileName('v1.0/labs')).toBe('v1.0/labs.edits.json')
  })
})
