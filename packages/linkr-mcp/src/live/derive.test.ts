import { describe, expect, it } from 'vitest'
import type { Job } from '@/lib/api/environments'
import type { Cohort, DataSource, SchemaMapping } from '@/types'
import { formatDerivePlan, formatJob, planDerivation } from './derive'

const mapping = {
  presetId: 'omop',
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'd' },
} as SchemaMapping

const db = (over: Partial<DataSource> = {}): DataSource => ({
  id: 'src', alias: 'mimic', name: { en: 'MIMIC' }, sourceType: 'database', workspaceId: 'ws', status: 'connected',
  lineageId: 'lin', entityId: 'mimic', connectionConfig: { engine: 'duckdb', managed: true }, schemaMapping: mapping,
  ...over,
} as DataSource)

const tree = { kind: 'group', id: 'root', operator: 'AND', exclude: false, enabled: true, children: [] } as Cohort['criteriaTree']
const cohort = (over: Partial<Cohort> = {}): Cohort => ({
  id: 'c2', ownerDataSourceId: 'src', name: { en: 'ICU adults' }, description: {}, level: 'visit', criteriaTree: tree, ...over,
} as Cohort)

const plan = (over: Partial<Parameters<typeof planDerivation>[0]> = {}) => planDerivation({
  cohort: cohort(), source: db(), siblings: [cohort()], databases: [db()],
  target: { kind: 'new-database' }, copyPersonless: true, newId: 'new', lineageId: 'lin-new', ...over,
})

describe('planDerivation', () => {
  it('creates a managed database named after the cohort, then derives into it', () => {
    const p = plan({ databases: [db(), db({ id: 'other', alias: 'icu_adults' })] })
    if ('error' in p) throw new Error(p.error)
    expect(p.sourceId).toBe('src')
    expect(p.create).toMatchObject({
      id: 'new', lineageId: 'lin-new', alias: 'icu_adults_2', name: { en: 'ICU adults' }, status: 'configuring',
      workspaceId: 'ws', connectionConfig: { engine: 'duckdb', managed: true }, sourceType: 'database',
    })
    expect(p.request.target).toEqual({ kind: 'new-database', dataSourceId: 'new' })
    expect(p.request.cohortId).toBe('c2')
    expect(p.request.membershipSql).toMatch(/AS patient_id/)
    expect(p.request.derivedFrom?.cohort).toEqual({ key: 'icu-adults', name: { en: 'ICU adults' } })
  })

  it('takes a name and a server path', () => {
    const p = plan({ target: { kind: 'new-database', name: 'Sepsis', path: '/srv/sepsis.duckdb' } })
    if ('error' in p) throw new Error(p.error)
    expect(p.create).toMatchObject({ alias: 'sepsis', name: { en: 'Sepsis' } })
    expect(p.request.target).toEqual({ kind: 'new-database', dataSourceId: 'new', path: '/srv/sepsis.duckdb' })
  })

  it('keys the cohort as its export does, a same-named sibling taking #2', () => {
    const p = plan({ siblings: [cohort(), cohort({ id: 'c1' })] })
    if ('error' in p) throw new Error(p.error)
    expect(p.request.derivedFrom?.cohort.key).toBe('icu-adults#2')
  })

  it('rebuilds a database derived before, creating nothing', () => {
    const derived = db({ id: 'd1', derivedFrom: { target: 'new-database' } as DataSource['derivedFrom'] })
    const p = plan({ databases: [db(), derived], target: { kind: 'new-database', rebuildId: 'd1' } })
    if ('error' in p) throw new Error(p.error)
    expect(p.create).toBeUndefined()
    expect(p.request.target).toEqual({ kind: 'new-database', dataSourceId: 'd1' })
    expect(plan({ target: { kind: 'new-database', rebuildId: 'src' } })).toHaveProperty('error')
  })

  it('does not record a project cohort on the cohort (the server would refuse it)', () => {
    const p = plan({ cohort: cohort({ ownerDataSourceId: undefined, projectUid: 'p1', dataSourceId: 'src' }) })
    if ('error' in p) throw new Error(p.error)
    expect(p.request.cohortId).toBeUndefined()
    expect(p.request.derivedFrom?.cohort.key).toBe('icu-adults')
  })

  it('refuses what the app refuses, in words', () => {
    expect(plan({ cohort: cohort({ customSql: 'SELECT 1' }) })).toEqual({ error: expect.stringMatching(/custom SQL/) })
    expect(plan({ cohort: cohort({ level: 'event' }) })).toEqual({ error: expect.stringMatching(/event-level/) })
    expect(plan({ source: db({ status: 'error' }) })).toEqual({ error: expect.stringMatching(/not connected/) })
    expect(plan({ source: db({ workspaceId: undefined }) })).toHaveProperty('error')
  })

  it('derives into a schema of a writable database, validating its name', () => {
    const p = plan({ target: { kind: 'schema' } })
    if ('error' in p) throw new Error(p.error)
    expect(p.create).toBeUndefined()
    expect(p.request.target).toEqual({ kind: 'schema', dataSourceId: 'src', schemaName: 'cohort_icu_adults' })
    expect(plan({ target: { kind: 'schema', schemaName: 'Bad name' } })).toEqual({ error: expect.stringMatching(/Invalid schema/) })

    const readOnly = db({ id: 'ro', connectionConfig: { engine: 'duckdb' } as DataSource['connectionConfig'] })
    expect(plan({ databases: [db(), readOnly], target: { kind: 'schema', databaseId: 'ro' } }))
      .toEqual({ error: expect.stringMatching(/may not create a schema/) })
    const elsewhere = db({ id: 'x', workspaceId: 'ws2' })
    expect(plan({ databases: [db(), elsewhere], target: { kind: 'schema', databaseId: 'x' } }))
      .toEqual({ error: expect.stringMatching(/same workspace/) })
  })

  it('declares a Postgres schema as a database unless told not to', () => {
    const pg = db({ id: 'pg', connectionConfig: { engine: 'postgresql', allowWrites: true } as DataSource['connectionConfig'] })
    const p = plan({ databases: [db(), pg], target: { kind: 'schema', databaseId: 'pg', schemaName: 'icu', replace: true } })
    if ('error' in p) throw new Error(p.error)
    expect(p.request.target).toEqual({
      kind: 'schema', dataSourceId: 'pg', schemaName: 'icu', replace: true, registerName: 'icu', registerAlias: 'icu',
    })
    const q = plan({ databases: [db(), pg], target: { kind: 'schema', databaseId: 'pg', schemaName: 'icu', register: false } })
    if ('error' in q) throw new Error(q.error)
    expect(q.request.target).toEqual({ kind: 'schema', dataSourceId: 'pg', schemaName: 'icu' })
  })
})

