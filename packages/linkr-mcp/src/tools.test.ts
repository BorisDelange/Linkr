import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeEntity, serializeProject, type ProjectSpec } from '@linkr/format'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addDashboardTab, addScript, addWidget, describeEntitySchema, describeTree,
  moveDashboardWidget, readTreeFile, removeDashboardTab, removeDashboardWidget,
  readEntitySpec, removeDqCheck, removeMappings, renameColumns, renameDashboardTab, updateProject,
  renameDashboardWidget, updateWidget, upsertDqCheck, upsertMappings, writeEntityFile,
  writeTree, writeZip,
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

describe('readTreeFile', () => {
  it('returns a script verbatim, so an agent never opens the file itself', () => {
    addScript(root, 'q.sql', 'SELECT 1;\n')
    expect(readTreeFile(root, 'scripts/q.sql')).toBe('SELECT 1;\n')
  })

  it('names the files that do exist when one does not', () => {
    // The correctable-failure contract: a rejection enumerates the alternatives
    // so the model fixes its own call instead of guessing again.
    expect(() => readTreeFile(root, 'scripts/ghost.sql')).toThrow(/Known:.*entity\.json/s)
  })

  it('refuses a path that escapes the tree', () => {
    // Same guard as every write: the caller is a model acting on text it was
    // given, so a path is untrusted input even when only reading.
    expect(() => readTreeFile(root, '../../../etc/passwd')).toThrow(/escapes the project/)
  })
})

describe('describeTree — the read half of read-modify-write', () => {
  it('shows a widget config, which is what an edit targets', () => {
    addWidget({
      path: root,
      dashboard: 'overview',
      tabKey: 'overview/demographics',
      name: { en: 'Ages' },
      dataset: 'stays.csv',
      pluginId: 'linkr-analysis-plot-builder',
      config: { xColumn: 'age' },
      layout: { x: 0, y: 0, w: 24, h: 16 },
    })
    const out = describeTree(root)
    // The name was resolved to a column id on write; the agent must see the id
    // it would be editing, not the name it happened to pass.
    expect(out).toMatch(/config\.xColumn = "col_age"/)
    expect(out).toMatch(/dataset stays\.csv/)
  })

  it('shows a widget layout, so a move has coordinates to work from', () => {
    addWidget({
      path: root,
      dashboard: 'overview',
      tabKey: 'overview/demographics',
      name: { en: 'Ages' },
      pluginId: 'kpi',
      layout: { x: 6, y: 2, w: 12, h: 8 },
    })
    expect(describeTree(root)).toMatch(/@2,6 12x8/)
  })

  it('lists a filter and the tab keys it is scoped to', () => {
    // A tab-scoped filter is invisible from the tab itself, so renaming that tab
    // would orphan the scope with nothing having warned the agent.
    const spec: ProjectSpec = {
      ...SPEC,
      dashboards: [{
        name: { en: 'Overview' },
        tabs: [{ name: { en: 'Demographics' } }],
        filters: [{ dataset: 'stays', column: 'age', scope: { type: 'tabs', tabKeys: ['overview/demographics'] } }],
      }],
    }
    writeTree(root, serializeProject(spec))
    expect(describeTree(root)).toMatch(/filter col_age \(age, range\) scope=tabs:overview\/demographics/)
  })
})

