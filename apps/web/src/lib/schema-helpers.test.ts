import { describe, it, expect } from 'vitest'
import { qualify, sanitizeSchemaMapping, tableListHas } from './schema-helpers'
import type { SchemaMapping } from '@/types/schema-mapping'

// Every table/column name in a mapping is interpolated into SQL as a bare
// `"${name}"`, and mappings arrive from workspace ZIPs, cloned git repos,
// manually imported presets and the seed loader. This is the one place those
// identifiers are checked, so the ~100 interpolation sites downstream can
// assume they are safe.

const evil = 'measurement" ; ATTACH \'https://evil/x.db\' AS e; --'

describe('sanitizeSchemaMapping', () => {
  it('drops a table name that breaks out of the quoting, keeping the rest', () => {
    const safe = sanitizeSchemaMapping({
      ...BASE,
      patient: { from: { table: evil, alias: 'p' }, fields: { patient_id: 'p.person_id' } },
    } as SchemaMapping)!
    // The whole from goes: an alias without its table names nothing.
    expect(safe.patient?.from).toBeUndefined()
    expect(safe.patient?.fields).toEqual({ patient_id: 'p.person_id' })
  })

  it('keeps a field only as a column reference, an expression or a constant', () => {
    const safe = sanitizeSchemaMapping({
      ...BASE,
      visit: {
        from: { table: 'stays', alias: 's' },
        fields: { visit_id: 's.id', patient_id: `s.pid" OR 1=1 --`, start_datetime: { expr: 'CAST(s.d AS TIMESTAMP)' }, visit_type: { value: 'H' } },
      },
    } as SchemaMapping)!
    expect(safe.visit?.fields).toEqual({ visit_id: 's.id', start_datetime: { expr: 'CAST(s.d AS TIMESTAMP)' }, visit_type: { value: 'H' } })
  })

  it('drops a join side or an alias that is not an identifier', () => {
    const safe = sanitizeSchemaMapping({
      ...BASE,
      visit: {
        from: { table: 'stays', alias: 's' },
        joins: [{ type: 'left', table: 'units', alias: `u"`, on: [['s.unit', 'u.id'], ['s.x', evil]] }],
      },
    } as SchemaMapping)!
    expect(safe.visit?.joins?.[0].alias).toBeUndefined()
    expect(safe.visit?.joins?.[0].on).toEqual([['s.unit', 'u.id']])
  })

  it('filters a list of table names entry by entry', () => {
    expect(sanitizeSchemaMapping({ ...BASE, knownTables: ['person', evil, 'visit'] } as SchemaMapping)!.knownTables).toEqual(['person', 'visit'])
  })

  it('leaves free text, DDL, SQL and parameters alone', () => {
    const mapping = {
      ...BASE,
      presetLabel: { en: 'My "quoted" schema', fr: 'Mon schéma' },
      ddl: 'CREATE TABLE person ("weird name" INT);',
      params: { attr: { default: `it's "x"` } },
      note: { customSql: `SELECT 'a;b' AS text` },
      erdLayout: { person: { x: 10, y: 20 } },
    } as SchemaMapping
    expect(sanitizeSchemaMapping(mapping)).toEqual(mapping)
  })

  it('converts a v1 mapping, dropping its unsafe identifiers first', () => {
    const safe = sanitizeSchemaMapping({
      presetId: 'x',
      presetLabel: { en: 'x' },
      patientTable: { table: 'person', idColumn: 'person_id', genderColumn: evil },
    } as unknown as SchemaMapping)!
    expect(safe.formatVersion).toBe(2)
    expect(safe.patient?.fields).toEqual({ patient_id: 'p.person_id' })
  })

  it('passes null and undefined through untouched', () => {
    expect(sanitizeSchemaMapping(undefined)).toBeUndefined()
    expect(sanitizeSchemaMapping(null)).toBeNull()
  })
})

const BASE = { formatVersion: 2, presetId: 't', presetLabel: { en: 't' } } as const

