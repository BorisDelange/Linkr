import { describe, expect, it } from 'vitest'
import { planColumnRename, rekeyFilter, rekeyWidgetConfig } from './dataset-column-rename'
import type { DashboardFilter, DashboardWidget, DatasetColumn } from '@/types'

function cols(...names: string[]): DatasetColumn[] {
  return names.map((name, i) => ({
    id: `col_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    name,
    type: 'string',
    order: i,
  }))
}

describe('planColumnRename', () => {
  it('derives the new id from the new name', () => {
    const plan = planColumnRename(cols('age', 'sex'), 'col_age', 'Age at admission')
    expect(plan.changes.get('col_age')).toBe('col_age_at_admission')
    expect(plan.columns[0]).toMatchObject({ id: 'col_age_at_admission', name: 'Age at admission' })
  })

  it('leaves untouched columns alone', () => {
    const plan = planColumnRename(cols('age', 'sex'), 'col_age', 'years')
    expect(plan.changes.has('col_sex')).toBe(false)
    expect(plan.columns[1]).toMatchObject({ id: 'col_sex', name: 'sex' })
  })

  it('records no change when the slug is unmoved', () => {
    // "age" and "Age" slug identically: the display name changes, the id does not.
    const plan = planColumnRename(cols('age', 'sex'), 'col_age', 'Age')
    expect(plan.changes.size).toBe(0)
    expect(plan.columns[0]).toMatchObject({ id: 'col_age', name: 'Age' })
  })

  it('refuses a rename that would displace an untouched column', () => {
    // Renaming age→sex beside a real `sex` would push the bystander to col_sex_2,
    // silently repointing every widget and filter that named it.
    expect(() => planColumnRename(cols('age', 'sex'), 'col_age', 'sex')).toThrow('collision')
  })

  it('rejects an empty name and an unknown column', () => {
    expect(() => planColumnRename(cols('age'), 'col_age', '   ')).toThrow('empty-name')
    expect(() => planColumnRename(cols('age'), 'col_nope', 'x')).toThrow('unknown-column')
  })
})

const widget = (over: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id: 'w1',
  tabId: 't1',
  name: { en: 'W' },
  datasetFileId: 'ds1',
  layout: { x: 0, y: 0, w: 2, h: 2 },
  source: { type: 'plugin', pluginId: 'p', config: {} },
  ...over,
} as DashboardWidget)

describe('rekeyWidgetConfig', () => {
  const changes = new Map([['col_age', 'col_years']])

  it('rewrites a string reference', () => {
    const w = widget({ source: { type: 'plugin', pluginId: 'p', config: { xColumn: 'col_age' } } } as Partial<DashboardWidget>)
    const out = rekeyWidgetConfig(w, 'ds1', changes)
    expect((out.source as { config: Record<string, unknown> }).config.xColumn).toBe('col_years')
  })

  it('rewrites references inside an array', () => {
    const w = widget({ source: { type: 'plugin', pluginId: 'p', config: { columns: ['col_age', 'col_sex'] } } } as Partial<DashboardWidget>)
    const out = rekeyWidgetConfig(w, 'ds1', changes)
    expect((out.source as { config: Record<string, unknown> }).config.columns).toEqual(['col_years', 'col_sex'])
  })

  it('leaves unrelated values untouched', () => {
    const w = widget({ source: { type: 'plugin', pluginId: 'p', config: { subtitleStats: ['median', 'min'], bins: 20 } } } as Partial<DashboardWidget>)
    const out = rekeyWidgetConfig(w, 'ds1', changes)
    const config = (out.source as { config: Record<string, unknown> }).config
    expect(config.subtitleStats).toEqual(['median', 'min'])
    expect(config.bins).toBe(20)
  })

  it('does not touch a widget bound to another dataset', () => {
    // Two datasets can both have a col_age; rewriting the other one corrupts it.
    const w = widget({ datasetFileId: 'ds2', source: { type: 'plugin', pluginId: 'p', config: { xColumn: 'col_age' } } } as Partial<DashboardWidget>)
    expect(rekeyWidgetConfig(w, 'ds1', changes)).toBe(w)
  })
})

describe('rekeyFilter', () => {
  const changes = new Map([['col_age', 'col_years']])
  const namesById = new Map([['col_years', 'years']])
  const filter = (over: Partial<DashboardFilter> = {}): DashboardFilter => ({
    id: 'f1',
    datasetFileId: 'ds1',
    columnId: 'col_age',
    columnName: 'age',
    type: 'numeric',
    inputType: 'range',
    ...over,
  } as DashboardFilter)

  it('rewrites the id AND the name the sidebar resolves by first', () => {
    const out = rekeyFilter(filter(), 'ds1', changes, namesById)
    expect(out.columnId).toBe('col_years')
    expect(out.columnName).toBe('years')
  })

  it('leaves a filter on another dataset or another column alone', () => {
    const other = filter({ datasetFileId: 'ds2' })
    expect(rekeyFilter(other, 'ds1', changes, namesById)).toBe(other)
    const untouched = filter({ columnId: 'col_sex' })
    expect(rekeyFilter(untouched, 'ds1', changes, namesById)).toBe(untouched)
  })
})
