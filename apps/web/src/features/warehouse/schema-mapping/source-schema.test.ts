import { describe, expect, it } from 'vitest'
import { indexSourceSchema } from './source-schema'

const index = indexSourceSchema([
  { name: 'concept', columns: [{ name: 'concept_id' }, { name: 'record_count' }] },
  { name: 'hosp.patients', columns: [{ name: 'subject_id' }] },
  { name: 'icu.patients', columns: [{ name: 'stay_id' }] },
])

describe('indexSourceSchema', () => {
  it('lists every table with its schema apart', () => {
    expect(index.tables).toEqual([
      { schema: undefined, table: 'concept', alias: '' },
      { schema: 'hosp', table: 'patients', alias: '' },
      { schema: 'icu', table: 'patients', alias: '' },
    ])
  })

  it('gives the columns the database has, beyond any DDL', () => {
    expect(index.columnsOf({ table: 'CONCEPT', alias: 'c' })).toEqual(['concept_id', 'record_count'])
  })

  it('reads a qualified reference in its own schema', () => {
    expect(index.columnsOf({ schema: 'icu', table: 'patients', alias: 'p' })).toEqual(['stay_id'])
  })

  it('finds a bare reference in the first schema holding it', () => {
    expect(index.columnsOf({ table: 'patients', alias: 'p' })).toEqual(['subject_id'])
  })

  it('knows nothing of a table the database lacks', () => {
    expect(index.columnsOf({ table: 'device_exposure', alias: 'd' })).toBeUndefined()
    expect(index.columnsOf({ schema: 'hosp', table: 'stays', alias: 's' })).toBeUndefined()
  })
})