describe('mutators', () => {
  const widget = (extra: Record<string, unknown> = {}) => addWidget({
    path: root,
    dashboard: 'overview',
    tabKey: 'overview/demographics',
    name: { en: 'Ages' },
    dataset: 'stays.csv',
    pluginId: 'linkr-analysis-plot-builder',
    config: { xColumn: 'age', binWidth: 5 },
    layout: { x: 0, y: 0, w: 24, h: 16 },
    ...extra,
  })

  it('merges a config update instead of replacing it', () => {
    // A real widget carries ~17 options; forcing a caller to resend them all to
    // change one is how options get silently dropped.
    widget()
    updateWidget({
      path: root, dashboard: 'overview',
      key: 'overview/demographics/ages@0,0',
      config: { binWidth: 10 },
    })
    expect(dashboard().widgets[0].source.config)
      .toEqual({ xColumn: 'col_age', binWidth: 10 })
  })

  it('resolves a column name to an id on update, as add does', () => {
    widget()
    updateWidget({
      path: root, dashboard: 'overview',
      key: 'overview/demographics/ages@0,0',
      config: { groupColumn: 'sex' },
    })
    expect(dashboard().widgets[0].source.config.groupColumn).toBe('col_sex')
  })

  it('rekeys on a move and says which keys changed', () => {
    widget()
    const out = moveDashboardWidget(root, 'overview', 'overview/demographics/ages@0,0', { x: 24, y: 8 })
    expect(dashboard().widgets[0].key).toBe('overview/demographics/ages@8,24')
    expect(out).toMatch(/ages@0,0 → .*ages@8,24/)
  })

  it('rekeys a tab and every widget under it', () => {
    widget()
    renameDashboardTab(root, 'overview', 'overview/demographics', { en: 'Cohort' })
    const doc = dashboard()
    expect(doc.tabs[0].key).toBe('overview/cohort')
    expect(doc.widgets[0].key).toBe('overview/cohort/ages@0,0')
    expect(doc.widgets[0].tabKey).toBe('overview/cohort')
  })

  it('rekeys on a widget rename', () => {
    widget()
    renameDashboardWidget(root, 'overview', 'overview/demographics/ages@0,0', { en: 'Age spread' })
    expect(dashboard().widgets[0].key).toBe('overview/demographics/age-spread@0,0')
  })

  it('names the widgets a tab removal takes with it, before they are gone', () => {
    // D2: the result is the only warning a caller gets, and there is no undo.
    widget()
    const out = removeDashboardTab(root, 'overview', 'overview/demographics')
    expect(out).toMatch(/Also removed:.*ages@0,0/)
    expect(dashboard().widgets).toEqual([])
    expect(dashboard().tabs).toEqual([])
  })

  it('removes one widget and leaves the tab', () => {
    widget()
    removeDashboardWidget(root, 'overview', 'overview/demographics/ages@0,0')
    expect(dashboard().widgets).toEqual([])
    expect(dashboard().tabs).toHaveLength(1)
  })

  it('rejects an unknown key by naming the ones that exist', () => {
    expect(() => updateWidget({
      path: root, dashboard: 'overview', key: 'overview/demographics/ghost@0,0', config: {},
    })).toThrow(/Unknown widget/)
  })

  it('revalidates, so a result always says whether the tree still holds', () => {
    widget()
    expect(moveDashboardWidget(root, 'overview', 'overview/demographics/ages@0,0', { x: 12 }))
      .toMatch(/Tree is valid/)
  })
})

describe('renameColumns', () => {
  const tree = () => JSON.parse(readFileSync(join(root, 'datasets/_tree.json'), 'utf-8'))
  const csv = () => readFileSync(join(root, 'datasets/stays/stays.csv'), 'utf-8')

  const widget = () => addWidget({
    path: root,
    dashboard: 'overview',
    tabKey: 'overview/demographics',
    name: { en: 'Ages' },
    dataset: 'stays.csv',
    pluginId: 'linkr-analysis-plot-builder',
    config: { xColumn: 'age', stats: ['median', 'age'] },
    layout: { x: 0, y: 0, w: 24, h: 16 },
  })

  it('re-derives the id and repoints the widget config', () => {
    widget()
    renameColumns(root, 'stays.csv', [{ from: 'col_age', to: 'age_years' }])
    expect(dashboard().widgets[0].source.config.xColumn).toBe('col_age_years')
  })

  it('rewrites the CSV header, without which the tree stops validating', () => {
    // The validator requires columns[].name to match the header, as an ERROR.
    // Treating the header as untouchable "data" produced a broken tree every time.
    renameColumns(root, 'stays.csv', [{ from: 'col_age', to: 'age_years' }])
    expect(csv().split('\n')[0]).toBe('patient_id,age_years,sex,ventilated')
    expect(tree()[0].columns[1]).toMatchObject({ id: 'col_age_years', name: 'age_years' })
  })

  it('leaves the data rows byte-identical', () => {
    const before = csv().split('\n').slice(1).join('\n')
    renameColumns(root, 'stays.csv', [{ from: 'col_age', to: 'age_years' }])
    expect(csv().split('\n').slice(1).join('\n')).toBe(before)
  })

  it('quotes a name that needs it, and only then', () => {
    renameColumns(root, 'stays.csv', [{ from: 'col_age', to: 'age, years' }])
    expect(csv().split('\n')[0]).toBe('patient_id,"age, years",sex,ventilated')
  })

  it('reports the ids it changed, since earlier ones are now stale', () => {
    const out = renameColumns(root, 'stays.csv', [{ from: 'col_age', to: 'age_years' }])
    expect(out).toMatch(/col_age → col_age_years/)
    expect(out).toMatch(/Tree is valid/)
  })

  it('says nothing moved when the id is unchanged', () => {
    const out = renameColumns(root, 'stays.csv', [{ from: 'col_age', to: 'Age' }])
    expect(out).toMatch(/No id changed/)
  })

  it('names the datasets that exist when one is unknown', () => {
    expect(() => renameColumns(root, 'ghost.csv', [{ from: 'col_age', to: 'x' }]))
      .toThrow(/Known: stays\.csv/)
  })

  it('accepts the dataset name without its extension', () => {
    expect(() => renameColumns(root, 'stays', [{ from: 'col_age', to: 'age_years' }])).not.toThrow()
  })
})

