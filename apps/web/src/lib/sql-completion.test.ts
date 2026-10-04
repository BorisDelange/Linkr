import { describe, it, expect } from 'vitest'
import { MAX_UNSCOPED_COLUMNS, quoteIdent, sqlCompletions, sqlSlot, type SqlCatalog } from './sql-completion'

const omop: SqlCatalog = {
  defaultSchemas: ['main'],
  schemas: [
    { name: 'main', tables: [{ name: 'notes', columns: [{ name: 'note_id' }, { name: 'text' }] }] },
    {
      name: 'cdm',
      tables: [
        { name: 'person', columns: [{ name: 'person_id', type: 'BIGINT' }, { name: 'gender_concept_id' }] },
        { name: 'visit_occurrence', columns: [{ name: 'visit_occurrence_id' }, { name: 'person_id' }] },
      ],
    },
  ],
}

const flat: SqlCatalog = {
  defaultSchemas: ['main'],
  schemas: [
    {
      name: 'main',
      tables: [
        { name: 'person', columns: [{ name: 'person_id' }, { name: 'year_of_birth' }] },
        { name: 'measurement', columns: [{ name: 'measurement_id' }, { name: 'value_as_number' }] },
      ],
    },
  ],
}

/** Completes at the `|` marker. */
function complete(sql: string, catalog: SqlCatalog = omop) {
  const offset = sql.indexOf('|')
  return sqlCompletions(sql.replace('|', ''), offset, catalog)
}
const labels = (sql: string, kind?: string, catalog?: SqlCatalog) =>
  complete(sql, catalog).items.filter((i) => !kind || i.kind === kind).map((i) => i.label)

describe('sqlCompletions — table slots', () => {
  it('offers schemas after FROM when the database has schemas beyond the search path', () => {
    expect(labels('SELECT * FROM |', 'schema')).toEqual(['main', 'cdm'])
    // and the search path's tables, which need no qualifier
    expect(labels('SELECT * FROM |', 'table')).toEqual(['notes'])
  })

  it('inserts a schema with its dot and asks for its tables next', () => {
    const cdm = complete('SELECT * FROM |').items.find((i) => i.label === 'cdm')
    expect(cdm).toMatchObject({ insertText: 'cdm.', retrigger: true })
  })

  it('offers tables directly after FROM when there is a single schema', () => {
    expect(labels('SELECT * FROM |', 'schema', flat)).toEqual([])
    expect(labels('SELECT * FROM |', 'table', flat)).toEqual(['person', 'measurement'])
  })

  it('offers the tables of a schema after `schema.`', () => {
    expect(labels('SELECT * FROM cdm.|')).toEqual(['person', 'visit_occurrence'])
    expect(labels('SELECT * FROM cdm.vis|')).toEqual(['visit_occurrence'])
  })

  it('treats JOIN and a comma in a FROM list as table slots', () => {
    expect(labels('SELECT * FROM cdm.person p JOIN cdm.|')).toContain('visit_occurrence')
    expect(labels('SELECT * FROM measurement, |', 'table', flat)).toEqual(['person', 'measurement'])
  })

  it('offers only keywords right after a table, where an alias or WHERE goes', () => {
    const items = complete('SELECT * FROM person |', flat).items
    expect(items.every((i) => i.kind === 'keyword' || i.kind === 'function')).toBe(true)
    expect(items.map((i) => i.label)).toContain('WHERE')
  })

  it('offers CTE names as tables', () => {
    expect(labels('WITH adults AS (SELECT 1) SELECT * FROM |', 'table', flat)).toContain('adults')
  })
})

