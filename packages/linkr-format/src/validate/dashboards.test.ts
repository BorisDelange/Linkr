import { describe, expect, it } from 'vitest'
import { IssueBag } from '../issue.js'
import { MemoryTree } from '../tree.js'
import { validateDashboards } from './dashboards.js'
import { validateDatasets, type DatasetIndex } from './datasets.js'
import { validateProject } from './project.js'

/** Minimal valid dataset tree + CSV, so dashboard tests start from a clean base. */
function datasetFiles(): Record<string, string> {
  return {
    'datasets/_tree.json': JSON.stringify([
      {
        id: 'patients.csv',
        name: 'patients.csv',
        type: 'file',
        columns: [
          { id: 'col_age', name: 'age', type: 'number' },
          { id: 'col_sex', name: 'sex', type: 'string' },
        ],
      },
    ]),
    'datasets/patients/patients.csv': 'age,sex\n60,M\n',
  }
}

function dashboardDoc(overrides: {
  tabs?: unknown[]
  widgets?: unknown[]
  filterConfig?: unknown[]
}): string {
  return JSON.stringify({
    dashboard: {
      name: { en: 'Overview' },
      gridV: 2,
      filterConfig: overrides.filterConfig ?? [],
    },
    tabs: overrides.tabs ?? [{ name: { en: 'Main' }, key: 'overview/main', parentKey: null }],
    widgets: overrides.widgets ?? [],
  })
}

function runDashboards(files: Record<string, string>): ReturnType<IssueBag['all']> {
  const tree = new MemoryTree({ ...datasetFiles(), ...files })
  const bag = new IssueBag()
  const datasets: DatasetIndex = validateDatasets(tree, bag)
  validateDashboards(tree, bag, datasets)
  return bag.all()
}

const widget = (over: Record<string, unknown> = {}) => ({
  name: { en: 'Age' },
  key: 'overview/main/age@0,0',
  tabKey: 'overview/main',
  datasetFileId: 'patients.csv',
  layout: { x: 0, y: 0, w: 12, h: 8 },
  source: { type: 'plugin', pluginId: 'linkr-analysis-plot-builder', config: { xColumn: 'col_age' } },
  ...over,
})

describe('validateDashboards', () => {
  it('accepts a well-formed key-based dashboard', () => {
    const issues = runDashboards({ 'dashboards/overview.json': dashboardDoc({ widgets: [widget()] }) })
    expect(issues).toEqual([])
  })

  it('flags a widget attached to a tab that does not exist', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({ widgets: [widget({ tabKey: 'overview/ghost' })] }),
    })
    const orphan = issues.find((i) => i.code === 'orphan-record')
    expect(orphan?.severity).toBe('error')
    expect(orphan?.hint).toContain('overview/main')
  })

  it('flags a config column that is not in the widget dataset', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({
        widgets: [
          widget({
            source: { type: 'plugin', pluginId: 'p', config: { xColumn: 'col_weight' } },
          }),
        ],
      }),
    })
    const unknown = issues.find((i) => i.code === 'unknown-column')
    expect(unknown?.severity).toBe('error')
    // The hint must enumerate the real columns; that is what lets an agent self-correct.
    expect(unknown?.hint).toContain('col_age')
  })

  it('leaves non-column config strings alone', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({
        widgets: [
          widget({
            source: {
              type: 'plugin',
              pluginId: 'p',
              config: { xColumn: 'col_age', title: 'Age by sex', icon: 'HeartPulse' },
            },
          }),
        ],
      }),
    })
    expect(issues.filter((i) => i.code === 'unknown-column')).toEqual([])
  })

  it('flags a widget spanning past the grid', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({
        widgets: [widget({ layout: { x: 40, y: 0, w: 12, h: 8 } })],
      }),
    })
    expect(issues.some((i) => i.code === 'layout-out-of-grid')).toBe(true)
  })

  it('accepts a 12-column widget on a v1 grid but rejects it past 12', () => {
    const v1 = (x: number) =>
      JSON.stringify({
        dashboard: { name: { en: 'Overview' }, filterConfig: [] },
        tabs: [{ name: { en: 'Main' }, key: 'overview/main', parentKey: null }],
        widgets: [widget({ layout: { x, y: 0, w: 6, h: 8 } })],
      })
    expect(runDashboards({ 'dashboards/overview.json': v1(6) })).toEqual([])
    expect(
      runDashboards({ 'dashboards/overview.json': v1(8) }).some((i) => i.code === 'layout-out-of-grid'),
    ).toBe(true)
  })

  it('flags a dashboard that mixes content keys and legacy ids', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({
        tabs: [
          { name: { en: 'A' }, key: 'overview/a', parentKey: null },
          { name: { en: 'B' }, id: 'uuid-b', parentTabId: null },
        ],
        widgets: [],
      }),
    })
    expect(issues.some((i) => i.code === 'legacy-format' && i.severity === 'error')).toBe(true)
  })

  it('accepts a wholly legacy id-based dashboard, with warnings only', () => {
    const issues = runDashboards({
      'dashboards/overview.json': JSON.stringify({
        dashboard: { name: 'CLIP', filterConfig: [] },
        tabs: [{ id: 'tab-1', name: 'Vue', displayOrder: 0, parentTabId: null }],
        widgets: [
          {
            id: 'w-1',
            tabId: 'tab-1',
            name: 'Patients',
            datasetFileId: 'patients.csv',
            layout: { x: 0, y: 0, w: 12, h: 8 },
            source: { type: 'plugin', pluginId: 'p', config: { column: 'col_age' } },
          },
        ],
      }),
    })
    expect(issues.every((i) => i.severity === 'warning')).toBe(true)
  })

  it('flags a filter pointing at a column that does not exist', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({
        filterConfig: [{ datasetFileId: 'patients.csv', columnId: 'col_ward', type: 'categorical' }],
      }),
    })
    expect(issues.some((i) => i.code === 'unknown-column')).toBe(true)
  })

  it('flags a filter scoped to an unknown tab', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({
        filterConfig: [
          {
            datasetFileId: 'patients.csv',
            columnId: 'col_age',
            scope: { type: 'tabs', tabKeys: ['overview/ghost'] },
          },
        ],
      }),
    })
    expect(issues.some((i) => i.code === 'unknown-reference')).toBe(true)
  })

  it('flags a widget referencing a dataset that does not exist', () => {
    const issues = runDashboards({
      'dashboards/overview.json': dashboardDoc({ widgets: [widget({ datasetFileId: 'ghost.csv' })] }),
    })
    const unknown = issues.find((i) => i.code === 'unknown-reference')
    expect(unknown?.hint).toContain('patients.csv')
  })
})

describe('validateProject', () => {
  it('requires project.json', () => {
    const issues = validateProject(new MemoryTree({}))
    expect(issues.some((i) => i.code === 'missing-file')).toBe(true)
  })

  it('reports a JSON syntax error rather than throwing', () => {
    const issues = validateProject(new MemoryTree({ 'project.json': '{ "name": ' }))
    expect(issues[0]?.code).toBe('invalid-json')
  })

  it('accepts a minimal project with no datasets or dashboards', () => {
    const issues = validateProject(
      new MemoryTree({
        'project.json': JSON.stringify({ name: { en: 'P' }, projectId: 'p', appVersion: '2.3.3' }),
      }),
    )
    expect(issues).toEqual([])
  })
})
