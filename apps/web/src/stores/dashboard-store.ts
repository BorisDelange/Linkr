import { create } from 'zustand'
import type { Dashboard, DashboardTab, DashboardWidget, DashboardWidgetSource, FilterValue } from '@/types'
import { getStorage } from '@/lib/storage'

interface DashboardState {
  // Loaded data for current project
  dashboards: Dashboard[]
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  activeProjectUid: string | null
  loaded: boolean

  // Editor state
  activeDashboardId: string | null
  activeTabId: Record<string, string> // dashboardId → tabId

  // Runtime filter state (not persisted) — keyed by DashboardFilter.id
  activeFilters: Record<string, FilterValue>

  // Dashboard CRUD
  loadProjectDashboards: (projectUid: string) => Promise<void>
  createDashboard: (projectUid: string, name: string) => Promise<string>
  updateDashboard: (id: string, changes: Partial<Dashboard>) => void
  deleteDashboard: (id: string) => void
  setActiveDashboard: (id: string | null) => void

  // Tab CRUD
  addTab: (dashboardId: string) => void
  removeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  reorderTabs: (dashboardId: string, orderedIds: string[]) => void
  setActiveTab: (dashboardId: string, tabId: string) => void

  // Widget CRUD
  addWidget: (tabId: string, source: DashboardWidgetSource, name: string, datasetFileId?: string | null) => void
  removeWidget: (widgetId: string) => void
  updateWidgetLayout: (widgetId: string, layout: { x: number; y: number; w: number; h: number }) => void
  updateWidgetSource: (widgetId: string, source: DashboardWidgetSource) => void
  updateWidgetName: (widgetId: string, name: string) => void
  updateWidgetDataset: (widgetId: string, datasetFileId: string | null) => void

  // Filter runtime state
  setFilter: (filterId: string, value: FilterValue) => void
  setAllFilters: (filters: Record<string, FilterValue>) => void
  clearFilter: (filterId: string) => void
  clearAllFilters: () => void
}

let dashboardCounter = 10
let tabCounter = 10
let widgetCounter = 10

function initCounters(dashboards: Dashboard[], tabs: DashboardTab[], widgets: DashboardWidget[]) {
  let maxD = 10
  let maxT = 10
  let maxW = 10
  for (const d of dashboards) {
    const m = d.id.match(/^dashboard-(\d+)$/)
    if (m) { const n = parseInt(m[1], 10); if (n >= maxD) maxD = n + 1 }
  }
  for (const t of tabs) {
    const m = t.id.match(/^dtab-(\d+)$/)
    if (m) { const n = parseInt(m[1], 10); if (n >= maxT) maxT = n + 1 }
  }
  for (const w of widgets) {
    const m = w.id.match(/^dw-(\d+)$/)
    if (m) { const n = parseInt(m[1], 10); if (n >= maxW) maxW = n + 1 }
  }
  dashboardCounter = maxD
  tabCounter = maxT
  widgetCounter = maxW
}

function getDefaultLayout(_source: DashboardWidgetSource): { w: number; h: number } {
  return { w: 12, h: 6 }
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

      initCounters(dashboards, allTabs, allWidgets)

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
    const id = `dashboard-${dashboardCounter++}`
    const now = new Date().toISOString()
    const dashboard: Dashboard = {
      id,
      projectUid,
      name,
      filterConfig: [],
      createdAt: now,
      updatedAt: now,
    }

    // Create a default first tab
    const tabId = `dtab-${tabCounter++}`
    const tab: DashboardTab = {
      id: tabId,
      dashboardId: id,
      name: 'Tab 1',
      displayOrder: 0,
    }

    set((s) => ({
      dashboards: [...s.dashboards, dashboard],
      tabs: [...s.tabs, tab],
    }))

    getStorage().dashboards.create(dashboard).catch((e) => console.warn('[dashboard-store] persist error:', e))
    getStorage().dashboardTabs.create(tab).catch((e) => console.warn('[dashboard-store] persist error:', e))

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
    const id = `dtab-${tabCounter++}`
    const tab: DashboardTab = (() => {
      const existing = get().tabs.filter((t) => t.dashboardId === dashboardId)
      return {
        id,
        dashboardId,
        name: `Tab ${existing.length + 1}`,
        displayOrder: existing.length,
      }
    })()

    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: { ...s.activeTabId, [dashboardId]: id },
    }))
    getStorage().dashboardTabs.create(tab).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  removeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      const siblings = s.tabs
        .filter((t) => t.dashboardId === tab.dashboardId && t.id !== tabId)
        .sort((a, b) => a.displayOrder - b.displayOrder)
      if (siblings.length === 0) return s // don't remove last tab
      const newActive =
        s.activeTabId[tab.dashboardId] === tabId
          ? siblings[0].id
          : s.activeTabId[tab.dashboardId]

      // Fire-and-forget storage deletes
      getStorage().dashboardWidgets.deleteByTab(tabId).catch((e) => console.warn('[dashboard-store] persist error:', e))
      getStorage().dashboardTabs.delete(tabId).catch((e) => console.warn('[dashboard-store] persist error:', e))

      return {
        tabs: s.tabs.filter((t) => t.id !== tabId),
        widgets: s.widgets.filter((w) => w.tabId !== tabId),
        activeTabId: { ...s.activeTabId, [tab.dashboardId]: newActive },
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

  // --- Widget CRUD ---

  addWidget: (tabId, source, name, datasetFileId) => {
    const id = `dw-${widgetCounter++}`
    const layout = { x: 0, y: Infinity, ...getDefaultLayout(source) }
    const widget: DashboardWidget = { id, tabId, name, datasetFileId: datasetFileId ?? null, layout, source }

    set((s) => ({ widgets: [...s.widgets, widget] }))
    getStorage().dashboardWidgets.create(widget).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  removeWidget: (widgetId) => {
    set((s) => ({ widgets: s.widgets.filter((w) => w.id !== widgetId) }))
    getStorage().dashboardWidgets.delete(widgetId).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  updateWidgetLayout: (widgetId, layout) => {
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, layout } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { layout }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  updateWidgetSource: (widgetId, source) => {
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, source } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { source }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  updateWidgetName: (widgetId, name) => {
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, name } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { name }).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  updateWidgetDataset: (widgetId, datasetFileId) => {
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, datasetFileId } : w)),
    }))
    getStorage().dashboardWidgets.update(widgetId, { datasetFileId }).catch((e) => console.warn('[dashboard-store] persist error:', e))
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
