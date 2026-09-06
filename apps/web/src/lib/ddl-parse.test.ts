import { describe, it, expect } from 'vitest'
import {
  parseDdl, indexTables, resolveTableRef, qualifiedName, matchesTableName, lookupByTableName,
} from './ddl-parse'

describe('parseDdl', () => {
  it('parses an unqualified table with its columns and types', () => {
    const [t] = parseDdl(`
      CREATE TABLE patients (
        subject_id INTEGER NOT NULL,
        gender VARCHAR(1),
        PRIMARY KEY (subject_id)
      );
    `)
    expect(t.name).toBe('patients')
    expect(t.schema).toBeUndefined()
    expect(t.bareName).toBe('patients')
    expect(t.columns.map((c) => c.name)).toEqual(['subject_id', 'gender'])
    expect(t.columns[0]).toMatchObject({ type: 'INTEGER', nullable: false, isPk: true })
    expect(t.columns[1]).toMatchObject({ type: 'VARCHAR(1)', nullable: true, isPk: false })
  })

  it('keeps a schema-qualified name qualified, and exposes the bare one', () => {
    const [t] = parseDdl('CREATE TABLE hosp.patients (subject_id INTEGER);')
    expect(t.name).toBe('hosp.patients')
    expect(t.schema).toBe('hosp')
    expect(t.bareName).toBe('patients')
  })

  it('reads a quoted schema and table', () => {
    const [t] = parseDdl('CREATE TABLE "EDBM_EDS"."EHOP_PATIENT" (id INTEGER);')
    expect(t.name).toBe('EDBM_EDS.EHOP_PATIENT')
    expect(t.schema).toBe('EDBM_EDS')
  })

  // The regression this module exists for: these two used to collapse into one
  // node, keeping only the constraints of whichever the parser saw last.
  it('keeps homonyms in different schemas apart', () => {
    const tables = parseDdl(`
      CREATE TABLE "EDBM_EDS"."EHOP_PATIENT" (
        id INTEGER,
        birth_year INTEGER
      );
      CREATE TABLE "EDBM_ZPAT"."EHOP_PATIENT" (
        id INTEGER,
        last_name VARCHAR(100)
      );
    `)
    expect(tables).toHaveLength(2)
    expect(tables.map((t) => t.name)).toEqual(['EDBM_EDS.EHOP_PATIENT', 'EDBM_ZPAT.EHOP_PATIENT'])
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'birth_year'])
    expect(tables[1].columns.map((c) => c.name)).toEqual(['id', 'last_name'])
  })

  it('applies ALTER TABLE ... PRIMARY KEY to the named schema only', () => {
    const tables = parseDdl(`
      CREATE TABLE "A"."T" (id INTEGER, x INTEGER);
      CREATE TABLE "B"."T" (id INTEGER, x INTEGER);
      ALTER TABLE "B"."T" ADD CONSTRAINT t_pk PRIMARY KEY (id);
    `)
    expect(tables[0].pkColumns).toEqual([])
    expect(tables[1].pkColumns).toEqual(['id'])
    expect(tables[1].columns.find((c) => c.name === 'id')?.isPk).toBe(true)
  })

  it('parses a table-level FOREIGN KEY, qualifying it as written', () => {
    const [t] = parseDdl(`
      CREATE TABLE hosp.admissions (
        hadm_id INTEGER,
        subject_id INTEGER,
        FOREIGN KEY (subject_id) REFERENCES hosp.patients (subject_id)
      );
    `)
    expect(t.fks).toEqual([
      { columns: ['subject_id'], refTable: 'hosp.patients', refColumns: ['subject_id'] },
    ])
  })

  it('parses ALTER TABLE ... FOREIGN KEY across schemas', () => {
    const tables = parseDdl(`
      CREATE TABLE hosp.patients (subject_id INTEGER);
      CREATE TABLE icu.icustays (stay_id INTEGER, subject_id INTEGER);
      ALTER TABLE icu.icustays ADD CONSTRAINT fk_s FOREIGN KEY (subject_id) REFERENCES hosp.patients (subject_id);
    `)
    expect(tables[1].fks).toEqual([
      { columns: ['subject_id'], refTable: 'hosp.patients', refColumns: ['subject_id'] },
    ])
  })

  it('parses a composite primary key', () => {
    const [t] = parseDdl(`
      CREATE TABLE icu.chartevents (
        stay_id INTEGER,
        itemid INTEGER,
        charttime TIMESTAMP,
        PRIMARY KEY (stay_id, itemid, charttime)
      );
    `)
    expect(t.pkColumns).toEqual(['stay_id', 'itemid', 'charttime'])
    expect(t.columns.every((c) => c.isPk)).toBe(true)
  })

  it('skips constraint lines that are not keys', () => {
    const [t] = parseDdl(`
      CREATE TABLE t (
        id INTEGER,
        UNIQUE (id),
        CHECK (id > 0)
      );
    `)
    expect(t.columns.map((c) => c.name)).toEqual(['id'])
  })

  it('accepts IF NOT EXISTS', () => {
    const [t] = parseDdl('CREATE TABLE IF NOT EXISTS icu.d_items (itemid INTEGER);')
    expect(t.name).toBe('icu.d_items')
  })

  it('returns nothing for a DDL with no CREATE TABLE', () => {
    expect(parseDdl('-- just a comment\n')).toEqual([])
  })

  // Module-level regexes carry `lastIndex` between calls when they are global;
  // resetting it is what keeps a second parse from starting mid-file.
  it('is repeatable across calls', () => {
    const ddl = 'CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);'
    expect(parseDdl(ddl)).toHaveLength(2)
    expect(parseDdl(ddl)).toHaveLength(2)
  })
})

