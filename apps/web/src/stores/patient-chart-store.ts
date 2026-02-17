import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatientChartTab {
  id: string
  projectUid: string
  name: string
  displayOrder: number
}

export type PatientWidgetType =
  | 'timeline'
  | 'clinical_table'
  | 'patient_summary'
  | 'medications'
  | 'diagnoses'

export interface TimelineConfig {
  conceptIds: number[]
}

export interface ClinicalTableConfig {
  conceptIds: number[]
  orientation: 'concepts-as-rows' | 'concepts-as-columns'
}

export type PatientWidgetConfig =
  | TimelineConfig
  | ClinicalTableConfig
  | Record<string, unknown>

export interface PatientChartWidget {
  id: string
  tabId: string
  type: PatientWidgetType
  name: string
  layout: { x: number; y: number; w: number; h: number }
  config: PatientWidgetConfig
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface PatientChartState {
  // Patient selection (keyed by projectUid)
  selectedCohortId: Record<string, string | null>
  selectedPatientId: Record<string, string | null>
  selectedVisitId: Record<string, string | null>
  selectedVisitDetailId: Record<string, string | null>

  // Tabs + widgets
  tabs: PatientChartTab[]
  widgets: PatientChartWidget[]
  activeTabId: Record<string, string>

  // Display settings (keyed by projectUid)
  showWidgetTitles: Record<string, boolean>

  // Selection actions (cascade resets)
  setSelectedCohort: (projectUid: string, cohortId: string | null) => void
  setSelectedPatient: (projectUid: string, patientId: string | null) => void
  setSelectedVisit: (projectUid: string, visitId: string | null) => void
  setSelectedVisitDetail: (projectUid: string, visitDetailId: string | null) => void

  // Tab CRUD
  addTab: (projectUid: string) => void
  removeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  reorderTabs: (projectUid: string, orderedIds: string[]) => void
  setActiveTab: (projectUid: string, tabId: string) => void

  // Display settings
  setShowWidgetTitles: (projectUid: string, show: boolean) => void

  // Widget CRUD
  addWidget: (tabId: string, type: PatientWidgetType, name: string) => void
  removeWidget: (widgetId: string) => void
  updateWidgetLayout: (
    widgetId: string,
    layout: { x: number; y: number; w: number; h: number },
  ) => void
  updateWidgetConfig: (widgetId: string, config: PatientWidgetConfig) => void
}

// ---------------------------------------------------------------------------
// Default widget layouts per type
// ---------------------------------------------------------------------------

const defaultWidgetLayouts: Record<string, { w: number; h: number }> = {
  timeline: { w: 16, h: 7 },
  clinical_table: { w: 24, h: 8 },
  patient_summary: { w: 8, h: 5 },
  medications: { w: 12, h: 6 },
  diagnoses: { w: 12, h: 6 },
}

// ---------------------------------------------------------------------------
// Default config per widget type
// ---------------------------------------------------------------------------

function defaultConfigForType(type: PatientWidgetType): PatientWidgetConfig {
  switch (type) {
    case 'timeline':
      return { conceptIds: [] } as TimelineConfig
    case 'clinical_table':
      return {
        conceptIds: [],
        orientation: 'concepts-as-rows',
      } as ClinicalTableConfig
    default:
      return {}
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'linkr-patient-chart'

interface PersistedState {
  tabs: PatientChartTab[]
  widgets: PatientChartWidget[]
  activeTabId: Record<string, string>
  showWidgetTitles: Record<string, boolean>
  tabCounter: number
  widgetCounter: number
}

function loadPersistedState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as PersistedState
  } catch {
    return {}
  }
}

const persisted = loadPersistedState()

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

let tabCounter = persisted.tabCounter ?? 10
let widgetCounter = persisted.widgetCounter ?? 10

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePatientChartStore = create<PatientChartState>((set) => ({
  selectedCohortId: {},
  selectedPatientId: {},
  selectedVisitId: {},
  selectedVisitDetailId: {},

  tabs: persisted.tabs ?? [],
  widgets: persisted.widgets ?? [],
  activeTabId: persisted.activeTabId ?? {},
  showWidgetTitles: persisted.showWidgetTitles ?? {},

  // --- Selection (cascade resets) ---

  setSelectedCohort: (projectUid, cohortId) =>
    set((s) => ({
      selectedCohortId: { ...s.selectedCohortId, [projectUid]: cohortId },
      selectedPatientId: { ...s.selectedPatientId, [projectUid]: null },
      selectedVisitId: { ...s.selectedVisitId, [projectUid]: null },
      selectedVisitDetailId: { ...s.selectedVisitDetailId, [projectUid]: null },
    })),

  setSelectedPatient: (projectUid, patientId) =>
    set((s) => ({
      selectedPatientId: { ...s.selectedPatientId, [projectUid]: patientId },
      selectedVisitId: { ...s.selectedVisitId, [projectUid]: null },
      selectedVisitDetailId: { ...s.selectedVisitDetailId, [projectUid]: null },
    })),

  setSelectedVisit: (projectUid, visitId) =>
    set((s) => ({
      selectedVisitId: { ...s.selectedVisitId, [projectUid]: visitId },
      selectedVisitDetailId: { ...s.selectedVisitDetailId, [projectUid]: null },
    })),

  setSelectedVisitDetail: (projectUid, visitDetailId) =>
    set((s) => ({
      selectedVisitDetailId: { ...s.selectedVisitDetailId, [projectUid]: visitDetailId },
    })),

  // --- Tab CRUD ---

  addTab: (projectUid) => {
    const id = `pctab-${tabCounter++}`
    set((s) => {
      const existing = s.tabs.filter((t) => t.projectUid === projectUid)
      const newTab: PatientChartTab = {
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
      if (siblings.length === 0) return s
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

  // --- Display settings ---

  setShowWidgetTitles: (projectUid, show) =>
    set((s) => ({
      showWidgetTitles: { ...s.showWidgetTitles, [projectUid]: show },
    })),

  // --- Widget CRUD ---

  addWidget: (tabId, type, name) => {
    const id = `pcw-${widgetCounter++}`
    const defaultLayout = defaultWidgetLayouts[type] ?? { w: 8, h: 5 }
    set((s) => ({
      widgets: [
        ...s.widgets,
        {
          id,
          tabId,
          type,
          name,
          layout: { x: 0, y: Infinity, ...defaultLayout },
          config: defaultConfigForType(type),
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
        w.id === widgetId ? { ...w, layout } : w,
      ),
    })),

  updateWidgetConfig: (widgetId, config) =>
    set((s) => ({
      widgets: s.widgets.map((w) =>
        w.id === widgetId ? { ...w, config } : w,
      ),
    })),
}))

// Persist tabs/widgets to localStorage on change
usePatientChartStore.subscribe((state) => {
  try {
    const data: PersistedState = {
      tabs: state.tabs,
      widgets: state.widgets,
      activeTabId: state.activeTabId,
      showWidgetTitles: state.showWidgetTitles,
      tabCounter,
      widgetCounter,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // Ignore quota errors
  }
})
