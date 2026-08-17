import { describe, it, expect } from 'vitest'
import {
  buildPatientDemographicsQuery,
  buildPatientSummaryQuery,
} from './patient-data-queries'
import type { SchemaMapping } from '@/types/schema-mapping'

// The age columns are the point of these tests. In OMOP CDM 5.4 `year_of_birth`
// is NOT NULL while `birth_datetime` is nullable and very often empty, so an age
// built from the precise column alone silently resolves to NULL for most real
// datasets — which is exactly how the sidebar's age field came to render "—".
// Both columns must therefore be COALESCEd, and both must reach the GROUP BY.

const patientTable = {
  table: 'person',
  idColumn: 'person_id',
  genderColumn: 'gender_concept_id',
}

const visitTable = {
  table: 'visit_occurrence',
  idColumn: 'visit_occurrence_id',
  patientIdColumn: 'person_id',
  startDateColumn: 'visit_start_date',
  endDateColumn: 'visit_end_date',
}

/** The OMOP preset shape: both birth columns mapped. */
const bothColumns = {
  patientTable: { ...patientTable, birthDateColumn: 'birth_datetime', birthYearColumn: 'year_of_birth' },
  visitTable,
} as unknown as SchemaMapping

const yearOnly = {
  patientTable: { ...patientTable, birthYearColumn: 'year_of_birth' },
  visitTable,
} as unknown as SchemaMapping

const dateOnly = {
  patientTable: { ...patientTable, birthDateColumn: 'birth_datetime' },
  visitTable,
} as unknown as SchemaMapping

const noBirth = {
  patientTable,
  visitTable,
} as unknown as SchemaMapping

describe('patient age expression', () => {
  it('falls back to the year column when the birth datetime is null', () => {
    const sql = buildPatientDemographicsQuery(bothColumns, '123')!
    // The whole bug: preferring birth_datetime alone yields NULL on OMOP data.
    expect(sql).toContain('COALESCE')
    expect(sql).toContain('birth_datetime')
    expect(sql).toContain('year_of_birth')
  })

  it('groups by every birth column it reads', () => {
    const sql = buildPatientDemographicsQuery(bothColumns, '123')!
    const groupBy = sql.slice(sql.indexOf('GROUP BY'))
    // Omitting either one is a DuckDB binder error, not a wrong number.
    expect(groupBy).toContain('birth_datetime')
    expect(groupBy).toContain('year_of_birth')
  })

  it('uses the year column directly when it is the only one mapped', () => {
    const sql = buildPatientDemographicsQuery(yearOnly, '123')!
    expect(sql).toContain('year_of_birth')
    expect(sql).not.toContain('COALESCE')
  })

  it('uses the birth date directly when it is the only one mapped', () => {
    const sql = buildPatientDemographicsQuery(dateOnly, '123')!
    expect(sql).toContain('birth_datetime')
    expect(sql).not.toContain('COALESCE')
  })

  it('omits the age column entirely when no birth column is mapped', () => {
    const sql = buildPatientDemographicsQuery(noBirth, '123')!
    expect(sql).not.toContain('AS age')
  })

  it('qualifies both birth columns with the table alias', () => {
    // An unqualified column is ambiguous once the visit table is joined.
    const sql = buildPatientDemographicsQuery(bothColumns, '123')!
    expect(sql).toContain('p."birth_datetime"')
    expect(sql).toContain('p."year_of_birth"')
  })

  it('applies the same fallback to the summary widget query', () => {
    const sql = buildPatientSummaryQuery(bothColumns, '123')!
    // Both age_first_visit and age_last_visit go through the same builder.
    expect(sql).toContain('age_first_visit')
    expect(sql).toContain('COALESCE')
    const groupBy = sql.slice(sql.indexOf('GROUP BY'))
    expect(groupBy).toContain('birth_datetime')
    expect(groupBy).toContain('year_of_birth')
  })

  it('casts the reference date so a bare year subtraction stays valid', () => {
    const sql = buildPatientDemographicsQuery(yearOnly, '123')!
    expect(sql).toContain('::TIMESTAMP')
  })
})
