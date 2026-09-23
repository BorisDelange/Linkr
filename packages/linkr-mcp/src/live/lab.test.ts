import { describe, expect, it } from 'vitest'
import type { PluginManifest } from '@/types/plugin'
import { GRID_COLUMNS, placeWidget, resolveColumns } from './lab'
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
