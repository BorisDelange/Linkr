import { describe, it, expect } from 'vitest'
import { buildCohortMembershipSql, buildCohortResultsSql } from './cohort-query'
import type { Cohort, CohortLevel, SchemaMapping } from '@/types'

// The membership query freezes cohort content into a snapshot (materialization).
// It must return both the level id and a patient_id, and must NOT cap rows with
// a LIMIT — a truncated snapshot would silently lose members.

const mapping: SchemaMapping = {
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: {
    table: 'visit',
    idColumn: 'visit_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'start',
    endDateColumn: 'end',
  },
} as unknown as SchemaMapping

function makeCohort(level: CohortLevel): Cohort {
  return {
    id: 'c1',
    projectUid: 'p1',
    name: 'Test',
    description: '',
    level,
    criteriaTree: {
      kind: 'group',
      id: 'root',
      operator: 'AND',
      children: [],
      exclude: false,
      enabled: true,
    },
    schemaVersion: 4,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  }
}

describe('buildCohortMembershipSql', () => {
  it('at patient level returns id + patient_id from the same column, no LIMIT', () => {
    const sql = buildCohortMembershipSql(makeCohort('patient'), mapping)!
    expect(sql).toContain('"person"."person_id" AS id')
    expect(sql).toContain('"person"."person_id" AS patient_id')
    expect(sql).not.toMatch(/LIMIT/i)
  })

  it('at visit level returns the visit id but the patient FK as patient_id', () => {
    const sql = buildCohortMembershipSql(makeCohort('visit'), mapping)!
    expect(sql).toContain('"visit"."visit_id" AS id')
    expect(sql).toContain('"visit"."person_id" AS patient_id')
  })

  it('returns null for event level (no single base table)', () => {
    expect(buildCohortMembershipSql(makeCohort('event'), mapping)).toBeNull()
  })
})

// A visit-level cohort whose criteria never touch the patient table still
// SELECTs gender/age through the `p` alias. Before the join was forced, DuckDB
// answered `Binder Error: Referenced table "p" not found!` — and because only
// this query (not the count) failed, the run looked like it had never happened.
describe('buildCohortResultsSql patient join', () => {
  const withPatientCols = {
    ...mapping,
    patientTable: {
      table: 'person',
      idColumn: 'person_id',
      genderColumn: 'gender_concept_id',
      birthYearColumn: 'year_of_birth',
    },
  } as unknown as SchemaMapping

  it('joins the patient table whenever a p.-qualified column is selected', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), withPatientCols)!
    expect(sql).toContain('INNER JOIN "person" p')
    // Every `p.` reference must be covered by that join.
    expect(sql).toMatch(/p\."gender_concept_id"/)
  })

  it('never emits a p. reference without the join', () => {
    for (const level of ['patient', 'visit'] as CohortLevel[]) {
      const sql = buildCohortResultsSql(makeCohort(level), withPatientCols)
      if (!sql) continue
      if (/\bp\."/.test(sql)) expect(sql).toContain('INNER JOIN "person" p')
    }
  })

  it('leaves the join out when the mapping exposes no patient-derived column', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), mapping)!
    expect(sql).not.toContain('INNER JOIN "person" p')
    expect(sql).not.toMatch(/\bp\."/)
  })
})

// MIMIC-IV maps both a birth date and a birth year, but person.birth_datetime is
// NULL for all 364k rows — preferring the date outright made age_at_admission
// NULL for every result.
describe('buildCohortResultsSql age column', () => {
  const withBoth = {
    ...mapping,
    patientTable: {
      table: 'person',
      idColumn: 'person_id',
      birthDateColumn: 'birth_datetime',
      birthYearColumn: 'year_of_birth',
    },
  } as unknown as SchemaMapping

  it('falls back to the birth year per row when both are mapped', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), withBoth)!
    expect(sql).toContain('COALESCE(')
    expect(sql).toContain('"birth_datetime"')
    expect(sql).toContain('"year_of_birth"')
    expect(sql).toMatch(/AS age_at_admission/)
  })

  it('emits a single expression when only one of the two is mapped', () => {
    const yearOnly = {
      ...mapping,
      patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth' },
    } as unknown as SchemaMapping
    const sql = buildCohortResultsSql(makeCohort('visit'), yearOnly)!
    expect(sql).not.toContain('COALESCE(')
    expect(sql).toContain('"year_of_birth"')
  })
})
