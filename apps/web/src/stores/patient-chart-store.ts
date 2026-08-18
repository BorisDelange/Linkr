import { create } from 'zustand'
import type {
  LocalizedString,
  PatientDashboard,
  PatientDashboardTab,
  PatientDashboardWidget,
} from '@/types'
import { toLocalized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { getStorage } from '@/lib/storage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Widget kinds that predate the plugin registry. Kept only to read boards that
 *  were persisted before widgets became plain plugin references. */
export type PatientWidgetType = 'patient_summary' | 'notes' | 'timeline' | 'plugin'

export interface NotesConfig {
  /** Saved search word sets: { label: string, words: string[] }[] */
  wordSets?: Array<{ label: string; words: string[] }>
}

export interface TimelineConfig {
  conceptIds: number[]
  /** Force the Y axis to start at zero instead of auto-scaling to the data. */
  yAxisFromZero?: boolean
  /** Share zoom / time window with other synced timelines in the same tab. */
  syncTimeRange?: boolean
  /** Draw the series as a step function instead of straight lines. */
  stepPlot?: boolean
  /** Show a marker at each data point. */
  showPoints?: boolean
  /** Line thickness in pixels (stored as a string by the schema `select`). */
  strokeWidth?: number | string
  /** Per-concept line color (concept_id → palette name or hex). */
  conceptColors?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface PatientChartState {
  // Patient selection (keyed by projectUid) — runtime only, never persisted.
  selectedCohortId: Record<string, string | null>
  selectedPatientId: Record<string, string | null>
  selectedVisitId: Record<string, string | null>
  selectedVisitDetailId: Record<string, string | null>

  // Persisted entities
  dashboards: PatientDashboard[]
  tabs: PatientDashboardTab[]
  widgets: PatientDashboardWidget[]

  activeProjectUid: string | null
  loaded: boolean
  /** Set when the last load failed, so the page can say so instead of rendering
   *  an empty board list that looks like data loss. */
  loadError: string | null
  /** Active board per project, and active tab per board. */
  activeDashboardId: Record<string, string>
  activeTabId: Record<string, string>

  loadProjectDashboards: (projectUid: string) => Promise<void>

  // Selection actions (cascade resets)
  setSelectedCohort: (projectUid: string, cohortId: string | null) => void
  setSelectedPatient: (projectUid: string, patientId: string | null) => void
  setSelectedVisit: (projectUid: string, visitId: string | null) => void
  setSelectedVisitDetail: (projectUid: string, visitDetailId: string | null) => void

  // Board CRUD
  createDashboard: (
    projectUid: string,
    name?: string,
    description?: string,
  ) => Promise<string>
  renameDashboard: (dashboardId: string, name: string) => void
  updateDashboard: (dashboardId: string, changes: Partial<PatientDashboard>) => void
  removeDashboard: (dashboardId: string) => void
  setActiveDashboard: (projectUid: string, dashboardId: string) => void

  // Tab CRUD
  addTab: (dashboardId: string) => void
  removeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  reorderTabs: (dashboardId: string, orderedIds: string[]) => void
  setActiveTab: (dashboardId: string, tabId: string) => void

  // Display settings
  setShowWidgetTitles: (dashboardId: string, show: boolean) => void

  // Widget CRUD
  addWidget: (
    tabId: string,
    pluginId: string,
    name: string,
    initialConfig?: Record<string, unknown>,
    language?: 'python' | 'r',
  ) => void
  removeWidget: (widgetId: string) => void
  renameWidget: (widgetId: string, name: string) => void
  updateWidgetLayout: (
    widgetId: string,
    layout: { x: number; y: number; w: number; h: number },
  ) => void
  updateWidgetConfig: (widgetId: string, config: Record<string, unknown>) => void
  updateWidgetLanguage: (widgetId: string, language: 'python' | 'r') => void
  /** null clears the override, so the widget follows its generated query again. */
  updateWidgetCustomSql: (widgetId: string, sql: string | null) => void
  /** Name + description together, as the shared edit dialog saves them. */
  updateWidget: (
    widgetId: string,
    changes: { name?: LocalizedString; description?: LocalizedString },
  ) => void
  duplicateWidget: (widgetId: string) => void
  moveWidget: (widgetId: string, targetTabId: string) => void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default grid size per built-in plugin, on the 48-column grid. */
const defaultWidgetLayouts: Record<string, { w: number; h: number }> = {
  'linkr-widget-patient-summary': { w: 48, h: 24 },
  'linkr-widget-timeline': { w: 48, h: 14 },
  'linkr-widget-notes': { w: 48, h: 20 },
}

const uid = () => crypto.randomUUID()

const warn = (op: string) => (e: unknown) =>
  console.warn(`[patient-chart-store] persist error (${op}):`, e)

/** Widgets persisted before the plugin-registry migration stored a `type`
 *  discriminator instead of a plugin id. Read-time only — nothing writes it. */
const LEGACY_TYPE_TO_PLUGIN: Record<string, string> = {
  patient_summary: 'linkr-widget-patient-summary',
  timeline: 'linkr-widget-timeline',
  notes: 'linkr-widget-notes',
}

interface LegacyWidgetShape {
  type?: string
  pluginId?: string
  config?: Record<string, unknown> & { pluginId?: string }
}

/** Resolve a widget's plugin id, tolerating the two pre-migration shapes: a
 *  built-in `type`, or `type: 'plugin'` with the real id nested in the config.
 *  Returns '' when nothing resolves, so the caller can drop the widget rather
 *  than render a "plugin not found" card. */
export function resolveLegacyPluginId(w: LegacyWidgetShape): string {
  if (w.pluginId) return w.pluginId
  if (w.type === 'plugin') return w.config?.pluginId ?? ''
  return LEGACY_TYPE_TO_PLUGIN[w.type ?? ''] ?? ''
}

// ---------------------------------------------------------------------------
// One-shot migration from the old localStorage store
// ---------------------------------------------------------------------------

const LEGACY_STORAGE_KEY = 'linkr-patient-chart'
const LEGACY_MIGRATED_KEY = 'linkr-patient-chart-migrated'

interface LegacyTab {
  id: string
  projectUid: string
  name: LocalizedString | string
  displayOrder: number
}

interface LegacyWidget extends LegacyWidgetShape {
  id: string
  tabId: string
  name: LocalizedString | string
  layout: { x: number; y: number; w: number; h: number }
}

interface LegacyState {
  tabs?: LegacyTab[]
  widgets?: LegacyWidget[]
  showWidgetTitles?: Record<string, boolean>
}

function readLegacyState(): LegacyState | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as LegacyState
  } catch {
    return null
  }
}

function legacyMigratedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(LEGACY_MIGRATED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function markLegacyMigrated(projectUid: string): void {
  try {
    const done = legacyMigratedProjects()
    done.add(projectUid)
    localStorage.setItem(LEGACY_MIGRATED_KEY, JSON.stringify([...done]))
  } catch {
    // Ignore quota errors: re-running the migration is guarded by the
    // "backend already has a board" check below, so a lost marker is harmless.
  }
}

/**
 * Import a project's tabs/widgets from the pre-server localStorage store into a
 * single board, once. The legacy key is deliberately NOT deleted — a stale but
 * present key stays recoverable, a deleted one does not.
 */
async function migrateLegacyProject(projectUid: string): Promise<{
  dashboard: PatientDashboard
  tabs: PatientDashboardTab[]
  widgets: PatientDashboardWidget[]
} | null> {
  if (legacyMigratedProjects().has(projectUid)) return null
  const legacy = readLegacyState()
  const legacyTabs = (legacy?.tabs ?? []).filter((t) => t.projectUid === projectUid)
  if (legacyTabs.length === 0) {
    markLegacyMigrated(projectUid)
    return null
  }

  const now = new Date().toISOString()
  const dashboard: PatientDashboard = {
    id: uid(),
    projectUid,
    name: toLocalized('Patient data'),
    showWidgetTitles: legacy?.showWidgetTitles?.[projectUid],
    displayOrder: 0,
    version: '0.1.0',
    createdAt: now,
    updatedAt: now,
  }

  const tabs: PatientDashboardTab[] = legacyTabs.map((t) => ({
    id: t.id,
    patientDashboardId: dashboard.id,
    name: typeof t.name === 'string' ? toLocalized(t.name) : t.name,
    displayOrder: t.displayOrder,
  }))

  const tabIds = new Set(tabs.map((t) => t.id))
  const widgets: PatientDashboardWidget[] = (legacy?.widgets ?? [])
    .filter((w) => tabIds.has(w.tabId))
    .map((w) => ({
      id: w.id,
      tabId: w.tabId,
      name: typeof w.name === 'string' ? toLocalized(w.name) : w.name,
      layout: w.layout,
      pluginId: resolveLegacyPluginId(w),
      config: w.config ?? {},
    }))
    // A widget whose plugin can't be resolved would render as "plugin not found".
    .filter((w) => w.pluginId !== '')

  const storage = getStorage()
  await storage.patientDashboards.create(dashboard)
  for (const tab of tabs) await storage.patientDashboardTabs.create(tab)
  for (const w of widgets) await storage.patientDashboardWidgets.create(w)
  markLegacyMigrated(projectUid)

  return { dashboard, tabs, widgets }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePatientChartStore = create<PatientChartState>((set, get) => ({
  selectedCohortId: {},
  selectedPatientId: {},
  selectedVisitId: {},
  selectedVisitDetailId: {},

  dashboards: [],
  tabs: [],
  widgets: [],
  activeProjectUid: null,
  loaded: false,
  loadError: null,
  activeDashboardId: {},
  activeTabId: {},

  loadProjectDashboards: async (projectUid) => {
    if (get().activeProjectUid === projectUid && get().loaded) return

    try {
      set({ loadError: null })
      const storage = getStorage()
      let dashboards = await storage.patientDashboards.getByProject(projectUid)

      // Nothing server-side yet: adopt whatever the old localStorage store held.
      if (dashboards.length === 0) {
        const migrated = await migrateLegacyProject(projectUid)
        if (migrated) {
          set((s) => ({
            dashboards: [...s.dashboards, migrated.dashboard],
            tabs: [...s.tabs, ...migrated.tabs],
            widgets: [...s.widgets, ...migrated.widgets],
            activeProjectUid: projectUid,
            loaded: true,
            activeDashboardId: {
              ...s.activeDashboardId,
              [projectUid]: migrated.dashboard.id,
            },
          }))
          return
        }
        dashboards = []
      }

      const allTabs: PatientDashboardTab[] = []
      const allWidgets: PatientDashboardWidget[] = []
      for (const dash of dashboards) {
        const tabs = await storage.patientDashboardTabs.getByDashboard(dash.id)
        allTabs.push(...tabs)
        for (const tab of tabs) {
          allWidgets.push(...(await storage.patientDashboardWidgets.getByTab(tab.id)))
        }
      }

      // Imported ZIPs and migrated rows may carry a bare string name.
      for (const d of dashboards) {
        if (typeof d.name === 'string') d.name = toLocalized(d.name)
      }
      for (const t of allTabs) {
        if (typeof t.name === 'string') t.name = toLocalized(t.name)
      }
      for (const w of allWidgets) {
        if (typeof w.name === 'string') w.name = toLocalized(w.name)
        // Boards written before widgets became plain plugin references.
        if (!w.pluginId) w.pluginId = resolveLegacyPluginId(w as LegacyWidgetShape)
      }

      const first = [...dashboards].sort((a, b) => a.displayOrder - b.displayOrder)[0]
      set((s) => ({
        dashboards,
        tabs: allTabs,
        widgets: allWidgets,
        activeProjectUid: projectUid,
        loaded: true,
        activeDashboardId: first
          ? { ...s.activeDashboardId, [projectUid]: s.activeDashboardId[projectUid] ?? first.id }
          : s.activeDashboardId,
      }))
    } catch (e) {
      // Do NOT mark this project loaded: `loaded` is what the guard above reads,
      // so a transient API failure would otherwise latch an empty board list for
      // the rest of the session and read as "my boards disappeared". Leaving the
      // flag down lets the next mount retry.
      console.error('[patient-chart-store] load error:', e)
      set({ loaded: false, loadError: e instanceof Error ? e.message : String(e) })
    }
  },

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

  // --- Board CRUD ---

  createDashboard: async (projectUid, name, description) => {
    const id = uid()
    const now = new Date().toISOString()
    const existing = get().dashboards.filter((d) => d.projectUid === projectUid)
    // Written into the ACTIVE language only. toLocalized would copy the same
    // string into every language, so a board named in French would then read
    // identically in English with no way to tell it was never translated.
    const lang = useAppStore.getState().language
    const dashboard: PatientDashboard = {
      id,
      projectUid,
      name: setLocalized({}, lang, name ?? `Board ${existing.length + 1}`),
      description: description ? setLocalized({}, lang, description) : undefined,
      displayOrder: existing.length,
      version: '0.1.0',
      createdAt: now,
      updatedAt: now,
    }
    const tabId = uid()
    const tab: PatientDashboardTab = {
      id: tabId,
      patientDashboardId: id,
      name: toLocalized('Tab 1'),
      displayOrder: 0,
    }

    set((s) => ({
      dashboards: [...s.dashboards, dashboard],
      tabs: [...s.tabs, tab],
      activeDashboardId: { ...s.activeDashboardId, [projectUid]: id },
      activeTabId: { ...s.activeTabId, [id]: tabId },
    }))

    // The tab's create references the board (FK), so persist the board first: in
    // server mode the tab POST 404s if it races ahead of the parent.
    const storage = getStorage()
    try {
      await storage.patientDashboards.create(dashboard)
      await storage.patientDashboardTabs.create(tab)
    } catch (e) {
      warn('createDashboard')(e)
    }
    return id
  },

  renameDashboard: (dashboardId, name) =>
    set((s) => {
      const lang = useAppStore.getState().language
      const next = s.dashboards.map((d) =>
        d.id === dashboardId ? { ...d, name: setLocalized(d.name, lang, name) } : d,
      )
      const changed = next.find((d) => d.id === dashboardId)
      if (changed) {
        getStorage()
          .patientDashboards.update(dashboardId, { name: changed.name })
          .catch(warn('renameDashboard'))
      }
      return { dashboards: next }
    }),

  updateDashboard: (dashboardId, changes) =>
    set((s) => {
      getStorage()
        .patientDashboards.update(dashboardId, changes)
        .catch(warn('updateDashboard'))
      return {
        dashboards: s.dashboards.map((d) =>
          d.id === dashboardId ? { ...d, ...changes } : d,
        ),
      }
    }),

  removeDashboard: (dashboardId) =>
    set((s) => {
      const board = s.dashboards.find((d) => d.id === dashboardId)
      if (!board) return s
      const tabIds = new Set(
        s.tabs.filter((t) => t.patientDashboardId === dashboardId).map((t) => t.id),
      )
      // Rows cascade server-side; the client only mirrors the delete.
      getStorage().patientDashboards.delete(dashboardId).catch(warn('removeDashboard'))

      const remaining = s.dashboards
        .filter((d) => d.id !== dashboardId && d.projectUid === board.projectUid)
        .sort((a, b) => a.displayOrder - b.displayOrder)
      return {
        dashboards: s.dashboards.filter((d) => d.id !== dashboardId),
        tabs: s.tabs.filter((t) => t.patientDashboardId !== dashboardId),
        widgets: s.widgets.filter((w) => !tabIds.has(w.tabId)),
        activeDashboardId: {
          ...s.activeDashboardId,
          [board.projectUid]: remaining[0]?.id ?? '',
        },
      }
    }),

  setActiveDashboard: (projectUid, dashboardId) =>
    set((s) => ({
      activeDashboardId: { ...s.activeDashboardId, [projectUid]: dashboardId },
    })),

  // --- Tab CRUD ---

  addTab: (dashboardId) => {
    const id = uid()
    set((s) => {
      const existing = s.tabs.filter((t) => t.patientDashboardId === dashboardId)
      const newTab: PatientDashboardTab = {
        id,
        patientDashboardId: dashboardId,
        name: toLocalized(`Tab ${existing.length + 1}`),
        displayOrder: existing.length,
      }
      getStorage().patientDashboardTabs.create(newTab).catch(warn('addTab'))
      return {
        tabs: [...s.tabs, newTab],
        activeTabId: { ...s.activeTabId, [dashboardId]: id },
      }
    })
  },

  removeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      const siblings = s.tabs
        .filter((t) => t.patientDashboardId === tab.patientDashboardId && t.id !== tabId)
        .sort((a, b) => a.displayOrder - b.displayOrder)
      // A board always keeps at least one tab.
      if (siblings.length === 0) return s

      getStorage().patientDashboardTabs.delete(tabId).catch(warn('removeTab'))

      const newActive =
        s.activeTabId[tab.patientDashboardId] === tabId
          ? siblings[0].id
          : s.activeTabId[tab.patientDashboardId]
      return {
        tabs: s.tabs.filter((t) => t.id !== tabId),
        widgets: s.widgets.filter((w) => w.tabId !== tabId),
        activeTabId: { ...s.activeTabId, [tab.patientDashboardId]: newActive },
      }
    }),

  renameTab: (tabId, name) =>
    set((s) => {
      const lang = useAppStore.getState().language
      const next = s.tabs.map((t) =>
        t.id === tabId ? { ...t, name: setLocalized(t.name, lang, name) } : t,
      )
      const changed = next.find((t) => t.id === tabId)
      if (changed) {
        getStorage()
          .patientDashboardTabs.update(tabId, { name: changed.name })
          .catch(warn('renameTab'))
      }
      return { tabs: next }
    }),

  reorderTabs: (dashboardId, orderedIds) =>
    set((s) => {
      const storage = getStorage()
      return {
        tabs: s.tabs.map((t) => {
          if (t.patientDashboardId !== dashboardId) return t
          const idx = orderedIds.indexOf(t.id)
          if (idx < 0 || idx === t.displayOrder) return t
          storage.patientDashboardTabs
            .update(t.id, { displayOrder: idx })
            .catch(warn('reorderTabs'))
          return { ...t, displayOrder: idx }
        }),
      }
    }),

  setActiveTab: (dashboardId, tabId) =>
    set((s) => ({
      activeTabId: { ...s.activeTabId, [dashboardId]: tabId },
    })),

  // --- Display settings ---

  setShowWidgetTitles: (dashboardId, show) =>
    set((s) => {
      getStorage()
        .patientDashboards.update(dashboardId, { showWidgetTitles: show })
        .catch(warn('setShowWidgetTitles'))
      return {
        dashboards: s.dashboards.map((d) =>
          d.id === dashboardId ? { ...d, showWidgetTitles: show } : d,
        ),
      }
    }),

  // --- Widget CRUD ---

  addWidget: (tabId, pluginId, name, initialConfig, language) => {
    const id = uid()
    const defaultLayout = defaultWidgetLayouts[pluginId] ?? { w: 24, h: 14 }
    set((s) => {
      // Place below the lowest widget of this tab, as the dashboard grid does.
      const bottom = s.widgets
        .filter((w) => w.tabId === tabId)
        .reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0)
      const widget: PatientDashboardWidget = {
        id,
        tabId,
        name: toLocalized(name),
        layout: { x: 0, y: bottom, ...defaultLayout },
        pluginId,
        language,
        config: initialConfig ?? {},
      }
      getStorage().patientDashboardWidgets.create(widget).catch(warn('addWidget'))
      return { widgets: [...s.widgets, widget] }
    })
  },

  removeWidget: (widgetId) =>
    set((s) => {
      getStorage().patientDashboardWidgets.delete(widgetId).catch(warn('removeWidget'))
      return { widgets: s.widgets.filter((w) => w.id !== widgetId) }
    }),

  renameWidget: (widgetId, name) =>
    set((s) => {
      const lang = useAppStore.getState().language
      const next = s.widgets.map((w) =>
        w.id === widgetId ? { ...w, name: setLocalized(w.name, lang, name) } : w,
      )
      const changed = next.find((w) => w.id === widgetId)
      if (changed) {
        getStorage()
          .patientDashboardWidgets.update(widgetId, { name: changed.name })
          .catch(warn('renameWidget'))
      }
      return { widgets: next }
    }),

  updateWidgetLayout: (widgetId, layout) =>
    set((s) => {
      getStorage()
        .patientDashboardWidgets.update(widgetId, { layout })
        .catch(warn('updateWidgetLayout'))
      return {
        widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, layout } : w)),
      }
    }),

  updateWidgetConfig: (widgetId, config) =>
    set((s) => {
      getStorage()
        .patientDashboardWidgets.update(widgetId, { config })
        .catch(warn('updateWidgetConfig'))
      return {
        widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, config } : w)),
      }
    }),

  updateWidget: (widgetId, changes) =>
    set((s) => {
      getStorage()
        .patientDashboardWidgets.update(widgetId, changes)
        .catch(warn('updateWidget'))
      return {
        widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, ...changes } : w)),
      }
    }),

  updateWidgetCustomSql: (widgetId, sql) =>
    set((s) => {
      getStorage()
        .patientDashboardWidgets.update(widgetId, { customSql: sql })
        .catch(warn('updateWidgetCustomSql'))
      return {
        widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, customSql: sql } : w)),
      }
    }),

  updateWidgetLanguage: (widgetId, language) =>
    set((s) => {
      getStorage()
        .patientDashboardWidgets.update(widgetId, { language })
        .catch(warn('updateWidgetLanguage'))
      return {
        widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, language } : w)),
      }
    }),

  duplicateWidget: (widgetId) =>
    set((s) => {
      const source = s.widgets.find((w) => w.id === widgetId)
      if (!source) return s
      const bottom = s.widgets
        .filter((w) => w.tabId === source.tabId)
        .reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0)
      const copy: PatientDashboardWidget = {
        ...source,
        id: uid(),
        name: Object.fromEntries(
          Object.entries(source.name).map(([lang, value]) => [lang, `${value} (copy)`]),
        ),
        layout: { ...source.layout, x: 0, y: bottom },
      }
      getStorage().patientDashboardWidgets.create(copy).catch(warn('duplicateWidget'))
      return { widgets: [...s.widgets, copy] }
    }),

  moveWidget: (widgetId, targetTabId) =>
    set((s) => {
      const widget = s.widgets.find((w) => w.id === widgetId)
      if (!widget || widget.tabId === targetTabId) return s
      const bottom = s.widgets
        .filter((w) => w.tabId === targetTabId)
        .reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0)
      const layout = { ...widget.layout, x: 0, y: bottom }
      getStorage()
        .patientDashboardWidgets.update(widgetId, { tabId: targetTabId, layout })
        .catch(warn('moveWidget'))
      return {
        widgets: s.widgets.map((w) =>
          w.id === widgetId ? { ...w, tabId: targetTabId, layout } : w,
        ),
      }
    }),
}))
