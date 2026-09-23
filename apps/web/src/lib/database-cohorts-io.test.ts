import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { buildDataSourceFolder, readDatabaseCohorts, replaceDatabaseCohorts } from './entity-io'
import { deterministicId } from '@/lib/deterministic-id'
import type { Storage } from '@/lib/storage'
import type { Cohort, DataSource } from '@/types'

// A database's own cohorts travel inside its tree (cohorts/<key>.json): their
// definition only — never the frozen patient ids — and a re-import or a pull
// makes the database's cohorts exactly the tree's.

function memoryCohorts(initial: Cohort[] = []) {
  const rows = new Map(initial.map((c) => [c.id, c]))
  return {
    rows,
    api: {
      getByDatabase: async (id: string) => [...rows.values()].filter((c) => c.ownerDataSourceId === id),
      create: async (c: Cohort) => { rows.set(c.id, c) },
      update: async (id: string, changes: Partial<Cohort>) => { rows.set(id, { ...rows.get(id)!, ...changes }) },
      delete: async (id: string) => { rows.delete(id) },
    },
  }
}

const cohort = (over: Partial<Cohort>): Cohort => ({
  id: 'c1',
  ownerDataSourceId: 'db1',
  dataSourceId: 'db1',
  name: { en: 'Adults' },
  description: { en: '' },
  level: 'patient',
  criteriaTree: { kind: 'group', id: 'root', operator: 'AND', children: [], exclude: false, enabled: true },
  ...over,
} as Cohort)

const source = { id: 'db1', alias: 'db', name: { en: 'DB' }, sourceType: 'database', connectionConfig: { engine: 'duckdb' } } as unknown as DataSource

describe('database cohorts — export', () => {
  it('writes each cohort under cohorts/, without run results or patient ids', async () => {
    const mem = memoryCohorts([cohort({
      materialization: { level: 'patient', ids: ['7'], patientIds: ['7'], count: 1, materializedAt: 'x' },
      resultCount: 1,
      attrition: [],
    })])
    const zip = new JSZip()
    await buildDataSourceFolder(zip, 'db/', source, {
      cohorts: mem.api,
      files: { getByDataSource: async () => [] },
      readmeAttachments: { getByOwner: async () => [] },
      organizations: { getById: async () => undefined },
      workspaces: { getById: async () => undefined },
    } as unknown as Storage)
    const out = JSON.parse(await zip.files['db/cohorts/adults.json'].async('string'))
    expect(out.name).toEqual({ en: 'Adults' })
    for (const leaked of ['materialization', 'resultCount', 'attrition', 'id', 'ownerDataSourceId', 'dataSourceId']) {
      expect(out).not.toHaveProperty(leaked)
    }
  })
})

describe('database cohorts — import', () => {
  it('lands on ids derived from the database and the file key, dropping foreign patient ids', async () => {
    const zip = new JSZip()
    zip.file('cohorts/adults.json', JSON.stringify({
      name: { en: 'Adults' }, level: 'patient', criteriaTree: { kind: 'group' },
      materialization: { patientIds: ['from-elsewhere'] },
      projectUid: 'nope',
    }))
    const mem = memoryCohorts()
    await replaceDatabaseCohorts({ cohorts: mem.api } as unknown as Storage, 'db9', await readDatabaseCohorts(zip, ''))

    const [row] = [...mem.rows.values()]
    expect(row.id).toBe(deterministicId('db9', 'adults'))
    expect(row.ownerDataSourceId).toBe('db9')
    expect(row.dataSourceId).toBe('db9')
    expect(row).not.toHaveProperty('materialization')
    expect(row).not.toHaveProperty('projectUid')
    expect(row).not.toHaveProperty('exportKey')
  })

  it('makes the database cohorts exactly the tree’s, and leaves them alone when the tree has none', async () => {
    const kept = cohort({ id: deterministicId('db1', 'adults') })
    const gone = cohort({ id: deterministicId('db1', 'children'), name: { en: 'Children' } })
    const mem = memoryCohorts([kept, gone])
    const storage = { cohorts: mem.api } as unknown as Storage

    // An older tree, written before database cohorts: nothing may be wiped.
    await replaceDatabaseCohorts(storage, 'db1', [])
    expect(mem.rows.size).toBe(2)

    const zip = new JSZip()
    zip.file('cohorts/adults.json', JSON.stringify({ name: { en: 'Adults, renamed' }, level: 'visit', criteriaTree: {} }))
    await replaceDatabaseCohorts(storage, 'db1', await readDatabaseCohorts(zip, ''))
    expect([...mem.rows.keys()]).toEqual([kept.id])
    expect(mem.rows.get(kept.id)?.level).toBe('visit')
  })
})
