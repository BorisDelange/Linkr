import { describe, it, expect } from 'vitest'
import { birthYearColumns, birthYearSql, qualify, qualifyIn, sanitizeSchemaMapping, tableListHas } from './schema-helpers'
import type { SchemaMapping } from '@/types/schema-mapping'

// Every table/column name in a mapping is interpolated into SQL as a bare
// `"${name}"`, and mappings arrive from workspace ZIPs, cloned git repos,
// manually imported presets and the seed loader. This is the one place those
// identifiers are checked, so the ~100 interpolation sites downstream can
// assume they are safe.

const evil = 'measurement" ; ATTACH \'https://evil/x.db\' AS e; --'

describe('sanitizeSchemaMapping', () => {
  it('keeps the identifiers real schemas use', () => {
    const mapping = {
      presetId: 'omop-5.4',
      patientTable: {
        table: 'person',
        idColumn: 'person_id',
        birthDateColumn: 'birth_datetime',
        genderColumn: 'gender_concept_id',
      },
      visitTable: {
        table: 'visit_occurrence',
        idColumn: 'visit_occurrence_id',
        patientIdColumn: 'person_id',
        startDateColumn: 'visit_start_date',
        careSiteNameTable: 'care_site',
      },
      eventTables: {
        Measurements: { table: 'measurement', conceptIdColumn: 'measurement_concept_id' },
      },
      conceptTables: [{ key: 'concept', table: 'concept', nameColumn: 'concept_name' }],
      knownTables: ['person', 'visit_occurrence', 'd_items', 'main.person'],
    } as unknown as SchemaMapping

    expect(sanitizeSchemaMapping(mapping)).toEqual(mapping)
  })

  it('drops a table name that breaks out of the quoting', () => {
    const mapping = {
      patientTable: { table: evil, idColumn: 'person_id' },
    } as unknown as SchemaMapping

    const safe = sanitizeSchemaMapping(mapping)!
    expect(safe.patientTable?.table).toBeUndefined()
    // The rest of the descriptor survives — one poisoned field does not
    // invalidate a whole mapping.
    expect(safe.patientTable?.idColumn).toBe('person_id')
  })

  it('drops an unsafe column inside a nested event table', () => {
    const mapping = {
      eventTables: {
        Labs: { table: 'measurement', valueColumn: 'x" OR 1=1 --', dateColumn: 'measurement_date' },
      },
    } as unknown as SchemaMapping

    const safe = sanitizeSchemaMapping(mapping)!
    const labs = safe.eventTables?.Labs as unknown as Record<string, unknown>
    expect(labs.valueColumn).toBeUndefined()
    expect(labs.dateColumn).toBe('measurement_date')
  })

  it('filters a list of table names entry by entry', () => {
    const mapping = { knownTables: ['person', evil, 'visit'] } as unknown as SchemaMapping
    expect(sanitizeSchemaMapping(mapping)!.knownTables).toEqual(['person', 'visit'])
  })

  // extraColumns is a Record<alias, columnName>: the third shape an identifier
  // field takes, and the one that slipped through when only string and string[]
  // were handled. Its VALUES are what resolveActualColumn feeds to `"${…}"`.
  it('filters extraColumns on its values, keeping the aliases', () => {
    const mapping = {
      conceptTables: [
        {
          key: 'concept',
          table: 'concept',
          nameColumn: 'concept_name',
          extraColumns: {
            domain_id: 'domain_id',
            standard_concept: evil,
          },
        },
      ],
    } as unknown as SchemaMapping

    const safe = sanitizeSchemaMapping(mapping)!
    expect(safe.conceptTables?.[0].extraColumns).toEqual({ domain_id: 'domain_id' })
  })

  it('leaves non-identifier fields alone, including free text and DDL', () => {
    const mapping = {
      presetId: 'custom',
      presetLabel: { en: 'My "quoted" schema', fr: 'Mon schéma' },
      ddl: 'CREATE TABLE person ("weird name" INT);',
      genderValues: { male: '8507', female: '8532' },
      erdLayout: { person: { x: 10, y: 20 } },
    } as unknown as SchemaMapping

    expect(sanitizeSchemaMapping(mapping)).toEqual(mapping)
  })

  it('passes null and undefined through untouched', () => {
    expect(sanitizeSchemaMapping(undefined)).toBeUndefined()
    expect(sanitizeSchemaMapping(null)).toBeNull()
  })
})

