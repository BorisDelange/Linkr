import { create } from 'zustand'
import type { Dashboard, DashboardTab, DashboardWidget, DashboardWidgetSource, FilterValue, LocalizedString } from '@/types'
import { getStorage } from '@/lib/storage'
import { toLocalized } from '@/lib/localized'
import { stampAuthored } from '@/stores/app-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { remapWidgetColumns } from '@/features/projects/dashboard/remap-widget-columns'
import { isWidgetPluginStale, stampPluginVersion } from '@/features/projects/dashboard/plugin-drift'
import { invalidateWidgetResult } from '@/features/projects/dashboard/widget-renderers/use-widget-execution'
import { fitTabLayouts } from '@/features/projects/dashboard/dashboard-grid'

interface DashboardState {
  // Loaded data for current project
  dashboards: Dashboard[]
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  activeProjectUid: string | null
  loaded: boolean

  // Editor state
  activeDashboardId: string | null
  // dashboardId → active LEAF tabId (a tab at any nesting level). The breadcrumb of
  // ancestors is reconstructed by walking parentTabId up to the root.
  activeTabId: Record<string, string>

  // Runtime filter state (not persisted) — keyed by DashboardFilter.id
  activeFilters: Record<string, FilterValue>

  // Dashboard CRUD
  loadProjectDashboards: (projectUid: string) => Promise<void>
  createDashboard: (projectUid: string, name: LocalizedString) => Promise<string>
  updateDashboard: (id: string, changes: Partial<Dashboard>) => void
  deleteDashboard: (id: string) => void
  setActiveDashboard: (id: string | null) => void

  // Tab CRUD
  addTab: (dashboardId: string) => void
  /** Add a sub-tab to any tab (nesting is unbounded). When the parent already holds widgets
   *  and this is its first sub-tab, it becomes a container (which has no widgets of its own):
   *  moveWidgets=true migrates them into the new sub-tab, false deletes them. */
  addSubTab: (parentTabId: string, moveWidgets?: boolean) => void
  removeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  reorderTabs: (dashboardId: string, orderedIds: string[]) => void
  /** Select a tab as-is. A container has no widgets of its own, so the page shows a
   *  "pick a sub-tab" hint instead — use enterTab to step into its children. */
  setActiveTab: (dashboardId: string, tabId: string) => void
  /** Step into a container by selecting its first direct child (one level down). A leaf is
   *  just selected. Used when clicking a container tab or a breadcrumb ancestor. */
  enterTab: (dashboardId: string, tabId: string) => void

  // Widget CRUD
  addWidget: (tabId: string, source: DashboardWidgetSource, name: string, datasetFileId?: string | null) => void
  removeWidget: (widgetId: string) => void
  /** Move a widget to another tab, dropping it at the bottom of the target tab. */
  moveWidget: (widgetId: string, newTabId: string) => void
  /** Clone a widget (config + dataset) into the same or another tab. */
  duplicateWidget: (widgetId: string, targetTabId?: string) => void
  updateWidgetLayout: (widgetId: string, layout: { x: number; y: number; w: number; h: number }) => void
  /** Remove vertical gaps (compact upward) for every tab of a dashboard, then scale each tab's
   *  widgets down so they fit within maxRows. Called once when a dashboard is switched into
   *  "fit to height" so existing layouts fit the visible area without scrolling. */
  fitDashboardToHeight: (dashboardId: string, maxRows: number, mode?: 'fill' | 'shrink-only') => void
  updateWidgetSource: (widgetId: string, source: DashboardWidgetSource) => void
  updateWidgetName: (widgetId: string, name: string) => void
  updateWidgetDataset: (widgetId: string, datasetFileId: string | null) => void
  /** Realign a single widget's stamped plugin version with the live plugin (user accepts the change). */
  acceptPluginVersion: (widgetId: string) => void
  /** Realign every stale widget of a dashboard with its plugin's current version. */
  acceptAllPluginVersions: (dashboardId: string) => void

