import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { applyClonedEntity, buildDataSourceFolder } from './entity-io'
import type { Storage } from './storage'
import type { DataSource } from '@/types'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))

const DERIVED_FROM = {
  database: { lineageId: 'lin-parent', entityId: 'parent', label: 'Parent' },
  cohort: { key: 'three', name: { en: 'Three' } },
  level: 'patient',
  criteriaTree: { kind: 'group', id: 'root', operator: 'AND', children: [] },
  target: 'new-database',
  options: {
    scope: 'patient',
    pseudonymization: {
      method: 'hmac', keepKey: true, reuseKeyOf: 'local-db-id.dm_other',
      correspondence: { dataSourceId: 'local-corr-id', schemaName: 'dm_private_corr', tableName: 'linkr_pseudonyms' },
    },
  },
  derivationId: 'tgt.dm_cohort_private',
  schemaName: 'dm_cohort_private',
  builtAt: '2026-10-01T00:00:00.000Z',
  patientCount: 3,
}

const SOURCE = {
  id: 'db-1', entityId: 'cohort-three', alias: 'cohort_three', name: { en: 'Cohort three' }, description: {},
  sourceType: 'database', lineageId: 'lin-db', connectionConfig: { engine: 'duckdb', managed: true },
  schemaMapping: { formatVersion: 2, presetId: 't', presetLabel: { en: 't' } },
  derivedFrom: DERIVED_FROM,
} as unknown as DataSource

const emptyStorage = new Proxy({}, {
  get: () => new Proxy({}, { get: () => async () => [] }),
}) as unknown as Storage

function recordingStorage(existing: DataSource | null) {
  const written: Partial<DataSource>[] = []
  const store = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'dataSources') return {
        getAll: async () => (existing ? [existing] : []), getById: async () => existing,
        create: async (ds: Partial<DataSource>) => { written.push(ds) },
        update: async (_id: string, ds: Partial<DataSource>) => { written.push(ds) },
      }
      if (prop === 'files') return { getByDataSource: async () => [], create: async () => {}, delete: async () => {} }
      return new Proxy({}, { get: () => async () => [] })
    },
  }) as unknown as Storage
  return { store, written }
}

async function exportedManifest(): Promise<{ zip: JSZip; meta: Record<string, unknown> }> {
  const zip = new JSZip()
  await buildDataSourceFolder(zip, '', SOURCE, emptyStorage)
  return { zip, meta: JSON.parse(await zip.files['entity.json'].async('string')) }
}

describe('derived database export', () => {
  it('carries the provenance a rebuild needs, never the build count or server-side names', async () => {
    const { meta } = await exportedManifest()
    expect(meta.derivedFrom).toEqual({
      database: DERIVED_FROM.database,
      cohort: DERIVED_FROM.cohort,
      level: 'patient',
      criteriaTree: DERIVED_FROM.criteriaTree,
      target: 'new-database',
      options: { scope: 'patient', pseudonymization: { method: 'hmac', keepKey: true } },
      builtAt: DERIVED_FROM.builtAt,
    })
  })

  it('a pull onto the database it came from keeps what this instance recorded', async () => {
    const { zip } = await exportedManifest()
    const { store, written } = recordingStorage({ ...SOURCE, id: 'db-target' } as DataSource)
    expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toEqual({ ok: true })
    expect(written[0].derivedFrom).toEqual(DERIVED_FROM)
  })

  it('a clone into a new database has none of the source instance’s names, even from an older tree', async () => {
    const { zip } = await exportedManifest()
    const meta = JSON.parse(await zip.files['entity.json'].async('string'))
    zip.file('entity.json', JSON.stringify({ ...meta, derivedFrom: DERIVED_FROM }))
    const { store, written } = recordingStorage(null)
    expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toEqual({ ok: true })
    const derived = written[0].derivedFrom as unknown as Record<string, unknown>
    expect(derived).not.toHaveProperty('patientCount')
    expect(derived).not.toHaveProperty('schemaName')
    expect(derived).not.toHaveProperty('derivationId')
    expect((derived.options as { pseudonymization: object }).pseudonymization).toEqual({ method: 'hmac', keepKey: true })
  })
})
