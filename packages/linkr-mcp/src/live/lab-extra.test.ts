import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { DatasetOp } from '@linkr/format'
import type { PipelineNode } from '@/types'
import type { PluginManifest } from '@/types/plugin'
import {
  buildRowFilters, cellValue, checkNodeFields, checkPatientConfig, checkPluginFiles, columnOrderWith, connectError,
  listPatientPlugins, newPipelineNode, nextAddedRow, reorderIds, resolveTimelineMapping, scaffoldManifest, summarizeOps,
  templateFile, undoStart, withoutNode,
} from './lab-extra'
import { registerLabExtraTools } from './tools-lab-extra'

const COLS = [
  { id: 'col_age', name: 'age', type: 'number' },
  { id: 'col_sex', name: 'sex', type: 'string' },
  { id: 'col_admit', name: 'admit', type: 'date' },
  { id: 'col_dead', name: 'dead', type: 'boolean' },
]

const op = (over: Partial<DatasetOp> & { type: DatasetOp['type'] }): DatasetOp =>
  ({ id: Math.random().toString(), at: 0, ...over }) as DatasetOp

describe('cellValue', () => {
  it('reads values into the column type', () => {
    expect(cellValue('42', 'number')).toEqual({ value: 42 })
    expect(cellValue('yes', 'boolean')).toEqual({ value: true })
    expect(cellValue('2024-01-02', 'date')).toEqual({ value: '2024-01-02' })
    expect(cellValue('', 'number')).toEqual({ value: null })
    expect(cellValue(null, 'string')).toEqual({ value: null })
  })

  it('refuses values that do not fit', () => {
    expect(cellValue('abc', 'number')).toHaveProperty('error')
    expect(cellValue('maybe', 'boolean')).toHaveProperty('error')
    expect(cellValue('yesterday', 'date')).toHaveProperty('error')
  })
})

describe('op log helpers', () => {
  it('mints added-row ordinals below every one taken', () => {
    expect(nextAddedRow([])).toBe(-1)
    expect(nextAddedRow([op({ type: 'addRow', row: -1 }), op({ type: 'addRow', row: -3 })])).toBe(-4)
  })

  it('moves a column after another, or first', () => {
    expect(columnOrderWith(['a', 'b', 'c'], 'c', 'a')).toEqual(['a', 'c', 'b'])
    expect(columnOrderWith(['a', 'b', 'c'], 'c', null)).toEqual(['c', 'a', 'b'])
  })

  it('undoes whole actions (groups), not fragments', () => {
    const log = [
      op({ type: 'setCell', group: 'g1' }), op({ type: 'addColumn', group: 'g2' }),
      op({ type: 'setCell', group: 'g2' }), op({ type: 'removeRow' }),
    ]
    expect(undoStart(log, 1)).toBe(3)
    expect(undoStart(log, 2)).toBe(1)
    expect(undoStart(log, 10)).toBe(0)
  })

  it('summarizes actions newest first', () => {
    const s = summarizeOps([
      op({ type: 'addColumn', group: 'g', name: 'score', colType: 'number', column: 'col_score' } as never),
      op({ type: 'removeRow', row: 3 } as never),
    ])
    expect(s.split('\n')[1]).toContain('remove row 3')
    expect(s).toContain('add column score (number)')
    expect(summarizeOps([])).toMatch(/No edit/)
  })
})

describe('buildRowFilters', () => {
  it('maps each test to the endpoint shape, by column type', () => {
    const r = buildRowFilters([
      { column: 'age', min: 18 }, { column: 'SEX', one_of: ['F'] }, { column: 'admit', from: '2020-01-01' },
      { column: 'dead', equals: true }, { column: 'sex', missing: false },
    ], COLS)
    expect(r.errors).toEqual([])
    expect(r.filters).toEqual([
      { colId: 'col_age', min: 18, max: null }, { colId: 'col_sex', values: ['F'] },
      { colId: 'col_admit', from: '2020-01-01', to: null }, { colId: 'col_dead', value: 'true' },
    ])
    expect(r.na).toEqual([{ colId: 'col_sex', mode: 'exclude' }])
  })

  it('reports unknown columns and tests that do not fit the type', () => {
    const r = buildRowFilters([{ column: 'weight', min: 1 }, { column: 'sex', min: 1 }, { column: 'age', contains: '4' }], COLS)
    expect(r.errors).toHaveLength(3)
  })
})

