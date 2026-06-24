import { describe, it, expect } from 'vitest'
import type { DashboardTab, DashboardWidget } from '@/types'
import { buildDashboardTree } from './dashboard-tree'

const tab = (id: string, parentTabId: string | null, displayOrder: number): DashboardTab => ({
  id,
  dashboardId: 'd1',
  name: id,
  displayOrder,
  parentTabId,
})

const widget = (id: string, tabId: string): DashboardWidget => ({
  id,
  tabId,
  name: id,
  datasetFileId: null,
  layout: { x: 0, y: 0, w: 4, h: 4 },
  source: { type: 'inline', language: 'r', code: '', config: {} },
})

describe('buildDashboardTree', () => {
  it('nests tabs and widgets with increasing depth, in display order', () => {
    const tabs = [
      tab('root2', null, 1),
      tab('root1', null, 0),
      tab('child2', 'root1', 1),
      tab('child1', 'root1', 0),
    ]
    const widgets = [widget('w1', 'child1'), widget('w2', 'root2')]

    const rows = buildDashboardTree(tabs, widgets, 'd1', true)

    expect(rows.map((r) => [r.kind, r.id, r.depth])).toEqual([
      ['tab', 'root1', 0],
      ['tab', 'child1', 1],
      ['widget', 'w1', 2],
      ['tab', 'child2', 1],
      ['tab', 'root2', 0],
      ['widget', 'w2', 1],
    ])
  })

  it('flags container tabs and omits their own widgets (a container holds none)', () => {
    const tabs = [tab('root', null, 0), tab('child', 'root', 0)]
    // A widget wrongly attached to the container must not surface as the container's child.
    const widgets = [widget('orphan', 'root'), widget('ok', 'child')]

    const rows = buildDashboardTree(tabs, widgets, 'd1', true)

    const root = rows.find((r) => r.id === 'root')
    expect(root?.isContainer).toBe(true)
    expect(rows.some((r) => r.id === 'orphan')).toBe(false)
    expect(rows.some((r) => r.id === 'ok')).toBe(true)
  })

  it('excludes widgets when includeWidgets is false', () => {
    const tabs = [tab('root', null, 0)]
    const rows = buildDashboardTree(tabs, [widget('w', 'root')], 'd1', false)
    expect(rows.every((r) => r.kind === 'tab')).toBe(true)
  })

  it('only includes the given dashboard', () => {
    const tabs = [tab('a', null, 0), { ...tab('b', null, 0), dashboardId: 'other' }]
    const rows = buildDashboardTree(tabs, [], 'd1', true)
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  it('does not infinite-loop on a corrupted parent cycle', () => {
    // a→b→a cycle: should terminate (guarded) rather than overflow the stack.
    const tabs = [tab('a', 'b', 0), tab('b', 'a', 0)]
    expect(() => buildDashboardTree(tabs, [], 'd1', true)).not.toThrow()
  })
})
