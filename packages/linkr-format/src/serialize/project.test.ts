import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { validateProject } from '../validate/project.js'
import { serializeProject, type ProjectSpec } from './project.js'

const CSV = 'patient_id,age,sex,admitted_at,ventilated\n1,60,M,2026-01-02 08:00,1\n2,71,F,2026-01-03 09:30,0\n'

const SPEC: ProjectSpec = {
  projectId: 'icu-demo',
  name: { en: 'ICU demo', fr: 'Démo réanimation' },
  appVersion: '2.3.3',
  datasets: [{ name: 'stays', csv: CSV }],
  dashboards: [
    {
      name: { en: 'Overview', fr: 'Vue d\'ensemble' },
      tabs: [
        { name: { en: 'Demographics', fr: 'Démographie' } },
        { name: { en: 'Detail', fr: 'Détail' }, parent: 'Demographics' },
      ],
      widgets: [
        {
          name: { en: 'Age distribution', fr: "Distribution de l'âge" },
          tab: 'Demographics',
          dataset: 'stays',
          pluginId: 'linkr-analysis-plot-builder',
          // Written as a NAME, as a spec author would; must come out as an id.
          config: { plotType: 'histogram', xColumn: 'age', groupColumn: 'sex' },
          layout: { x: 0, y: 0, w: 24, h: 16 },
        },
      ],
    },
  ],
  scripts: [{ path: '01_extract.sql', content: 'SELECT 1;\n' }],
}

function treeOf(spec: ProjectSpec): MemoryTree {
  return new MemoryTree(Object.fromEntries(serializeProject(spec).map((f) => [f.path, f.content])))
}

