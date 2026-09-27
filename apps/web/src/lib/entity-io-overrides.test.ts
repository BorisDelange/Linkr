import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { applyClonedEntity, buildDataSourceFolder, parseWorkspaceZip } from './entity-io'
import type { Storage } from './storage'
import type { DataSource } from '@/types'
import type { SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))

const BASE: SchemaMapping = {
  formatVersion: 2, presetId: 't', presetLabel: { en: 't' },
  patient: { from: { table: 'persons', alias: 'p' }, fields: { patient_id: 'p.id' } },
  visit: { from: { table: 'stays', alias: 's' }, fields: { visit_id: 's.id', patient_id: 's.pid' } },
}

const OVERRIDES: SchemaOverrides = {
  relations: {
    visit: { customSql: 'SELECT id AS visit_id, pid AS patient_id FROM stays WHERE kept' },
    'events.labs': { label: 'labs', from: { table: 'labs', alias: 'l' }, fields: { patient_id: 'l.pid', concept_id: 'l.item' } },
  } as SchemaOverrides['relations'],
  baseAtOverride: { visit: '0badf00d', 'events.labs': 'none' },
}

const SOURCE = {
  id: 'db-1', entityId: 'site-db', alias: 'site_db', name: { en: 'Site' }, description: {},
  sourceType: 'database', lineageId: 'lin-db', connectionConfig: { engine: 'duckdb' },
  schemaMapping: BASE, schemaOverrides: OVERRIDES,
} as unknown as DataSource

const emptyStorage = new Proxy({}, {
  get: () => new Proxy({}, { get: () => async () => [] }),
}) as unknown as Storage

function recordingStorage(): { store: Storage; created: Partial<DataSource>[] } {
  const created: Partial<DataSource>[] = []
  const store = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'dataSources') return {
        getAll: async () => [], getById: async () => null,
        create: async (ds: Partial<DataSource>) => { created.push(ds) },
        update: async () => {},
      }
      if (prop === 'files') return { getByDataSource: async () => [], create: async () => {}, delete: async () => {} }
      return new Proxy({}, { get: () => async () => [] })
    },
  }) as unknown as Storage
  return { store, created }
}

async function exported(prefix = ''): Promise<JSZip> {
  const zip = new JSZip()
  await buildDataSourceFolder(zip, prefix, SOURCE, emptyStorage)
  return zip
}

async function cloned(zip: JSZip): Promise<Partial<DataSource>> {
  const { store, created } = recordingStorage()
  expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toEqual({ ok: true })
  return created[0]
}

describe('database overrides round trip', () => {
  it('a cloned repo restores the overrides it was exported with', async () => {
    const row = await cloned(await exported())
    expect(row.schemaOverrides).toEqual(OVERRIDES)
  })

  it('a workspace ZIP reads the overrides back', async () => {
    const zip = await exported('databases/site-db/')
    zip.file('entity.json', JSON.stringify({ name: { en: 'W' }, type: 'workspace' }))
    const parsed = await parseWorkspaceZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    expect(parsed!.databases[0].schemaOverrides).toEqual(OVERRIDES)
  })

  it('drops an unsafe identifier, and a from left without its table', async () => {
    const zip = await exported()
    zip.file('mapping-overrides.json', JSON.stringify({
      relations: {
        visit: { from: { table: 'stays"; DROP TABLE x; --', alias: 's' }, fields: { visit_id: 's.id' } },
        'events.labs': { label: 'labs', from: { table: 'labs', alias: 'l' }, fields: { patient_id: 'l.pid" OR 1=1' } },
      },
    }))
    const row = await cloned(zip)
    const relations = row.schemaOverrides!.relations!
    expect(relations.visit.from).toBeUndefined()
    expect(relations.visit.fields).toEqual({ visit_id: 's.id' })
    expect(relations['events.labs'].fields).toEqual({})
  })

  it('reads a file that is not an object as no overrides', async () => {
    for (const content of ['[]', '"x"', 'null', '{not json', '{"relations": []}']) {
      const zip = await exported()
      zip.file('mapping-overrides.json', content)
      expect((await cloned(zip)).schemaOverrides).toBeUndefined()
    }
  })
})
