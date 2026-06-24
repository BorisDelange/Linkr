import { create } from 'zustand'
import type { Dashboard, DashboardTab, DashboardWidget, DashboardWidgetSource, FilterValue } from '@/types'
import { getStorage } from '@/lib/storage'
import { useDatasetStore } from '@/stores/dataset-store'
import { remapWidgetColumns } from '@/features/projects/dashboard/remap-widget-columns'
import { isWidgetPluginStale, stampPluginVersion } from '@/features/projects/dashboard/plugin-drift'

interface DashboardState {
  // Loaded data for current project
  dashboards: Dashboard[]
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  activeProjectUid: string | null
  loaded: boolean

  // Editor state
  activeDashboardId: string | null
  activeTabId: Record<string, string> // dashboardId → active ROOT tabId
  activeSubTabId: Record<string, string> // parent tabId → active child tabId

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
  /** Add a sub-tab to a root tab. If the root currently holds widgets, they move into the
   *  first sub-tab so nothing is orphaned when it becomes a container. */
  addSubTab: (parentTabId: string) => void
  removeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  reorderTabs: (dashboardId: string, orderedIds: string[]) => void
  setActiveTab: (dashboardId: string, tabId: string) => void
  setActiveSubTab: (parentTabId: string, childTabId: string) => void

  // Widget CRUD
  addWidget: (tabId: string, source: DashboardWidgetSource, name: string, datasetFileId?: string | null) => void
  removeWidget: (widgetId: string) => void
  /** Move a widget to another tab, dropping it at the bottom of the target tab. */
  moveWidget: (widgetId: string, newTabId: string) => void
  /** Clone a widget (config + dataset) into the same or another tab. */
  duplicateWidget: (widgetId: string, targetTabId?: string) => void
  updateWidgetLayout: (widgetId: string, layout: { x: number; y: number; w: number; h: number }) => void
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
  activeSubTabId: {},
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

      set({
        dashboards,
        tabs: allTabs,
        widgets: allWidgets,
        activeProjectUid: projectUid,
        loaded: true,
        activeDashboardId: null,
        activeTabId: {},
        activeSubTabId: {},
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
        activeSubTabId: {},
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

  addSubTab: (parentTabId) => {
    const parent = get().tabs.find((t) => t.id === parentTabId)
    if (!parent || parent.parentTabId) return // sub-tabs are one level deep only
    const existingChildren = get().tabs.filter((t) => t.parentTabId === parentTabId)
    const id = uid()
    const child: DashboardTab = {
      id,
      dashboardId: parent.dashboardId,
      name: `Sub-tab ${existingChildren.length + 1}`,
      displayOrder: existingChildren.length,
      parentTabId,
    }
    // First sub-tab: the parent becomes a container, so its own widgets move into this child.
    const moveParentWidgets = existingChildren.length === 0
    const movedWidgetIds = moveParentWidgets
      ? get().widgets.filter((w) => w.tabId === parentTabId).map((w) => w.id)
      : []

    set((s) => ({
      tabs: [...s.tabs, child],
      widgets: movedWidgetIds.length > 0
        ? s.widgets.map((w) => (w.tabId === parentTabId ? { ...w, tabId: id } : w))
        : s.widgets,
      activeSubTabId: { ...s.activeSubTabId, [parentTabId]: id },
    }))
    getStorage().dashboardTabs.create(child).catch((e) => console.warn('[dashboard-store] persist error:', e))
    for (const wid of movedWidgetIds) {
      getStorage().dashboardWidgets.update(wid, { tabId: id }).catch((e) => console.warn('[dashboard-store] persist error:', e))
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

      // Deleting a container cascades to its sub-tabs (and their widgets).
      const children = s.tabs.filter((t) => t.parentTabId === tabId)
      const removeIds = new Set<string>([tabId, ...children.map((c) => c.id)])

      for (const id of removeIds) {
        getStorage().dashboardWidgets.deleteByTab(id).catch((e) => console.warn('[dashboard-store] persist error:', e))
        getStorage().dashboardTabs.delete(id).catch((e) => console.warn('[dashboard-store] persist error:', e))
      }

      // Repair active selections.
      let activeTabId = s.activeTabId
      if (!tab.parentTabId && s.activeTabId[tab.dashboardId] === tabId) {
        const nextRoot = s.tabs
          .filter((t) => t.dashboardId === tab.dashboardId && !t.parentTabId && t.id !== tabId)
          .sort((a, b) => a.displayOrder - b.displayOrder)[0]
        activeTabId = { ...s.activeTabId, [tab.dashboardId]: nextRoot?.id }
      }
      let activeSubTabId = s.activeSubTabId
      if (tab.parentTabId && s.activeSubTabId[tab.parentTabId] === tabId) {
        const nextChild = s.tabs
          .filter((t) => t.parentTabId === tab.parentTabId && t.id !== tabId)
          .sort((a, b) => a.displayOrder - b.displayOrder)[0]
        activeSubTabId = { ...s.activeSubTabId, [tab.parentTabId]: nextChild?.id }
      }

      return {
        tabs: s.tabs.filter((t) => !removeIds.has(t.id)),
        widgets: s.widgets.filter((w) => !removeIds.has(w.tabId)),
        activeTabId,
        activeSubTabId,
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

  setActiveSubTab: (parentTabId, childTabId) =>
    set((s) => ({
      activeSubTabId: { ...s.activeSubTabId, [parentTabId]: childTabId },
    })),

  // --- Widget CRUD ---

  addWidget: (tabId, source, name, datasetFileId) => {
    const id = uid()
    const stamped = stampPluginVersion(source)
    const layout = { x: 0, y: Infinity, ...getDefaultLayout(stamped) }
    const widget: DashboardWidget = { id, tabId, name, datasetFileId: datasetFileId ?? null, layout, source: stamped }

    set((s) => ({ widgets: [...s.widgets, widget] }))
    getStorage().dashboardWidgets.create(widget).catch((e) => console.warn('[dashboard-store] persist error:', e))
  },

  removeWidget: (widgetId) => {
    set((s) => ({ widgets: s.widgets.filter((w) => w.id !== widgetId) }))
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
