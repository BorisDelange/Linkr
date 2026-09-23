import { describe, it, expect, vi } from 'vitest'
import { importProjectContent } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
import type { Storage } from '@/lib/storage'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => true }))
vi.mock('@/lib/api/datasets', () => ({
  importDatasetOnServer: vi.fn(async ({ name }: { name: string }) => ({ id: `uploaded/${name}`, columns: [] })),
  recordDatasetOps: vi.fn(),
}))

// A dataset not marked for versioning is exported without its data, and a
// server does not recreate a dataset it has nothing to upload for. Its analysis
// then names a dataset this project does not have: creating it was refused,
// which failed the import half-way — the project row written, the list never
// re-read.

describe('importProjectContent — analysis of a dataset exported without data', () => {
  it('skips the analysis and imports the rest', async () => {
    const created: Record<string, Record<string, unknown>[]> = { datasetAnalyses: [], cohorts: [] }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        const p = String(prop)
        if (created[p]) return { create: async (row: Record<string, unknown>) => { created[p].push(row) } }
        return new Proxy({}, { get: () => async () => [] })
      },
    }) as unknown as Storage
    const parsed = {
      project: { uid: 'p1', name: { en: 'P' } },
      ideFiles: [], pipelines: [], connections: [], conceptLists: [],
      cohorts: [{ id: 'c1', name: 'C' }],
      dashboards: [], dashboardTabs: [], dashboardWidgets: [],
      patientDashboards: [], patientDashboardTabs: [], patientDashboardWidgets: [],
      datasetFiles: [
        { id: 'kept', name: 'kept.csv', type: 'file', parentId: null },
        { id: 'dataless', name: 'dataless.csv', type: 'file', parentId: null },
      ],
      datasetData: [{ datasetFileId: 'kept', rows: [{ a: 1 }] }],
      datasetRawFiles: [],
      datasetAnalyses: [
        { id: 'a1', datasetFileId: 'kept', name: 'Kept', type: 't', config: {} },
        { id: 'a2', datasetFileId: 'dataless', name: 'Orphan', type: 't', config: {} },
      ],
      attachmentsMeta: [], attachmentBlobs: new Map(),
    } as unknown as ParsedProjectZip

    await importProjectContent(parsed, 'p1', store)

    expect(created.datasetAnalyses.map((a) => a.name)).toEqual(['Kept'])
    expect(created.datasetAnalyses[0].datasetFileId).toBe('uploaded/kept.csv')
    expect(created.cohorts).toHaveLength(1)
  })
})
