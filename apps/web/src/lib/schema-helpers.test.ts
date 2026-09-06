import { describe, it, expect } from 'vitest'
import { qualify, qualifyIn, sanitizeSchemaMapping } from './schema-helpers'
import { SCHEMA_PRESETS } from './schema-presets'
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
// silently removes a table or column from a working database. The built-in
// presets are the real-world sample that has to survive it untouched.
describe('sanitizeSchemaMapping leaves the built-in presets alone', () => {
  it('round-trips OMOP and MIMIC byte for byte', () => {
    const all = Object.entries(SCHEMA_PRESETS)
    expect(all.length).toBeGreaterThan(0)
    for (const [id, mapping] of all) {
      const before = JSON.stringify(mapping)
      expect(JSON.stringify(sanitizeSchemaMapping(mapping)), id).toBe(before)
    }
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