// The sanitizer drops any identifier it does not recognise, so a false positive
// silently removes a table or column from a working database. This is a whole
// preset in the shape the published repos use — every field kind the sanitizer
// walks, including the ones that tripped it before: `extraColumns` (a map whose
// VALUES are identifiers), `knownTables` (a string[]), and `schema` (an
// identifier ending in neither `table` nor `column`).
//
// It is written out rather than read from the seed on purpose: the seed folder is
// a build artefact and is gitignored, so a fixture read from it passes here and
// fails on a clean checkout.
const REALISTIC_PRESET = {
  presetId: 'mimic-iv',
  presetLabel: { en: 'MIMIC-IV', fr: 'MIMIC-IV' },
  patientTable: {
    schema: 'hosp',
    table: 'patients',
    idColumn: 'subject_id',
    genderColumn: 'gender',
    birthYearColumn: 'anchor_year',
    extraColumns: { anchor_age: 'anchor_age' },
  },
  deathTable: { schema: 'hosp', table: 'patients', idColumn: 'subject_id', dateColumn: 'dod' },
  visitTable: {
    schema: 'hosp',
    table: 'admissions',
    idColumn: 'hadm_id',
    patientIdColumn: 'subject_id',
    startDateColumn: 'admittime',
    endDateColumn: 'dischtime',
    careSiteNameTable: 'care_site',
    careSiteNameColumn: 'care_site_name',
  },
  noteTable: { schema: 'note', table: 'discharge', idColumn: 'note_id', textColumn: 'text' },
  visitDetailTable: { schema: 'icu', table: 'icustays', idColumn: 'stay_id', patientIdColumn: 'subject_id' },
  conceptTables: [
    {
      key: 'd_items',
      schema: 'icu',
      table: 'd_items',
      idColumn: 'itemid',
      nameColumn: 'label',
      extraColumns: { category: 'category', unitname: 'unitname' },
    },
  ],
  eventTables: {
    'Chart events': {
      schema: 'icu',
      table: 'chartevents',
      conceptIdColumn: 'itemid',
      patientIdColumn: 'subject_id',
      dateColumn: 'charttime',
      valueColumn: 'valuenum',
      valueUnitColumn: 'valueuom',
    },
  },
  genderValues: { male: 'M', female: 'F' },
  knownTables: ['patients', 'admissions', 'icustays', 'chartevents', 'discharge'],
  erdGroups: [{ id: 'core', label: 'Core', color: 'blue', tables: ['patients', 'admissions'] }],
  ddl: 'CREATE TABLE hosp.patients (subject_id INTEGER);',
} as unknown as SchemaMapping

describe('sanitizeSchemaMapping leaves a real preset alone', () => {
  it('round-trips a full mapping byte for byte', () => {
    const before = JSON.stringify(REALISTIC_PRESET)
    expect(JSON.stringify(sanitizeSchemaMapping(REALISTIC_PRESET))).toBe(before)
  })

  it('keeps every schema, which is what qualifies the tables', () => {
    const safe = sanitizeSchemaMapping(REALISTIC_PRESET)!
    expect(safe.patientTable?.schema).toBe('hosp')
    expect(safe.noteTable?.schema).toBe('note')
    expect(safe.conceptTables?.[0].schema).toBe('icu')
    expect(safe.eventTables?.['Chart events'].schema).toBe('icu')
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

  it('lets a lookup table inherit the schema of the descriptor naming it', () => {
    expect(qualifyIn({ schema: 'hosp' }, 'care_site')).toBe('"hosp"."care_site"')
    expect(qualifyIn({}, 'care_site')).toBe('"care_site"')
  })
})

describe('sanitizeSchemaMapping — schema field', () => {
  it('drops a schema that is not a safe identifier', () => {
    // `schema` ends in neither `table` nor `column`, so the suffix pattern alone
    // would have let it reach SQL unchecked.
    const m = sanitizeSchemaMapping({
      patientTable: { schema: 'bad"name', table: 'patients', idColumn: 'id' },
    } as unknown as SchemaMapping)
    expect(m?.patientTable?.schema).toBeUndefined()
    expect(m?.patientTable?.table).toBe('patients')
  })

  it('keeps a safe schema', () => {
    const m = sanitizeSchemaMapping({
      patientTable: { schema: 'hosp', table: 'patients', idColumn: 'id' },
    } as unknown as SchemaMapping)
    expect(m?.patientTable?.schema).toBe('hosp')
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

describe('birthYearSql', () => {
  const pt = { table: 'patients', idColumn: 'subject_id' }

  it('prefers the birth-year column, else the anchor pair, else nothing', () => {
    expect(birthYearSql({ ...pt, birthYearColumn: 'yob', anchorAgeColumn: 'a', anchorYearColumn: 'y' }, 'p')).toBe('p."yob"')
    expect(birthYearSql({ ...pt, anchorAgeColumn: 'anchor_age', anchorYearColumn: 'anchor_year' }, 'p'))
      .toBe('(p."anchor_year" - p."anchor_age")')
    expect(birthYearSql({ ...pt, anchorAgeColumn: 'anchor_age', anchorYearColumn: 'anchor_year' }))
      .toBe('("anchor_year" - "anchor_age")')
  })

  it('needs both halves of the anchor pair', () => {
    expect(birthYearSql({ ...pt, anchorAgeColumn: 'anchor_age' }, 'p')).toBeNull()
    expect(birthYearColumns({ ...pt, anchorAgeColumn: 'anchor_age' })).toEqual([])
    expect(birthYearColumns({ ...pt, anchorAgeColumn: 'a', anchorYearColumn: 'y' })).toEqual(['y', 'a'])
  })
})
