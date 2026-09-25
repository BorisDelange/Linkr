import { describe, expect, it } from 'vitest'
import type { SchemaMapping } from '@/types/schema-mapping'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { injectClassRelations, referencedRelations, withClassRelations } from './inject'
import { classRelation, classRelations, conceptJoinOn, dictionaryOf, drugRelation, eventRelation, generatedRelationSql, has, readableRelationSql, substituteParams } from './relations'
import { checkContract, hasGlobalWindow } from './contract-check'
import { diffOverrides, effectiveMapping, isEmptyOverrides, relationFingerprint, revertOverride, staleOverrides } from './overrides'
import { conceptIdentity } from './spec'
import { isMappingV1, mappingV1ToV2, type SchemaMappingV1 } from './v1'

const omopV1: SchemaMappingV1 = {
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

const mimicV1: SchemaMappingV1 = {
  presetId: 'mimic',
  presetLabel: { en: 'MIMIC-IV' },
  patientTable: { schema: 'hosp', table: 'patients', idColumn: 'subject_id', anchorAgeColumn: 'anchor_age', anchorYearColumn: 'anchor_year', deathDateColumn: 'dod' },
  eventTables: {
    Prescriptions: { schema: 'hosp', table: 'prescriptions', conceptIdColumn: 'drug', conceptDictionaryKey: 'none', dateColumn: 'starttime' },
  },
}

const thesaurusV1: SchemaMappingV1 = {
  presetId: 'eav',
  presetLabel: { en: 'EAV' },
  conceptTables: [{ key: 'thes', table: 'thesaurus', idColumn: 'id', nameColumn: 'label', codeColumn: 'code', vocabularyColumn: 'terminology' }],
  eventTables: {
    Data: { table: 'facts', conceptIdColumn: 'code', conceptVocabularyColumn: 'terminology', conceptCodeColumn: 'code', patientIdColumn: 'pid' },
  },
}

const omop = mappingV1ToV2(omopV1)
const mimic = mappingV1ToV2(mimicV1)
const thesaurus = mappingV1ToV2(thesaurusV1)

describe('classRelations (converted v1 mapping)', () => {
  it('names one relation per class and slugs event labels without collisions', () => {
    expect(classRelations(omop).map((r) => r.name)).toEqual([
      'linkr_patient', 'linkr_visit', 'linkr_visit_detail', 'linkr_concept_concept',
      'linkr_event_measurement', 'linkr_event_measurement_2',
    ])
  })

  it('emits every contract column, NULL where unmapped', () => {
    const visit = classRelation(omop, 'visit')!
    expect(visit.sql).toContain('v."visit_start_datetime" AS start_datetime')
    expect(visit.sql).toContain('LEFT JOIN (SELECT * FROM "care_site" UNION ALL BY NAME SELECT NULL AS "care_site_name", NULL AS "care_site_id" WHERE false) cs ON v."care_site_id" = cs."care_site_id"')
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
    expect(p.sql).toMatch(/NULL AS "person_id"/)
  })

  it('derives the MIMIC-IV birth year from the anchor pair and qualifies schemas', () => {
    const p = classRelation(mimic, 'patient')!
    expect(p.sql).toContain('(p."anchor_year" - p."anchor_age") AS birth_year')
    expect(p.sql).toContain('FROM (SELECT * FROM "hosp"."patients" UNION ALL BY NAME')
    expect(p.sql).toContain('p."dod" AS death_datetime')
  })

  it('names an inline-concept event itself and gives it no dictionary', () => {
    const rx = eventRelation(mimic, 'Prescriptions')!
    expect(rx.dictionary).toBeNull()
    expect(rx.sql).toContain('CAST(e."drug" AS VARCHAR) AS concept_name')
    expect(rx.sql).toContain('FROM (SELECT * FROM "hosp"."prescriptions" UNION ALL BY NAME')
  })

  it('pads every named column, so a missing one reads as NULL instead of failing', () => {
    const m = eventRelation(omop, 'Measurement')!
    expect(m.sql).toMatch(/UNION ALL BY NAME SELECT .*NULL AS "visit_occurrence_id".* WHERE false\) e/)
    expect(m.sql).toContain('NULL AS "value_as_number"')
    expect(has(m, 'visit_id')).toBe(true)
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

  it('ignores names inside literals and comments', () => {
    expect(referencedRelations(`SELECT 'linkr_visit', "not linkr_patient" -- linkr_note\nFROM x`).size).toBe(0)
  })

  it('sees a relation named as a quoted identifier', () => {
    expect([...referencedRelations('SELECT "linkr_visit"."visit_id" FROM "linkr_visit"')]).toEqual(['linkr_visit'])
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

  it('is idempotent: an already-injected statement comes back unchanged', () => {
    const once = withClassRelations('SELECT * FROM linkr_visit v JOIN linkr_patient p USING (patient_id)', omop)
    expect(withClassRelations(once, omop)).toBe(once)
  })

  it('rewrites each statement of a script', () => {
    const out = injectClassRelations('SET threads = 1; SELECT * FROM linkr_note', mappingV1ToV2({ ...omopV1, noteTable: { table: 'note', idColumn: 'note_id', patientIdColumn: 'person_id', dateColumn: 'note_datetime', textColumn: 'note_text' } }))
    expect(out.split(';\n')[0]).toBe('SET threads = 1')
    expect(out.split(';\n')[1].startsWith('WITH linkr_note AS NOT MATERIALIZED (')).toBe(true)
  })
})

describe('mappingV1ToV2', () => {
  it('recognises a v1 mapping and leaves v2 alone', () => {
    expect(isMappingV1(omopV1)).toBe(true)
    expect(isMappingV1(omop)).toBe(false)
    expect(omop.formatVersion).toBe(2)
  })

  it('turns lookup triples into joins and anchor pairs into expressions', () => {
    expect(omop.visit?.joins).toEqual([{ type: 'left', table: 'care_site', alias: 'cs', on: [['v.care_site_id', 'cs.care_site_id']] }])
    expect(mimic.patient?.fields?.birth_year).toEqual({ expr: 'p."anchor_year" - p."anchor_age"' })
    expect(omop.patient?.genderValues).toEqual({ male: '8507', female: '8532' })
  })

  it('leaves out the conventional visit column of an event table whose DDL lacks it', () => {
    const v2 = mappingV1ToV2({
      ...omopV1,
      ddl: 'CREATE TABLE specimen (\n  specimen_id INTEGER,\n  person_id INTEGER\n);\nCREATE TABLE measurement (\n  person_id INTEGER,\n  visit_occurrence_id INTEGER\n);',
      eventTables: {
        Specimen: { table: 'specimen', conceptIdColumn: 'specimen_concept_id' },
        Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id' },
      },
    })
    expect(v2.events?.[0].fields?.visit_id).toBeUndefined()
    expect(v2.events?.[1].fields?.visit_id).toBe('e.visit_occurrence_id')
  })

  it('keeps a code-only dictionary hashed, so stored mapping-project ids do not move', () => {
    const v2 = mappingV1ToV2({ ...mimicV1, conceptTables: [{ key: 'icd', table: 'd_icd_diagnoses', codeColumn: 'icd_code', nameColumn: 'long_title' }] })
    expect(conceptIdentity(v2, 'icd')).toEqual({ key: 'icd', ownId: false, hasCode: true, table: 'd_icd_diagnoses' })
    expect(conceptIdentity(omop, 'concept')?.ownId).toBe(true)
  })

  it('is applied at the trust boundary, which then validates the v2 shape', () => {
    const out = sanitizeSchemaMapping(omopV1 as unknown as SchemaMapping)
    expect(out.formatVersion).toBe(2)
    expect(out.patient?.fields?.patient_id).toBe('p.person_id')
    const bad = sanitizeSchemaMapping({
      formatVersion: 2, presetId: 'x', presetLabel: { en: 'x' },
      visit: { from: { table: 'v"x', alias: 'v' }, fields: { visit_id: 'v.id"; DROP', patient_id: { expr: 'v.pid' } }, joins: [{ type: 'left', table: 't', alias: 't', on: [['v.a', 't.b"']] }] },
    } as SchemaMapping)
    expect(bad.visit?.from?.table).toBeUndefined()
    expect(bad.visit?.fields).toEqual({ patient_id: { expr: 'v.pid' } })
    expect(bad.visit?.joins?.[0].on).toEqual([])
  })
})

const v2: SchemaMapping = {
  formatVersion: 2,
  presetId: 'eav',
  presetLabel: { en: 'EAV' },
  params: { attr_rate: { default: "RATE'1" } },
  patient: { from: { table: 'patients', alias: 'p' }, fields: { patient_id: 'p.id', gender: { value: 'unknown' } } },
  visit: {
    from: { schema: 'dw', table: 'stays', alias: 's' },
    where: "s.kind = 'H'",
    fields: { visit_id: 's.id', patient_id: 's.pid', start_datetime: { expr: 'CAST(s.start AS TIMESTAMP)' }, bogus: 's.x' },
  },
  drugs: [{
    label: 'Administrations',
    drugKind: 'administration',
    customSql: 'SELECT d.pid AS patient_id, d.code AS concept_id, d.at AS start_datetime, r.val AS rate_value\nFROM facts d JOIN facts r ON r.doc = d.doc AND r.attr = {{attr_rate}};',
    sqlColumns: ['patient_id', 'concept_id', 'start_datetime', 'rate_value'],
  }],
}

describe('classRelations (v2 mapping)', () => {
  it('compiles expressions, constants and filters, and pads the columns they name', () => {
    const visit = classRelation(v2, 'visit')!
    expect(visit.sql).toContain('(CAST(s.start AS TIMESTAMP)) AS start_datetime')
    expect(visit.sql).toContain(`WHERE (s.kind = 'H')`)
    expect(visit.sql).toContain('FROM (SELECT * FROM "dw"."stays" UNION ALL BY NAME SELECT NULL AS "id", NULL AS "pid", NULL AS "start", NULL AS "kind" WHERE false) s')
    expect(visit.problems).toEqual(['not a visit column: bogus'])
    expect(classRelation(v2, 'patient')!.sql).toContain(`'unknown' AS gender`)
  })

  it('projects custom SQL onto the contract, parameters as escaped literals', () => {
    const drug = drugRelation(v2, 'Administrations')!
    expect(drug.name).toBe('linkr_drug_administrations')
    expect(drug.custom).toBe(true)
    expect(drug.sql).toContain(`r.attr = 'RATE''1'`)
    expect(drug.sql).not.toContain(';')
    expect(drug.sql).toContain(`COALESCE(_c."drug_kind", 'administration') AS drug_kind`)
    expect(drug.sql).toContain('_c."dose_source_value" AS dose_source_value')
    expect([...drug.mapped].sort()).toEqual(['concept_id', 'drug_kind', 'patient_id', 'rate_value', 'start_datetime'])
  })

  it('refuses custom SQL that is not a single SELECT, loudly', () => {
    const rel = classRelation({ ...v2, visit: { customSql: 'DELETE FROM stays' } }, 'visit')!
    expect(rel.problems).toEqual(['custom SQL must be a single SELECT statement'])
    expect(rel.sql).toContain("error('Custom SQL of the visit relation")
  })

  it('never substitutes a parameter inside a literal or as an identifier', () => {
    const params = { a: { default: 'x' } }
    expect(substituteParams(`WHERE c = {{a}} AND d = '{{a}}' AND e = {{missing}}`, params)).toBe(`WHERE c = 'x' AND d = '{{a}}' AND e = NULL`)
  })
})

describe('export order', () => {
  it('orders fields exactly like the contracts (the format package keeps its own copy)', async () => {
    const { RELATION_COLUMN_ORDER } = await import('@linkr/format')
    const { CLASS_CONTRACTS } = await import('./contracts')
    const byKey = { patient: 'patient', visit: 'visit', visitDetail: 'visit_detail', note: 'note', concepts: 'concept', events: 'event', drugs: 'drug' } as const
    for (const [key, cls] of Object.entries(byKey)) {
      expect(RELATION_COLUMN_ORDER[key]).toEqual(CLASS_CONTRACTS[cls].map((c) => c.name))
    }
  })
})

describe('readableRelationSql', () => {
  it('writes the form as a person would: mapped columns, no padding, parameters kept', () => {
    const m: SchemaMapping = { ...v2, visit: { ...v2.visit!, where: 's.kind = {{attr_rate}}' } }
    const sql = readableRelationSql(m, 'visit')!
    expect(sql).toBe([
      'SELECT',
      '  s."id" AS visit_id,',
      '  s."pid" AS patient_id,',
      '  (CAST(s.start AS TIMESTAMP)) AS start_datetime',
      'FROM "dw"."stays" s',
      'WHERE (s.kind = {{attr_rate}})',
    ].join('\n'))
    expect(generatedRelationSql(m, 'visit')).toContain(`WHERE (s.kind = 'RATE''1')`)
  })

  it('keeps the derived columns, which a switch to SQL would otherwise lose', () => {
    expect(readableRelationSql(omop, 'patient')).toContain(`THEN 'male'`)
    expect(readableRelationSql(v2, 'drugs.Administrations')).toBeNull()
  })
})

describe('checkContract', () => {
  const described = [
    { column_name: 'visit_id', column_type: 'BIGINT' },
    { column_name: 'patient_id', column_type: 'VARCHAR' },
    { column_name: 'start_datetime', column_type: 'VARCHAR' },
    { column_name: 'end_datetime', column_type: '"NULL"'.replace(/"/g, '') },
    { column_name: 'ward', column_type: 'VARCHAR' },
  ]

  it('reports what the SQL fills, what it misses and what does not fit', () => {
    const r = checkContract('visit', described)
    expect(r.filled).toEqual(['visit_id', 'patient_id', 'start_datetime'])
    expect(r.missingRequired).toEqual([])
    expect(r.unknown).toEqual(['ward'])
    expect(r.typeMismatches).toEqual([{ column: 'start_datetime', type: 'VARCHAR', expected: 'datetime' }])
    expect(checkContract('visit', described.slice(1)).missingRequired).toEqual(['visit_id'])
  })

  it('flags a window over the whole relation, not one partitioned per patient', () => {
    expect(hasGlobalWindow('SELECT ROW_NUMBER() OVER (ORDER BY id) AS drug_id FROM t')).toBe(true)
    expect(hasGlobalWindow('SELECT ROW_NUMBER() OVER (PARTITION BY pid ORDER BY id) FROM t')).toBe(false)
    expect(hasGlobalWindow("SELECT 'OVER (ORDER BY x)' FROM t")).toBe(false)
  })
})

describe('per-database overrides', () => {
  const base = v2
  const site: SchemaMapping = {
    ...base,
    visit: { ...base.visit!, where: "s.kind = 'X'" },
    events: [{ label: 'Local', from: { table: 'local', alias: 'e' }, fields: { patient_id: 'e.pid' } }],
  }

  it('records the relations a database changed, with the base they were made against', () => {
    const o = diffOverrides(base, site, { params: { attr_rate: 'R2' } })
    expect(Object.keys(o.relations!)).toEqual(['visit', 'events.Local'])
    expect(o.baseAtOverride!.visit).toBe(relationFingerprint('visit', base.visit))
    expect(o.baseAtOverride!.visit).toMatch(/^[0-9a-f]{8}$/)
    expect(o.baseAtOverride!['events.Local']).toBe('none')
    // Key order does not change the fingerprint.
    const reordered = { fields: base.visit!.fields, where: base.visit!.where, from: base.visit!.from }
    expect(relationFingerprint('visit', reordered)).toBe(relationFingerprint('visit', base.visit))
    expect(o.params).toEqual({ attr_rate: 'R2' })
  })

  it('applies relations and parameter values on top of the base', () => {
    const o = diffOverrides(base, site, { params: { attr_rate: 'R2', unknown: 'x' } })
    const eff = effectiveMapping(base, o)
    expect(eff.visit?.where).toBe("s.kind = 'X'")
    expect(eff.events?.map((e) => e.label)).toEqual(['Local'])
    expect(eff.params).toEqual({ attr_rate: { default: 'R2' } })
    expect(drugRelation(eff, 'Administrations')!.sql).toContain(`r.attr = 'R2'`)
    expect(effectiveMapping(base, undefined)).toBe(base)
  })

  it('flags an override whose base the preset changed, and reverts one relation', () => {
    const o = diffOverrides(base, site)
    const updated: SchemaMapping = { ...base, visit: { ...base.visit!, fields: { ...base.visit!.fields, end_datetime: 's.end' } } }
    expect(staleOverrides(updated, o)).toEqual(['visit'])
    expect(staleOverrides(base, o)).toEqual([])
    const reverted = revertOverride(o, 'visit')
    expect(Object.keys(reverted.relations!)).toEqual(['events.Local'])
    expect(isEmptyOverrides(revertOverride(reverted, 'events.Local'))).toBe(true)
  })
})