describe('sqlCompletions — column slots', () => {
  it('offers the columns of the FROM tables only', () => {
    const cols = labels('SELECT | FROM cdm.person', 'column')
    expect(cols).toEqual(['person_id', 'gender_concept_id'])
  })

  it('offers every column when no FROM is written yet', () => {
    const cols = labels('SELECT |', 'column', flat)
    expect(cols).toEqual(['person_id', 'year_of_birth', 'measurement_id', 'value_as_number'])
  })

  it('resolves an alias to its table', () => {
    expect(labels('SELECT v.| FROM cdm.visit_occurrence v')).toEqual(['visit_occurrence_id', 'person_id'])
    expect(labels('SELECT * FROM cdm.person AS p WHERE p.gen|')).toEqual(['gender_concept_id'])
  })

  it('resolves an unaliased table name used as a qualifier', () => {
    expect(labels('SELECT person.| FROM person', undefined, flat)).toEqual(['person_id', 'year_of_birth'])
  })

  it('resolves schema.table. to the table columns', () => {
    expect(labels('SELECT cdm.person.| FROM cdm.person')).toEqual(['person_id', 'gender_concept_id'])
  })

  it('keeps the same column from two joined tables apart by their alias', () => {
    const items = complete('SELECT person_| FROM cdm.person p JOIN cdm.visit_occurrence v ON true').items
    expect(items.filter((i) => i.kind === 'column').map((i) => i.detail)).toEqual(['p · BIGINT', 'v'])
  })

  it('looks only at the statement under the cursor', () => {
    const sql = 'SELECT * FROM cdm.person;\nSELECT | FROM main.notes'
    expect(labels(sql, 'column')).toEqual(['note_id', 'text'])
  })

  it('reads a FROM in a subquery written after the cursor', () => {
    expect(labels('SELECT * FROM (SELECT | FROM person) t', 'column', flat)).toEqual(['person_id', 'year_of_birth'])
  })

  it('is case-insensitive on names and prefixes', () => {
    expect(labels('select P.YEAR| from PERSON p', undefined, flat)).toEqual(['year_of_birth'])
  })
})

describe('sqlCompletions — where nothing belongs', () => {
  it('stays silent inside a string literal', () => {
    expect(complete("SELECT * FROM person WHERE x = 'ab|").items).toEqual([])
  })

  it('stays silent inside a quoted identifier', () => {
    expect(complete('SELECT "per| FROM person').items).toEqual([])
  })

  it('ignores comments', () => {
    expect(labels('-- FROM cdm.person\nSELECT | FROM main.notes', 'column')).toEqual(['note_id', 'text'])
  })

  it('stays silent inside a line comment, up to its end of line', () => {
    expect(complete('SELECT 1 -- see per|').items).toEqual([])
    expect(complete('SELECT 1 -- from |\nFROM person').slot).toBe('none')
    expect(complete('SELECT 1 -- note\n|').slot).not.toBe('none')
  })

  it('stays silent inside a block comment, closed or not', () => {
    expect(complete('SELECT /* FROM | */ 1').slot).toBe('none')
    expect(complete('SELECT 1 /* FROM per|').items).toEqual([])
    expect(complete('SELECT /* x */ | FROM main.notes').slot).toBe('expression')
  })

  it('reports where the replaced word starts', () => {
    expect(complete('SELECT * FROM cdm.per|').wordStart).toBe('SELECT * FROM cdm.'.length)
  })
})

describe('sqlCompletions — slot', () => {
  it('tells a table slot from an expression one, so a space opens the list only after FROM', () => {
    expect(complete('SELECT * FROM |').slot).toBe('table')
    expect(complete('SELECT * FROM person p JOIN |').slot).toBe('table')
    expect(complete('SELECT |').slot).toBe('expression')
    expect(complete('SELECT * FROM person |').slot).toBe('keywords')
    expect(complete('SELECT * FROM cdm.|').slot).toBe('qualified')
  })
})

describe('sqlCompletions — without FROM', () => {
  it('caps the every-column fallback on a large database', () => {
    const tables = Array.from({ length: 300 }, (_, i) => ({
      name: `t${i}`,
      columns: Array.from({ length: 20 }, (_, j) => ({ name: `c${i}_${j}` })),
    }))
    const big: SqlCatalog = { defaultSchemas: ['main'], schemas: [{ name: 'main', tables }] }
    expect(labels('SELECT |', 'column', big)).toHaveLength(MAX_UNSCOPED_COLUMNS)
  })
})

describe('sqlSlot', () => {
  it('reads the slot from the text before the cursor alone', () => {
    expect(sqlSlot('SELECT * FROM ')).toBe('table')
    expect(sqlSlot('SELECT * FROM person WHERE ')).toBe('expression')
    expect(sqlSlot('SELECT 1;\nSELECT * FROM person ')).toBe('keywords')
  })

  it('is none inside a comment or a string', () => {
    expect(sqlSlot('SELECT 1 -- FROM ')).toBe('none')
    expect(sqlSlot("SELECT * FROM person WHERE x = 'a ")).toBe('none')
  })
})

describe('quoteIdent', () => {
  it('leaves plain lower-case names alone and quotes the rest', () => {
    expect(quoteIdent('person_id')).toBe('person_id')
    expect(quoteIdent('Person')).toBe('"Person"')
    expect(quoteIdent('my col')).toBe('"my col"')
    expect(quoteIdent('order')).toBe('"order"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })
})
