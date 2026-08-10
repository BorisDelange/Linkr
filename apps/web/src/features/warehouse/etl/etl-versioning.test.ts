import { describe, expect, it } from 'vitest'
import { isVersioned, pruneVersioningMarks, toggleVersioned , setVersionedMany } from './etl-versioning'

const CSV = 'mapping/source_to_concept_map.csv'
const SQL = '00_vocabulary.sql'

describe('isVersioned', () => {
  it('leaves a data file out by default', () => {
    // The mapping export holds a possibly private dictionary: silence must mean
    // "not committed", never the reverse.
    expect(isVersioned(CSV, undefined)).toBe(false)
  })

  it('includes a data file once marked', () => {
    expect(isVersioned(CSV, { versionedDataFiles: [CSV] })).toBe(true)
  })

  it('keeps a code file by default', () => {
    expect(isVersioned(SQL, undefined)).toBe(true)
    expect(isVersioned(SQL, {})).toBe(true)
  })

  it('drops a code file once excluded', () => {
    expect(isVersioned(SQL, { excludedFiles: [SQL] })).toBe(false)
  })

  it('does not let one list affect the other kind', () => {
    // Marking the CSV must not change what happens to the script.
    expect(isVersioned(SQL, { versionedDataFiles: [CSV] })).toBe(true)
    expect(isVersioned(CSV, { excludedFiles: [CSV] })).toBe(false)
  })

  it('treats every data extension the same way', () => {
    for (const p of ['a.csv', 'a.parquet', 'a.pq', 'a.xlsx', 'a.xls']) {
      expect(isVersioned(p, undefined)).toBe(false)
    }
  })
})

describe('toggleVersioned', () => {
  it('includes a data file, then excludes it again', () => {
    const on = toggleVersioned(CSV, undefined)
    expect(isVersioned(CSV, on)).toBe(true)
    expect(isVersioned(CSV, toggleVersioned(CSV, on))).toBe(false)
  })

  it('excludes a code file, then restores it', () => {
    const off = toggleVersioned(SQL, undefined)
    expect(isVersioned(SQL, off)).toBe(false)
    expect(isVersioned(SQL, toggleVersioned(SQL, off))).toBe(true)
  })

  it('touches only the list matching the file kind', () => {
    const out = toggleVersioned(CSV, { excludedFiles: [SQL] })
    expect(out.excludedFiles).toEqual([SQL])
    expect(out.versionedDataFiles).toEqual([CSV])
  })

  it('keeps the list sorted, so clicking order is not a diff', () => {
    let cfg = toggleVersioned('b.csv', undefined)
    cfg = toggleVersioned('a.csv', cfg)
    expect(cfg.versionedDataFiles).toEqual(['a.csv', 'b.csv'])
  })

  it('preserves the other keys of the config', () => {
    const out = toggleVersioned(SQL, { versionedDataFiles: [CSV] })
    expect(out.versionedDataFiles).toEqual([CSV])
  })
})

describe('pruneVersioningMarks', () => {
  it('drops a mark whose file is gone', () => {
    // Otherwise a new file later taking that name inherits the old state.
    const out = pruneVersioningMarks({ versionedDataFiles: [CSV, 'gone.csv'] }, [CSV])
    expect(out?.versionedDataFiles).toEqual([CSV])
  })

  it('returns the same object when everything still exists', () => {
    const cfg = { versionedDataFiles: [CSV], excludedFiles: [SQL] }
    expect(pruneVersioningMarks(cfg, [CSV, SQL])).toBe(cfg)
  })

  it('handles a pipeline that was never marked', () => {
    expect(pruneVersioningMarks(undefined, [CSV])).toBeUndefined()
  })

  it('prunes both lists', () => {
    const out = pruneVersioningMarks(
      { versionedDataFiles: ['x.csv'], excludedFiles: ['y.sql'] },
      [],
    )
    expect(out?.versionedDataFiles).toEqual([])
    expect(out?.excludedFiles).toEqual([])
  })
})


describe('setVersionedMany', () => {
  it('forces a MIXED selection to one state, rather than flipping each file', () => {
    // A loop of toggleVersioned would invert each one and leave the set mixed.
    const config = { excludedFiles: ['b.sql'] }
    const out = setVersionedMany(['a.sql', 'b.sql'], true, config)
    expect(isVersioned('a.sql', out)).toBe(true)
    expect(isVersioned('b.sql', out)).toBe(true)
  })

  it('un-versions a mixed selection the same way', () => {
    const config = { excludedFiles: ['b.sql'] }
    const out = setVersionedMany(['a.sql', 'b.sql'], false, config)
    expect(isVersioned('a.sql', out)).toBe(false)
    expect(isVersioned('b.sql', out)).toBe(false)
  })

  it('moves data and code paths in opposite directions for one request', () => {
    // Data files are listed when INCLUDED, code files when EXCLUDED.
    const out = setVersionedMany(['mapping/x.csv', 'a.sql'], true, undefined)
    expect(out.versionedDataFiles).toEqual(['mapping/x.csv'])
    expect(out.excludedFiles).toEqual([])
    expect(isVersioned('mapping/x.csv', out)).toBe(true)
    expect(isVersioned('a.sql', out)).toBe(true)

    const off = setVersionedMany(['mapping/x.csv', 'a.sql'], false, out)
    expect(off.versionedDataFiles).toEqual([])
    expect(off.excludedFiles).toEqual(['a.sql'])
  })

  it('keeps the lists sorted, so a bulk change is not a spurious diff', () => {
    const out = setVersionedMany(['c.sql', 'a.sql', 'b.sql'], false, undefined)
    expect(out.excludedFiles).toEqual(['a.sql', 'b.sql', 'c.sql'])
  })

  it('leaves paths outside the selection alone', () => {
    const config = { excludedFiles: ['keep.sql'] }
    const out = setVersionedMany(['a.sql'], false, config)
    expect(out.excludedFiles).toContain('keep.sql')
  })
})
