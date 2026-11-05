import { describe, expect, it } from 'vitest'
import { mappingV1ToV2 } from '@/lib/schema-classes/v1'
import type { Job } from '@/lib/api/environments'
import type { Cohort, DataSource } from '@/types'
import {
  deriveChoices, derivationOptions, formatDerivePlan, formatJob, planDerivation, previousDerivation, rebuildChoices, waitForJob,
} from './derive'
import type { DerivePlanTable } from '@/lib/api/data-sources'

const mapping = mappingV1ToV2({
  presetId: 'omop',
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: { table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id', startDateColumn: 'd' },
} as never)

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
    const ora = db({ id: 'ora', connectionConfig: { engine: 'oracle', allowWrites: true } as DataSource['connectionConfig'] })
    const o = plan({ databases: [db(), ora], target: { kind: 'schema', databaseId: 'ora', schemaName: 'cohort_t' } })
    if ('error' in o) throw new Error(o.error)
    expect(o.request.target).toMatchObject({ registerAlias: 'cohort_t' })
  })

  it('sends the options and checks where the correspondence goes', () => {
    const pg = db({ id: 'pg', connectionConfig: { engine: 'postgresql', allowWrites: true } as DataSource['connectionConfig'] })
    const options = { scope: 'visit' as const, birthPrecision: 'year' as const, pseudonymization: { method: 'hmac' as const, keepKey: true, correspondence: { dataSourceId: 'pg', schemaName: 'pseudonyms' } } }
    const p = plan({ databases: [db(), pg], options })
    if ('error' in p) throw new Error(p.error)
    expect(p.request.pseudonymization).toEqual(options.pseudonymization)
    expect(p.request.derivedFrom?.options).toEqual(options)
    expect(plan({ databases: [db(), pg], options, target: { kind: 'schema', databaseId: 'pg' } }))
      .toEqual({ error: expect.stringMatching(/database derived into/) })
    const onSource = { ...options, pseudonymization: { ...options.pseudonymization, correspondence: { dataSourceId: 'src', schemaName: 'p' } } }
    expect(plan({ options: onSource })).toEqual({ error: expect.stringMatching(/DuckDB file/) })
  })

  it('refuses a rebuild writing the correspondence into the database it rebuilds', () => {
    const derived = db({ id: 'd1', derivedFrom: { target: 'new-database' } as DataSource['derivedFrom'] })
    const options = {
      scope: 'visit' as const,
      pseudonymization: { method: 'hmac' as const, keepKey: true, correspondence: { dataSourceId: 'd1', schemaName: 'pseudonyms' } },
    }
    expect(plan({ databases: [db(), derived], options, target: { kind: 'new-database', rebuildId: 'd1' } }))
      .toEqual({ error: expect.stringMatching(/database being rebuilt/) })
  })

  it('writes into SQL Server and Doris only where writes are allowed, declaring the schema by default', () => {
    for (const engine of ['sqlserver', 'doris']) {
      const open = db({ id: engine, connectionConfig: { engine, allowWrites: true } as DataSource['connectionConfig'] })
      const p = plan({ databases: [db(), open], target: { kind: 'schema', databaseId: engine, schemaName: 'icu' } })
      if ('error' in p) throw new Error(p.error)
      expect(p.request.target).toEqual({ kind: 'schema', dataSourceId: engine, schemaName: 'icu', registerName: 'icu', registerAlias: 'icu' })
      const closed = db({ id: engine, connectionConfig: { engine } as DataSource['connectionConfig'] })
      expect(plan({ databases: [db(), closed], target: { kind: 'schema', databaseId: engine } }))
        .toEqual({ error: expect.stringMatching(/may not create a schema/) })
    }
  })
})