describe('standalone entities', () => {
  let entityRoot: string

  beforeEach(() => {
    entityRoot = mkdtempSync(join(tmpdir(), 'linkr-entity-'))
  })
  afterEach(() => rmSync(entityRoot, { recursive: true, force: true }))

  const ruleSet = () => writeTree(entityRoot, serializeEntity('dq-rule-set', {
    entityId: 'icu-checks',
    name: { en: 'ICU checks' },
    checks: [
      { name: 'null ids', sql: 'SELECT 1', severity: 'error' },
      { name: 'age range', sql: 'SELECT 2', severity: 'warning' },
    ],
  }))

  const collection = () => writeTree(entityRoot, serializeEntity('sql-collection', {
    entityId: 'icu-queries',
    name: { en: 'ICU queries' },
    files: [{ path: 'a.sql', content: 'SELECT 1;\n', order: 0 }],
  }))

  const mappingProject = () => writeTree(entityRoot, serializeEntity('mapping-project', {
    entityId: 'mimic-map',
    name: { en: 'MIMIC map' },
    mappings: [
      { sourceConceptCode: 'A', sourceConceptName: 'Alpha', targetConceptId: 1 },
      { sourceConceptCode: 'B', sourceConceptName: 'Beta' },
    ],
  }))

  const checksOf = () =>
    JSON.parse(readFileSync(join(entityRoot, 'checks.json'), 'utf-8'))
  const rowsOf = () =>
    JSON.parse(readFileSync(join(entityRoot, 'mappings.json'), 'utf-8'))

  it('reads a tree back as its spec, kind detected', () => {
    collection()
    const out = readEntitySpec(entityRoot)
    expect(out).toMatch(/^kind: sql-collection/)
    expect(JSON.parse(out.slice(out.indexOf('{'))).files[0].path).toBe('a.sql')
  })

  it('refuses a project tree, pointing at the right tools', () => {
    expect(() => readEntitySpec(root)).toThrow(/use describe_tree/)
  })

  it('updates one check and leaves the others alone', () => {
    ruleSet()
    upsertDqCheck(entityRoot, { name: 'age range', severity: 'error' })
    const checks = checksOf()
    expect(checks).toHaveLength(2)
    // Merged: the sql it did not resend survives.
    expect(checks.find((c: { name: string }) => c.name === 'age range'))
      .toMatchObject({ sql: 'SELECT 2', severity: 'error' })
    expect(checks.find((c: { name: string }) => c.name === 'null ids'))
      .toMatchObject({ sql: 'SELECT 1', severity: 'error' })
  })

  it('needs a sql query for a brand-new check', () => {
    ruleSet()
    expect(() => upsertDqCheck(entityRoot, { name: 'fresh' })).toThrow(/needs a sql query/)
  })

  it('removes a check and names the ones that exist when it cannot', () => {
    ruleSet()
    removeDqCheck(entityRoot, 'null ids')
    expect(checksOf()).toHaveLength(1)
    expect(() => removeDqCheck(entityRoot, 'ghost')).toThrow(/Known: age range/)
  })

  it('merges a mapping row field by field', () => {
    // The point of a granular tool: a real project has thousands of rows, and
    // re-sending them all to change one is both wasteful and a chance to mangle
    // the rest.
    mappingProject()
    upsertMappings(entityRoot, [{ sourceConceptCode: 'A', status: 'approved' }])
    const rows = rowsOf()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ sourceConceptName: 'Alpha', targetConceptId: 1, status: 'approved' })
  })

  it('appends an unknown code as a new row', () => {
    mappingProject()
    upsertMappings(entityRoot, [{ sourceConceptCode: 'C', sourceConceptName: 'Gamma' }])
    expect(rowsOf().map((r: { sourceConceptCode: string }) => r.sourceConceptCode)).toEqual(['A', 'B', 'C'])
  })

  it('refuses a row with no source code', () => {
    mappingProject()
    expect(() => upsertMappings(entityRoot, [{ targetConceptId: 9 }]))
      .toThrow(/needs a sourceConceptCode/)
  })

  it('removes rows by code, and says so when none matched', () => {
    mappingProject()
    removeMappings(entityRoot, ['A'])
    expect(rowsOf()).toHaveLength(1)
    expect(() => removeMappings(entityRoot, ['ZZZ'])).toThrow(/No row matched/)
  })

  it('adds a script file to a collection', () => {
    collection()
    writeEntityFile(entityRoot, 'b.sql', 'SELECT 2;\n')
    expect(readFileSync(join(entityRoot, 'scripts/b.sql'), 'utf-8')).toBe('SELECT 2;\n')
  })

  it('deletes a script file from disk, not only from the tree', () => {
    // The serializer only writes what the spec lists, so a file dropped from the
    // spec would otherwise survive on disk, untracked and still running.
    collection()
    writeEntityFile(entityRoot, 'b.sql', 'SELECT 2;\n')
    writeEntityFile(entityRoot, 'b.sql', null)
    expect(existsSync(join(entityRoot, 'scripts/b.sql'))).toBe(false)
  })

  it('refuses script files on a kind that has none', () => {
    ruleSet()
    expect(() => writeEntityFile(entityRoot, 'a.sql', 'x')).toThrow(/has no script files/)
  })
})

