import { create } from 'zustand'

/**
 * Which side panel is open on the dashboard, kept outside the page so it
 * survives navigation — leaving a dashboard and coming back used to close it.
 *
 * At most ONE panel is open at a time: two 320px panels leave the dashboard
 * itself squeezed, which defeats the point of watching it change. Opening one
 * closes the other. Closing the assistant does not lose the conversation — that
 * lives in agent-session-store.
 */
const STORAGE_KEY = 'linkr.dashboard.panels'

interface PanelPrefs {
  filterOpen: boolean
  agentOpen: boolean
}

function load(): PanelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { filterOpen: false, agentOpen: false }
    const parsed = JSON.parse(raw) as Partial<PanelPrefs>
    return {
      filterOpen: parsed.filterOpen === true,
      agentOpen: parsed.agentOpen === true,
    }
  } catch {
    return { filterOpen: false, agentOpen: false }
  }
}

function persist(prefs: PanelPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // A full or unavailable localStorage must not break the panel toggle.
  }
}

interface DashboardPanelsState extends PanelPrefs {
  toggleFilter: () => void
  toggleAgent: () => void
  setFilterOpen: (open: boolean) => void
  setAgentOpen: (open: boolean) => void
}

/** Apply and persist in one step; opening either panel closes the other. */
function apply(set: (prefs: PanelPrefs) => void, prefs: PanelPrefs) {
  set(prefs)
  persist(prefs)
}

export const useDashboardPanelsStore = create<DashboardPanelsState>((set, get) => ({
  ...load(),
  toggleFilter: () =>
    apply(set, { filterOpen: !get().filterOpen, agentOpen: false }),
  toggleAgent: () =>
    apply(set, { agentOpen: !get().agentOpen, filterOpen: false }),
  setFilterOpen: (open) =>
    apply(set, { filterOpen: open, agentOpen: open ? false : get().agentOpen }),
  setAgentOpen: (open) =>
    apply(set, { agentOpen: open, filterOpen: open ? false : get().filterOpen }),
}))
