import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { buildProjectZip, parseProjectZip } from './entity-io'
import type { Storage } from '@/lib/storage'
import type {
  PatientDashboard,
  PatientDashboardTab,
  PatientDashboardWidget,
  Project,
} from '@/types'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer: vi.fn() }))

// Patient boards are exported with derived content keys instead of UUIDs, exactly
// like dashboards: a delete+reimport must re-derive the same ids so the git diff
// stays byte-stable. These tests pin the key format and the round-trip.

const board: PatientDashboard = {
  id: 'uuid-board-1',
  projectUid: 'proj-uuid',
  name: { en: 'Haemodynamics', fr: 'Hémodynamique' },
  displayOrder: 0,
  version: '0.1.0',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
}

const tabs: PatientDashboardTab[] = [
  { id: 'uuid-tab-1', patientDashboardId: 'uuid-board-1', name: { en: 'Overview' }, displayOrder: 0 },
  { id: 'uuid-tab-2', patientDashboardId: 'uuid-board-1', name: { en: 'Labs' }, displayOrder: 1 },
]

const widgets: PatientDashboardWidget[] = [
  {
    id: 'uuid-w-1',
    tabId: 'uuid-tab-1',
    name: { en: 'Heart rate' },
    layout: { x: 0, y: 0, w: 48, h: 14 },
    pluginId: 'linkr-widget-timeline',
    config: { conceptIds: [3027018] },
  },
  {
    id: 'uuid-w-2',
    tabId: 'uuid-tab-2',
    name: { en: 'Notes' },
    layout: { x: 0, y: 14, w: 48, h: 20 },
    pluginId: 'linkr-widget-notes',
    config: {},
  },
]

/** Storage returning the fixture for patient boards and nothing for everything else.
 *  `rowsTabs` lets a test hand the same tabs back in a different order. */
function makeStorage(rowsTabs: PatientDashboardTab[] = tabs): Storage {
  const empty = () => Promise.resolve([])
  const collection = (rows: unknown[]) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'getByProject' || prop === 'getByDashboard' || prop === 'getByTab') {
            return (parentId: string) => {
              if (prop === 'getByDashboard')
                return Promise.resolve(
                  (rows as PatientDashboardTab[]).filter((r) => r.patientDashboardId === parentId),
                )
              if (prop === 'getByTab')
                return Promise.resolve(
                  (rows as PatientDashboardWidget[]).filter((r) => r.tabId === parentId),
                )
              return Promise.resolve(rows)
            }
          }
          return () => Promise.resolve(undefined)
        },
      },
    )

  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'patientDashboards') return collection([board])
        if (prop === 'patientDashboardTabs') return collection(rowsTabs)
        if (prop === 'patientDashboardWidgets') return collection(widgets)
        if (prop === 'projects') {
          return { getById: () => Promise.resolve(project) }
        }
        return new Proxy({}, { get: () => empty })
      },
    },
  ) as unknown as Storage
}

