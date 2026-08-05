import { create } from 'zustand'

/**
 * Which side panels are open on the dashboard, kept outside the page so they
 * survive navigation — leaving a dashboard and coming back used to close them.
 *
 * Filters and the assistant can be open together: they answer different
 * questions ("what data am I looking at" vs "change this for me"), and the user
 * often wants to see a filter applied while asking for a widget.
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

export const useDashboardPanelsStore = create<DashboardPanelsState>((set, get) => ({
  ...load(),
  toggleFilter: () => {
    set({ filterOpen: !get().filterOpen })
    persist({ filterOpen: get().filterOpen, agentOpen: get().agentOpen })
  },
  toggleAgent: () => {
    set({ agentOpen: !get().agentOpen })
    persist({ filterOpen: get().filterOpen, agentOpen: get().agentOpen })
  },
  setFilterOpen: (open) => {
    set({ filterOpen: open })
    persist({ filterOpen: open, agentOpen: get().agentOpen })
  },
  setAgentOpen: (open) => {
    set({ agentOpen: open })
    persist({ filterOpen: get().filterOpen, agentOpen: open })
  },
}))