describe('formatDerivePlan', () => {
  it('lists filtered tables, then the ones without a patient id', () => {
    const out = formatDerivePlan([
      { schema: null, table: 'person', filter: 'patient', column: 'person_id' },
      { schema: 'vocab', table: 'concept', filter: null, column: null },
    ], false)
    expect(out).toContain('person: rows of the cohort\'s patients (person_id)')
    expect(out).toContain('vocab.concept: skipped')
  })
})

describe('formatJob', () => {
  const job = (over: Partial<Job>): Job => ({
    id: 'j1', projectUid: null, workspaceId: 'ws', kind: 'derive', label: 'ICU → ICU db', status: 'running',
    progress: 40, logTail: '', createdAt: '2026-09-24T10:00:00Z', ...over,
  })

  it('says to wait while running, with the last log lines', () => {
    const out = formatJob(job({ logTail: '5/12 measurement\n6/12 drug_exposure' }))
    expect(out).toMatch(/running, 40%/)
    expect(out).toMatch(/check again/)
    expect(out).toContain('6/12 drug_exposure')
  })

  it('gives the database to query when done', () => {
    const out = formatJob(job({
      status: 'done', progress: 100,
      result: {
        targetId: 'd1', cohortId: 'c1', dataSourceId: 'd1', patientCount: 12, unitCount: 15, builtAt: '',
        tables: [{ skipped: false }, { skipped: true }],
      } as unknown as Job['result'],
    }))
    expect(out).toContain('database_id d1 — 12 patient(s), 15 cohort row(s), 1 table(s) copied')
  })
})
