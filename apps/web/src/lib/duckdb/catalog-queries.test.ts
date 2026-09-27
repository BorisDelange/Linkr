import { describe, it, expect } from 'vitest'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { CatalogVariables, ServiceVariableConfig } from '@/types/catalog'
import { ageBucketLabels, defaultCatalogVariables } from '@/lib/data-catalog/config'
import {
  ageBucketExpr,
  buildConceptListQueries,
  buildCrossingEstimateQuery,
  buildCrossingQuery,
  periodExpr,
  serviceGroupingExpr,
} from './catalog-queries'

const mapping = {
  patientTable: { table: 'person', idColumn: 'person_id', birthDateColumn: 'birth_datetime', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_start_datetime', endDateColumn: 'visit_end_datetime', typeColumn: 'visit_source_value' },
  visitDetailTable: { table: 'visit_detail', idColumn: 'visit_detail_id', visitIdColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'visit_detail_start_datetime', endDateColumn: 'visit_detail_end_datetime', unitSourceValueColumn: 'visit_detail_source_value' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', categoryColumn: 'domain_id' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', sourceConceptIdColumn: 'measurement_source_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
  },
  genderValues: { male: '8507', female: '8532' },
} as unknown as SchemaMapping

const service = (patch: Partial<ServiceVariableConfig>): ServiceVariableConfig => ({
  enabled: true, level: 'visit_detail', grouping: 'all', topN: 10, groups: {}, unassigned: 'other', ...patch,
})

describe('variable expressions', () => {
  it('writes period modalities that sort chronologically', () => {
    expect(periodExpr('d', 'month')).toContain("'%Y-%m'")
    expect(periodExpr('d', 'year')).toContain("'%Y'")
    expect(periodExpr('d', 'quarter')).toContain("'-Q'")
  })

  it('labels age brackets exactly as ageBucketLabels does', () => {
    const sql = ageBucketExpr(mapping, 'd', [18, 65])!
    for (const label of ageBucketLabels([18, 65])) expect(sql).toContain(`'${label}'`)
    // Birth date first, birth year as the fallback: many OMOP ETLs fill only year_of_birth.
    expect(sql).toMatch(/COALESCE\(EXTRACT\(YEAR FROM AGE\(/)
  })

  it('keeps the top services and folds the rest into Other', () => {
    const sql = serviceGroupingExpr('s', service({ grouping: 'top' }), ['ICU', "O'Neil ward"])
    expect(sql).toContain("IN ('ICU', 'O''Neil ward') THEN s ELSE '__other__'")
  })

  it('maps services to named groups, the rest to Other or to itself', () => {
    const groups = { 'MICU': 'ICU', 'SICU': 'ICU', 'Cardio': 'Cardiology', 'Ignored': '  ' }
    const other = serviceGroupingExpr('s', service({ grouping: 'manual', groups }), [])
    expect(other).toContain("WHEN s IN ('MICU', 'SICU') THEN 'ICU'")
    expect(other).toContain("WHEN s IN ('Cardio') THEN 'Cardiology'")
    expect(other).not.toContain('Ignored')
    expect(other).toMatch(/ELSE '__other__' END$/)
    expect(serviceGroupingExpr('s', service({ grouping: 'manual', groups, unassigned: 'keep' }), [])).toMatch(/ELSE s END$/)
  })
})

describe('buildCrossingQuery', () => {
  const variables: CatalogVariables = { ...defaultCatalogVariables(), service: service({}) }

  it('counts patients and stays over visits without the concept variable', () => {
    const sql = buildCrossingQuery({ mapping, variables }, ['age', 'period'])!
    expect(sql).toContain('AS v_period')
    expect(sql).toContain('AS v_age')
    expect(sql).toContain('COUNT(DISTINCT vid)::BIGINT AS stays')
    // Canonical order, whatever order the variables were given in.
    expect(sql.indexOf('AS v_period')).toBeLessThan(sql.indexOf('AS v_age'))
  })

  it('counts patients and records over events with it, never a row twice', () => {
    const sql = buildCrossingQuery({ mapping, variables: { ...variables, concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } } }, ['concept', 'sex'])!
    expect(sql).toContain('COUNT(*)::BIGINT AS records')
    expect(sql).toContain('IS DISTINCT FROM e."measurement_concept_id"')
  })

  it('attaches events to the unit stay containing them', () => {
    const sql = buildCrossingQuery({ mapping, variables: { ...variables, concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } } }, ['concept', 'service'])!
    expect(sql).toContain('ev.edate >= CAST(vd."visit_detail_start_datetime" AS TIMESTAMP)')
  })

  it('restricts to the concepts of a chunk', () => {
    const sql = buildCrossingQuery({
      mapping,
      variables: { ...variables, concept: { enabled: true, level: 'concept', scope: 'all', topN: 10 } },
      conceptFilter: [{ dictKey: 'concept', ids: ['3000963', '3023314'] }],
    }, ['concept', 'period'])!
    expect(sql).toContain("IN ('3000963', '3023314')")
  })

  it('gives up when a variable cannot be expressed on this mapping', () => {
    expect(buildCrossingQuery({ mapping: { ...mapping, genderValues: undefined } as SchemaMapping, variables }, ['sex'])).toBeNull()
  })

  it('estimates within the periods the publication keeps', () => {
    const sql = buildCrossingEstimateQuery({ mapping, variables }, ['period', 'age'], 10)!
    expect(sql).toContain('WHERE patients >= 10')
    expect(sql).toContain('v_period BETWEEN (SELECT lo FROM rng) AND (SELECT hi FROM rng)')
  })
})

describe('buildConceptListQueries', () => {
  it('counts records on the events alone, visits only when an event falls within one', () => {
    const q = buildConceptListQueries(mapping, 'domain_id')!
    const sql = q.batchTemplates[0].buildSql([1, 2])
    expect(sql).toMatch(/per_concept AS \(\s*SELECT cid, COUNT\(\*\)::BIGINT AS record_count/)
    expect(sql).toContain('e.edate >= CAST(v."visit_start_datetime" AS TIMESTAMP)')
    expect(sql).toContain('WHERE cid IN (1, 2)')
  })
})