// The sanitizer drops any identifier it does not recognise, so a false positive
// silently removes a table or column from a working database. This is a whole
// preset in the shape the published repos use.
//
// It is written out rather than read from the seed on purpose: the seed folder is
// a build artefact and is gitignored, so a fixture read from it passes here and
// fails on a clean checkout.
const REALISTIC_PRESET: SchemaMapping = {
  formatVersion: 2,
  presetId: 'mimic-iv',
  presetLabel: { en: 'MIMIC-IV', fr: 'MIMIC-IV' },
  patient: {
    from: { schema: 'hosp', table: 'patients', alias: 'p' },
    fields: { patient_id: 'p.subject_id', gender_source_value: 'p.gender', birth_year: { expr: 'p.anchor_year - p.anchor_age' }, death_datetime: 'p.dod' },
    genderValues: { male: 'M', female: 'F' },
  },
  visit: {
    from: { schema: 'hosp', table: 'admissions', alias: 'v' },
    joins: [{ type: 'left', schema: 'hosp', table: 'care_site', alias: 'cs', on: [['v.care_site_id', 'cs.care_site_id']] }],
    fields: { visit_id: 'v.hadm_id', patient_id: 'v.subject_id', start_datetime: 'v.admittime', care_site_name: 'cs.care_site_name' },
  },
  note: { from: { schema: 'note', table: 'discharge', alias: 'n' }, fields: { note_id: 'n.note_id', text: 'n.text' } },
  concepts: [{ key: 'd_items', from: { schema: 'icu', table: 'd_items', alias: 'd' }, fields: { concept_id: 'd.itemid', concept_name: 'd.label', extra_unitname: 'd.unitname' } }],
  events: [{
    label: 'Chart events',
    conceptDictionaryKey: 'd_items',
    from: { schema: 'icu', table: 'chartevents', alias: 'e' },
    where: "e.warning = 0",
    fields: { patient_id: 'e.subject_id', concept_id: 'e.itemid', start_datetime: 'e.charttime', value_number: 'e.valuenum' },
  }],
  drugs: [{ label: 'Inputs', drugKind: 'administration', customSql: 'SELECT 1 AS patient_id', sqlColumns: ['patient_id'] }],
  knownTables: ['patients', 'admissions', 'icustays', 'chartevents', 'discharge'],
  erdGroups: [{ id: 'core', label: 'Core', color: 'blue', tables: ['patients', 'admissions'] }],
  ddl: 'CREATE TABLE hosp.patients (subject_id INTEGER);',
}

describe('sanitizeSchemaMapping leaves a real preset alone', () => {
  it('round-trips a full mapping byte for byte', () => {
    const before = JSON.stringify(REALISTIC_PRESET)
    expect(JSON.stringify(sanitizeSchemaMapping(REALISTIC_PRESET))).toBe(before)
  })
})

describe('qualify', () => {
  it('emits two identifiers when a schema is named', () => {
    // NOT `"hosp.patients"`: that names a table whose name contains a dot, which
    // DuckDB reports as missing — silently, wherever the caller swallows it.
    expect(qualify({ schema: 'hosp', table: 'patients' })).toBe('"hosp"."patients"')
  })

  it('emits one identifier without a schema, as every preset did before', () => {
    expect(qualify({ table: 'patients' })).toBe('"patients"')
    expect(qualify({ schema: undefined, table: 'patients' })).toBe('"patients"')
  })

  it('keeps the two eHOP homonyms apart', () => {
    expect(qualify({ schema: 'EDBM_EDS', table: 'EHOP_PATIENT' }))
      .not.toBe(qualify({ schema: 'EDBM_ZPAT', table: 'EHOP_PATIENT' }))
  })
})

describe('sanitizeSchemaMapping — schema field', () => {
  it('drops a schema that is not a safe identifier, keeps a safe one', () => {
    // `schema` ends in neither `table` nor `column`, so the suffix pattern alone
    // would have let it reach SQL unchecked.
    const m = sanitizeSchemaMapping({
      ...BASE,
      patient: { from: { schema: 'bad"name', table: 'patients', alias: 'p' } },
      visit: { from: { schema: 'hosp', table: 'admissions', alias: 'v' } },
    } as SchemaMapping)
    expect(m?.patient?.from?.schema).toBeUndefined()
    expect(m?.patient?.from?.table).toBe('patients')
    expect(m?.visit?.from?.schema).toBe('hosp')
  })
})

describe('tableListHas', () => {
  // What discoverTables reports for a MIMIC-IV Parquet folder: module directories
  // become schemas, so every name is qualified.
  const mimic = ['hosp.patients', 'hosp.d_labitems', 'icu.d_items', 'icu.chartevents']

  it('matches a qualified name against a mapping that keeps the halves apart', () => {
    // The regression: comparing against `table` alone said icu.d_items did not
    // exist, and the Concepts page reported no concepts over a full cache.
    expect(tableListHas(mimic, { schema: 'icu', table: 'd_items' })).toBe(true)
    expect(tableListHas(mimic, { schema: 'hosp', table: 'd_labitems' })).toBe(true)
  })

  it('still matches a flat import, which reports unqualified names', () => {
    expect(tableListHas(['concept', 'measurement'], { table: 'concept' })).toBe(true)
  })

  it('accepts an unqualified match for a mapping that names a schema', () => {
    // A source imported flat, read through a preset that names schemas.
    expect(tableListHas(['d_items'], { schema: 'icu', table: 'd_items' })).toBe(true)
  })

  it('ignores case, since derived schemas are lowercased', () => {
    expect(tableListHas(['ICU.D_Items'], { schema: 'icu', table: 'd_items' })).toBe(true)
    expect(tableListHas(mimic, { schema: 'ICU', table: 'D_ITEMS' })).toBe(true)
  })

  it('does not match the same table under another schema', () => {
    expect(tableListHas(mimic, { schema: 'hosp', table: 'd_items' })).toBe(false)
  })

  it('is false for a table that is simply absent', () => {
    expect(tableListHas(mimic, { schema: 'icu', table: 'nope' })).toBe(false)
    expect(tableListHas([], { table: 'concept' })).toBe(false)
  })
})
