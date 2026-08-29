/**
 * The cascade tests.
 *
 * Every case here is a way to orphan a reference by rewriting a record whose key
 * is derived from what changed. They matter more than most tests in this package
 * because the failure is **silent**: nothing throws, the file stays valid JSON,
 * and the damage shows up later as widgets detached from their tab or a filter
 * that quietly stopped being scoped.
 */
import { describe, expect, it } from 'vitest'
import {
  moveWidget, removeTab, removeWidget, renameDatasetColumns, renameTab, renameWidget,
  tabCollateral, type DashboardDocument, type DatasetRecord,
} from './rekey.js'

/** A dashboard with a sub-tab, widgets in both, and both kinds of filter scope. */
function doc(): DashboardDocument {
  return {
    dashboard: {
      name: { en: 'Overview' },
      filterConfig: [
        { columnId: 'col_age', scope: { type: 'tabs', tabKeys: ['overview/summary'] } },
        { columnId: 'col_sex', scope: { type: 'widgets', widgetKeys: ['overview/summary/kpi@0,0'] } },
      ],
    },
    tabs: [
      { name: { en: 'Summary' }, key: 'overview/summary', parentKey: null, displayOrder: 0 },
      { name: { en: 'Detail' }, key: 'overview/summary/detail', parentKey: 'overview/summary', displayOrder: 1 },
    ],
    widgets: [
      { name: { en: 'KPI' }, key: 'overview/summary/kpi@0,0', tabKey: 'overview/summary', layout: { x: 0, y: 0, w: 12, h: 8 } },
      { name: { en: 'Chart' }, key: 'overview/summary/detail/chart@0,0', tabKey: 'overview/summary/detail', layout: { x: 0, y: 0, w: 12, h: 8 } },
    ],
  }
}

const keys = (d: DashboardDocument) => (d.widgets ?? []).map((w) => w.key)
const scopeOf = (d: DashboardDocument, i: number) => d.dashboard?.filterConfig?.[i].scope

describe('renameTab', () => {
  it('moves the tab, its widgets, its sub-tab and that sub-tab\'s widgets', () => {
    // The whole point: a sub-tab's key contains its parent's, and a widget's key
    // contains its tab's — so one rename re-keys four records.
    const { doc: out } = renameTab(doc(), 'overview/summary', { en: 'Cohort' })
    expect((out.tabs ?? []).map((t) => t.key)).toEqual([
      'overview/cohort', 'overview/cohort/detail',
    ])
    expect(keys(out)).toEqual([
      'overview/cohort/kpi@0,0', 'overview/cohort/detail/chart@0,0',
    ])
  })

  it('repoints the sub-tab at its parent\'s new key', () => {
    // Missed, the sub-tab keeps a parentKey nobody answers to and detaches.
    const { doc: out } = renameTab(doc(), 'overview/summary', { en: 'Cohort' })
    expect(out.tabs?.[1].parentKey).toBe('overview/cohort')
  })

  it('repoints a filter scoped to the tab', () => {
    const { doc: out } = renameTab(doc(), 'overview/summary', { en: 'Cohort' })
    expect(scopeOf(out, 0)).toEqual({ type: 'tabs', tabKeys: ['overview/cohort'] })
  })

  it('repoints a filter scoped to a widget the rename moved', () => {
    // The second-order one: the filter names a WIDGET, and the widget moved only
    // because its tab did. Cascading one level would have missed this.
    const { doc: out } = renameTab(doc(), 'overview/summary', { en: 'Cohort' })
    expect(scopeOf(out, 1)).toEqual({ type: 'widgets', widgetKeys: ['overview/cohort/kpi@0,0'] })
  })

  it('reports every key it changed', () => {
    const { changes } = renameTab(doc(), 'overview/summary', { en: 'Cohort' })
    expect(changes.get('overview/summary')).toBe('overview/cohort')
    expect(changes.get('overview/summary/detail')).toBe('overview/cohort/detail')
    expect(changes.get('overview/summary/kpi@0,0')).toBe('overview/cohort/kpi@0,0')
  })

  it('is a no-op when the name slugifies to the same key', () => {
    // 'Summary' and 'summary' share a slug; re-keying would be churn for nothing.
    const { doc: out, changes } = renameTab(doc(), 'overview/summary', { en: 'summary' })
    expect(changes.size).toBe(0)
    expect(keys(out)).toEqual(keys(doc()))
  })

  it('refuses a name that collides with a sibling', () => {
    const d = doc()
    d.tabs!.push({ name: { en: 'Other' }, key: 'overview/other', parentKey: null })
    expect(() => renameTab(d, 'overview/summary', { en: 'Other' })).toThrow(/already exists/)
  })

  it('names the tabs that exist when the key is unknown', () => {
    expect(() => renameTab(doc(), 'overview/ghost', { en: 'X' }))
      .toThrow(/Known: overview\/summary, overview\/summary\/detail/)
  })
})

