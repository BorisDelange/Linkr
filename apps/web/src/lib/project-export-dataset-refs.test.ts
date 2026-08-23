/**
 * A widget's `datasetFileId` must name a dataset the ZIP actually carries.
 *
 * The failure this guards against is silent: configure a widget front-only (dataset ids
 * are uuids), move the project to server mode (ids become paths), and the widget keeps a
 * uuid that no longer names anything. Exporting it verbatim produced a ZIP whose
 * datasets/_tree.json is keyed by path but whose widget points at a uuid — so the
 * re-import rebuilt a dashboard with a widget bound to nothing, with no error anywhere.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildProjectZip } from './entity-io'
import type { Storage } from './storage'

const PROJECT_UID = 'proj-1'

interface Widget {
  id: string
  tabId: string
  type: string
  datasetFileId?: string
}

/** Widgets key on their grid position, so every fixture widget needs a layout. */
function withLayout(w: Widget, i: number) {
  return { ...w, name: { en: w.id }, layout: { x: 0, y: i, w: 4, h: 3 } }
}

/** Minimal storage: one dashboard, one tab, the given widgets, the given datasets. */
function makeStorage(widgets: Widget[], datasetIds: string[]): Storage {
  const dashboard = { id: 'dash-1', projectUid: PROJECT_UID, name: { en: 'Board' } }
  const tab = { id: 'tab-1', dashboardId: 'dash-1', name: { en: 'Tab' } }
  return {
    projects: {
      getById: async () => ({ uid: PROJECT_UID, name: { en: 'P' }, organization: null }),
    },
    ideFiles: { getByProject: async () => [] },
    pipelines: { getByProject: async () => [] },
    cohorts: { getByProject: async () => [] },
    connections: { getByProject: async () => [] },
    dashboards: { getByProject: async () => [dashboard] },
    dashboardTabs: { getByDashboard: async () => [tab] },
    dashboardWidgets: { getByTab: async () => widgets.map(withLayout) },
    patientDashboards: { getByProject: async () => [] },
    patientDashboardTabs: { getByDashboard: async () => [] },
    patientDashboardWidgets: { getByTab: async () => [] },
    datasetFiles: {
      getByProject: async () =>
        datasetIds.map((id) => ({ id, name: id, type: 'file', parentId: null, projectUid: PROJECT_UID })),
    },
    datasetAnalyses: { getByDataset: async () => [] },
    datasetData: { get: async () => undefined },
    datasetRawFiles: { get: async () => undefined },
    readmeAttachments: { getByOwner: async () => [] },
    workspaces: { getById: async () => undefined },
    organizations: { getById: async () => undefined },
  } as unknown as Storage
}

async function exportedWidgets(widgets: Widget[], datasetIds: string[]): Promise<Record<string, unknown>[]> {
  const built = await buildProjectZip(PROJECT_UID, makeStorage(widgets, datasetIds), {})
  if (!built) throw new Error('build returned null')
  const zip = await JSZip.loadAsync(await built.blob.arrayBuffer())
  // `dashboards/` itself is a directory entry in the ZIP — match the .json inside it.
  const name = Object.keys(zip.files).find((f) => f.startsWith('dashboards/') && f.endsWith('.json'))
  if (!name) throw new Error('no dashboard file in the ZIP')
  const parsed = JSON.parse(await zip.files[name]!.async('string')) as {
    widgets: Record<string, unknown>[]
  }
  return parsed.widgets
}

describe('buildProjectZip: widget dataset references', () => {
  it('keeps a datasetFileId that names an exported dataset', async () => {
    const [widget] = await exportedWidgets(
      [{ id: 'w1', tabId: 'tab-1', type: 'chart', datasetFileId: 'icu_activity.csv' }],
      ['icu_activity.csv'],
    )
    expect(widget!.datasetFileId).toBe('icu_activity.csv')
  })

  it('drops a datasetFileId that names no exported dataset', async () => {
    // The real-world shape: tree keyed by path, widget still holding the old uuid.
    const [widget] = await exportedWidgets(
      [{ id: 'w1', tabId: 'tab-1', type: 'chart', datasetFileId: 'dc114ff5-a1c4-4486-8c17-141a0c7cd9ae' }],
      ['icu_activity.csv'],
    )
    expect(widget!.datasetFileId).toBeUndefined()
    // Only the dangling reference goes — the widget itself is still exported.
    expect(widget!.key).toBeDefined()
  })

  it('leaves a widget that never had a dataset alone', async () => {
    const [widget] = await exportedWidgets(
      [{ id: 'w1', tabId: 'tab-1', type: 'text' }],
      ['icu_activity.csv'],
    )
    expect('datasetFileId' in widget!).toBe(false)
  })

  it('drops every dangling reference when a project has no datasets at all', async () => {
    const widgets = await exportedWidgets(
      [
        { id: 'w1', tabId: 'tab-1', type: 'chart', datasetFileId: 'gone-1' },
        { id: 'w2', tabId: 'tab-1', type: 'chart', datasetFileId: 'gone-2' },
      ],
      [],
    )
    expect(widgets).toHaveLength(2)
    for (const w of widgets) expect(w.datasetFileId).toBeUndefined()
  })
})
