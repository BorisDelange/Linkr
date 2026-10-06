import { describe, it, expect } from 'vitest'
import type { DatasetColumn } from '@/types'
import { buildPlotBuilderSpec } from './plot-builder-server'

const columns: DatasetColumn[] = [
  { id: 'col_ward', name: 'ward', type: 'string', order: 0 },
  { id: 'col_age', name: 'age', type: 'number', order: 1 },
]

describe('buildPlotBuilderSpec', () => {
  it('counts the X variable of a pie', () => {
    const spec = buildPlotBuilderSpec(columns, { plotType: 'pie', xColumn: 'col_ward' })
    expect(spec.hist).toBe('ward')
  })

  it('drops a Y left over from another plot type, so it cannot filter the pie rows', () => {
    const spec = buildPlotBuilderSpec(columns, { plotType: 'pie', xColumn: 'col_ward', yColumn: 'col_age' })
    expect(spec.y).toBeNull()
    expect(spec.yType).toBeNull()
  })

  it('swaps a horizontal boxplot back to x = categories, y = values', () => {
    const spec = buildPlotBuilderSpec(columns, {
      plotType: 'boxplot', boxplotOrientation: 'horizontal', xColumn: 'col_age', yColumn: 'col_ward',
    })
    expect([spec.x, spec.y, spec.xType, spec.yType]).toEqual(['ward', 'age', 'string', 'number'])
  })

  it('leaves a horizontal histogram setting alone on a boxplot', () => {
    const spec = buildPlotBuilderSpec(columns, {
      plotType: 'boxplot', histogramOrientation: 'horizontal', xColumn: 'col_ward', yColumn: 'col_age',
    })
    expect([spec.x, spec.y]).toEqual(['ward', 'age'])
  })

  it('sends the median ordering only for box and violin plots', () => {
    expect(buildPlotBuilderSpec(columns, { plotType: 'violin', xColumn: 'col_ward', sortByMedian: true }).boxSortByMedian).toBe(true)
    expect(buildPlotBuilderSpec(columns, { plotType: 'bar', xColumn: 'col_ward', sortByMedian: true }).boxSortByMedian).toBe(false)
    expect(buildPlotBuilderSpec(columns, { plotType: 'boxplot', xColumn: 'col_ward' }).boxSortByMedian).toBe(false)
  })

  it('keeps Y for the other plot types', () => {
    const spec = buildPlotBuilderSpec(columns, { plotType: 'scatter', xColumn: 'col_age', yColumn: 'col_age' })
    expect(spec.y).toBe('age')
  })
})