describe('derivationOptions', () => {
  const planTables: DerivePlanTable[] = [
    { schema: null, table: 'person', filter: 'patient', column: 'person_id', pseudonymized: ['person_id'] },
    { schema: null, table: 'measurement', filter: 'visit', column: 'visit_occurrence_id' },
    { schema: 'vocab', table: 'concept', filter: null, column: null },
    { schema: null, table: 'note', filter: null, column: null, unfilterable: 'visit_detail_id' },
  ]
  const conceptTree = {
    ...tree,
    children: [{ kind: 'criterion', id: 'k', type: 'concept', enabled: true, config: { conceptIds: [3, 4], conceptNames: { 3: 'HR' } } }],
  } as unknown as Cohort['criteriaTree']

  it('takes the app\'s defaults: the cohort\'s level, every copyable table, pseudonymised, birth to the month', () => {
    const r = derivationOptions(cohort(), planTables, {})
    if ('error' in r) throw new Error(r.error)
    expect(r.copyPersonless).toBe(true)
    expect(r.options).toEqual({
      scope: 'visit',
      tables: [{ schema: null, table: 'person' }, { schema: null, table: 'measurement' }, { schema: 'vocab', table: 'concept' }],
      birthPrecision: 'month',
      pseudonymization: { method: 'hmac', keepKey: true },
    })
  })

  it('keeps the tables, variables and pseudonyms asked', () => {
    const r = derivationOptions(cohort({ criteriaTree: conceptTree }), planTables, {
      scope: 'patient', tables: ['PERSON'], variables: 'criteria', birthPrecision: 'day', method: 'random',
      correspondence: { databaseId: 'pg' },
    })
    if ('error' in r) throw new Error(r.error)
    expect(r.copyPersonless).toBe(false)
    expect(r.options).toEqual({
      scope: 'patient',
      tables: [{ schema: null, table: 'person' }],
      variables: { conceptIds: [3, 4], conceptNames: { 3: 'HR' } },
      pseudonymization: {
        method: 'random', keepKey: false,
        correspondence: { dataSourceId: 'pg', schemaName: 'pseudonyms', tableName: 'linkr_pseudonyms' },
      },
    })
    const plain = derivationOptions(cohort(), planTables, { pseudonymize: false, copyPersonless: false, variables: [5, 5] })
    if ('error' in plain) throw new Error(plain.error)
    expect(plain.options.pseudonymization).toBeUndefined()
    expect(plain.options.variables).toEqual({ conceptIds: [5], conceptNames: {} })
    expect(plain.options.tables).toHaveLength(2)
  })

  it('refuses what the dialog would not send', () => {
    expect(derivationOptions(cohort({ level: 'patient' }), planTables, { scope: 'visit' })).toHaveProperty('error')
    expect(derivationOptions(cohort(), planTables, { tables: ['note'] })).toEqual({ error: expect.stringMatching(/note/) })
    expect(derivationOptions(cohort(), planTables, { variables: 'criteria' })).toEqual({ error: expect.stringMatching(/no concept/) })
    expect(derivationOptions(cohort(), planTables, { method: 'random', reuseKeyOf: 'd1' })).toHaveProperty('error')
    expect(derivationOptions(cohort(), planTables, { correspondence: { databaseId: 'pg', schemaName: 'Bad' } })).toHaveProperty('error')
  })
})

describe('deriveChoices', () => {
  it('leaves absent what the call does not state', () => {
    expect(deriveChoices({})).toEqual({})
    expect(deriveChoices({ birth_precision: 'year' })).toEqual({ birthPrecision: 'year' })
  })

  it('reads concept_ids as the concepts kept, and refuses them beside another variables choice', () => {
    expect(deriveChoices({ concept_ids: [3, 4] })).toEqual({ variables: [3, 4] })
    expect(deriveChoices({ variables: 'concepts', concept_ids: [3] })).toEqual({ variables: [3] })
    expect(deriveChoices({ variables: 'criteria', concept_ids: [3] })).toEqual({ error: expect.stringMatching(/variables concepts/) })
    expect(deriveChoices({ variables: 'concepts' })).toEqual({ variables: [] })
  })

  it('refuses a correspondence schema or table with no database to hold it', () => {
    expect(deriveChoices({ correspondence_schema: 'p' })).toEqual({ error: expect.stringMatching(/correspondence_database_id/) })
    expect(deriveChoices({ correspondence_table: 't' })).toEqual({ error: expect.stringMatching(/correspondence_database_id/) })
    expect(deriveChoices({ correspondence_database_id: 'pg', correspondence_table: 't' }))
      .toEqual({ correspondence: { databaseId: 'pg', schemaName: undefined, tableName: 't' } })
  })
})

describe('previousDerivation', () => {
  const options = { scope: 'visit' as const, birthPrecision: 'year' as const }

  it('reads a rebuilt database\'s own record', () => {
    const derived = db({ id: 'd1', derivedFrom: { target: 'new-database', options, copyPersonless: false } as DataSource['derivedFrom'] })
    expect(previousDerivation(cohort(), db(), [db(), derived], { kind: 'new-database', rebuildId: 'd1' }))
      .toEqual({ options, copyPersonless: false })
    expect(previousDerivation(cohort(), db(), [db(), derived], { kind: 'new-database' })).toBeUndefined()
  })

  it('reads the cohort\'s record of the schema a replace rebuilds', () => {
    const c = cohort({
      derivations: [
        { kind: 'schema', targetId: 'src', schemaName: 'cohort_icu_adults', builtAt: '', patientCount: 1, options },
        { kind: 'schema', targetId: 'src', schemaName: 'other', builtAt: '', patientCount: 1 },
      ],
    })
    expect(previousDerivation(c, db(), [db()], { kind: 'schema', replace: true })).toEqual({ options })
    expect(previousDerivation(c, db(), [db()], { kind: 'schema' })).toBeUndefined()
    expect(previousDerivation(c, db(), [db()], { kind: 'schema', replace: true, schemaName: 'fresh' })).toBeUndefined()
  })
})

