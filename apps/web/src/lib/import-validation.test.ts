import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { treeFromZip, validateImportZip } from './import-validation'

function projectZip(files: Record<string, string>): JSZip {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  return zip
}

const PROJECT = JSON.stringify({ name: { en: 'P' }, projectId: 'p', appVersion: '2.3.3' })

const DATASETS = JSON.stringify([
  {
    id: 'patients.csv',
    name: 'patients.csv',
    type: 'file',
    columns: [{ id: 'col_age', name: 'age', type: 'number' }],
  },
])

const dashboard = (config: Record<string, unknown>) =>
  JSON.stringify({
    dashboard: { name: { en: 'Overview' }, gridV: 2, filterConfig: [] },
    tabs: [{ name: { en: 'Main' }, key: 'overview/main', parentKey: null }],
    widgets: [
      {
        name: { en: 'Age' },
        key: 'overview/main/age@0,0',
        tabKey: 'overview/main',
        datasetFileId: 'patients.csv',
        layout: { x: 0, y: 0, w: 12, h: 8 },
        source: { type: 'plugin', pluginId: 'linkr-analysis-plot-builder', config },
      },
    ],
  })

describe('validateImportZip', () => {
  it('reports nothing for a well-formed project', async () => {
    const result = await validateImportZip(projectZip({
      'project.json': PROJECT,
      'datasets/_tree.json': DATASETS,
      'datasets/patients/patients.csv': 'age\n60\n',
      'dashboards/overview.json': dashboard({ xColumn: 'col_age' }),
    }))
    expect(result.issues).toEqual([])
  })

  it('reports a widget config pointing at a column that does not exist', async () => {
    const result = await validateImportZip(projectZip({
      'project.json': PROJECT,
      'datasets/_tree.json': DATASETS,
      'datasets/patients/patients.csv': 'age\n60\n',
      'dashboards/overview.json': dashboard({ xColumn: 'col_weight' }),
    }))
    expect(result.errors).toBe(1)
    expect(result.issues[0].code).toBe('unknown-column')
  })

  it('counts errors and warnings apart', async () => {
    const result = await validateImportZip(projectZip({
      'project.json': JSON.stringify({ name: { en: 'P' }, projectId: 'p' }),
      'datasets/_tree.json': DATASETS,
      'datasets/patients/patients.csv': 'age\n60\n',
      'dashboards/overview.json': dashboard({ xColumn: 'col_weight' }),
    }))
    expect(result.errors).toBe(1)
    // The missing appVersion is a warning, never a blocker.
    expect(result.warnings).toBe(1)
  })
})

describe('treeFromZip', () => {
  it('truncates a CSV to its header', async () => {
    const tree = await treeFromZip(projectZip({
      'datasets/patients/patients.csv': 'age,sex\n60,M\n61,F\n62,M\n',
    }))
    // Only the header is needed to check the declared columns; decoding a large
    // dataset into memory to do that would be wasteful.
    expect(tree.read('datasets/patients/patients.csv')).toBe('age,sex\n')
  })

  it('skips binary and irrelevant files', async () => {
    const tree = await treeFromZip(projectZip({
      'project.json': PROJECT,
      'datasets/patients/_data.parquet': 'binary-ish',
      'README.md': '# hello',
    }))
    expect(tree.read('project.json')).not.toBeNull()
    expect(tree.read('datasets/patients/_data.parquet')).toBeNull()
    expect(tree.read('README.md')).toBeNull()
  })
})
