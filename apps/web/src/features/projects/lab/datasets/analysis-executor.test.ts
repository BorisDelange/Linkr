import { describe, it, expect } from 'vitest'
import { buildRColumnData, buildRInjectionCode, resolveRColumnNames } from './analysis-executor'
import type { DatasetColumn } from '@/types'

const col = (id: string, name: string, type: DatasetColumn['type'] = 'string'): DatasetColumn =>
  ({ id, name, type }) as DatasetColumn

describe('buildRColumnData', () => {
  it('remaps column ids to names and emits one array per column', () => {
    const columns = [col('col_a', 'age', 'number'), col('col_b', 'site')]
    const rows = [
      { col_a: 42, col_b: 'ICU' },
      { col_a: 7, col_b: 'ER' },
    ]
    expect(buildRColumnData(rows, columns)).toEqual({
      age: [42, 7],
      site: ['ICU', 'ER'],
    })
  })

  it('pads every column to the same length, so the frame stays rectangular', () => {
    const columns = [col('col_a', 'a'), col('col_b', 'b')]
    // Second row is missing col_b entirely — a ragged source must not yield a ragged frame.
    const rows = [{ col_a: '1', col_b: '2' }, { col_a: '3' }]
    const out = buildRColumnData(rows, columns)
    expect(out.a).toHaveLength(2)
    expect(out.b).toHaveLength(2)
    expect(out.b).toEqual(['2', null])
  })

  it('normalises undefined and null to null', () => {
    const columns = [col('col_a', 'a')]
    const rows = [{ col_a: undefined }, { col_a: null }, {}]
    expect(buildRColumnData(rows, columns).a).toEqual([null, null, null])
  })

  it('flattens objects and arrays to strings rather than nested lists', () => {
    // This is the RangeError case: a nested value made jsonlite return a list,
    // and building the data.frame from it blew up inside webR.
    const columns = [col('col_a', 'a')]
    const rows = [{ col_a: { k: 1 } }, { col_a: [1, 2] }, { col_a: 'plain' }]
    expect(buildRColumnData(rows, columns).a).toEqual(['{"k":1}', '[1,2]', 'plain'])
  })

  it('serialises dates as ISO strings', () => {
    const columns = [col('col_a', 'when', 'date')]
    const rows = [{ col_a: new Date('2026-01-02T03:04:05.000Z') }]
    expect(buildRColumnData(rows, columns).when).toEqual(['2026-01-02T03:04:05.000Z'])
  })

  it('maps non-finite numbers to null (R has no JSON NaN/Infinity)', () => {
    const columns = [col('col_a', 'a', 'number')]
    const rows = [{ col_a: NaN }, { col_a: Infinity }, { col_a: 1.5 }]
    expect(buildRColumnData(rows, columns).a).toEqual([null, null, 1.5])
  })

  it('keeps booleans as booleans', () => {
    const columns = [col('col_a', 'flag')]
    expect(buildRColumnData([{ col_a: true }, { col_a: false }], columns).flag).toEqual([true, false])
  })

  it('suffixes duplicate column names instead of overwriting', () => {
    const columns = [col('col_a', 'dup'), col('col_b', 'dup')]
    const out = buildRColumnData([{ col_a: 'first', col_b: 'second' }], columns)
    expect(out.dup).toEqual(['first'])
    expect(out['dup.2']).toEqual(['second'])
  })

  it('ignores row keys that no column declares', () => {
    const columns = [col('col_a', 'a')]
    const out = buildRColumnData([{ col_a: '1', stray: 'x' }], columns)
    expect(Object.keys(out)).toEqual(['a'])
  })

  it('returns an empty object for no columns', () => {
    expect(buildRColumnData([{ col_a: 1 }], [])).toEqual({})
  })

  it('emits empty arrays when there are no rows', () => {
    expect(buildRColumnData([], [col('col_a', 'a')])).toEqual({ a: [] })
  })
})

// The data and the type coercions are built separately but must agree on the
// name every column ends up under, suffix included: coercing against the raw
// name left a duplicated column un-coerced while casting its neighbour twice.
describe('resolveRColumnNames', () => {
  it('suffixes duplicates positionally, in column order', () => {
    const columns = [col('col_a', 'dup'), col('col_b', 'other'), col('col_c', 'dup')]
    expect(resolveRColumnNames(columns)).toEqual(['dup', 'other', 'dup.2'])
  })

  it('agrees with the keys buildRColumnData actually writes', () => {
    const columns = [col('col_a', 'dup', 'number'), col('col_b', 'dup', 'number')]
    const data = buildRColumnData([{ col_a: 1, col_b: 2 }], columns)
    expect(Object.keys(data)).toEqual(resolveRColumnNames(columns))
  })

  it('leaves distinct names untouched', () => {
    const columns = [col('col_a', 'age'), col('col_b', 'site')]
    expect(resolveRColumnNames(columns)).toEqual(['age', 'site'])
  })
})

// The preamble casts each column by name. Coercing against the raw name while
// the data was written under the suffixed one left the second `dup` a character
// vector and cast the first one twice — silently, because the `%in%` guard
// turns a wrong name into a no-op rather than an error.
describe('buildRInjectionCode', () => {
  it('coerces every column the data was written under, suffix included', () => {
    const columns = [col('col_a', 'dup', 'number'), col('col_b', 'dup', 'number')]
    const r = buildRInjectionCode(columns)
    for (const name of Object.keys(buildRColumnData([{ col_a: 1, col_b: 2 }], columns))) {
      expect(r).toContain(`dataset[["${name}"]] <- as.numeric`)
    }
  })

  it('casts a name once, not once per column sharing it', () => {
    const columns = [col('col_a', 'dup', 'number'), col('col_b', 'dup', 'number')]
    const r = buildRInjectionCode(columns)
    expect(r.match(/dataset\[\["dup"\]\] <- as\.numeric/g)).toHaveLength(1)
  })

  it('emits a date coercion under the resolved name too', () => {
    const columns = [col('col_a', 'when', 'date'), col('col_b', 'when', 'date')]
    const r = buildRInjectionCode(columns)
    expect(r).toContain('dataset[["when"]] <- as.POSIXct')
    expect(r).toContain('dataset[["when.2"]] <- as.POSIXct')
  })
})
