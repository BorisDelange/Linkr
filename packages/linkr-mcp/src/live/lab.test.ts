import { describe, expect, it } from 'vitest'
import type { PluginManifest } from '@/types/plugin'
import { GRID_COLUMNS, buildFilter, columnMetaMap, findColumn, placeWidget, resolveColumns } from './lab'
import { findPlugin, listPlugins, pluginDoc } from './plugins'

const MANIFEST = {
  id: 'p',
  configSchema: {
    plotType: { type: 'select' },
    xColumn: { type: 'column-select' },
    groups: { type: 'column-select', multi: true },
  },
} as unknown as PluginManifest

const COLUMNS = [
  { id: 'col_age', name: 'age' },
  { id: 'col_los_days', name: 'LOS days' },
]

describe('resolveColumns', () => {
  it('maps names to ids, case-insensitively, single and multi', () => {
    const { config, errors } = resolveColumns(
      { plotType: 'histogram', xColumn: 'AGE', groups: ['los days', 'col_age'] }, MANIFEST, COLUMNS,
    )
    expect(errors).toEqual([])
    expect(config).toEqual({ plotType: 'histogram', xColumn: 'col_age', groups: ['col_los_days', 'col_age'] })
  })

  it('reports unknown columns and unknown fields', () => {
    const { errors } = resolveColumns({ xColumn: 'weight', colour: 'red' }, MANIFEST, COLUMNS)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/no column "weight"/)
    expect(errors[1]).toMatch(/colour/)
  })

  it('leaves non-column fields untouched even when they look like a column', () => {
    expect(resolveColumns({ plotType: 'age' }, MANIFEST, COLUMNS).config.plotType).toBe('age')
  })
})

describe('placeWidget', () => {
  it('goes below the lowest widget, half width', () => {
    expect(placeWidget([{ x: 0, y: 0, w: 24, h: 12 }, { x: 24, y: 4, w: 24, h: 12 }])).toEqual({ x: 0, y: 16, w: 24, h: 12 })
  })

  it('clamps a request to the grid', () => {
    expect(placeWidget([], { x: 40, w: 100 })).toEqual({ x: 0, y: 0, w: GRID_COLUMNS, h: 12 })
    expect(placeWidget([], { x: 40, w: 24 }).x).toBe(GRID_COLUMNS - 24)
  })
})

describe('plugins', () => {
  it('reads the default analysis plugins and finds them by short id', () => {
    expect(listPlugins().length).toBeGreaterThan(5)
    expect(findPlugin('plot-builder')?.id).toBe('linkr-analysis-plot-builder')
  })

  it('documents fields without the cosmetic ones', () => {
    const doc = pluginDoc(findPlugin('plot-builder')!)
    expect(doc).toContain('xColumn (column')
    expect(doc).not.toMatch(/colorPalette|legendFontSize/)
  })
})

describe('buildFilter', () => {
  const columns = [
    { id: 'col_age', name: 'age', type: 'number' },
    { id: 'col_sex', name: 'sex', type: 'string' },
    { id: 'col_adm', name: 'admission', type: 'date' },
  ]
  const make = (column: string, extra: { inputType?: string; tabIds?: string[] } = {}) =>
    buildFilter({ id: 'f1', datasetPath: 'data/icu.parquet', column, columns, ...extra })

  it('picks the app defaults by column type and resolves names', () => {
    expect(make('Age').filter).toMatchObject({ columnId: 'col_age', type: 'numeric', inputType: 'range', scope: { type: 'all' } })
    expect(make('col_sex').filter).toMatchObject({ type: 'categorical', inputType: 'multi-select' })
    expect(make('admission', { tabIds: ['t1'] }).filter).toMatchObject({ type: 'date', scope: { type: 'tabs', tabIds: ['t1'] } })
  })

  it('refuses an unknown column or an input type that does not fit', () => {
    expect(make('weight').error).toMatch(/No column "weight"/)
    expect(make('sex', { inputType: 'range' }).error).toMatch(/allowed: multi-select, checkbox, single-select/)
  })
})

describe('columnMetaMap', () => {
  const columns = [
    { id: 'col_sex', name: 'sex', type: 'string', label: 'Sex', valueLabels: { F: 'Female' } },
    { id: 'col_age', name: 'age', type: 'number', description: 'At admission' },
  ]

  it('changes one column and sends every other one back as it was', () => {
    expect(columnMetaMap(columns, 'col_age', { label: 'Age (years)' })).toEqual({
      col_sex: { label: 'Sex', valueLabels: { F: 'Female' } },
      col_age: { description: 'At admission', label: 'Age (years)' },
    })
  })

  it('clears a field with an empty string, dropping a column left empty', () => {
    expect(columnMetaMap(columns, 'col_age', { description: '' })).toEqual({
      col_sex: { label: 'Sex', valueLabels: { F: 'Female' } },
    })
  })

  it('finds a column by id or name', () => {
    expect(findColumn(columns, 'SEX')?.id).toBe('col_sex')
    expect(findColumn(columns, 'col_age')?.name).toBe('age')
    expect(findColumn(columns, 'weight')).toBeUndefined()
  })
})