const project = {
  uid: 'proj-uuid',
  // A clean export strips `uid`, so the parser identifies the project by this.
  projectId: 'proj-stable-id',
  name: { en: 'P' },
  config: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as Project

/** jsdom's Blob cannot be re-read by JSZip, so hand back an ArrayBuffer instead. */
async function buildZip(rowsTabs?: PatientDashboardTab[]): Promise<ArrayBuffer> {
  const built = await buildProjectZip('proj-uuid', makeStorage(rowsTabs))
  expect(built).toBeTruthy()
  return await (built!.blob as Blob).arrayBuffer()
}

async function exportedBoardJson() {
  const zip = await JSZip.loadAsync(await buildZip())
  const file = zip.file('patient-dashboards/haemodynamics.json')
  expect(file).toBeTruthy()
  return JSON.parse(await file!.async('string')) as {
    patientDashboard: Record<string, unknown>
    tabs: { key: string }[]
    widgets: { key: string; tabKey: string }[]
  }
}

describe('patient board export', () => {
  it('writes one file per board, named after the English slug', async () => {
    const bundle = await exportedBoardJson()
    expect(bundle.patientDashboard.name).toEqual({ en: 'Haemodynamics', fr: 'Hémodynamique' })
  })

  it('strips the UUIDs and the parent link in favour of content keys', async () => {
    const bundle = await exportedBoardJson()
    expect(bundle.patientDashboard.id).toBeUndefined()
    expect(bundle.patientDashboard.projectUid).toBeUndefined()
    for (const t of bundle.tabs) {
      expect((t as Record<string, unknown>).id).toBeUndefined()
      expect((t as Record<string, unknown>).patientDashboardId).toBeUndefined()
    }
    for (const w of bundle.widgets) {
      expect((w as Record<string, unknown>).id).toBeUndefined()
      expect((w as Record<string, unknown>).tabId).toBeUndefined()
    }
  })

  it('qualifies a tab key by its board and a widget key by tab + grid position', async () => {
    const bundle = await exportedBoardJson()
    expect(bundle.tabs.map((t) => t.key)).toEqual([
      'haemodynamics/labs',
      'haemodynamics/overview',
    ])
    const hr = bundle.widgets.find((w) => w.tabKey === 'haemodynamics/overview')
    expect(hr?.key).toBe('haemodynamics/overview/heart-rate@0,0')
  })

  it('sorts tabs and widgets by key so the bytes do not depend on row order', async () => {
    const bundle = await exportedBoardJson()
    const tabKeys = bundle.tabs.map((t) => t.key)
    expect([...tabKeys].sort()).toEqual(tabKeys)
  })

  it('drops updatedAt but keeps createdAt as portable provenance', async () => {
    const bundle = await exportedBoardJson()
    expect(bundle.patientDashboard.updatedAt).toBeUndefined()
    expect(bundle.patientDashboard.createdAt).toBe('2026-01-01T00:00:00Z')
  })

  it('keeps the widget on its plugin reference, config included', async () => {
    const bundle = await exportedBoardJson()
    const hr = bundle.widgets.find((w) => w.key.includes('heart-rate')) as Record<string, unknown>
    expect(hr.pluginId).toBe('linkr-widget-timeline')
    expect(hr.config).toEqual({ conceptIds: [3027018] })
  })
})

describe('patient board round-trip', () => {
  it('parses back the board with its tabs and widgets', async () => {
    const parsed = await parseProjectZip((await buildZip()) as unknown as File)
    expect(parsed).toBeTruthy()
    expect(parsed!.patientDashboards).toHaveLength(1)
    expect(parsed!.patientDashboardTabs).toHaveLength(2)
    expect(parsed!.patientDashboardWidgets).toHaveLength(2)
    // Links travel as keys, not ids.
    expect(parsed!.patientDashboardTabs![0].key).toBeTruthy()
    expect(parsed!.patientDashboardWidgets![0].tabKey).toBeTruthy()
  })

  it('yields empty sections for a ZIP exported before patient boards existed', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'x', name: { en: 'X' } }))
    const buf = (await zip.generateAsync({ type: 'arraybuffer' })) as unknown as File
    const parsed = await parseProjectZip(buf)
    expect(parsed).toBeTruthy()
    // Empty arrays, not undefined — the parser always emits the section.
    expect(parsed!.patientDashboards).toEqual([])
    expect(parsed!.patientDashboardTabs).toEqual([])
    expect(parsed!.patientDashboardWidgets).toEqual([])
  })
})

describe('patient board export is independent of DB row order', () => {
  // Two tabs sharing a name collide on their content key, and the `#` suffix
  // that separates them is handed out while iterating. Read the rows in the
  // other order and the pair swap keys: ids flip on reimport and git shows a
  // diff with no change behind it. The old "sorts by key" test could not catch
  // this — it sorted the output and never varied the input.
  const sameName: PatientDashboardTab[] = [
    { id: 'uuid-tab-a', patientDashboardId: 'uuid-board-1', name: { en: 'Labs' }, displayOrder: 0 },
    { id: 'uuid-tab-b', patientDashboardId: 'uuid-board-1', name: { en: 'Labs' }, displayOrder: 1 },
  ]

  async function boardBytes(rows: PatientDashboardTab[]): Promise<string> {
    const zip = await JSZip.loadAsync(await buildZip(rows))
    return await zip.file('patient-dashboards/haemodynamics.json')!.async('string')
  }

  it('gives two same-named tabs the same keys whichever order they arrive in', async () => {
    const forward = await boardBytes(sameName)
    const reverse = await boardBytes([...sameName].reverse())
    expect(forward).toBe(reverse)
    const keys = (JSON.parse(forward) as { tabs: { key: string }[] }).tabs.map((t) => t.key)
    expect(keys).toEqual(['haemodynamics/labs', 'haemodynamics/labs#1'])
  })
})
