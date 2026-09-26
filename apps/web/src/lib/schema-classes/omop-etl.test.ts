import { describe, expect, it } from 'vitest'
import { parseDdl } from '@/lib/ddl-parse'
import { eavSource, omopDdl, omopTarget } from './__fixtures__/omop-etl'
import { eventTargetChoices, generateOmopEtl, generatedScriptState } from './omop-etl'

// The scripts below were also run end to end on DuckDB (synthetic EAV tables,
// the OMOP DDL, a vocabulary with one 'Maps to'): every table filled as asserted.

const ddl = parseDdl(omopDdl)
const run = (opts: Parameters<typeof generateOmopEtl>[3] = { sourceLabel: 'EAV' }) => generateOmopEtl(eavSource, omopTarget, ddl, opts)
const script = (name: string, r = run()) => r.scripts.find((s) => s.name === name)!.sql

describe('generateOmopEtl', () => {
  it('writes one script per source relation, in load order', () => {
    const r = run()
    expect(r.warnings).toEqual([])
    expect(r.scripts.map((s) => [s.name, s.source])).toEqual([
      ['10_person.sql', 'patient'],
      ['20_visit_occurrence.sql', 'visit'],
      ['50_drug_exposure.sql', 'drugs.Administrations'],
    ])
  })

  it('inverts the target mapping and applies the OMOP rules to person', () => {
    const sql = script('10_person.sql')
    expect(sql).toContain('TRUNCATE target.person;')
    expect(sql).toContain('s.patient_id AS person_id')
    // The contract's normalised gender, through the target's own codes.
    expect(sql).toContain(`CASE s.gender WHEN 'male' THEN 8507 WHEN 'female' THEN 8532 ELSE 0 END AS gender_concept_id`)
    expect(sql).toContain('s.birth_year AS year_of_birth')
    expect(sql).toContain('0 AS race_concept_id')
    expect(sql).toContain('WITH linkr_patient AS NOT MATERIALIZED (')
    // Deaths go to their own table, dated.
    expect(sql).toContain('INSERT INTO target.death (person_id, death_date, death_datetime, death_type_concept_id)')
    expect(sql).toContain('WHERE s.death_datetime IS NOT NULL')
  })

  it('fills date companions, type concepts and the tables a relation joins', () => {
    const sql = script('20_visit_occurrence.sql')
    expect(sql).toContain('CAST(s.start_datetime AS DATE) AS visit_start_date')
    expect(sql).toContain('COALESCE(CAST(s.end_datetime AS DATE), CAST(s.start_datetime AS DATE)) AS visit_end_date')
    expect(sql).toContain('32817 AS visit_type_concept_id')
    expect(sql).toContain('INSERT OR IGNORE INTO target.care_site (care_site_id, care_site_name)')
    expect(sql).toContain('SELECT DISTINCT')
    expect(run({ sourceLabel: 'EAV', typeConceptId: 32818 }).scripts[1].sql).toContain('32818 AS visit_type_concept_id')
  })

  it("resolves concepts through the pipeline's vocabulary", () => {
    const ccr = script('50_drug_exposure.sql')
    expect(ccr).toContain(`LEFT JOIN target.concept sc ON sc.vocabulary_id = 'drug_codes' AND sc.concept_code = c.concept_code`)
    expect(ccr).toContain(`relationship_id = 'Maps to'`)
    expect(ccr).toContain('COALESCE(cr.concept_id_2, 0) AS drug_concept_id')
    expect(ccr).toContain('COALESCE(sc.concept_id, 0) AS drug_source_concept_id')
    expect(ccr).toContain('c.concept_code AS drug_source_value')
    expect(ccr).toContain('TODO(etl): drug_exposure_id is numbered per run')

    const stcm = script('50_drug_exposure.sql', run({ sourceLabel: 'EAV', conceptMode: 'stcm' }))
    expect(stcm).toContain('COALESCE(stcm.target_concept_id, 0) AS drug_concept_id')
    const asIs = script('50_drug_exposure.sql', run({ sourceLabel: 'EAV', conceptMode: 'as-is' }))
    expect(asIs).toContain('s.concept_id AS drug_concept_id')
    expect(asIs).not.toContain('target.concept')
  })

  it('routes events by the target table picked, drugs to drug_exposure by default', () => {
    expect(eventTargetChoices(eavSource, omopTarget)).toEqual([
      { specKey: 'drugs.Administrations', label: 'Administrations', cls: 'drug', tables: ['drug_exposure', 'measurement'], default: 'drug_exposure' },
    ])
    const skipped = run({ sourceLabel: 'EAV', eventTargets: { 'drugs.Administrations': null } })
    expect(skipped.scripts.map((s) => s.name)).not.toContain('50_drug_exposure.sql')
    expect(skipped.warnings).toEqual([{ kind: 'no-target-table', relation: 'drugs.Administrations' }])
  })
})

describe('generatedScriptState', () => {
  it('tells an untouched generated script from an edited one', () => {
    const sql = script('20_visit_occurrence.sql')
    expect(generatedScriptState(sql)).toBe('generated')
    expect(generatedScriptState(sql.replace('32817', '32818'))).toBe('modified')
    expect(generatedScriptState('SELECT 1')).toBe('foreign')
  })
})
