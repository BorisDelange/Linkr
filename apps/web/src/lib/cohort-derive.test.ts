import { describe, expect, it } from 'vitest'
import type { Cohort, DataSource, SchemaMapping } from '@/types'
import { DERIVE_SCHEMA_NAME, derivableReason, derivationRequest, isWritableTarget, rebuildRequest } from './cohort-derive'

const mapping = {
  presetId: 'omop',
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'd' },
} as SchemaMapping

const db = (over: Partial<DataSource> = {}): DataSource => ({
  id: 'db1', alias: 'db', name: { en: 'Parent' }, sourceType: 'database', workspaceId: 'ws',
  lineageId: 'lin-parent', entityId: 'parent', status: 'connected',
  connectionConfig: { engine: 'duckdb', managed: true }, schemaMapping: mapping, ...over,
} as DataSource)

const tree = { kind: 'group', id: 'root', operator: 'AND', exclude: false, enabled: true, children: [] } as Cohort['criteriaTree']
const cohort = (over: Partial<Cohort> = {}): Cohort => ({
  id: 'c1', ownerDataSourceId: 'db1', name: { en: 'ICU' }, description: {}, level: 'visit', criteriaTree: tree, ...over,
} as Cohort)

describe('isWritableTarget', () => {
  it('takes a DuckDB Linkr owns, or a Postgres that allows writes — nothing else', () => {
    expect(isWritableTarget(db())).toBe(true)
    expect(isWritableTarget(db({ connectionConfig: { engine: 'duckdb' } as DataSource['connectionConfig'] }))).toBe(false)
    expect(isWritableTarget(db({ connectionConfig: { engine: 'postgresql' } as DataSource['connectionConfig'] }))).toBe(false)
    expect(isWritableTarget(db({ connectionConfig: { engine: 'postgresql', allowWrites: true } as DataSource['connectionConfig'] }))).toBe(true)
    expect(isWritableTarget(db({ isVocabularyReference: true }))).toBe(false)
  })
})

describe('derivableReason', () => {
  it('refuses custom SQL, the event level and a schema without patients', () => {
    expect(derivableReason(cohort(), db())).toBeNull()
    expect(derivableReason(cohort({ customSql: 'SELECT 1' }), db())).toBe('custom-sql')
    expect(derivableReason(cohort({ level: 'event' }), db())).toBe('event-level')
    expect(derivableReason(cohort(), db({ schemaMapping: { presetId: 'x' } as SchemaMapping }))).toBe('no-mapping')
  })
})

describe('DERIVE_SCHEMA_NAME', () => {
  it('accepts plain lowercase identifiers only', () => {
    expect(DERIVE_SCHEMA_NAME.test('cohort_1234')).toBe(true)
    for (const bad of ['Cohort', '1abc', 'a-b', 'a"; DROP', '']) expect(DERIVE_SCHEMA_NAME.test(bad)).toBe(false)
  })
})

describe('derivationRequest', () => {
  it('sends the membership at the cohort level and portable provenance', () => {
    const r = derivationRequest({ cohort: cohort(), cohortKey: 'icu', source: db(), copyPersonless: false, target: 'new-database' })
    expect(r.level).toBe('visit')
    expect(r.cohortId).toBe('c1')
    expect(r.copyPersonless).toBe(false)
    expect(r.membershipSql).toMatch(/AS id/)
    expect(r.membershipSql).toMatch(/AS patient_id/)
    expect(r.derivedFrom).toEqual({
      database: { lineageId: 'lin-parent', entityId: 'parent', label: { en: 'Parent' } },
      cohort: { key: 'icu', name: { en: 'ICU' } },
      level: 'visit', criteriaTree: tree, target: 'new-database', copyPersonless: false,
    })
    // No local id in what is exported with the derived database.
    expect(JSON.stringify(r.derivedFrom)).not.toContain('db1')
  })
})

describe('rebuildRequest', () => {
  const derived = (over: Partial<NonNullable<DataSource['derivedFrom']>> = {}) => db({
    id: 'db2',
    derivedFrom: {
      database: { lineageId: 'lin-parent' }, cohort: { key: 'icu', name: { en: 'ICU' } },
      level: 'patient', criteriaTree: tree, target: 'new-database', copyPersonless: false, ...over,
    },
  })

  it('rebuilds from the recorded snapshot, into the derived database itself', () => {
    const r = rebuildRequest(derived(), db(), 'c9')!
    expect(r.target).toEqual({ kind: 'new-database', dataSourceId: 'db2' })
    expect(r.level).toBe('patient')
    expect(r.copyPersonless).toBe(false)
    expect(r.cohortId).toBe('c9')
  })

  it('has nothing to rebuild for a SQL schema, or without provenance', () => {
    expect(rebuildRequest(derived({ target: 'schema' }), db())).toBeNull()
    expect(rebuildRequest(db(), db())).toBeNull()
  })
})