describe('pipeline graph', () => {
  const node = (id: string, parentId?: string): PipelineNode =>
    ({ id, type: 'dataset', position: { x: 0, y: 0 }, data: { label: id, type: 'dataset', status: 'idle' }, ...(parentId ? { parentId } : {}) })

  it('builds a node as the canvas does', () => {
    const n = newPipelineNode('n', 'scripts', { scripts: ['a.R', 'b.R'] }, { x: 1, y: 2 }, () => 's')
    expect(n.data).toMatchObject({ label: 'Scripts', type: 'scripts', status: 'idle' })
    expect(n.data.scripts).toEqual([{ id: 's', filePath: 'a.R', displayOrder: 0 }, { id: 's', filePath: 'b.R', displayOrder: 1 }])
    expect(newPipelineNode('g', 'group', {}, { x: 0, y: 0 }, () => '')).toMatchObject({ width: 300, height: 200 })
  })

  it('refuses a link field the node type does not hold', () => {
    expect(checkNodeFields('database', { cohortId: 'c' })).toMatch(/no cohortId/)
    expect(checkNodeFields('cohort', { cohortId: 'c', label: 'x' })).toBeNull()
  })

  it('removes a node with its edges and detaches its children', () => {
    const g = withoutNode({
      nodes: [node('grp'), node('a', 'grp'), node('b')],
      edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'grp', target: 'b' }],
    }, 'grp')
    expect(g.nodes.map((n) => [n.id, n.parentId])).toEqual([['a', undefined], ['b', undefined]])
    expect(g.edges.map((e) => e.id)).toEqual(['e1'])
  })

  it('checks a link before drawing it', () => {
    const g = { nodes: [node('a'), node('b')], edges: [{ id: 'e', source: 'a', target: 'b' }] }
    expect(connectError(g, 'a', 'b')).toMatch(/already/)
    expect(connectError(g, 'a', 'a')).toMatch(/itself/)
    expect(connectError(g, 'a', 'x')).toMatch(/No node x/)
    expect(connectError(g, 'b', 'a')).toBeNull()
  })
})

describe('reorderIds', () => {
  it('puts the named ids first and keeps the others in order', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual({ order: ['c', 'a', 'b', 'd'] })
    expect(reorderIds(['a'], ['z']).error).toMatch(/z/)
  })
})

describe('patient widgets', () => {
  const timeline = listPatientPlugins().find((p) => p.id === 'linkr-widget-timeline')!

  it('reads the built-in manifests from disk', () => {
    expect(listPatientPlugins().map((p) => p.id)).toEqual(expect.arrayContaining([
      'linkr-widget-timeline', 'linkr-widget-notes', 'linkr-widget-patient-summary',
    ]))
  })

  it('types the config against the manifest', () => {
    const r = checkPatientConfig({ conceptIds: ['3027018', 3004249], strokeWidth: 2, showPoints: false, conceptColors: {} }, timeline)
    expect(r.errors).toEqual([])
    expect(r.config).toEqual({ conceptIds: [3027018, 3004249], strokeWidth: '2', showPoints: false, conceptColors: {} })
  })

  it('refuses unknown fields and bad values', () => {
    const r = checkPatientConfig({ conceptId: [1], engine: 'plotly', stepPlot: 'yes' }, timeline)
    expect(r.errors).toHaveLength(3)
  })

  it('accepts free-form keys of a schemaless widget only when known', () => {
    const notes = { id: 'linkr-widget-notes', configSchema: {} } as unknown as PluginManifest
    expect(checkPatientConfig({ wordSets: [] }, notes).errors).toEqual([])
    expect(checkPatientConfig({ words: [] }, notes).errors).toHaveLength(1)
  })

  it('resolves a timeline dataset mapping to column ids', () => {
    const r = resolveTimelineMapping({ datasetFileId: 'd.csv', personColumn: 'SEX', dateColumn: 'admit', valueColumn: 'age' }, COLS)
    expect(r.errors).toEqual([])
    expect(r.mapping).toEqual({ datasetFileId: 'd.csv', personColumn: 'col_sex', dateColumn: 'col_admit', valueColumn: 'col_age' })
    expect(resolveTimelineMapping({ datasetFileId: 'd.csv', valueColumn: 'x' }, COLS).errors).toHaveLength(3)
  })
})

describe('checkPluginFiles', () => {
  const files = (manifest: Record<string, unknown>, extra: Record<string, string> = {}) =>
    ({ 'plugin.json': JSON.stringify(manifest), ...extra })

  it('accepts the scaffold the app writes', () => {
    const m = scaffoldManifest({ id: 'p', name: 'P', description: '', scope: 'lab', languages: ['python', 'r'] })
    const r = checkPluginFiles(files(m, { [templateFile('python')]: 'print(1)', [templateFile('r')]: 'print(1)' }))
    expect(r.errors).toEqual([])
    expect(m.templates).toEqual({ python: 'analysis.py.template', r: 'analysis.R.template' })
  })

  it('blocks what the app cannot read', () => {
    expect(checkPluginFiles({ 'plugin.json': '{' }).errors).toHaveLength(1)
    const r = checkPluginFiles(files({ id: 'p', scope: 'bedside', languages: ['r'], configSchema: { x: { type: 'slider' } } }))
    expect(r.errors).toHaveLength(3)
  })

  it('warns on placeholders no config field fills', () => {
    const r = checkPluginFiles(files(
      { id: 'p', languages: ['python'], configSchema: { col: { type: 'column-select' } } },
      { 'a.py.template': 'x = {{col}}\ny = {{other}}' },
    ))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([expect.stringContaining('{{other}}')])
  })
})

describe('registerLabExtraTools', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerLabExtraTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