describe('moveWidget', () => {
  it('re-keys on a grid move, since the key embeds the position', () => {
    const { doc: out } = moveWidget(doc(), 'overview/summary/kpi@0,0', { x: 12, y: 4 })
    expect(keys(out)).toContain('overview/summary/kpi@4,12')
  })

  it('keeps the size when only x/y are given', () => {
    // A move is not a resize; dropping w/h would silently shrink the widget.
    const { doc: out } = moveWidget(doc(), 'overview/summary/kpi@0,0', { x: 12, y: 4 })
    const moved = (out.widgets ?? []).find((w) => w.key === 'overview/summary/kpi@4,12')
    expect(moved?.layout).toEqual({ x: 12, y: 4, w: 12, h: 8 })
  })

  it('re-keys and repoints tabKey when moved to another tab', () => {
    const { doc: out } = moveWidget(doc(), 'overview/summary/kpi@0,0', {
      tabKey: 'overview/summary/detail',
    })
    const moved = (out.widgets ?? []).find((w) => w.key === 'overview/summary/detail/kpi@0,0')
    expect(moved?.tabKey).toBe('overview/summary/detail')
  })

  it('repoints a filter scoped to the moved widget', () => {
    const { doc: out } = moveWidget(doc(), 'overview/summary/kpi@0,0', { x: 12, y: 4 })
    expect(scopeOf(out, 1)).toEqual({ type: 'widgets', widgetKeys: ['overview/summary/kpi@4,12'] })
  })

  it('refuses a move onto a position already taken by a same-named widget', () => {
    const d = doc()
    d.widgets!.push({
      name: { en: 'KPI' }, key: 'overview/summary/kpi@4,12',
      tabKey: 'overview/summary', layout: { x: 12, y: 4, w: 12, h: 8 },
    })
    expect(() => moveWidget(d, 'overview/summary/kpi@0,0', { x: 12, y: 4 }))
      .toThrow(/already exists/)
  })

  it('refuses an unknown destination tab', () => {
    expect(() => moveWidget(doc(), 'overview/summary/kpi@0,0', { tabKey: 'overview/ghost' }))
      .toThrow(/Unknown tab/)
  })

  it('keeps the widget array in writer order', () => {
    // Array order is byte-visible: leaving a moved widget in place would add a
    // diff on lines nobody edited.
    const { doc: out } = moveWidget(doc(), 'overview/summary/kpi@0,0', {
      tabKey: 'overview/summary/detail', x: 24, y: 0,
    })
    expect(keys(out)).toEqual([
      'overview/summary/detail/chart@0,0', 'overview/summary/detail/kpi@0,24',
    ])
  })
})

describe('renameWidget', () => {
  it('re-keys and repoints the filter scoped to it', () => {
    const { doc: out } = renameWidget(doc(), 'overview/summary/kpi@0,0', { en: 'Beds' })
    expect(keys(out)).toContain('overview/summary/beds@0,0')
    expect(scopeOf(out, 1)).toEqual({ type: 'widgets', widgetKeys: ['overview/summary/beds@0,0'] })
  })

  it('keeps the position, which is part of the key', () => {
    const { doc: out } = renameWidget(doc(), 'overview/summary/kpi@0,0', { en: 'Beds' })
    const w = (out.widgets ?? []).find((x) => x.key === 'overview/summary/beds@0,0')
    expect(w?.layout).toEqual({ x: 0, y: 0, w: 12, h: 8 })
  })
})

describe('tabCollateral', () => {
  it('names the sub-tab and every widget a removal would take', () => {
    // D2: a tab looks like one record but owns a subtree, and there is no undo.
    const { removes, scopes } = tabCollateral(doc(), 'overview/summary')
    expect(removes).toEqual([
      'overview/summary', 'overview/summary/detail',
      'overview/summary/kpi@0,0', 'overview/summary/detail/chart@0,0',
    ])
    expect(scopes).toEqual(['col_age', 'col_sex'])
  })
})

describe('removeTab / removeWidget', () => {
  it('removes the tab, its sub-tree and their widgets', () => {
    const { doc: out } = removeTab(doc(), 'overview/summary')
    expect(out.tabs).toEqual([])
    expect(out.widgets).toEqual([])
  })

  it('drops the removed keys from filter scopes', () => {
    const { doc: out } = removeTab(doc(), 'overview/summary')
    expect(scopeOf(out, 0)).toMatchObject({ tabKeys: [] })
    expect(scopeOf(out, 1)).toMatchObject({ widgetKeys: [] })
  })

  it('empties a scope rather than deleting it', () => {
    // Deleting the scope would widen the filter to the whole dashboard — the
    // opposite of what "only these widgets" asked for.
    const { doc: out } = removeWidget(doc(), 'overview/summary/kpi@0,0')
    expect(scopeOf(out, 1)).toEqual({ type: 'widgets', widgetKeys: [] })
  })

  it('leaves the other widget alone', () => {
    const { doc: out } = removeWidget(doc(), 'overview/summary/kpi@0,0')
    expect(keys(out)).toEqual(['overview/summary/detail/chart@0,0'])
  })
})