describe('updateProject', () => {
  const manifest = () => JSON.parse(readFileSync(join(root, 'entity.json'), 'utf-8'))

  it('changes only the fields it was given', () => {
    const before = manifest()
    updateProject({ path: root, status: 'archived' })
    const after = manifest()
    expect(after.status).toBe('archived')
    expect(after.name).toEqual(before.name)
    expect(Object.keys(after)).toEqual(Object.keys(before))
  })

  it('leaves the project content alone', () => {
    // serializeProject emits a whole tree from a spec, and this spec holds no
    // datasets or dashboards — writing all of it would delete them.
    addWidget({
      path: root, dashboard: 'overview', tabKey: 'overview/demographics',
      name: { en: 'W' }, pluginId: 'kpi', layout: { x: 0, y: 0, w: 12, h: 8 },
    })
    updateProject({ path: root, status: 'archived' })
    expect(existsSync(join(root, 'dashboards/overview.json'))).toBe(true)
    expect(existsSync(join(root, 'datasets/stays/stays.csv'))).toBe(true)
    expect(dashboard().widgets).toHaveLength(1)
  })

  it('writes a localized README', () => {
    updateProject({ path: root, readme: { en: '# Hello', fr: '# Bonjour' } })
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toBe('# Hello')
    expect(readFileSync(join(root, 'README.fr.md'), 'utf-8')).toBe('# Bonjour')
  })

  it('refuses a call that changes nothing', () => {
    expect(() => updateProject({ path: root })).toThrow(/at least one field/)
  })

  it('refuses a tree that is not a project', () => {
    const other = mkdtempSync(join(tmpdir(), 'linkr-other-'))
    writeTree(other, serializeEntity('dq-rule-set', {
      entityId: 'r', name: { en: 'R' }, checks: [{ name: 'c', sql: 'SELECT 1' }],
    }))
    expect(() => updateProject({ path: other, status: 'x' })).toThrow(/not a project tree/)
    rmSync(other, { recursive: true, force: true })
  })
})