describe('resolveTableRef', () => {
  const tables = parseDdl(`
    CREATE TABLE hosp.patients (subject_id INTEGER);
    CREATE TABLE icu.patients (subject_id INTEGER);
    CREATE TABLE icu.icustays (stay_id INTEGER);
    CREATE TABLE standalone (id INTEGER);
  `)
  const { byQualified, byBare } = indexTables(tables)
  const resolve = (ref: { schema?: string; table: string }, current?: string) =>
    resolveTableRef(byQualified, byBare, ref, current)?.name

  it('resolves a qualified reference exactly', () => {
    expect(resolve({ schema: 'icu', table: 'patients' })).toBe('icu.patients')
  })

  it('is case-insensitive', () => {
    expect(resolve({ schema: 'ICU', table: 'PATIENTS' })).toBe('icu.patients')
  })

  it('prefers the current schema for a bare reference', () => {
    expect(resolve({ table: 'patients' }, 'icu')).toBe('icu.patients')
    expect(resolve({ table: 'patients' }, 'hosp')).toBe('hosp.patients')
  })

  it('falls back to another schema when the current one has no such table', () => {
    expect(resolve({ table: 'icustays' }, 'hosp')).toBe('icu.icustays')
  })

  it('resolves an unqualified table by its bare name', () => {
    expect(resolve({ table: 'standalone' }, 'hosp')).toBe('standalone')
  })

  it('returns undefined for a table that is not declared', () => {
    expect(resolve({ schema: 'hosp', table: 'nope' })).toBeUndefined()
    expect(resolve({ table: 'nope' })).toBeUndefined()
  })

  it('does not fall back to another schema for a qualified reference', () => {
    expect(resolve({ schema: 'note', table: 'patients' })).toBeUndefined()
  })
})

describe('matchesTableName', () => {
  const [qualified] = parseDdl('CREATE TABLE hosp.patients (id INTEGER);')
  const [bare] = parseDdl('CREATE TABLE patients (id INTEGER);')

  it('matches a stored qualified name', () => {
    expect(matchesTableName(qualified, 'hosp.patients')).toBe(true)
  })

  // Every preset written before schemas were parsed stores the bare name; those
  // erdGroups and erdLayout entries have to keep working.
  it('matches a stored bare name against a qualified table', () => {
    expect(matchesTableName(qualified, 'patients')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesTableName(qualified, 'HOSP.PATIENTS')).toBe(true)
    expect(matchesTableName(qualified, 'Patients')).toBe(true)
  })

  it('does not match another schema', () => {
    expect(matchesTableName(qualified, 'icu.patients')).toBe(false)
  })

  it('does not match a different table', () => {
    expect(matchesTableName(qualified, 'admissions')).toBe(false)
    expect(matchesTableName(bare, 'hosp.patients')).toBe(false)
  })
})

describe('lookupByTableName', () => {
  const [qualified] = parseDdl('CREATE TABLE hosp.patients (id INTEGER);')

  it('prefers an exact qualified key over a bare one', () => {
    const layout = { 'hosp.patients': { x: 1, y: 1 }, patients: { x: 9, y: 9 } }
    expect(lookupByTableName(layout, qualified)).toEqual({ x: 1, y: 1 })
  })

  it('falls back to a bare key, so an old saved layout still applies', () => {
    expect(lookupByTableName({ patients: { x: 5, y: 6 } }, qualified)).toEqual({ x: 5, y: 6 })
  })

  it('matches a lowercased key', () => {
    const [upper] = parseDdl('CREATE TABLE "EDBM_EDS"."EHOP_PATIENT" (id INTEGER);')
    expect(lookupByTableName({ 'edbm_eds.ehop_patient': { x: 2, y: 3 } }, upper)).toEqual({ x: 2, y: 3 })
  })

  it('returns undefined when nothing matches, or when there is no store', () => {
    expect(lookupByTableName({ other: { x: 0, y: 0 } }, qualified)).toBeUndefined()
    expect(lookupByTableName(undefined, qualified)).toBeUndefined()
  })
})

describe('qualifiedName', () => {
  it('joins a schema and table', () => {
    expect(qualifiedName('hosp', 'patients')).toBe('hosp.patients')
  })

  it('returns the bare name when there is no schema', () => {
    expect(qualifiedName(undefined, 'patients')).toBe('patients')
  })
})