describe('renameDatasetColumns', () => {
  const dataset = (): DatasetRecord => ({
    id: 'stays.csv',
    name: 'stays',
    columns: [
      { id: 'col_age', name: 'age', type: 'number', order: 0 },
      { id: 'col_sex', name: 'sex', type: 'string', order: 1 },
    ],
  })

  const dashboards = () => new Map<string, DashboardDocument>([
    ['dashboards/overview.json', {
      dashboard: {
        filterConfig: [
          { datasetFileId: 'stays.csv', columnId: 'col_age', columnName: 'age' },
          { datasetFileId: 'other.csv', columnId: 'col_age', columnName: 'age' },
        ],
      },
      tabs: [],
      widgets: [
        {
          key: 'o/t/w@0,0', tabKey: 'o/t', datasetFileId: 'stays.csv',
          layout: { x: 0, y: 0, w: 12, h: 8 },
          source: { type: 'plugin', config: { xColumn: 'col_age', subtitleStats: ['median', 'col_age'] } },
        },
        {
          key: 'o/t/x@0,12', tabKey: 'o/t', datasetFileId: 'other.csv',
          layout: { x: 12, y: 0, w: 12, h: 8 },
          source: { type: 'plugin', config: { xColumn: 'col_age' } },
        },
      ],
    }],
  ])

  it('re-derives the id from the new name', () => {
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'age_years' }])
    expect(out.dataset.columns?.[0]).toMatchObject({ id: 'col_age_years', name: 'age_years' })
    expect(out.changes.get('col_age')).toBe('col_age_years')
  })

  it('repoints a widget config that referenced the old id', () => {
    // Without this the widget keeps an id nothing answers to: it renders blank,
    // with an empty column picker and no error.
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'age_years' }])
    const doc = out.dashboards.get('dashboards/overview.json')!
    expect(doc.widgets?.[0].source).toMatchObject({ config: { xColumn: 'col_age_years' } })
  })

  it('rewrites inside an array, as the serializer resolver does', () => {
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'age_years' }])
    const config = (out.dashboards.get('dashboards/overview.json')!.widgets?.[0].source as
      { config: Record<string, unknown> }).config
    // 'median' is a stat name, not a column: matching by VALUE leaves it alone.
    expect(config.subtitleStats).toEqual(['median', 'col_age_years'])
  })

  it('repoints a filter on the same dataset', () => {
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'age_years' }])
    expect(out.dashboards.get('dashboards/overview.json')!.dashboard?.filterConfig?.[0])
      .toMatchObject({ columnId: 'col_age_years' })
  })

  it('leaves another dataset\'s identical id alone', () => {
    // Two datasets can both have a col_age; scoping by datasetFileId is what
    // stops a rename here from corrupting a widget bound to the other one.
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'age_years' }])
    const doc = out.dashboards.get('dashboards/overview.json')!
    expect(doc.widgets?.[1].source).toMatchObject({ config: { xColumn: 'col_age' } })
    expect(doc.dashboard?.filterConfig?.[1]).toMatchObject({ columnId: 'col_age' })
  })

  it('hands out collision suffixes in column order, not per column', () => {
    // The trap: ids are only correct over the WHOLE ordered list. Renaming `sex`
    // to `Age` makes two columns normalise to col_age; the first in header order
    // keeps the bare id and the second takes _2. Deriving one id at a time would
    // accept them swapped, after which the app re-derives the other arrangement
    // and orphans everything pointing at either.
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_sex', to: 'Age' }])
    expect(out.dataset.columns?.map((c) => c.id)).toEqual(['col_age', 'col_age_2'])
    expect(out.changes.get('col_sex')).toBe('col_age_2')
  })

  it('reports nothing when the name slugifies to the same id', () => {
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'Age' }])
    expect(out.changes.size).toBe(0)
    expect(out.dataset.columns?.[0].name).toBe('Age')
  })

  it('names the columns that exist when the id is unknown', () => {
    expect(() => renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_ghost', to: 'x' }]))
      .toThrow(/Known: col_age, col_sex/)
  })

  it('refuses an empty name', () => {
    expect(() => renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: '  ' }]))
      .toThrow(/needs a name/)
  })

  it('repoints the filter\'s columnName, not just its columnId', () => {
    // The sidebar resolves the live column by NAME first and only falls back to
    // the id, so a rewritten id beside a stale name is the branch never taken.
    const out = renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'age_years' }])
    expect(out.dashboards.get('dashboards/overview.json')!.dashboard?.filterConfig?.[0])
      .toMatchObject({ columnId: 'col_age_years', columnName: 'age_years' })
  })

  it('refuses a rename that would take an untouched column\'s id', () => {
    // Otherwise `sex` keeps its name but slides to col_sex_2, and every widget
    // and filter pointing at the original col_sex silently follows the renamed
    // column instead.
    expect(() => renameDatasetColumns(dataset(), dashboards(), [{ from: 'col_age', to: 'sex' }]))
      .toThrow(/collides with column "sex"/)
  })

  it('allows two columns to swap names in one call', () => {
    // Both are in the rename set, so nothing is displaced behind the user's back.
    const out = renameDatasetColumns(dataset(), dashboards(), [
      { from: 'col_age', to: 'sex' }, { from: 'col_sex', to: 'age' },
    ])
    expect(out.dataset.columns?.map((c) => c.id)).toEqual(['col_sex', 'col_age'])
  })
})
