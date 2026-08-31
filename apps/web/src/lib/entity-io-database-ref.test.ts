import { describe, it, expect, vi } from 'vitest'
import { importProjectContent } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
import type { Storage } from '@/lib/storage'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer: vi.fn() }))

// A patient board and a cohort each name the database they read. That id is this
// instance's local UUID, so the export strips it and carries `dataSourceRef`
// instead; the import resolves the pointer back to whatever local row matches.
// Get this wrong and an imported board silently reads another project's database.

const DATABASES = [
  { id: 'local-a', lineageId: 'lin-a', workspaceId: 'ws-1', name: { en: 'A' } },
  { id: 'local-b', lineageId: 'lin-b', workspaceId: 'ws-1', name: { en: 'B' } },
]

const emptyParsed = (over: Partial<ParsedProjectZip> = {}): ParsedProjectZip =>
  ({
    project: { uid: 'p1', name: { en: 'P' } },
    ideFiles: [], pipelines: [], cohorts: [], connections: [], conceptLists: [],
    dashboards: [], dashboardTabs: [], dashboardWidgets: [],
    datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
    patientDashboards: [], patientDashboardTabs: [], patientDashboardWidgets: [],
    attachmentsMeta: [], attachmentBlobs: new Map(),
    ...over,
  }) as unknown as ParsedProjectZip

const makeStore = () => {
  const created: Record<string, Record<string, unknown>[]> = { cohorts: [], patientDashboards: [] }
  const store = new Proxy({}, {
    get: (_t, prop) => {
      const p = String(prop)
      if (p === 'dataSources') return { getAll: async () => DATABASES }
      if (created[p]) {
        return { create: async (row: Record<string, unknown>) => { created[p].push(row) } }
      }
      return new Proxy({}, { get: () => async () => {} })
    },
  }) as unknown as Storage
  return { store, created }
}

describe('importProjectContent — portable database pointer', () => {
  it('resolves a cohort’s dataSourceRef to the local database id', async () => {
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      cohorts: [{ id: 'c1', name: 'C', dataSourceRef: { lineageId: 'lin-b' } }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store, { workspaceId: 'ws-1' })

    expect(created.cohorts[0]?.dataSourceId).toBe('local-b')
  })

  it('resolves a patient board’s dataSourceRef to the local database id', async () => {
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      patientDashboards: [{ id: 'b1', name: { en: 'B' }, dataSourceRef: { lineageId: 'lin-a' } }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store, { workspaceId: 'ws-1' })

    expect(created.patientDashboards[0]?.dataSourceId).toBe('local-a')
  })

  it('leaves the database unset when the pointer matches nothing', async () => {
    // Imported into an instance that does not have that database. Leaving the id
    // unset lets the lazy fallback pick a usable one, rather than pointing the
    // board at an id no row has.
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      cohorts: [{ id: 'c1', name: 'C', dataSourceRef: { lineageId: 'lin-unknown' } }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store, { workspaceId: 'ws-1' })

    expect(created.cohorts[0]?.dataSourceId).toBeUndefined()
  })

  it('never carries a foreign dataSourceId through when no workspace is known', async () => {
    // Without a workspace the pointer cannot be resolved; the exporting instance's
    // raw id must not survive, or it would address an unrelated local row.
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      cohorts: [{ id: 'c1', name: 'C', dataSourceId: 'foreign-uuid' }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store)

    expect(created.cohorts[0]?.dataSourceId).toBeUndefined()
  })
})
