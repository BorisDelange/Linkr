import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeProject, type ProjectSpec } from '@linkr/format'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addDashboardTab, addScript, addWidget, describeEntitySchema, describeTree, writeTree, writeZip,
} from './tools.js'

const CSV = 'patient_id,age,sex,ventilated\n1,60,M,1\n2,71,F,0\n'

const SPEC: ProjectSpec = {
  projectId: 'demo',
  name: { en: 'Demo' },
  appVersion: '2.3.3',
  datasets: [{ name: 'stays', csv: CSV }],
  dashboards: [
    {
      name: { en: 'Overview' },
      tabs: [{ name: { en: 'Demographics' } }],
      widgets: [],
    },
  ],
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkr-mcp-'))
  writeTree(root, serializeProject(SPEC))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const dashboard = () => JSON.parse(readFileSync(join(root, 'dashboards/overview.json'), 'utf-8'))

describe('describeTree', () => {
  it('lists datasets with their column ids and dashboards with their keys', () => {
    const out = describeTree(root)
    expect(out).toContain('col_age (age, number)')
    expect(out).toContain('tab overview/demographics')
  })

  it('fails clearly when the directory holds no project', () => {
    expect(() => describeTree(join(root, 'nope'))).toThrow(/No entity.json/)
  })
})

describe('addDashboardTab', () => {
  it('adds a tab and reports the tree still validates', () => {
    const result = addDashboardTab(root, 'overview', { en: 'Outcomes' })
    expect(result).toContain('overview/outcomes')
    expect(result).toContain('valid')
    expect(dashboard().tabs.map((t: { key: string }) => t.key)).toContain('overview/outcomes')
  })

  it('nests under a parent tab', () => {
    addDashboardTab(root, 'overview', { en: 'Detail' }, 'overview/demographics')
    const tab = dashboard().tabs.find((t: { key: string }) => t.key.endsWith('/detail'))
    expect(tab.key).toBe('overview/demographics/detail')
    expect(tab.parentKey).toBe('overview/demographics')
  })

  it('rejects an unknown parent, naming the valid ones', () => {
    expect(() => addDashboardTab(root, 'overview', { en: 'X' }, 'overview/ghost'))
      .toThrow(/Unknown parent tab.*overview\/demographics/s)
  })

  it('rejects a duplicate key rather than silently overwriting', () => {
    addDashboardTab(root, 'overview', { en: 'Outcomes' })
    expect(() => addDashboardTab(root, 'overview', { en: 'Outcomes' })).toThrow(/already exists/)
  })
})

describe('addWidget', () => {
  const base = {
    path: '',
    dashboard: 'overview',
    tabKey: 'overview/demographics',
    name: { en: 'Age' },
    pluginId: 'linkr-analysis-plot-builder',
    layout: { x: 0, y: 0, w: 24, h: 16 },
  }

  it('resolves config column names to ids', () => {
    addWidget({ ...base, path: root, dataset: 'stays.csv', config: { xColumn: 'age' } })
    expect(dashboard().widgets[0].source.config).toEqual({ xColumn: 'col_age' })
  })

  it('leaves an already-resolved column id alone', () => {
    addWidget({ ...base, path: root, dataset: 'stays.csv', config: { xColumn: 'col_age' } })
    expect(dashboard().widgets[0].source.config).toEqual({ xColumn: 'col_age' })
  })

  it('leaves non-column config values alone', () => {
    addWidget({
      ...base,
      path: root,
      dataset: 'stays.csv',
      config: { xColumn: 'age', title: 'Age by sex', icon: 'HeartPulse' },
    })
    expect(dashboard().widgets[0].source.config).toEqual({
      xColumn: 'col_age', title: 'Age by sex', icon: 'HeartPulse',
    })
  })

  it('rejects an unknown tab, naming the valid ones', () => {
    expect(() => addWidget({ ...base, path: root, tabKey: 'overview/ghost' }))
      .toThrow(/Unknown tab.*overview\/demographics/s)
  })

  it('reports a widget that lands outside the grid instead of hiding it', () => {
    // The write succeeds — the tree is on disk — but the result must say the
    // tree no longer validates, which is what drives a correction.
    const result = addWidget({ ...base, path: root, layout: { x: 40, y: 0, w: 24, h: 16 } })
    expect(result).toContain('error(s)')
    expect(result).toContain('layout-out-of-grid')
  })
})

describe('addScript', () => {
  it('writes the file and registers it in the tree', () => {
    const result = addScript(root, '02_build.py', 'print(1)\n')
    expect(result).toContain('valid')
    expect(readFileSync(join(root, 'scripts/02_build.py'), 'utf-8')).toBe('print(1)\n')
    const tree = JSON.parse(readFileSync(join(root, 'scripts/_tree.json'), 'utf-8'))
    expect(tree).toEqual([{ path: '02_build.py', type: 'file', language: 'python', createdAt: '' }])
  })

  it('does not duplicate an entry when a file is rewritten', () => {
    addScript(root, '02_build.py', 'print(1)\n')
    addScript(root, '02_build.py', 'print(2)\n')
    expect(JSON.parse(readFileSync(join(root, 'scripts/_tree.json'), 'utf-8'))).toHaveLength(1)
  })
})

describe('path confinement', () => {
  // The caller is a model acting on text it was given, which may include text the
  // operator did not write. A `..` in any caller-supplied path must never write
  // outside the project — this was a real hole before it was closed.
  const outside = () => join(root, '..', 'ESCAPED.txt')

  it('refuses a script path that escapes the project', () => {
    expect(() => addScript(root, '../../ESCAPED.txt', 'x')).toThrow(/escapes the project/)
    expect(existsSync(outside())).toBe(false)
  })

  it('contains an absolute script path inside the project', () => {
    // `join` makes a leading `/` inert: it lands under scripts/, not at the
    // filesystem root. Contained rather than rejected, which is the safe outcome.
    addScript(root, '/tmp/ESCAPED.txt', 'x')
    expect(existsSync('/tmp/ESCAPED.txt')).toBe(false)
    expect(readFileSync(join(root, 'scripts/tmp/ESCAPED.txt'), 'utf-8')).toBe('x')
  })

  it('refuses before writing anything, leaving no dangling tree entry', () => {
    addScript(root, 'first.py', 'print(1)\n')
    expect(() => addScript(root, '../../ESCAPED.txt', 'x')).toThrow()
    const tree = JSON.parse(readFileSync(join(root, 'scripts/_tree.json'), 'utf-8')) as {
      path: string
    }[]
    // The rejected path must not have been registered before the write failed.
    expect(tree.map((e) => e.path)).toEqual(['first.py'])
  })

  it('refuses a dashboard name carrying a directory', () => {
    expect(() => addDashboardTab(root, '../../../etc/evil', { en: 'X' }))
      .toThrow(/must be a file name/)
  })

  it('still allows a nested path inside the project', () => {
    addScript(root, 'sub/build.py', 'print(1)\n')
    expect(readFileSync(join(root, 'scripts/sub/build.py'), 'utf-8')).toBe('print(1)\n')
  })

  it('refuses a sibling directory sharing the root prefix', () => {
    // `<root>-evil` starts with `<root>` but is not inside it; a startsWith check
    // on the prefix would let this through.
    expect(() => writeTree(root, [{ path: '../evil/x.txt', content: 'x' }]))
      .toThrow(/escapes the project/)
  })
})

describe('writeZip', () => {
  it('bundles the tree with no wrapping directory', async () => {
    const target = join(root, 'out.zip')
    const files = serializeProject(SPEC)
    await writeZip(target, files)

    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(readFileSync(target))
    const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir)
    // entity.json must sit at the root: a wrapping folder is something the
    // app's parser then has to strip, and getting it wrong breaks the import.
    expect(paths).toContain('entity.json')
    expect(paths.some((p) => p.split('/')[0].endsWith('.json') && p.includes('/'))).toBe(false)
  })

  it('ships a .gitignore that excludes data files', async () => {
    const target = join(root, 'out.zip')
    await writeZip(target, serializeProject(SPEC))
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(readFileSync(target))
    expect(await zip.file('.gitignore')!.async('string')).toContain('datasets/**/*.csv')
  })
})

describe('describeEntitySchema', () => {
  it('documents every kind the server offers', () => {
    for (const kind of ['project', 'dataset', 'dashboard', 'widget', 'tab', 'script']) {
      expect(describeEntitySchema(kind), kind).toBeTruthy()
    }
  })

  it('returns null for an unknown kind', () => {
    expect(describeEntitySchema('cohort')).toBeNull()
  })
})
