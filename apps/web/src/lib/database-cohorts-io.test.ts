import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { buildDataSourceFolder, readDatabaseBoards, readDatabaseCohorts, replaceDatabaseBoards, replaceDatabaseCohorts } from './entity-io'
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
      derivations: [{ kind: 'new-database', targetId: 'db2', builtAt: 'x', patientCount: 1 }],
    })])
    const zip = new JSZip()
    const derivedFrom = {
      database: { lineageId: 'parent', label: { en: 'Parent' } },
      cohort: { key: 'icu', name: { en: 'ICU' } },
      level: 'patient' as const,
      criteriaTree: cohort({}).criteriaTree,
      target: 'new-database' as const,
    }
    await buildDataSourceFolder(zip, 'db/', { ...source, derivedFrom }, {
      cohorts: mem.api,
      files: { getByDataSource: async () => [] },
      readmeAttachments: { getByOwner: async () => [] },
      organizations: { getById: async () => undefined },
      workspaces: { getById: async () => undefined },
    } as unknown as Storage)
    const out = JSON.parse(await zip.files['db/cohorts/adults.json'].async('string'))
    expect(out.name).toEqual({ en: 'Adults' })
    for (const leaked of ['materialization', 'resultCount', 'attrition', 'derivations', 'id', 'ownerDataSourceId', 'dataSourceId']) {
      expect(out).not.toHaveProperty(leaked)
    }
    // The database's own provenance does travel: portable pointers only.
    expect(JSON.parse(await zip.files['db/entity.json'].async('string')).derivedFrom).toEqual(derivedFrom)
  })
})

describe('database cohorts — import', () => {
  it('lands on ids derived from the database and the file key, dropping foreign patient ids', async () => {
    const zip = new JSZip()
    zip.file('cohorts/adults.json', JSON.stringify({
      name: { en: 'Adults' }, level: 'patient', criteriaTree: { kind: 'group' },
      materialization: { patientIds: ['from-elsewhere'] },
      derivations: [{ targetId: 'elsewhere' }],
      projectUid: 'nope',
    }))
    const mem = memoryCohorts()
    await replaceDatabaseCohorts({ cohorts: mem.api } as unknown as Storage, 'db9', await readDatabaseCohorts(zip, ''))

    const [row] = [...mem.rows.values()]
    expect(row.id).toBe(deterministicId('db9', 'adults'))
    expect(row.ownerDataSourceId).toBe('db9')
    expect(row.dataSourceId).toBe('db9')
    expect(row).not.toHaveProperty('materialization')
    expect(row).not.toHaveProperty('derivations')
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

describe('database patient board — import', () => {
  it('replaces the database board with the tree’s, ids derived from the database and the keys', async () => {
    const boards = new Map<string, Record<string, unknown>>([['old', { id: 'old', ownerDataSourceId: 'db1' }]])
    const tabs = new Map<string, Record<string, unknown>>([['old-tab', { id: 'old-tab', patientDashboardId: 'old' }]])
    const widgets = new Map<string, Record<string, unknown>>()
    const storage = {
      patientDashboards: {
        getByDatabase: async (id: string) => [...boards.values()].filter((b) => b.ownerDataSourceId === id),
        create: async (b: Record<string, unknown>) => { boards.set(b.id as string, b) },
        delete: async (id: string) => { boards.delete(id) },
      },
      patientDashboardTabs: {
        getByDashboard: async (id: string) => [...tabs.values()].filter((t) => t.patientDashboardId === id),
        create: async (t: Record<string, unknown>) => { tabs.set(t.id as string, t) },
        deleteByDashboard: async (id: string) => { for (const [k, t] of tabs) if (t.patientDashboardId === id) tabs.delete(k) },
      },
      patientDashboardWidgets: {
        create: async (w: Record<string, unknown>) => { widgets.set(w.id as string, w) },
        deleteByTab: async () => {},
      },
    } as unknown as Storage

    const zip = new JSZip()
    const bundle = (tab: string) => JSON.stringify({
      patientDashboard: { name: { en: 'Cohort review' } },
      tabs: [{ name: { en: tab }, displayOrder: 0, key: 'cohort-review/stay' }],
      widgets: [{ name: { en: 'Summary' }, pluginId: 'linkr-widget-patient-summary', config: {}, key: 'cohort-review/stay/summary@0,0', tabKey: 'cohort-review/stay' }],
    })
    // Two cohorts, two boards sharing every content key: scoped by the cohort key.
    zip.file('cohort-boards/adults.json', bundle('Stay'))
    zip.file('cohort-boards/icu.json', bundle('ICU stay'))
    zip.file('cohort-boards/nested/ignored.json', bundle('x'))
    await replaceDatabaseBoards(storage, 'db1', await readDatabaseBoards(zip, ''))

    const boardId = deterministicId('db1', 'adults/cohort-review')
    expect([...boards.keys()].sort()).toEqual([boardId, deterministicId('db1', 'icu/cohort-review')].sort())
    expect(boards.get(boardId)).toMatchObject({ ownerDataSourceId: 'db1', ownerCohortId: deterministicId('db1', 'adults'), dataSourceId: 'db1' })
    expect(tabs.get(deterministicId('db1', 'adults/cohort-review/stay'))).toMatchObject({ patientDashboardId: boardId })
    expect(tabs.size).toBe(2)
    expect(widgets.size).toBe(2)
  })

  it('leaves the local board alone when the tree has none', async () => {
    await expect(replaceDatabaseBoards({} as Storage, 'db1', await readDatabaseBoards(new JSZip(), ''))).resolves.toBeUndefined()
  })
})