  // Filter runtime state
  setFilter: (filterId: string, value: FilterValue) => void
  setAllFilters: (filters: Record<string, FilterValue>) => void
  clearFilter: (filterId: string) => void
  clearAllFilters: () => void
}

const uid = () => crypto.randomUUID()

function getDefaultLayout(_source: DashboardWidgetSource): { w: number; h: number } {
  // 48-col grid, 20px rows → a quarter-width, ~240px-tall default widget.
  return { w: 24, h: 12 }
}

/** Direct children of a tab, sorted by display order. */
export function getChildTabs(tabs: DashboardTab[], tabId: string): DashboardTab[] {
  return tabs
    .filter((t) => t.parentTabId === tabId)
    .sort((a, b) => a.displayOrder - b.displayOrder)
}

/** Walk down through the first child at each level until reaching a leaf (a tab with no
 *  children). A container holds no widgets of its own, so we always render a leaf. */
export function firstLeafTab(tabs: DashboardTab[], tabId: string): string {
  let current = tabId
  for (let guard = 0; guard < 100; guard++) {
    const children = getChildTabs(tabs, current)
    if (children.length === 0) return current
    current = children[0].id
  }
  return current
}

/** Ancestors→tab chain (root first, the tab itself last), reconstructed via parentTabId. */
export function getTabPath(tabs: DashboardTab[], tabId: string): DashboardTab[] {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const path: DashboardTab[] = []
  let current: string | null | undefined = tabId
  for (let guard = 0; guard < 100 && current; guard++) {
    const tab = byId.get(current)
    if (!tab) break
    path.unshift(tab)
    current = tab.parentTabId
  }
  return path
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  dashboards: [],
  tabs: [],
  widgets: [],
  activeProjectUid: null,
  loaded: false,
  activeDashboardId: null,
  activeTabId: {},
  activeFilters: {},

  loadProjectDashboards: async (projectUid) => {
    if (get().activeProjectUid === projectUid && get().loaded) return

    try {
      const storage = getStorage()
      const dashboards = await storage.dashboards.getByProject(projectUid)

      // Backfill legacy plain-string names into LocalizedString and persist once.
      for (const dash of dashboards) {
        if (typeof dash.name === 'string') {
          dash.name = toLocalized(dash.name)
          storage.dashboards.update(dash.id, { name: dash.name }).catch((e) => console.warn('[dashboard-store] name backfill:', e))
        }
      }

      // Load all tabs and widgets for all dashboards in this project
      const allTabs: DashboardTab[] = []
      const allWidgets: DashboardWidget[] = []
      for (const dash of dashboards) {
        const tabs = await storage.dashboardTabs.getByDashboard(dash.id)
        allTabs.push(...tabs)
        for (const tab of tabs) {
          const widgets = await storage.dashboardWidgets.getByTab(tab.id)
          allWidgets.push(...widgets)
        }
      }

      // Grid migration 1→2 (24→48 cols, row height halved): double each widget's position and
      // size once so legacy dashboards keep their visual layout. Stamp gridV=2 FIRST and await it,
      // so a crash mid-migration can't re-run (and re-double) the layouts on the next load. The
      // worst case if widget updates then fail is widgets rendered half-size, not runaway doubling.
      for (const dash of dashboards) {
        if ((dash.gridV ?? 1) >= 2) continue
        dash.gridV = 2
        try {
          await storage.dashboards.update(dash.id, { gridV: 2 })
        } catch (e) {
          console.warn('[dashboard-store] grid migrate (skipped, will retry next load):', e)
          dash.gridV = 1
          continue
        }
        const tabIds = new Set(allTabs.filter((t) => t.dashboardId === dash.id).map((t) => t.id))
        for (const w of allWidgets) {
          if (!tabIds.has(w.tabId)) continue
          w.layout = { x: w.layout.x * 2, y: w.layout.y * 2, w: w.layout.w * 2, h: w.layout.h * 2 }
          storage.dashboardWidgets.update(w.id, { layout: w.layout }).catch((e) => console.warn('[dashboard-store] grid migrate:', e))
        }
      }

      set({
        dashboards,
        tabs: allTabs,
        widgets: allWidgets,
        activeProjectUid: projectUid,
        loaded: true,
        activeDashboardId: null,
        activeTabId: {},
        activeFilters: {},
      })
    } catch {
      set({
        dashboards: [],
        tabs: [],
        widgets: [],
        activeProjectUid: projectUid,
        loaded: true,
        activeDashboardId: null,
        activeTabId: {},
        activeFilters: {},
      })
    }
  },

  createDashboard: async (projectUid, name) => {
    const id = uid()
    const now = new Date().toISOString()
    const dashboard: Dashboard = {
      id,
      projectUid,
      name,
      filterConfig: [],
      gridV: 2,
      ...stampAuthored(),
      createdAt: now,
      updatedAt: now,
    }

    // Create a default first tab
    const tabId = uid()
    const tab: DashboardTab = {
      id: tabId,
      dashboardId: id,
      name: 'Tab 1',
      displayOrder: 0,
      parentTabId: null,
    }

    set((s) => ({
      dashboards: [...s.dashboards, dashboard],
      tabs: [...s.tabs, tab],
    }))

    // The tab's create references the dashboard (FK), so persist the dashboard
    // first: in server mode the tab POST 404s if it races ahead of the parent.
    try {
      await getStorage().dashboards.create(dashboard)
      await getStorage().dashboardTabs.create(tab)
    } catch (e) {
      console.warn('[dashboard-store] persist error:', e)
    }

    return id
  },

  updateDashboard: (id, changes) => {
    set((s) => ({
      dashboards: s.dashboards.map((d) =>
        d.id === id ? { ...d, ...changes, updatedAt: new Date().toISOString() } : d
      ),
    }))
    getStorage().dashboards.update(id, changes).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  deleteDashboard: (id) => {
    const state = get()
    const dashTabs = state.tabs.filter((t) => t.dashboardId === id)
    const tabIds = new Set(dashTabs.map((t) => t.id))

    set((s) => ({
      dashboards: s.dashboards.filter((d) => d.id !== id),
      tabs: s.tabs.filter((t) => t.dashboardId !== id),
      widgets: s.widgets.filter((w) => !tabIds.has(w.tabId)),
      activeDashboardId: s.activeDashboardId === id ? null : s.activeDashboardId,
    }))

    // Cascade delete in storage
    const storage = getStorage()
    for (const tab of dashTabs) {
      storage.dashboardWidgets.deleteByTab(tab.id).catch((e) => console.warn('[dashboard-store] persist error:', e))
    }
    storage.dashboardTabs.deleteByDashboard(id).catch((e) => console.warn('[dashboard-store] persist error:', e))
    storage.dashboards.delete(id).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  setActiveDashboard: (id) => {
    set({ activeDashboardId: id, activeFilters: {} })
  },

  // --- Tab CRUD ---

  addTab: (dashboardId) => {
    const id = uid()
    const tab: DashboardTab = (() => {
      const roots = get().tabs.filter((t) => t.dashboardId === dashboardId && !t.parentTabId)
      return {
        id,
        dashboardId,
        name: `Tab ${roots.length + 1}`,
        displayOrder: roots.length,
        parentTabId: null,
      }
    })()

    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: { ...s.activeTabId, [dashboardId]: id },
    }))
    getStorage().dashboardTabs.create(tab).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  addSubTab: (parentTabId, moveWidgets = true) => {
    const parent = get().tabs.find((t) => t.id === parentTabId)
    if (!parent) return
    const existingChildren = get().tabs.filter((t) => t.parentTabId === parentTabId)
    const id = uid()
    const child: DashboardTab = {
      id,
      dashboardId: parent.dashboardId,
      name: `Sub-tab ${existingChildren.length + 1}`,
      displayOrder: existingChildren.length,
      parentTabId,
    }
    // First sub-tab only: the parent turns into a container. A container holds no widgets,
    // so the parent's existing widgets are either moved into this first child or dropped.
    const isFirstChild = existingChildren.length === 0
    const parentWidgetIds = isFirstChild
      ? get().widgets.filter((w) => w.tabId === parentTabId).map((w) => w.id)
      : []
    const movedWidgetIds = moveWidgets ? parentWidgetIds : []
    const deletedWidgetIds = moveWidgets ? [] : parentWidgetIds

    set((s) => ({
      tabs: [...s.tabs, child],
      widgets: s.widgets
        .filter((w) => !deletedWidgetIds.includes(w.id))
        .map((w) => (movedWidgetIds.includes(w.id) ? { ...w, tabId: id } : w)),
      activeTabId: { ...s.activeTabId, [parent.dashboardId]: id },
    }))
    getStorage().dashboardTabs.create(child).catch((e) => console.warn('[dashboard-store] persist error:', e))
    for (const wid of movedWidgetIds) {
      getStorage().dashboardWidgets.update(wid, { tabId: id }).catch((e) => console.warn('[dashboard-store] persist error:', e))
    }
    for (const wid of deletedWidgetIds) {
      getStorage().dashboardWidgets.delete(wid).catch((e) => console.warn('[dashboard-store] persist error:', e))
    }
  },

  removeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s

      if (!tab.parentTabId) {
        // Root tab: never remove the last root of a dashboard.
        const rootSiblings = s.tabs.filter(
          (t) => t.dashboardId === tab.dashboardId && !t.parentTabId && t.id !== tabId,
        )
        if (rootSiblings.length === 0) return s
      }

      // Deleting a container cascades to all descendants (any depth) and their widgets.
      const removeIds = new Set<string>([tabId])
      for (let added = true; added; ) {
        added = false
        for (const t of s.tabs) {
          if (!removeIds.has(t.id) && t.parentTabId && removeIds.has(t.parentTabId)) {
            removeIds.add(t.id)
            added = true
          }
        }
      }

      for (const id of removeIds) {
        getStorage().dashboardWidgets.deleteByTab(id).catch((e) => console.warn('[dashboard-store] persist error:', e))
        getStorage().dashboardTabs.delete(id).catch((e) => console.warn('[dashboard-store] persist error:', e))
      }

      const remainingTabs = s.tabs.filter((t) => !removeIds.has(t.id))

      // Repair the active leaf: if it was removed, fall back to a sibling of the deleted tab
      // (or any remaining root), then descend to its first leaf.
      let activeTabId = s.activeTabId
      if (removeIds.has(s.activeTabId[tab.dashboardId])) {
        const sibling = remainingTabs
          .filter((t) => (t.parentTabId ?? null) === (tab.parentTabId ?? null) && t.dashboardId === tab.dashboardId)
          .sort((a, b) => a.displayOrder - b.displayOrder)[0]
          ?? remainingTabs
            .filter((t) => t.dashboardId === tab.dashboardId && !t.parentTabId)
            .sort((a, b) => a.displayOrder - b.displayOrder)[0]
        // A root tab always remains (we never delete the last one), so `sibling` is defined; only
        // drop the entry if somehow none is left rather than storing an undefined id.
        if (sibling) {
          activeTabId = { ...s.activeTabId, [tab.dashboardId]: firstLeafTab(remainingTabs, sibling.id) }
        } else {
          const { [tab.dashboardId]: _removed, ...rest } = s.activeTabId
          activeTabId = rest
        }
      }

      return {
        tabs: remainingTabs,
        widgets: s.widgets.filter((w) => !removeIds.has(w.tabId)),
        activeTabId,
      }
    }),

  renameTab: (tabId, name) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
    }))
    getStorage().dashboardTabs.update(tabId, { name }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  reorderTabs: (dashboardId, orderedIds) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.dashboardId === dashboardId) {
          const idx = orderedIds.indexOf(t.id)
          return idx >= 0 ? { ...t, displayOrder: idx } : t
        }
        return t
      }),
    }))
    // Persist each tab's new order
    for (let i = 0; i < orderedIds.length; i++) {
      getStorage().dashboardTabs.update(orderedIds[i], { displayOrder: i }).catch((e) => console.warn('[dashboard-store] persist error:', e))
    }
  },

  setActiveTab: (dashboardId, tabId) =>
    set((s) => ({
      activeTabId: { ...s.activeTabId, [dashboardId]: tabId },
    })),

  enterTab: (dashboardId, tabId) =>
    set((s) => {
      const firstChild = getChildTabs(s.tabs, tabId)[0]
      return { activeTabId: { ...s.activeTabId, [dashboardId]: firstChild?.id ?? tabId } }
    }),

  // --- Widget CRUD ---

  addWidget: (tabId, source, name, datasetFileId) => {
    const id = uid()
    const stamped = stampPluginVersion(source)
    // Place the new widget just below the lowest one in the tab.
    const bottom = get().widgets
      .filter((w) => w.tabId === tabId)
      .reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0)
    const layout = { x: 0, y: bottom, ...getDefaultLayout(stamped) }
    const widget: DashboardWidget = { id, tabId, name, datasetFileId: datasetFileId ?? null, layout, source: stamped }

    set((s) => ({ widgets: [...s.widgets, widget] }))
    getStorage().dashboardWidgets.create(widget).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  removeWidget: (widgetId) => {
    set((s) => ({ widgets: s.widgets.filter((w) => w.id !== widgetId) }))
    invalidateWidgetResult(widgetId) // drop the cached execution result so it doesn't linger
    getStorage().dashboardWidgets.delete(widgetId).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  moveWidget: (widgetId, newTabId) => {
    const widget = get().widgets.find((w) => w.id === widgetId)
    if (!widget || widget.tabId === newTabId) return
    const bottom = get().widgets
      .filter((w) => w.tabId === newTabId)
      .reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0)
    const layout = { ...widget.layout, x: 0, y: bottom }
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, tabId: newTabId, layout } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { tabId: newTabId, layout }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  duplicateWidget: (widgetId, targetTabId) => {
    const widget = get().widgets.find((w) => w.id === widgetId)
    if (!widget) return
    const tabId = targetTabId ?? widget.tabId
    const siblings = get().widgets.filter((w) => w.tabId === tabId)
    const bottom = siblings.reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0)

    // Generate a unique "(copy)" name among the target tab's widgets.
    const taken = new Set(siblings.map((w) => w.name.toLowerCase()))
    const base = `${widget.name} (copy)`
    let name = base
    let n = 2
    while (taken.has(name.toLowerCase())) name = `${base} ${n++}`

    const clone: DashboardWidget = {
      ...widget,
      id: uid(),
      tabId,
      name,
      layout: { ...widget.layout, x: 0, y: bottom },
      source: structuredClone(widget.source),
    }
    set((s) => ({ widgets: [...s.widgets, clone] }))
    getStorage().dashboardWidgets.create(clone).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  updateWidgetLayout: (widgetId, layout) => {
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, layout } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { layout }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  fitDashboardToHeight: (dashboardId, maxRows, mode = 'shrink-only') => {
    if (maxRows < 1) return
    const state = get()
    const tabIds = new Set(state.tabs.filter((t) => t.dashboardId === dashboardId).map((t) => t.id))
    const newLayouts = new Map<string, { x: number; y: number; w: number; h: number }>()

    const widgetById = new Map(state.widgets.map((w) => [w.id, w]))
    for (const tabId of tabIds) {
      const tabWidgets = state.widgets
        .filter((w) => w.tabId === tabId)
        .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
      if (tabWidgets.length === 0) continue
      const fitted = fitTabLayouts(tabWidgets, maxRows, mode)
      for (const [id, layout] of fitted) {
        // Only record real changes — this makes the function a no-op once a tab already fits, so a
        // post-resize re-fit (which calls this unconditionally) can't loop.
        const cur = widgetById.get(id)?.layout
        if (cur && cur.x === layout.x && cur.y === layout.y && cur.w === layout.w && cur.h === layout.h) continue
        newLayouts.set(id, layout)
      }
    }

    if (newLayouts.size === 0) return
    set((s) => ({
      widgets: s.widgets.map((w) => (newLayouts.has(w.id) ? { ...w, layout: newLayouts.get(w.id)! } : w)),
    }))
    for (const [id, layout] of newLayouts) {
      getStorage().dashboardWidgets.update(id, { layout }).catch((e) => console.warn('[dashboard-store] persist error:', e))
    }
  },

  updateWidgetSource: (widgetId, source) => {
    // A real edit means the user is working against the live plugin, so realign the
    // stamped version. Opening the editor without changing anything never calls this.
    const stamped = stampPluginVersion(source)
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, source: stamped } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { source: stamped }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  acceptPluginVersion: (widgetId) => {
    const widget = get().widgets.find((w) => w.id === widgetId)
    if (!widget) return
    const stamped = stampPluginVersion(widget.source)
    if (stamped === widget.source) return
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, source: stamped } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { source: stamped }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  acceptAllPluginVersions: (dashboardId) => {
    const { tabs, widgets } = get()
    const tabIds = new Set(tabs.filter((t) => t.dashboardId === dashboardId).map((t) => t.id))
    const updates = widgets
      .filter((w) => tabIds.has(w.tabId) && isWidgetPluginStale(w))
      .map((w) => ({ id: w.id, source: stampPluginVersion(w.source) }))
    if (updates.length === 0) return
    const byId = new Map(updates.map((u) => [u.id, u.source]))
    set((s) => ({
      widgets: s.widgets.map((w) => (byId.has(w.id) ? { ...w, source: byId.get(w.id)! } : w)),
    }))
    for (const u of updates) {
      getStorage().dashboardWidgets.update(u.id, { source: u.source }).catch((e) => console.warn('[dashboard-store] persist error:', e))
    }
  },

  updateWidgetName: (widgetId, name) => {
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, name } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { name }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  updateWidgetDataset: (widgetId, datasetFileId) => {
    const widget = get().widgets.find((w) => w.id === widgetId)
    if (!widget) return

    // The widget's config references the OLD dataset's column IDs. Remap them onto the
    // new dataset by column name so the configuration (X/Y choices, etc.) survives the swap.
    const datasetFiles = useDatasetStore.getState().files
    const oldColumns = datasetFiles.find((f) => f.id === widget.datasetFileId)?.columns ?? []
    const newColumns = datasetFiles.find((f) => f.id === datasetFileId)?.columns ?? []
    const source = remapWidgetColumns(widget.source, oldColumns, newColumns)
    const sourceChanged = source !== widget.source

    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, datasetFileId, source } : w)),
    }))
    getStorage().dashboardWidgets
      .update(widgetId, sourceChanged ? { datasetFileId, source } : { datasetFileId })
      .catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  // --- Filter runtime state ---

  setFilter: (filterId, value) =>
    set((s) => ({
      activeFilters: { ...s.activeFilters, [filterId]: value },
    })),

  setAllFilters: (filters) => set({ activeFilters: filters }),

  clearFilter: (filterId) =>
    set((s) => {
      const { [filterId]: _, ...rest } = s.activeFilters
      return { activeFilters: rest }
    }),

  clearAllFilters: () => set({ activeFilters: {} }),
}))
