import { create } from 'zustand'

export interface DashboardTab {
  id: string
  projectUid: string
  name: string
  displayOrder: number
}

export interface DashboardWidget {
  id: string
  tabId: string
  type: string
  name: string
  layout: { x: number; y: number; w: number; h: number }
  config: Record<string, unknown>
}

interface DashboardState {
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  activeTabId: Record<string, string>

  // Tabs CRUD
  addTab: (projectUid: string) => void
  removeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  reorderTabs: (projectUid: string, orderedIds: string[]) => void
  setActiveTab: (projectUid: string, tabId: string) => void

  // Widgets CRUD
  addWidget: (tabId: string, type: string, name: string) => void
  removeWidget: (widgetId: string) => void
  updateWidgetLayout: (
    widgetId: string,
    layout: { x: number; y: number; w: number; h: number }
  ) => void
}

let tabCounter = 10
let widgetCounter = 10

// Default widget layouts per type
const defaultWidgetLayouts: Record<
  string,
  { w: number; h: number }
> = {
  admission_count: { w: 6, h: 4 },
  patient_count: { w: 6, h: 4 },
  admission_timeline: { w: 12, h: 6 },
  heart_rate: { w: 12, h: 6 },
  vitals_table: { w: 12, h: 8 },
}

// Demo data: tabs + widgets for project MIMIC-IV Demo
const DEMO_PROJECT_UID = '00000000-0000-0000-0000-000000000001'

const defaultTabs: DashboardTab[] = [
  {
    id: 'tab-1',
    projectUid: DEMO_PROJECT_UID,
    name: 'Overview',
    displayOrder: 0,
  },
  {
    id: 'tab-2',
    projectUid: DEMO_PROJECT_UID,
    name: 'Patient view',
    displayOrder: 1,
  },
]

const defaultWidgets: DashboardWidget[] = [
  {
    id: 'w-1',
    tabId: 'tab-1',
    type: 'admission_count',
    name: 'Admissions',
    layout: { x: 0, y: 0, w: 6, h: 4 },
    config: {},
  },
  {
    id: 'w-2',
    tabId: 'tab-1',
    type: 'patient_count',
    name: 'Patients',
    layout: { x: 6, y: 0, w: 6, h: 4 },
    config: {},
  },
  {
    id: 'w-3',
    tabId: 'tab-1',
    type: 'admission_timeline',
    name: 'Admission timeline',
    layout: { x: 0, y: 4, w: 24, h: 6 },
    config: {},
  },
  {
    id: 'w-4',
    tabId: 'tab-2',
    type: 'heart_rate',
    name: 'Heart rate',
    layout: { x: 0, y: 0, w: 12, h: 6 },
    config: {},
  },
  {
    id: 'w-5',
    tabId: 'tab-2',
    type: 'vitals_table',
    name: 'Vital signs',
    layout: { x: 12, y: 0, w: 12, h: 8 },
    config: {},
  },
]

export const useDashboardStore = create<DashboardState>((set) => ({
  tabs: defaultTabs,
  widgets: defaultWidgets,
  activeTabId: {
    [DEMO_PROJECT_UID]: 'tab-1',
  },

  addTab: (projectUid) => {
    const id = `tab-${tabCounter++}`
    set((s) => {
      const existing = s.tabs.filter((t) => t.projectUid === projectUid)
      const newTab: DashboardTab = {
        id,
        projectUid,
        name: `Tab ${existing.length + 1}`,
        displayOrder: existing.length,
      }
      return {
        tabs: [...s.tabs, newTab],
        activeTabId: { ...s.activeTabId, [projectUid]: id },
      }
    })
  },

  removeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      const siblings = s.tabs
        .filter((t) => t.projectUid === tab.projectUid && t.id !== tabId)
        .sort((a, b) => a.displayOrder - b.displayOrder)
      if (siblings.length === 0) return s // don't remove last tab
      const newActive =
        s.activeTabId[tab.projectUid] === tabId
          ? siblings[0].id
          : s.activeTabId[tab.projectUid]
      return {
        tabs: s.tabs.filter((t) => t.id !== tabId),
        widgets: s.widgets.filter((w) => w.tabId !== tabId),
        activeTabId: { ...s.activeTabId, [tab.projectUid]: newActive },
      }
    }),

  renameTab: (tabId, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
    })),

  reorderTabs: (projectUid, orderedIds) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.projectUid === projectUid) {
          const idx = orderedIds.indexOf(t.id)
          return idx >= 0 ? { ...t, displayOrder: idx } : t
        }
        return t
      }),
    })),

  setActiveTab: (projectUid, tabId) =>
    set((s) => ({
      activeTabId: { ...s.activeTabId, [projectUid]: tabId },
    })),

  addWidget: (tabId, type, name) => {
    const id = `w-${widgetCounter++}`
    const defaultLayout = defaultWidgetLayouts[type] ?? { w: 4, h: 3 }
    set((s) => ({
      widgets: [
        ...s.widgets,
        {
          id,
          tabId,
          type,
          name,
          layout: { x: 0, y: Infinity, ...defaultLayout },
          config: {},
        },
      ],
    }))
  },

  removeWidget: (widgetId) =>
    set((s) => ({
      widgets: s.widgets.filter((w) => w.id !== widgetId),
    })),

  updateWidgetLayout: (widgetId, layout) =>
    set((s) => ({
      widgets: s.widgets.map((w) =>
        w.id === widgetId ? { ...w, layout } : w
      ),
    })),
}))