describe('rebuildChoices', () => {
  const planTables: DerivePlanTable[] = [
    { schema: null, table: 'person', filter: 'patient', column: 'person_id' },
    { schema: null, table: 'measurement', filter: 'visit', column: 'visit_occurrence_id' },
    { schema: null, table: 'drug_exposure', filter: 'visit', column: 'visit_occurrence_id' },
    { schema: 'vocab', table: 'concept', filter: null, column: null },
  ]
  const stored = {
    scope: 'patient' as const,
    tables: [{ schema: null, table: 'person' }, { schema: null, table: 'measurement' }, { schema: 'vocab', table: 'concept' }],
    variables: { conceptIds: [3], conceptNames: { 3: 'HR' } },
    birthPrecision: 'year' as const,
    pseudonymization: {
      method: 'random' as const, keepKey: false,
      correspondence: { dataSourceId: 'pg', schemaName: 'p', tableName: 't' },
    },
  }
  const rebuilt = (previous: Parameters<typeof rebuildChoices>[0], stated: Parameters<typeof deriveChoices>[0] = {}) => {
    const choices = deriveChoices(stated)
    if ('error' in choices) throw new Error(choices.error)
    const r = derivationOptions(cohort(), planTables, rebuildChoices(previous, choices))
    if ('error' in r) throw new Error(r.error)
    return r
  }

  it('redraws what the derivation kept, not the defaults of a new one', () => {
    expect(rebuilt({ options: stored }).options).toEqual(stored)
  })

  it('changes only what the call states', () => {
    expect(rebuilt({ options: stored }, { birth_precision: 'month' }).options).toEqual({ ...stored, birthPrecision: 'month' })
    expect(rebuilt({ options: stored }, { copy_personless: false }).options.tables)
      .toEqual([{ schema: null, table: 'person' }, { schema: null, table: 'measurement' }])
    expect(rebuilt({ options: stored }, { variables: 'all' }).options.variables).toBeUndefined()
  })

  it('adds or removes the tables with no patient id from a list of tables', () => {
    const r = derivationOptions(cohort(), planTables, { tables: ['person'], copyPersonless: true })
    if ('error' in r) throw new Error(r.error)
    expect(r.options.tables).toEqual([{ schema: null, table: 'person' }, { schema: 'vocab', table: 'concept' }])
  })

  it('drops a recorded key reuse when the call switches to random pseudonyms', () => {
    const keyed = { ...stored, pseudonymization: { method: 'hmac' as const, keepKey: true, reuseKeyOf: 'k' } }
    expect(rebuilt({ options: keyed }, { method: 'random' }).options.pseudonymization).toEqual({ method: 'random', keepKey: false })
  })

  it('rebuilds one recorded before the options as it was: everything, unpseudonymised', () => {
    const r = rebuilt({ copyPersonless: false })
    expect(r.options).toEqual({
      scope: 'visit',
      tables: [{ schema: null, table: 'person' }, { schema: null, table: 'measurement' }, { schema: null, table: 'drug_exposure' }],
    })
    expect(r.copyPersonless).toBe(false)
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

  it('says why a table read without a patient id column is never copied', () => {
    const out = formatDerivePlan([{ schema: null, table: 'labs', filter: null, column: null, unresolved: 'events.Labs' }], true)
    expect(out).toContain('labs: skipped — relation events.Labs')
    expect(out).not.toContain('copied whole')
  })

  it('skips a table no kept set filters, and names the pseudonymised ids', () => {
    const out = formatDerivePlan([
      { schema: null, table: 'person', filter: 'patient', column: 'person_id', pseudonymized: ['person_id'] },
      { schema: null, table: 'note', filter: null, column: null, unfilterable: 'visit_detail_id', pseudonymized: ['note_id'] },
    ], true)
    expect(out).toContain('note: skipped — it carries visit_detail_id')
    expect(out).toContain('replaces: person_id.')
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
    expect(out).toMatch(/call get_job_status again/)
    expect(out).toContain('6/12 drug_exposure')
  })

  it('tells the agent to wait inside one call rather than poll', () => {
    expect(formatJob(job({ kind: 'suggestion-scores' }))).toMatch(/wait_seconds: 50/)
  })

  it('speaks of a database copy only for a derivation', () => {
    expect(formatJob(job({}))).toMatch(/copy of a large database/)
    expect(formatJob(job({ kind: 'embeddings-index' }))).not.toMatch(/database/)
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

describe('waitForJob', () => {
  const at = (status: Job['status']) => ({ id: 'j1', status } as Job)
  const noSleep = () => Promise.resolve()

  it('returns as soon as the job ends', async () => {
    const states = [at('running'), at('running'), at('done')]
    let reads = 0
    const job = await waitForJob(async () => states[Math.min(reads++, 2)], 50, noSleep, 0)
    expect(job.status).toBe('done')
    expect(reads).toBe(3)
  })

  it('reads once without a wait', async () => {
    let reads = 0
    expect((await waitForJob(async () => { reads++; return at('running') }, 0, noSleep)).status).toBe('running')
    expect(reads).toBe(1)
  })
})
