import type { DashboardTab, DashboardWidget } from '@/types'

export interface DashboardTreeRow {
  kind: 'tab' | 'widget'
  id: string
  name: string
  /** Nesting depth: root tabs at 0, their sub-tabs at 1, widgets one level below their tab. */
  depth: number
  /** Tabs only: whether this tab has sub-tabs (a container holds no widgets of its own). */
  isContainer?: boolean
  /** Widgets only: the id of the tab the widget lives in. */
  tabId?: string
}

/**
 * Flatten a dashboard's tabs (any nesting depth) and their widgets into an ordered, indented
 * list for tree-style pickers (Export, Move-to-tab):
 *   Tab 1
 *     Sub-tab 1
 *       Widget A
 *       Widget B
 *     Sub-tab 2
 *   Tab 2
 * `includeWidgets` toggles whether widget rows are emitted (Move-to-tab shows them for context).
 */
export function buildDashboardTree(
  tabs: DashboardTab[],
  widgets: DashboardWidget[],
  dashboardId: string,
  includeWidgets = true,
): DashboardTreeRow[] {
  const dashTabs = tabs.filter((t) => t.dashboardId === dashboardId)
  const childrenByParent = new Map<string | null, DashboardTab[]>()
  for (const t of dashTabs) {
    const key = t.parentTabId ?? null
    const arr = childrenByParent.get(key) ?? []
    arr.push(t)
    childrenByParent.set(key, arr)
  }
  for (const arr of childrenByParent.values()) arr.sort((a, b) => a.displayOrder - b.displayOrder)

  const widgetsByTab = new Map<string, DashboardWidget[]>()
  for (const w of widgets) {
    const arr = widgetsByTab.get(w.tabId) ?? []
    arr.push(w)
    widgetsByTab.set(w.tabId, arr)
  }

  const rows: DashboardTreeRow[] = []
  const walk = (tab: DashboardTab, depth: number) => {
    const kids = childrenByParent.get(tab.id) ?? []
    const isContainer = kids.length > 0
    rows.push({ kind: 'tab', id: tab.id, name: tab.name, depth, isContainer })
    if (isContainer) {
      for (const k of kids) walk(k, depth + 1)
    } else if (includeWidgets) {
      for (const w of widgetsByTab.get(tab.id) ?? []) {
        rows.push({ kind: 'widget', id: w.id, name: w.name, depth: depth + 1, tabId: tab.id })
      }
    }
  }
  for (const root of childrenByParent.get(null) ?? []) walk(root, 0)
  return rows
}
