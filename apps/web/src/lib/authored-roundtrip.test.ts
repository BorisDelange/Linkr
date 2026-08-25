/**
 * The contract this file exists for: an entity written by the authoring tools
 * (the `@linkr/format` serializer, which the MCP server calls), installed into
 * Linkr, and exported again must produce **the same bytes**.
 *
 * Anything else means the first sync after an install commits a diff nobody
 * wrote — the newline, a key order, an id the app fills in. Each of those was a
 * real defect found by hand before this test existed.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { serializeEntity, type EntitySpecMap, type SerializableEntityKind } from '../../../../packages/linkr-format/src/serialize/entities'
import {
  applyClonedEntity, buildDataCatalogFolder, buildDqRuleSetFolder,
  buildSqlCollectionFolder, buildEtlPipelineFolder, buildSchemaPresetFolder,
} from './entity-io'
import type { Storage } from '@/lib/storage'

/** Storage stub: one row per table, updated in place like the real thing. */
function makeStore(rows: Record<string, Record<string, unknown>>, children: Record<string, unknown[]> = {}) {
  const table = (key: string) => ({
    getById: async () => rows[key],
    update: async (_id: string, c: Record<string, unknown>) => { rows[key] = { ...rows[key], ...c } },
    create: async (r: Record<string, unknown>) => { (children[key] ??= []).push(r) },
    createBatch: async (rs: unknown[]) => { (children[key] ??= []).push(...rs) },
    getAll: async () => (rows[key] ? [rows[key]] : []),
    getByWorkspace: async () => (rows[key] ? [rows[key]] : []),
    getByCollection: async () => children.files ?? [],
    getByPipeline: async () => children.files ?? [],
    getByRuleSet: async () => children.checks ?? [],
    deleteByRuleSet: async () => { children.checks = [] },
    deleteByCollection: async () => { children.files = [] },
    deleteByPipeline: async () => { children.files = [] },
  })
  return new Proxy({}, {
    get: (_t, prop) => {
      switch (prop) {
        case 'dataCatalogs': return table('row')
        case 'dqRuleSets': return table('row')
        case 'sqlScriptCollections': return table('row')
        case 'etlPipelines': return table('row')
        case 'dqCustomChecks': return table('checks')
        case 'sqlScriptFiles': case 'etlFiles': return table('files')
        default: return new Proxy({}, { get: () => async () => [] })
      }
    },
  }) as unknown as Storage
}

const zipOf = (files: { path: string; content: unknown }[]) => {
  const z = new JSZip()
  for (const f of files) z.file(f.path, f.content as string)
  return z
}
const readZip = async (z: JSZip) => {
  const o: Record<string, string> = {}
  for (const [p, e] of Object.entries(z.files)) if (!e.dir) o[p] = await e.async('string')
  return o
}

const ID = '11111111-2222-4333-8444-555555555555'
const LINEAGE = '99999999-8888-4777-8666-555555555555'
const CREATED = '2026-01-02T03:04:05.000Z'
const IDENTITY = { id: ID, entityId: 'my-entity', lineageId: LINEAGE, createdAt: CREATED, version: '0.1.0' }

type Case = {
  kind: SerializableEntityKind
  meta: string
  spec: EntitySpecMap[SerializableEntityKind]
  build: (zip: JSZip, row: unknown, store: Storage) => Promise<void>
}

const CASES: Case[] = [
  {
    kind: 'data-catalog', meta: 'catalog.json',
    spec: { ...IDENTITY, name: { en: 'C' }, description: { en: 'D' }, dimensions: ['gender'] } as never,
    build: (z, row, s) => buildDataCatalogFolder(z, '', row as never, s),
  },
  {
    kind: 'dq-rule-set', meta: 'rule-set.json',
    spec: { ...IDENTITY, name: { en: 'R' }, description: { en: 'D' }, checks: [{ name: 'c', sql: 'SELECT 1' }] } as never,
    build: (z, row, s) => buildDqRuleSetFolder(z, '', row as never, s),
  },
  {
    kind: 'sql-collection', meta: '_collection.json',
    spec: { ...IDENTITY, name: { en: 'S' }, description: { en: 'D' }, files: [{ path: 'q/a.sql', content: 'SELECT 1' }] } as never,
    build: (z, row, s) => buildSqlCollectionFolder(z, '', row as never, s),
  },
  {
    kind: 'etl-pipeline', meta: '_pipeline.json',
    spec: { ...IDENTITY, name: { en: 'E' }, description: { en: 'D' }, files: [{ path: 'e/a.sql', content: 'SELECT 1' }] } as never,
    build: (z, row, s) => buildEtlPipelineFolder(z, '', row as never, s),
  },
]

describe('authored tree → install → re-export', () => {
  it('schema-preset: the metadata file survives the round trip unchanged', async () => {
    // A preset is the one kind keyed on `entityId`: the clone mints its own local
    // `id` and lineage, so the round trip must survive without the repo naming
    // either. What it does carry — entityId, mapping, badges, createdAt, version,
    // lineageId — has to come back byte for byte.
    const spec = {
      presetId: 'omop-cdm-5-4',
      presetLabel: { en: 'OMOP CDM 5.4' },
      lineageId: LINEAGE,
      createdAt: CREATED,
      version: '0.1.0',
      mapping: { patientTable: { table: 'person', idColumn: 'person_id' } },
      ddl: 'CREATE TABLE person (person_id INTEGER);\n',
    }
    const authored = serializeEntity('schema-preset', spec as never)
    const written = Object.fromEntries(authored.map((f) => [f.path, f.content as string]))

    let saved: Record<string, unknown> | undefined
    const store = new Proxy({}, {
      get: (_t, prop) => prop === 'schemaPresets'
        ? { save: async (p: Record<string, unknown>) => { saved = p }, getById: async () => undefined }
        : new Proxy({}, { get: () => async () => [] }),
    }) as unknown as Storage

    // targetId is what the catalog install resolves for a preset: its entityId.
    expect(await applyClonedEntity(zipOf(authored), 'schema-preset', 'omop-cdm-5-4', store)).toBe(true)

    const out = new JSZip()
    await buildSchemaPresetFolder(out, '', saved as never, store)
    expect((await readZip(out))['preset.json']).toBe(written['preset.json'])
  })

  for (const c of CASES) {
    it(`${c.kind}: the metadata file survives the round trip unchanged`, async () => {
      const authored = serializeEntity(c.kind, c.spec as never)
      const written = Object.fromEntries(authored.map((f) => [f.path, f.content as string]))

      // The install adopts the repo's id as the local key (catalog `idOf`).
      const rows: Record<string, Record<string, unknown>> = { row: { id: ID } }
      const store = makeStore(rows)
      expect(await applyClonedEntity(zipOf(authored), c.kind, ID, store)).toBe(true)

      const out = new JSZip()
      await c.build(out, rows.row, store)
      const reExported = (await readZip(out))[c.meta]

      expect(reExported).toBe(written[c.meta])
    })
  }
})
