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
  moveWidget, removeTab, removeWidget, renameTab, renameWidget, tabCollateral,
  type DashboardDocument,
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
