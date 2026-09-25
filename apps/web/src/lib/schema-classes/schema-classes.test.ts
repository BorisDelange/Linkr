import { describe, expect, it } from 'vitest'
import type { SchemaMapping } from '@/types/schema-mapping'
import { injectClassRelations, referencedRelations, withClassRelations } from './inject'
import { classRelation, classRelations, conceptJoinOn, dictionaryOf, eventRelation, has } from './relations'

const omop: SchemaMapping = {
  presetId: 'omop',
  presetLabel: { en: 'OMOP' },
  patientTable: { table: 'person', idColumn: 'person_id', birthDateColumn: 'birth_datetime', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
  deathTable: { table: 'death', patientIdColumn: 'person_id', dateColumn: 'death_date' },
  genderValues: { male: '8507', female: '8532' },
  visitTable: {
    table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id',
    startDateColumn: 'visit_start_datetime', endDateColumn: 'visit_end_datetime', typeColumn: 'visit_source_value',
    careSiteColumn: 'care_site_id', careSiteNameTable: 'care_site', careSiteNameIdColumn: 'care_site_id', careSiteNameColumn: 'care_site_name',
  },
  visitDetailTable: {
    table: 'visit_detail', idColumn: 'visit_detail_id', visitIdColumn: 'visit_occurrence_id', patientIdColumn: 'person_id',
    startDateColumn: 'visit_detail_start_datetime', unitColumn: 'care_site_id', unitNameTable: 'care_site',
    unitNameIdColumn: 'care_site_id', unitNameColumn: 'care_site_name', unitSourceValueColumn: 'visit_detail_source_value',
  },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', extraColumns: { standard_concept: 'standard_concept', 'bad"alias': 'x' } }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', sourceConceptIdColumn: 'measurement_source_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime', valueColumn: 'value_as_number' },
    'Measurement!': { table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_datetime' },
  },
}

const mimic: SchemaMapping = {
  presetId: 'mimic',
  presetLabel: { en: 'MIMIC-IV' },
  patientTable: { schema: 'hosp', table: 'patients', idColumn: 'subject_id', anchorAgeColumn: 'anchor_age', anchorYearColumn: 'anchor_year', deathDateColumn: 'dod' },
  eventTables: {
    Prescriptions: { schema: 'hosp', table: 'prescriptions', conceptIdColumn: 'drug', conceptDictionaryKey: 'none', dateColumn: 'starttime' },
  },
}

const thesaurus: SchemaMapping = {
  presetId: 'eav',
  presetLabel: { en: 'EAV' },
  conceptTables: [{ key: 'thes', table: 'thesaurus', idColumn: 'id', nameColumn: 'label', codeColumn: 'code', vocabularyColumn: 'terminology' }],
  eventTables: {
    Data: { table: 'facts', conceptIdColumn: 'code', conceptVocabularyColumn: 'terminology', conceptCodeColumn: 'code', patientIdColumn: 'pid' },
  },
}

describe('classRelations (v1 mapping)', () => {
  it('names one relation per class and slugs event labels without collisions', () => {
    expect(classRelations(omop).map((r) => r.name)).toEqual([
      'linkr_patient', 'linkr_visit', 'linkr_visit_detail', 'linkr_concept_concept',
      'linkr_event_measurement', 'linkr_event_measurement_2',
    ])
  })

  it('emits every contract column, NULL where unmapped', () => {
    const visit = classRelation(omop, 'visit')!
    expect(visit.sql).toContain('v."visit_start_datetime" AS start_datetime')
    expect(visit.sql).toContain('LEFT JOIN "care_site" cs ON v."care_site_id" = cs."care_site_id"')
    expect(visit.sql).toContain('cs."care_site_name" AS care_site_name')
    const vd = classRelation(omop, 'visit_detail')!
    expect(vd.sql).toContain('NULL AS end_datetime')
    expect(has(vd, 'end_datetime')).toBe(false)
    expect(has(vd, 'unit_name')).toBe(true)
  })

  it('folds birth, gender and death into the patient relation', () => {
    const p = classRelation(omop, 'patient')!
    expect(p.sql).toContain(`COALESCE(DATE_PART('year', p."birth_datetime"::TIMESTAMP), p."year_of_birth") AS birth_year`)
    expect(p.sql).toContain(`= '8507' THEN 'male'`)
    expect(p.sql).toContain('p."gender_concept_id" AS gender_source_value')
    expect(p.sql).toContain('(SELECT MIN(_d."death_date") FROM "death" _d WHERE _d."person_id" = p."person_id") AS death_datetime')
  })

  it('derives the MIMIC-IV birth year from the anchor pair and qualifies schemas', () => {
    const p = classRelation(mimic, 'patient')!
    expect(p.sql).toContain('(p."anchor_year" - p."anchor_age") AS birth_year')
    expect(p.sql).toContain('FROM "hosp"."patients" p')
    expect(p.sql).toContain('p."dod" AS death_datetime')
  })

  it('names an inline-concept event itself and gives it no dictionary', () => {
    const rx = eventRelation(mimic, 'Prescriptions')!
    expect(rx.dictionary).toBeNull()
    expect(rx.sql).toContain('CAST(e."drug" AS VARCHAR) AS concept_name')
    expect(rx.sql).toContain('FROM "hosp"."prescriptions" e')
  })

  it('pads the conventional visit column instead of assuming it exists', () => {
    const m = eventRelation(omop, 'Measurement')!
    expect(m.sql).toContain('UNION ALL BY NAME SELECT NULL AS "visit_occurrence_id" WHERE false')
    expect(has(m, 'visit_id')).toBe(false)
    expect(m.dictionary).toBe('linkr_concept_concept')
    expect(dictionaryOf(omop, m)?.cls).toBe('concept')
  })

  it('joins a composite-key dictionary on terminology and code', () => {
    const ev = eventRelation(thesaurus, 'Data')!
    expect(ev.compositeConceptKey).toBe(true)
    expect(conceptJoinOn(ev, 'e', 'c')).toBe('e.concept_terminology = c.concept_terminology AND e.concept_code = c.concept_code')
    expect(conceptJoinOn(eventRelation(omop, 'Measurement')!, 'e', 'c')).toBe('e.concept_id = c.concept_id')
  })

  it('exposes safe extra columns only', () => {
    const concept = classRelations(omop).find((r) => r.cls === 'concept')!
    expect(concept.extras).toEqual({ standard_concept: 'extra_standard_concept' })
    expect(concept.sql).toContain('d."standard_concept" AS "extra_standard_concept"')
    expect(concept.sql).not.toContain('bad')
  })
})

describe('withClassRelations', () => {
  it('leaves SQL without a relation untouched', () => {
    const sql = 'SELECT * FROM visit_occurrence'
    expect(withClassRelations(sql, omop)).toBe(sql)
  })

  it('ignores names inside literals, quoted identifiers and comments', () => {
    expect(referencedRelations(`SELECT 'linkr_visit', "linkr_patient" -- linkr_note\nFROM x`).size).toBe(0)
  })

  it('prepends only the referenced relations, non-materialised', () => {
    const out = withClassRelations('SELECT COUNT(*) FROM linkr_visit v JOIN linkr_patient p USING (patient_id)', omop)
    expect(out.startsWith('WITH linkr_patient AS NOT MATERIALIZED (')).toBe(true)
    expect(out).toContain('linkr_visit AS NOT MATERIALIZED (')
    expect(out).not.toContain('linkr_visit_detail AS')
    expect(out.endsWith('SELECT COUNT(*) FROM linkr_visit v JOIN linkr_patient p USING (patient_id)')).toBe(true)
  })

  it('merges into an existing WITH, keeping RECURSIVE and leading comments', () => {
    const out = withClassRelations('-- note\nWITH RECURSIVE t AS (SELECT 1) SELECT * FROM t, linkr_visit', omop)
    expect(out.startsWith('-- note\nWITH RECURSIVE linkr_visit AS NOT MATERIALIZED (')).toBe(true)
    expect(out).toContain('),\nt AS (SELECT 1)')
  })

  it('does not rewrite a non-query statement or an unknown relation', () => {
    expect(withClassRelations('CREATE TABLE x AS SELECT * FROM linkr_visit', omop)).toBe('CREATE TABLE x AS SELECT * FROM linkr_visit')
    expect(withClassRelations('SELECT * FROM linkr_drug_x', omop)).toBe('SELECT * FROM linkr_drug_x')
  })

  it('rewrites each statement of a script', () => {
    const out = injectClassRelations('SET threads = 1; SELECT * FROM linkr_note', { ...omop, noteTable: { table: 'note', idColumn: 'note_id', patientIdColumn: 'person_id', dateColumn: 'note_datetime', textColumn: 'note_text' } })
    expect(out.split(';\n')[0]).toBe('SET threads = 1')
    expect(out.split(';\n')[1].startsWith('WITH linkr_note AS NOT MATERIALIZED (')).toBe(true)
  })
})
