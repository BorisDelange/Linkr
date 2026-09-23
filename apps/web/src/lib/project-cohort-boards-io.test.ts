import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { buildProjectZip, importProjectContent, parseProjectZip } from './entity-io'
import { deterministicId } from '@/lib/deterministic-id'
import type { Storage } from '@/lib/storage'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer: vi.fn() }))

// A project cohort has its own patient board, apart from the project's Patient
// data boards: exported beside the cohort (cohort-boards/<cohort key>.json), and
// read back onto the cohort the same key lands on.

const cohort = {
  id: 'co-1', projectUid: 'p-src', dataSourceId: 'db-local', dataSourceRef: { lineageId: 'lin-db' },
  name: { en: 'Adults' }, level: 'patient',
  criteriaTree: { kind: 'group', id: 'root', operator: 'AND', children: [], exclude: false, enabled: true },
}
const boards = [
  { id: 'pb-1', projectUid: 'p-src', name: { en: 'Bedside' }, displayOrder: 0 },
  {
    id: 'cb-1', projectUid: 'p-src', ownerCohortId: 'co-1', dataSourceId: 'db-local',
    dataSourceRef: { lineageId: 'lin-db' }, name: { en: 'Patient review' }, displayOrder: 0,
  },
]
const tabs = [
  { id: 't-1', patientDashboardId: 'pb-1', name: { en: 'Vitals' }, displayOrder: 0 },
  { id: 't-2', patientDashboardId: 'cb-1', name: { en: 'Vitals' }, displayOrder: 0 },
]
const widgets = [
  { id: 'w-1', tabId: 't-2', name: { en: 'Summary' }, layout: { x: 0, y: 0, w: 12, h: 6 }, pluginId: 'linkr-widget-patient-summary', config: {} },
]

const sourceStorage = {
  projects: { getById: async () => ({ uid: 'p-src', name: { en: 'P' }, projectId: 'p' }) },
  ideFiles: { getByProject: async () => [] },
  pipelines: { getByProject: async () => [] },
  cohorts: { getByProject: async () => [cohort] },
  connections: { getByProject: async () => [] },
  dashboards: { getByProject: async () => [] },
  patientDashboards: { getByProject: async () => boards },
  patientDashboardTabs: { getByDashboard: async (id: string) => tabs.filter((t) => t.patientDashboardId === id) },
  patientDashboardWidgets: { getByTab: async (id: string) => widgets.filter((w) => w.tabId === id) },
  datasetFiles: { getByProject: async () => [] },
  readmeAttachments: { getByOwner: async () => [] },
  workspaces: { getById: async () => undefined },
  organizations: { getById: async () => undefined },
} as unknown as Storage

async function exportTree(): Promise<JSZip> {
  const built = await buildProjectZip('p-src', sourceStorage, {})
  return JSZip.loadAsync(await built!.blob.arrayBuffer())
}

describe('project cohort boards — export', () => {
  it("writes a cohort's board under its key, not among the Patient data boards", async () => {
    const zip = await exportTree()
    const files = Object.keys(zip.files).filter((p) => !zip.files[p].dir)
    expect(files.filter((p) => p.startsWith('patient-dashboards/'))).toEqual(['patient-dashboards/bedside.json'])
    const out = JSON.parse(await zip.files['cohort-boards/adults.json'].async('string'))
    // The file name is the link to the cohort; the board reads its cohort's database.
    for (const leaked of ['id', 'projectUid', 'ownerCohortId', 'dataSourceId', 'dataSourceRef']) {
      expect(out.patientDashboard).not.toHaveProperty(leaked)
    }
    expect(out.tabs).toHaveLength(1)
    expect(out.widgets).toHaveLength(1)
  })
})

describe('project cohort boards — import', () => {
  it('lands the board on the cohort the same key lands on, under ids scoped by that key', async () => {
    const zip = await exportTree()
    const parsed = await parseProjectZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    const created: Record<string, Record<string, unknown>[]> = {
      cohorts: [], patientDashboards: [], patientDashboardTabs: [], patientDashboardWidgets: [],
    }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        const p = String(prop)
        if (p === 'dataSources') return { getAll: async () => [{ id: 'db-here', lineageId: 'lin-db', workspaceId: 'ws' }] }
        if (created[p]) return { create: async (row: Record<string, unknown>) => { created[p].push(row) } }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage

    await importProjectContent(parsed!, 'p-new', store, { workspaceId: 'ws' })

    const cohortId = deterministicId('p-new', 'adults')
    expect(created.cohorts[0]).toMatchObject({ id: cohortId, dataSourceId: 'db-here' })
    const board = created.patientDashboards.find((b) => b.ownerCohortId)
    const boardId = deterministicId('p-new', 'cohort-boards/adults/patient-review')
    expect(board).toMatchObject({ id: boardId, projectUid: 'p-new', ownerCohortId: cohortId, dataSourceId: 'db-here' })
    expect(board).not.toHaveProperty('ownerDataSourceId')
    // The Patient data board keeps its own id space: same tab key, distinct ids.
    expect(created.patientDashboards.filter((b) => !b.ownerCohortId)).toHaveLength(1)
    const tabIds = created.patientDashboardTabs.map((t) => t.id)
    expect(new Set(tabIds).size).toBe(2)
    expect(created.patientDashboardTabs.find((t) => t.patientDashboardId === boardId)?.id)
      .toBe(deterministicId('p-new', 'cohort-boards/adults/patient-review/vitals'))
    expect(created.patientDashboardWidgets[0]?.tabId).toBe(deterministicId('p-new', 'cohort-boards/adults/patient-review/vitals'))
  })
})
