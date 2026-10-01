import { describe, it, expect } from 'vitest'
import { toSqlCatalog } from './sql-catalog'

describe('toSqlCatalog', () => {
  it('groups bare names under main and qualified names under their schema', () => {
    const catalog = toSqlCatalog([
      { name: 'person', columns: [{ name: 'person_id', type: 'BIGINT', nullable: false }] },
      { name: 'hosp.patients', columns: [{ name: 'subject_id', type: 'INTEGER', nullable: true }] },
    ])
    expect(catalog.schemas.map((s) => [s.name, s.tables.map((t) => t.name)])).toEqual([
      ['main', ['person']],
      ['hosp', ['patients']],
    ])
    expect(catalog.schemas[1].tables[0].columns).toEqual([{ name: 'subject_id', type: 'INTEGER' }])
    // Every schema is on the search path, so all of them are reachable unqualified.
    expect(catalog.defaultSchemas).toEqual(['main', 'hosp'])
  })
})
