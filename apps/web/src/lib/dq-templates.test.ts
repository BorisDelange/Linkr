import { describe, expect, it } from 'vitest'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import { checksFromTemplates, ddlCheckTemplates, mappingCheckTemplates, schemaCheckTemplates } from './dq-templates'
import type { SchemaMapping } from '@/types/schema-mapping'

const t = (key: string) => key

const DDL = `
CREATE TABLE person (
  person_id integer NOT NULL PRIMARY KEY,
  year_of_birth integer NOT NULL,
  birth_datetime TIMESTAMP NULL
);

CREATE TABLE visit_occurrence (
  visit_occurrence_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  visit_start_datetime TIMESTAMP NULL,
  visit_end_datetime TIMESTAMP NULL
);

CREATE TABLE measurement (
  measurement_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  measurement_concept_id integer NOT NULL,
  measurement_datetime TIMESTAMP NULL,
  visit_occurrence_id integer NULL
);

ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_person FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_meas_person FOREIGN KEY (person_id) REFERENCES person (person_id);
`

const mapping: SchemaMapping = {
  ...mappingV1ToV2({
    presetId: 'omop',
    presetLabel: { en: 'OMOP' },
    patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', birthDateColumn: 'birth_datetime' },
    visitTable: {
      table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id',
      startDateColumn: 'visit_start_datetime', endDateColumn: 'visit_end_datetime',
    },
    eventTables: {
      Measurement: {
        table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_datetime',
        patientIdColumn: 'person_id',
      },
    },
  }),
  ddl: DDL,
}
// v1 had no visit column on events; v2 maps it like any contract column.
const measurement = mapping.events![0]
measurement.fields = { ...measurement.fields, visit_id: `${measurement.from!.alias}.visit_occurrence_id` }

const keys = (tpls: { templateKey: string }[]) => tpls.map((c) => c.templateKey)

describe('checks from the DDL', () => {
  const tpls = ddlCheckTemplates(DDL, t)

  it('checks structure, every NOT NULL column, primary and foreign keys', () => {
    expect(keys(tpls)).toEqual(expect.arrayContaining([
      'ddl.columns:person',
      'ddl.not_null:person.person_id',
      'ddl.not_null:person.year_of_birth',
      'ddl.primary_key:person',
      'ddl.foreign_key:measurement(person_id)->person(person_id)',
    ]))
    expect(keys(tpls)).not.toContain('ddl.not_null:person.birth_datetime')
  })

  it('writes SQL returning violated_rows and total_rows', () => {
    const notNull = tpls.find((c) => c.templateKey === 'ddl.not_null:person.person_id')!
    expect(notNull.sql).toContain('COUNT(*) FILTER (WHERE "person_id" IS NULL)::BIGINT AS violated_rows')
    expect(notNull.sql).toContain('FROM "person"')
    const fk = tpls.find((c) => c.templateKey.startsWith('ddl.foreign_key:measurement'))!
    expect(fk.sql).toContain('LEFT JOIN (SELECT DISTINCT "person_id" FROM "person") r ON t."person_id" = r."person_id"')
    expect(fk.sql).toContain('WHERE t."person_id" IS NOT NULL')
    expect(fk).toMatchObject({ category: 'conformance', subcategory: 'relational', origin: 'ddl', tableName: 'measurement' })
  })

  it('resolves an unqualified reference in the referencing table\'s schema', () => {
    const ddl = `CREATE TABLE hosp.patients (\n  subject_id integer NOT NULL\n);\nCREATE TABLE hosp.admissions (\n  subject_id integer NOT NULL\n);\nALTER TABLE hosp.admissions ADD CONSTRAINT fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);`
    const fk = ddlCheckTemplates(ddl, t).find((c) => c.templateKey.startsWith('ddl.foreign_key'))!
    expect(fk.sql).toContain('FROM "hosp"."admissions" t')
    expect(fk.sql).toContain('FROM "hosp"."patients"')
  })
})

describe('checks from the mapping', () => {
  it('leaves out what a DDL constraint already checks', () => {
    const tpls = keys(mappingCheckTemplates(mapping, t))
    // person_id NOT NULL + PRIMARY KEY in the DDL
    expect(tpls).not.toContain('mapping.required:linkr_patient.patient_id')
    expect(tpls).not.toContain('mapping.unique:linkr_patient')
    // FOREIGN KEY measurement.person_id → person
    expect(tpls.some((k) => k.startsWith('mapping.orphan:linkr_event_measurement.patient_id'))).toBe(false)
    // no DDL constraint on these
    expect(tpls).toContain('mapping.required:linkr_visit.start_datetime')
    expect(tpls.some((k) => k.startsWith('mapping.orphan:linkr_event_measurement.visit_id'))).toBe(true)
  })

  it('keeps every check when there is no DDL', () => {
    const tpls = keys(mappingCheckTemplates({ ...mapping, ddl: undefined }, t))
    expect(tpls).toContain('mapping.required:linkr_patient.patient_id')
    expect(tpls).toContain('mapping.unique:linkr_patient')
    expect(tpls.some((k) => k.startsWith('mapping.orphan:linkr_event_measurement.patient_id'))).toBe(true)
  })

  it('checks dates against the life of the patient and the visit order', () => {
    const tpls = mappingCheckTemplates(mapping, t)
    const birth = tpls.find((c) => c.templateKey === 'mapping.after_birth:linkr_event_measurement')!
    expect(birth).toMatchObject({ category: 'plausibility', subcategory: 'temporal' })
    expect(birth.sql).toContain('JOIN linkr_patient p ON e.patient_id = p.patient_id')
    expect(keys(tpls)).toContain('mapping.end_after_start:linkr_visit')
    expect(keys(tpls)).toContain('mapping.plausible_age:linkr_visit')
  })
})

describe('schema checks as stored checks', () => {
  it('puts the DDL checks first, with unique keys, in list order', () => {
    const tpls = schemaCheckTemplates(mapping, t)
    expect(tpls[0].origin).toBe('ddl')
    expect(new Set(keys(tpls)).size).toBe(tpls.length)
    const checks = checksFromTemplates('rs-1', tpls)
    expect(checks.map((c) => c.order)).toEqual(tpls.map((_, i) => i))
    // Key order is the server's response order: exports must be byte-identical.
    expect(Object.keys(checks[0])).toEqual([
      'id', 'ruleSetId', 'name', 'description', 'category', 'subcategory', 'severity', 'threshold',
      'sql', 'order', 'origin', 'templateKey', 'tableName', 'disabled', 'createdAt', 'updatedAt',
    ])
  })
})