describe('serializeProject', () => {
  it('produces a tree its own validator accepts', () => {
    // The loop that matters: anything this writes must pass the same checks an
    // externally authored tree is held to, or the MCP would emit invalid trees.
    expect(validateProject(treeOf(SPEC))).toEqual([])
  })

  it('derives column ids from the CSV header', () => {
    const tree = treeOf(SPEC)
    const datasets = JSON.parse(tree.read('datasets/_tree.json')!)
    expect(datasets[0].columns.map((c: { id: string }) => c.id)).toEqual([
      'col_patient_id', 'col_age', 'col_sex', 'col_admitted_at', 'col_ventilated',
    ])
  })

  it('resolves config column names to ids', () => {
    const dashboard = JSON.parse(treeOf(SPEC).read('dashboards/overview.json')!)
    expect(dashboard.widgets[0].source.config).toMatchObject({
      xColumn: 'col_age',
      groupColumn: 'col_sex',
      plotType: 'histogram',
    })
  })

  it('infers column types conservatively', () => {
    const datasets = JSON.parse(treeOf(SPEC).read('datasets/_tree.json')!)
    const byName = Object.fromEntries(
      datasets[0].columns.map((c: { name: string; type: string }) => [c.name, c.type]),
    )
    expect(byName).toEqual({
      patient_id: 'number',
      age: 'number',
      sex: 'string',
      admitted_at: 'date',
      // 0/1 reads as boolean, matching how the app treats such a flag.
      ventilated: 'boolean',
    })
  })

  it('honours an explicit type hint over inference', () => {
    const datasets = JSON.parse(
      treeOf({ ...SPEC, datasets: [{ name: 'stays', csv: CSV, types: { patient_id: 'string' } }] })
        .read('datasets/_tree.json')!,
    )
    expect(datasets[0].columns[0].type).toBe('string')
  })

  it('nests a sub-tab under its parent key', () => {
    const dashboard = JSON.parse(treeOf(SPEC).read('dashboards/overview.json')!)
    const detail = dashboard.tabs.find((t: { key: string }) => t.key.endsWith('/detail'))
    expect(detail.key).toBe('overview/demographics/detail')
    expect(detail.parentKey).toBe('overview/demographics')
  })

  it('writes a script tree alongside the files', () => {
    const tree = treeOf(SPEC)
    expect(tree.read('scripts/01_extract.sql')).toBe('SELECT 1;\n')
    expect(JSON.parse(tree.read('scripts/_tree.json')!)).toEqual([
      { path: '01_extract.sql', type: 'file', language: 'sql', createdAt: '' },
    ])
  })

  it('is deterministic', () => {
    // Same spec → byte-identical files, so re-running over a git tree shows a
    // diff only where content actually changed.
    expect(serializeProject(SPEC)).toEqual(serializeProject(SPEC))
  })

  it('serializes a minimal project', () => {
    const spec: ProjectSpec = { projectId: 'p', name: { en: 'P' }, appVersion: '2.3.3' }
    const files = serializeProject(spec).map((f) => f.path)
    expect(files).toEqual(['project.json'])
    expect(validateProject(treeOf(spec))).toEqual([])
  })

  it('flows widgets left to right and wraps at the grid edge', () => {
    const spec: ProjectSpec = {
      ...SPEC,
      dashboards: [
        {
          name: { en: 'Overview' },
          tabs: [{ name: { en: 'Main' } }],
          widgets: [1, 2, 3].map((n) => ({
            name: { en: `KPI ${n}` },
            tab: 'Main',
            dataset: 'stays',
            pluginId: 'linkr-analysis-key-indicator',
            w: 24,
            h: 8,
          })),
        },
      ],
    }
    const dashboard = JSON.parse(treeOf(spec).read('dashboards/overview.json')!)
    const layouts = dashboard.widgets
      .map((w: { layout: { x: number; y: number } }) => w.layout)
      .sort((a: { y: number; x: number }, b: { y: number; x: number }) => a.y - b.y || a.x - b.x)
    // Two fit on the first row (24 + 24 = 48); the third wraps below.
    expect(layouts).toEqual([
      { x: 0, y: 0, w: 24, h: 8 },
      { x: 24, y: 0, w: 24, h: 8 },
      { x: 0, y: 8, w: 24, h: 8 },
    ])
    expect(validateProject(treeOf(spec))).toEqual([])
  })

  it('gives each tab its own layout cursor', () => {
    const spec: ProjectSpec = {
      ...SPEC,
      dashboards: [
        {
          name: { en: 'Overview' },
          tabs: [{ name: { en: 'A' } }, { name: { en: 'B' } }],
          widgets: ['A', 'B'].map((tab) => ({
            name: { en: `W${tab}` },
            tab,
            dataset: 'stays',
            pluginId: 'p',
            w: 24,
            h: 8,
          })),
        },
      ],
    }
    const dashboard = JSON.parse(treeOf(spec).read('dashboards/overview.json')!)
    // Both start at x=0: a second tab does not continue the first tab's row.
    for (const w of dashboard.widgets) expect(w.layout).toEqual({ x: 0, y: 0, w: 24, h: 8 })
  })

  it('keeps an explicit layout over the flow', () => {
    const spec: ProjectSpec = {
      ...SPEC,
      dashboards: [
        {
          name: { en: 'Overview' },
          tabs: [{ name: { en: 'Main' } }],
          widgets: [
            {
              name: { en: 'Fixed' },
              tab: 'Main',
              dataset: 'stays',
              pluginId: 'p',
              layout: { x: 12, y: 4, w: 12, h: 6 },
            },
          ],
        },
      ],
    }
    const dashboard = JSON.parse(treeOf(spec).read('dashboards/overview.json')!)
    expect(dashboard.widgets[0].layout).toEqual({ x: 12, y: 4, w: 12, h: 6 })
  })

  it('derives a filter type from its column type', () => {
    const spec: ProjectSpec = {
      ...SPEC,
      dashboards: [
        {
          name: { en: 'Overview' },
          tabs: [{ name: { en: 'Main' } }],
          filters: [
            { dataset: 'stays', column: 'sex' },
            { dataset: 'stays', column: 'age' },
            { dataset: 'stays', column: 'admitted_at', label: 'Period' },
          ],
        },
      ],
    }
    const dashboard = JSON.parse(treeOf(spec).read('dashboards/overview.json')!)
    expect(dashboard.dashboard.filterConfig).toEqual([
      {
        datasetFileId: 'stays.csv', columnId: 'col_sex', columnName: 'sex',
        type: 'categorical', inputType: 'multi-select',
      },
      {
        datasetFileId: 'stays.csv', columnId: 'col_age', columnName: 'age',
        type: 'numeric', inputType: 'range',
      },
      {
        datasetFileId: 'stays.csv', columnId: 'col_admitted_at', columnName: 'admitted_at',
        type: 'date', inputType: 'range', label: 'Period',
      },
    ])
    expect(validateProject(treeOf(spec))).toEqual([])
  })

  it('serializes an inline code widget', () => {
    const spec: ProjectSpec = {
      ...SPEC,
      dashboards: [
        {
          name: { en: 'Overview' },
          tabs: [{ name: { en: 'Main' } }],
          widgets: [
            {
              name: { en: 'Custom' },
              tab: 'Main',
              dataset: 'stays',
              code: 'print(df.shape)',
              language: 'python',
            },
          ],
        },
      ],
    }
    const dashboard = JSON.parse(treeOf(spec).read('dashboards/overview.json')!)
    expect(dashboard.widgets[0].source).toEqual({
      type: 'inline', language: 'python', code: 'print(df.shape)', config: {},
    })
    expect(validateProject(treeOf(spec))).toEqual([])
  })

  it('writes README files per language', () => {
    const tree = treeOf({ ...SPEC, readme: { en: '# Hello', fr: '# Bonjour' } })
    expect(tree.read('README.md')).toBe('# Hello')
    expect(tree.read('README.fr.md')).toBe('# Bonjour')
  })
})
